/**
 * 同时创建本地视频和音轨。
 * 当同时获取音频和视频轨道时，它将向用户显示单个权限提示，而不是两个单独的提示。
 * @param options
 */
import {
    AudioCaptureOptions,
    CreateLocalTracksOptions,
    ScreenShareCaptureOptions,
    ScreenSharePresets,
    VideoCaptureOptions
} from "./options";
import LocalTrack from "./LocalTrack";
import {constraintsForOptions, mergeDefaultOptions, screenCaptureToDisplayMediaStreamOptions} from "./utils";
import {audioDefaults, videoDefaults} from "../defaults";
import DeviceManager from "../DeviceManager";
import {Track} from "./Track";
import LocalVideoTrack from "./LocalVideoTrack";
import LocalAudioTrack from "./LocalAudioTrack";
import {isSafari17} from "../utils";
import {DeviceUnsupportedError, TrackInvalidError} from "../errors";
import {mediaTrackToLocalTrack} from "../participant/publishUtils";


/**
 * 创建本地音轨
 * @param options 创建音轨选项
 */
export async function createLocalTracks(
    options?: CreateLocalTracksOptions,
): Promise<Array<LocalTrack>> {
    // 设置默认选项为真
    options ??= {};
    options.audio ??= true;
    options.video ??= true;

    const opts = mergeDefaultOptions(options, audioDefaults, videoDefaults);
    const constraints = constraintsForOptions(opts);

    // 在 DeviceManager 上保留对 Promise 的引用并在 getLocalDevices() 中等待它
    // 解决 iOS Safari Bug https://bugs.webkit.org/show_bug.cgi?id=179363
    const mediaPromise = navigator.mediaDevices.getUserMedia(constraints);

    if (options.audio) {
        DeviceManager.userMediaPromiseMap.set('audioinput', mediaPromise);
        mediaPromise.catch(() => DeviceManager.userMediaPromiseMap.delete('audioinput'));
    }
    if (options.video) {
        DeviceManager.userMediaPromiseMap.set('videoinput', mediaPromise);
        mediaPromise.catch(() => DeviceManager.userMediaPromiseMap.delete('videoinput'));
    }

    const stream = await mediaPromise;
    return stream.getTracks().map((mediaStreamTrack) => {
        const isAudio = mediaStreamTrack.kind === 'audio';
        let trackOptions = isAudio ? options!.audio : options!.video;
        if (typeof trackOptions === 'boolean' || !trackOptions) {
            trackOptions = {};
        }
        let trackConstraints: MediaTrackConstraints | undefined;
        const conOrBool = isAudio ? constraints.audio : constraints.video;
        if (typeof conOrBool !== 'boolean') {
            trackConstraints = conOrBool;
        }

        // 使用用户在权限提示中授予权限的设备 ID 更新约束
        // 否则每次轨道重新启动（例如静音 - 取消静音）将尝试再次初始化设备 -> 导致额外的权限提示
        if (trackConstraints) {
            trackConstraints.deviceId = mediaStreamTrack.getSettings().deviceId;
        } else {
            trackConstraints = {deviceId: mediaStreamTrack.getSettings().deviceId};
        }

        const track = mediaTrackToLocalTrack(mediaStreamTrack, trackConstraints);
        if (track.kind === Track.Kind.Video) {
            track.source = Track.Source.Camera;
        } else if (track.kind === Track.Kind.Audio) {
            track.source = Track.Source.Microphone;
        }
        track.mediaStream = stream;
        return track;
    });
}

/**
 * 使用 getUserMedia() 创建一个 [[LocalVideoTrack]]
 * @param options
 */
export async function createLocalVideoTrack(
    options?: VideoCaptureOptions,
): Promise<LocalVideoTrack> {
    const tracks = await createLocalTracks({
        audio: false,
        video: options,
    });
    return <LocalVideoTrack>tracks[0];
}

export async function createLocalAudioTrack(
    options?: AudioCaptureOptions,
): Promise<LocalAudioTrack> {
    const tracks = await createLocalTracks({
        audio: options,
        video: false,
    });
    return <LocalAudioTrack>tracks[0];
}

/**
 * 使用 getDisplayMedia() 创建屏幕捕获轨迹。
 * 始终创建并返回 LocalVideoTrack。
 * 如果 { audio: true }，并且浏览器支持音频捕获，则还会创建 LocalAudioTrack。
 */
export async function createLocalScreenTracks(
    options?: ScreenShareCaptureOptions,
): Promise<Array<LocalTrack>> {
    if (options === undefined) {
        options = {};
    }
    if (options.resolution === undefined && !isSafari17()) {
        options.resolution = ScreenSharePresets.h1080fps30.resolution;
    }

    if (navigator.mediaDevices.getDisplayMedia === undefined) {
        throw new DeviceUnsupportedError('getDisplayMedia not supported');
    }

    const constraints = screenCaptureToDisplayMediaStreamOptions(options);
    const stream: MediaStream = await navigator.mediaDevices.getDisplayMedia(constraints);

    const tracks = stream.getVideoTracks();
    if (tracks.length === 0) {
        throw new TrackInvalidError('no video track found');
    }
    const screenVideo = new LocalVideoTrack(tracks[0], undefined, false);
    screenVideo.source = Track.Source.ScreenShare;
    const localTracks: Array<LocalTrack> = [screenVideo];
    if (stream.getAudioTracks().length > 0) {
        const screenAudio = new LocalAudioTrack(stream.getAudioTracks()[0], undefined, false);
        screenAudio.source = Track.Source.ScreenShareAudio;
        localTracks.push(screenAudio);
    }
    return localTracks;
}
