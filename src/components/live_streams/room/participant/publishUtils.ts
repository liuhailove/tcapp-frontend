/** @internal */
import {LoggerOptions} from "../types";
import LocalVideoTrack from "../track/LocalVideoTrack";
import LocalAudioTrack from "../track/LocalAudioTrack";
import {TrackInvalidError} from "../errors";
import log from '../../logger';

import {
    ScreenSharePresets,
    TrackPublishOptions, VideoCodec,
    VideoEncoding,
    VideoPreset,
    VideoPresets,
    VideoPresets43
} from "../track/options";
import {getReactNativeOs, isFireFox, isReactNative, isSVCCodec} from "../utils";
import {Track} from "../track/Track";

export function mediaTrackToLocalTrack(
    mediaStreamTrack: MediaStreamTrack,
    constraints?: MediaTrackConstraints,
    loggerOptions?: LoggerOptions,
): LocalVideoTrack | LocalAudioTrack {
    switch (mediaStreamTrack.kind) {
        case 'audio':
            return new LocalAudioTrack(mediaStreamTrack, constraints, false, undefined, loggerOptions);
        case 'video':
            return new LocalVideoTrack(mediaStreamTrack, constraints, false, loggerOptions);
        default:
            throw new TrackInvalidError(`unsupported track type: ${mediaStreamTrack.kind}`);
    }
}

/* @internal */
export const presets169 = Object.values(VideoPresets);

/* @internal */
export const presets43 = Object.values(VideoPresets43);

/* @internal */
export const presetsScreenShare = Object.values(ScreenSharePresets);

/* @internal */
export const defaultSimulcastPresets169 = [VideoPresets.h180, VideoPresets.h360];

/* @internal */
export const defaultSimulcastPresets43 = [VideoPresets43.h180, VideoPresets43.h360];

/* @internal */
export const computeDefaultScreenShareSimulcastPresets = (fromPreset: VideoPreset) => {
    const layers = [{scaleResolutionDownBy: 2, fps: fromPreset.encoding.maxFramerate}];
    return layers.map(
        (t) =>
            new VideoPreset(
                Math.floor(fromPreset.width / t.scaleResolutionDownBy),
                Math.floor(fromPreset.height / t.scaleResolutionDownBy),
                Math.max(
                    150_000,
                    Math.floor(
                        fromPreset.encoding.maxBitrate /
                        (t.scaleResolutionDownBy ** 2 *
                            ((fromPreset.encoding.maxFramerate ?? 30) / (t.fps ?? 30))),
                    ),
                ),
                t.fps,
                fromPreset.encoding.priority,
            ),
    );
};

// /**
//  *
//  * @internal
//  * @experimental
//  */
// const computeDefaultMultiCodecSimulcastEncodings = (width: number, height: number) => {
//   // use vp8 as a default
//   const vp8 = determineAppropriateEncoding(false, width, height);
//   const vp9 = { ...vp8, maxBitrate: vp8.maxBitrate * 0.9 };
//   const h264 = { ...vp8, maxBitrate: vp8.maxBitrate * 1.1 };
//   const av1 = { ...vp8, maxBitrate: vp8.maxBitrate * 0.7 };
//   return {
//     vp8,
//     vp9,
//     h264,
//     av1,
//   };
// };

const videoRids = ['q', 'h', 'f'];

/**
 * 计算视频编码
 * @internal
 */
