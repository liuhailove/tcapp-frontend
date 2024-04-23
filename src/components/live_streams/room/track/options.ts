/**
 * 音轨发布默认选项
 */
import {Track} from "./Track";

export interface TrackPublishDefaults {
    /**
     * 摄像机轨迹的编码参数
     */
    videoEncoding?: VideoEncoding;

    /**
     * 多编解码器联播
     * 并非所有浏览器客户端都支持 VP9 和 AV1。 设置 backupCodec 后，
     * 当不兼容的客户端尝试订阅该曲目时，TcApp
     * 将自动发布使用备份编解码器编码的辅助轨道。
     *
     * 您可以通过以下方式自定义备份轨道的具体编码参数
     * 显式设置编解码器和编码字段。
     *
     * 默认为“true”
     */
    backupCodec?: true | false | { codec: BackupVideoCodec; encoding?: VideoEncoding };

    /**
     * 屏幕共享音轨的编码参数
     */
    screenShareEncoding?: VideoEncoding;

    /**
     * 编解码器，默认为vp8； 对于 svc 编解码器，自动启用 vp8 作为备份。 （待定）
     */
    videoCodec?: VideoCodec;

    /**
     * 应使用哪个音频预设来发布（音频）曲目，默认为 [[AudioPresets.music]]
     */
    audioPreset?: AudioPreset;

    /**
     * dtx（音频不连续传输），默认为单声道轨道启用。
     */
    dtx?: boolean;

    /**
     * red（冗余音频数据），默认情况下为单声道轨道启用。
     */
    red?: boolean;

    /**
     * 以立体声模式发布曲目（或设置为 false 以禁用）。 默认值由捕获通道数决定。
     */
    forceStereo?: boolean;

    /**
     * 使用联播，默认为true。
     * 使用联播时，TcApp 将以不同的分辨率发布最多三个版本的流。
     * 联播是一种通过同时传输多个不同质量或码率的版本来适应不同网络条件和设备能力的技术。
     * 它可以提供更好的观看体验，并确保媒体内容能够在各种环境下顺利播放。
     */
    simulcast?: boolean;

    /**
     * svc 编解码器的可扩展模式，默认为“L3T3”。 对于 svc 编解码器，联播已禁用。
     */
    scalabilityMode?: ScalabilityMode;

    /**
     * 除了原始轨道之外，最多还可以发布两个额外的联播层。
     * 留空时，默认为 h180、h360。
     * 如果使用 SVC 编解码器（VP9 或 AV1），则该字段无效。
     *
     * 要发布总共三个层，您需要指定：
     * {
     * videoEncoding: {...}, // 主层的编码
     * videoSimulcastLayers: [
     *    VideoPresets.h540,
     *    VideoPresets.h216,
     *],
     * }
     */
    videoSimulcastLayers?: Array<VideoPreset>;

    /**
     * 屏幕轨道的自定义视频联播层
     * 注意：图层需要按照质量从最低到最高的顺序排列
     */
    screenShareSimulcastLayers?: Array<VideoPreset>;

    /**
     * 对于本地轨道，当轨道在某些平台上静音（或暂停）时，停止底层 MediaStreamTrack，此选项对于禁用麦克风录音指示器是必要的。
     * 注意：启用此功能并连接 BT 设备后，它们将在配置文件之间转换（例如 HFP 到 A2DP），并且播放时会出现明显的差异。
     *
     * 默认为假
     */
    stopMicTrackOnMute?: boolean;
}

/**
 * 发布曲目时的选项
 */
export interface TrackPublishOptions extends TrackPublishDefaults {
    /**
     * 设置音轨名称
     */
    name?: string;

    /**
     * 音轨来源，camera, microphone, or screen
     */
    source?: Track.Source;

    /**
     * 设置曲目的流名称。 具有相同流名称的音频和视频轨道将被放置在同一个“MediaStream”中，并提供更好的同步。
     * 默认情况下，摄像头和麦克风会放置在一个流中； 就像 screen_share 和 screen_share_audio 一样
     */
    stream?: string;
}

/**
 * 创建本地音轨选项
 */
export interface CreateLocalTracksOptions {
    /**
     * 音轨选项，true 则使用默认值创建。 如果不应创建音频则为 false
     * 默认为真
     */
    audio?: boolean | AudioCaptureOptions;

    /**
     * 视频轨道选项，true 创建默认值。 如果不应创建视频，则为 false
     * 默认为真
     */
    video?: boolean | VideoCaptureOptions;
}

/**
 * 视频捕捉选项
 */
export interface VideoCaptureOptions {
    /**
     * 指定设备 ID 或设备数组的 ConstrainDOMString 对象
     * 可接受and/or必需的 ID。
     */
    deviceId?: ConstrainDOMString;
    /**
     * 可接受和/或要求的一个饰面或一组饰面。
     */
    facingMode?: 'user' | 'environment' | 'left' | 'right';

    /**
     * 视频分辨率
     */
    resolution?: VideoResolution;
}

/**
 * 屏幕共享捕获选项
 */