export function computeVideoEncodings(
    isScreenShare: boolean,
    width?: number,
    height?: number,
    options?: TrackPublishOptions,
): RTCRtpEncodingParameters[] {
    let videoEncoding: VideoEncoding | undefined = options?.videoEncoding;

    if (isScreenShare) {
        videoEncoding = options?.screenShareEncoding;
    }

    const useSimulcast = options?.simulcast;
    // 可扩展性模式
    const scalabilityMode = options?.scalabilityMode;
    const videoCodec = options?.videoCodec;

    if ((!videoEncoding && !useSimulcast && !scalabilityMode) || !width || !height) {
        // 当我们不进行联播或 svc 时，需要返回单个编码而不限制带宽。 我们总是需要 dynacast 的编码
        return [{}];
    }

    if (!videoEncoding) {
        // 根据宽度/高度找到正确的编码
        videoEncoding = determineAppropriateEncoding(isScreenShare, width, height, videoCodec);
        log.debug('using video encoding', videoEncoding);
    }

    const original = new VideoPreset(
        width,
        height,
        videoEncoding?.maxBitrate,
        videoEncoding?.maxFramerate,
        videoEncoding?.priority,
    );

    if (scalabilityMode && isSVCCodec(videoCodec)) {
        const sm = new ScalabilityMode(scalabilityMode);

        const encodings: RTCRtpEncodingParameters[] = [];

        if (sm.spatial > 3) {
            throw new Error(`unsupported scalabilityMode: ${scalabilityMode}`);
        }
        encodings.push({
            maxBitrate: videoEncoding?.maxBitrate,
            /* @ts-ignore */
            maxFramerate: original.encoding.maxFramerate,
            /* @ts-ignore */
            scalabilityMode: scalabilityMode,
        });
        log.debug(`using svc encoding`, encodings[0]);
        return encodings;
    }

    if (!useSimulcast) {
        return [videoEncoding];
    }

    let presets: Array<VideoPreset>;
    if (isScreenShare) {
        presets =
            sortPresets(options?.screenShareSimulcastLayers) ??
            defaultSimulcastLayers(isScreenShare, original);
    } else {
        presets =
            sortPresets(options?.videoSimulcastLayers ?? defaultSimulcastLayers(isScreenShare, original));
    }
    let midPreset: VideoPreset | undefined;
    if (presets.length > 0) {
        const lowPreset = presets[0];
        if (presets.length > 1) {
            [, midPreset] = presets;
        }

        // 笔记：
        // 1. 这些编码的顺序很重要。 Chrome 似乎使用编码索引来决定在 CPU 受限时禁用哪一层。
        // 因此编码应该按照空间分辨率递增的顺序进行排序。
        // 2. ion-sfu 将 Rid 转换为层。 因此，所有编码都应该具有基础层“q”，然后根据其他条件添加更多内容。
        const size = Math.max(width, height);
        if (size >= 960 && midPreset) {
            return encodingsFromPresets(width, height, [lowPreset, midPreset, original]);
        }
        if (size >= 480) {
            return encodingsFromPresets(width, height, [lowPreset, original]);
        }
    }
    return encodingsFromPresets(width, height, [original]);
}

export function computeTrackBackupEncodings(
    track: LocalVideoTrack,
    videoCodec: BackupVideoCodec,
    opts: TrackPublishOptions,
) {
    // backupCodec should not be true anymore, default codec is set in LocalParticipant.publish
    if (
        !opts.backupCodec ||
        opts.backupCodec === true ||
        opts.backupCodec.codec === opts.videoCodec
    ) {
        // backup codec publishing is disabled
        return;
    }
    if (videoCodec !== opts.backupCodec.codec) {
        log.warn('requested a different codec than specified as backup', {
            serverRequested: videoCodec,
            backup: opts.backupCodec.codec,
        });
    }

    opts.videoCodec = videoCodec;
    // use backup encoding setting as videoEncoding for backup codec publishing
    opts.videoEncoding = opts.backupCodec.encoding;

    const settings = track.mediaStreamTrack.getSettings();
    const width = settings.width ?? track.dimensions?.width;
    const height = settings.height ?? track.dimensions?.height;

    const encodings = computeVideoEncodings(
        track.source === Track.Source.ScreenShare,
        width,
        height,
        opts,
    );
    return encodings;
}
/**
 * 确定适当的编码
 * @internal
 */
export function determineAppropriateEncoding(
    isScreenShare: boolean,
    width: number,
    height: number,
    codec?: VideoCodec,
): VideoEncoding {
    const presets = presetsForResolution(isScreenShare, width, height);
    let {encoding} = presets[0];

    // 通过交换尺寸来处理纵向
    const size = Math.max(width, height);

    for (let i = 0; i < presets.length; i += 1) {
        const preset = presets[i];
        encoding = preset.encoding;
        if (preset.width >= size) {
            break;
        }
    }
    // 预设基于 vp8 作为编解码器的假设
    // 对于其他编解码器，如果没有提供特定的 videoEncoding，我们会调整 maxBitrate
    // 用户应该使用针对其用例优化的内容来覆盖它们
    // 注意：SVC 编解码器比特率包含所有可扩展层。 尽管
    // 非 SVC 编解码器的比特率不包括其他联播层。
    if (codec) {
        switch (codec) {
            case "av1":
                encoding = {...encoding};
                encoding.maxBitrate = encoding.maxBitrate * 0.7;
                break;
            case "vp9":
                encoding = {...encoding};
                encoding.maxBitrate = encoding.maxBitrate * 0.85;
                break;
            default:
                break;
        }
    }

    return encoding;
}

/* @internal */
export function presetsForResolution(
    isScreenShare: boolean,
    width: number,
    height: number,
): VideoPreset[] {
    if (isScreenShare) {
        return presetsScreenShare;
    }
    const aspect = width > height ? width / height : height / width;
    if (Math.abs(aspect - 16.0 / 9) < Math.abs(aspect - 4.0 / 3)) {
        return presets169;
    }
    return presets43;
}

/**
 * 默认联播层
 *@internal
 */
export function defaultSimulcastLayers(
    isScreenShare: boolean,
    original: VideoPreset,
): VideoPreset[] {
    if (isScreenShare) {
        return computeDefaultScreenShareSimulcastPresets(original);
    }
    const {width, height} = original;
    const aspect = width > height ? width / height : height / width;
    if (Math.abs(aspect - 16.0 / 9) < Math.abs(aspect - 4.0 / 3)) {
        return defaultSimulcastPresets169;
    }
    return defaultSimulcastPresets43;
}

// 预设应按低、中、高排序
function encodingsFromPresets(
    width: number,
    height: number,
    presets: VideoPreset[],
): RTCRtpEncodingParameters[] {
    const encodings: RTCRtpEncodingParameters[] = [];
    presets.forEach((preset, idx) => {
        if (idx >= videoRids.length) {
            return;
        }
        const size = Math.min(width, height);
        const rid = videoRids[idx];
        const encoding: RTCRtpEncodingParameters = {
            rid,
            scaleResolutionDownBy: Math.max(1, size / Math.min(preset.width, preset.height)),
            maxBitrate: preset.encoding.maxBitrate,
        };
        const canSetPriority = isFireFox() || idx == 0;
        if (preset.encoding.priority && canSetPriority) {
            encoding.priority = preset.encoding.priority;
            encoding.networkPriority = preset.encoding.priority;
        }
        encodings.push(encoding);
    });

    // RN ios 联播需要所有相同的帧速率。
    if (isReactNative() && getReactNativeOs() === 'ios') {
        let topFramerate: number | undefined = undefined;
        encodings.forEach((encoding) => {
            if (!topFramerate) {
                topFramerate = encoding.maxFramerate;
            } else if (encoding.maxFramerate && encoding.maxFramerate > topFramerate) {
                topFramerate = encoding.maxFramerate;
            }
        });

        let notifyOnce = true;
        encodings.forEach((encoding) => {
            if (encoding.maxFramerate !== topFramerate) {
                if (notifyOnce) {
                    notifyOnce = false;
                    log.info(
                        `Simulcast on iOS React-Native requires all encodings to share the same framerate.`,
                    );
                }
            }
            log.info(`Setting framerate of encoding \"${encoding.rid ?? ''}\" to ${topFramerate}`);
            encoding.maxFramerate = topFramerate!;
        });
    }

    return encodings;
}

/** @internal */
export function sortPresets(presets: Array<VideoPreset> | undefined) {
    if (!presets) {
        return;
    }
    return presets.sort((a, b) => {
        const {encoding: aEnc} = a;
        const {encoding: bEnc} = b;

        if (aEnc.maxBitrate > bEnc.maxBitrate) {
            return 1;
        }
        if (aEnc.maxBitrate < bEnc.maxBitrate) {
            return -1;
        }
        if (aEnc.maxBitrate === bEnc.maxBitrate && aEnc.maxFramerate && bEnc.maxFramerate) {
            return aEnc.maxFramerate > bEnc.maxFramerate ? 1 : -1;
        }
        return 0;
    });
}


/** @internal */
export class ScalabilityMode {
    spatial: number;

    temporal: number;

    suffix: undefined | 'h' | '_KEY' | '_KEY_SHIFT';

    constructor(scalabilityMode: string) {
        const results = scalabilityMode.match(/^L(\d)T(\d)(h|_KEY|_KEY_SHIFT){0,1}$/);
        if (!results) {
            throw new Error('invalid scalability mode');
        }

        this.spatial = parseInt(results[1]);
        this.temporal = parseInt(results[2]);
        if (results.length > 3) {
            switch (results[3]) {
                case 'h':
                case '_KEY':
                case '_KEY_SHIFT':
                    this.suffix = results[3];
            }
        }
    }

    toString(): string {
        return `L${this.spatial}T${this.temporal}${this.suffix ?? ''}`;
    }
}