export interface ScreenShareCaptureOptions {
    /**
     * true 捕获共享音频。 浏览器对屏幕共享中音频捕获的支持有限：https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia#browser_compatibility
     */
    audio?: boolean | AudioCaptureOptions;
    /**
     * 只允许“true”，chrome 允许传入附加选项
     * https://developer.chrome.com/docs/web-platform/screen-sharing-controls/#displaySurface
     */
    video?: true | { displaySurface?: 'window' | 'browser' | 'monitor' };
    /**
     * 捕获分辨率，除 Safari 之外的所有浏览器默认为 1080
     * 在 Safari 17 上，由于错误，默认分辨率没有上限，指定
     * 任何分辨率都会导致低分辨率捕获。
     * https://bugs.webkit.org/show_bug.cgi?id=263015
     */
    resolution?: VideoResolution;

    /** 一个 CaptureController 对象实例，包含可用于进一步操作捕获会话（如果包含）的方法。 */
    controller?: unknown;

    /** 指定浏览器是否应允许用户选择当前选项卡进行捕获 */
    selfBrowserSurface?: 'include' | 'exclude';

    /** 指定浏览器是否应显示控件以允许用户在屏幕共享期间动态切换共享选项卡。 */
    surfaceSwitching?: 'include' | 'exclude';

    /** 指定浏览器是否应将系统音频包含在提供给用户的可能音频源中 */
    systemAudio?: 'include' | 'exclude';

    /** 指定内容类型，参见：https://www.w3.org/TR/mst-content-hint/#video-content-hints */
    contentHint?: 'detail' | 'text' | 'motion';

    /**
     * 实验性选项，用于控制选项卡中播放的音频是否继续从用户的播放列表中播放
     * 捕获标签时的本地扬声器。
     */
    suppressLocalAudioPlayback?: boolean;

    /**
     * 实验性选项指示浏览器将当前选项卡提供为最突出的捕获源
     * @experimental
     * @参见 https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia#prefercurrenttab
     */
    preferCurrentTab?: boolean;
}

/**
 * 音频捕获选项
 */
export interface AudioCaptureOptions {
    /**
     * 指定是否首选和/或需要自动增益控制
     */
    autoGainControl?:ConstrainBoolean;

    /**
     * 可接受和/或要求的通道数或通道数范围
     */
    channelCount?:ConstrainULong;

    /**
     * 指定设备 ID 或设备数组的 ConstrainDOMString 对象
     * 可接受和/或必需的 ID。
     */
    deviceId?:ConstrainDOMString;

    /**
     * 回声消除是否是首选和/或必需的
     */
    echoCancellation?:ConstrainBoolean;

    /**
     * 可接受和/或要求的延迟或延迟范围。
     */
    latency?:ConstrainDouble;

    /**
     * 是否首选和/或需要噪声抑制。
     */
    noiseSuppression?:ConstrainBoolean;

    /**
     * 可接受和/或要求的采样率或采样率范围。
     */
    sampleRate?:ConstrainULong;

    /**
     * 可接受和/或要求的样本量或样本量范围。
     */
    sampleSize?:ConstrainULong;
}

/**
 * 音频输出选项
 */
export interface AudioOutputOptions {
    /**
     * 输出音频的deviceId
     *
     * 仅在支持 `setSinkId` 的浏览器上受支持
     */
    deviceId?: string;
}

/**
 * 视频分辨率
 */
export interface VideoResolution {
    /**
     * 宽
     */
    width: number;
    /**
     * 高
     */
    height: number;
    /**
     * 帧率
     */
    frameRate?: number;
    /**
     * 纵横比
     */
    aspectRatio?: number;
}

/**
 * 视频编码
 */
export interface VideoEncoding {
    /**
     * 最大比特率
     */
    maxBitrate: number;
    /**
     * 最大帧率
     */
    maxFramerate?: number;
    /**
     * RTC优先级类型
     */
    priority?: RTCPriorityType;
}

/**
 * 视频预设选项
 */
export interface VideoPresetOptions {
    /**
     * 宽
     */
    width: number;
    /**
     * 高
     */
    height: number;
    /**
     * 纵横比
     */
    aspectRatio?: number;
    /**
     * 最大比特率
     */
    maxBitrate: number;
    /**
     * 最大帧率
     */
    maxFramerate?: number;
    /**
     * RTC优先级类型
     */
    priority?: RTCPriorityType;
}

/**
 * 视频预设
 */
export class VideoPreset {
    /**
     * 视频编码
     */
    encoding: VideoEncoding;
    /**
     * 宽
     */
    width: number;
    /**
     * 高
     */
    height: number;
    /**
     * 纵横比
     */
    aspectRatio?: number;

    constructor(videoPresetOptions: VideoPresetOptions);
    constructor(
        width: number,
        height: number,
        maxBitrate?: number,
        maxFramerate?: number,
        priority?: RTCPriorityType
    );
    constructor(
        widthOrOptions: number | VideoPresetOptions,
        height?: number,
        maxBitrate?: number,
        maxFramerate?: number,
        priority?: RTCPriorityType,
    ) {
        if (typeof widthOrOptions === 'object') {
            this.width = widthOrOptions.width;
            this.height = widthOrOptions.height;
            this.aspectRatio = widthOrOptions.aspectRatio;
            this.encoding = {
                maxBitrate: widthOrOptions.maxBitrate,
                maxFramerate: widthOrOptions.maxFramerate,
                priority: widthOrOptions.priority,
            };
        } else if (height !== undefined && maxBitrate !== undefined) {
            this.width = widthOrOptions;
            this.height = height;
            this.aspectRatio = widthOrOptions / height;
            this.encoding = {
                maxBitrate,
                maxFramerate,
                priority,
            };
        } else {
            throw new TypeError('Unsupported options: provide at least width, height and maxBitrate');
        }
    }

    /**
     * 获取视频分辨率
     */
    get resolution(): VideoResolution {
        return {
            width: this.width,
            height: this.height,
            frameRate: this.encoding.maxFramerate,
            aspectRatio: this.aspectRatio,
        };
    }
}

/**
 * 音频预设
 */
export interface AudioPreset {
    /**
     * 最大比特率
     */
    maxBitrate: number;
    /**
     * RTC优先级类型
     */
    priority?: RTCPriorityType;
}

/**
 * 备份编解码器
 */
const backupCodecs = ['vp8', 'h264'] as const;
/**
 * 视频编码器
 */
export const videoCodecs = ['vp8', 'h264', 'vp9', 'av1'] as const;
/**
 * 定义视频编码类型别名
 */
export type VideoCodec = (typeof videoCodecs)[number];
/**
 * 定义备份编码器类型别名
 */
export type BackupVideoCodec = (typeof backupCodecs)[number];

/**
 * 判断是否为备份编码器
 * @param codec 备份编码名称
 */
export function isBackupCodec(codec: string): codec is BackupVideoCodec {
    return !!backupCodecs.find((backup) => backup === codec);
}

/**
 * svc 的可扩展模式。
 */
export type ScalabilityMode = 'L1T3' | 'L2T3' | 'L2T3_KEY' | 'L3T3' | 'L3T3_KEY';

/**
 * 音频预设命名空间
 */
export namespace AudioPresets {
    export const telephone: AudioPreset = {
        maxBitrate: 12_000,
    };
    export const speech: AudioPreset = {
        maxBitrate: 20_000,
    };
    export const music: AudioPreset = {
        maxBitrate: 32_000,
    };
    export const musicStereo: AudioPreset = {
        maxBitrate: 48_000,
    };
    export const musicHighQuality: AudioPreset = {
        maxBitrate: 64_000,
    };
    export const musicHighQualityStereo: AudioPreset = {
        maxBitrate: 96_000,
    };
}

/**
 * 视频分辨率/编码的健全预设
 */
export const VideoPresets = {
    h90: new VideoPreset(160, 90, 90_000, 20),
    h180: new VideoPreset(320, 180, 160_000, 20),
    h216: new VideoPreset(384, 216, 180_000, 20),
    h360: new VideoPreset(640, 360, 450_000, 20),
    h540: new VideoPreset(960, 540, 800_000, 25),
    h720: new VideoPreset(1280, 720, 1_700_000, 30),
    h1080: new VideoPreset(1920, 1080, 3_000_000, 30),
    h1440: new VideoPreset(2560, 1440, 5_000_000, 30),
    h2160: new VideoPreset(3840, 2160, 8_000_000, 30),
} as const;

/**
 * 四乘三预设
 */
export const VideoPresets43 = {
    h120: new VideoPreset(160, 120, 70_000, 20),
    h180: new VideoPreset(240, 180, 125_000, 20),
    h240: new VideoPreset(320, 240, 140_000, 20),
    h360: new VideoPreset(480, 360, 330_000, 20),
    h480: new VideoPreset(640, 480, 500_000, 20),
    h540: new VideoPreset(720, 540, 600_000, 25),
    h720: new VideoPreset(960, 720, 1_300_000, 30),
    h1080: new VideoPreset(1440, 1080, 2_300_000, 30),
    h1440: new VideoPreset(1920, 1440, 3_800_000, 30),
} as const;

/**
 * 共享预设
 */
export const ScreenSharePresets = {
    h360fps3: new VideoPreset(640, 360, 200_000, 3, 'medium'),
    h360fps15: new VideoPreset(640, 360, 400_000, 15, 'medium'),
    h720fps5: new VideoPreset(1280, 720, 800_000, 5, 'medium'),
    h720fps15: new VideoPreset(1280, 720, 1_500_000, 15, 'medium'),
    h720fps30: new VideoPreset(1280, 720, 2_000_000, 30, 'medium'),
    h1080fps15: new VideoPreset(1920, 1080, 2_500_000, 15, 'medium'),
    h1080fps30: new VideoPreset(1920, 1080, 5_000_000, 30, 'medium'),
    // original resolution, without resizing
    original: new VideoPreset(0, 0, 7_000_000, 30, 'medium'),
} as const;