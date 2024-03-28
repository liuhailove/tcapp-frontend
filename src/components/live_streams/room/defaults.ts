import {
    AudioCaptureOptions,
    AudioPresets,
    ScreenSharePresets,
    TrackPublishDefaults,
    VideoCaptureOptions, VideoPresets
} from "./track/options";

/**
 * 默认video编码
 */
export const defaultVideoCodec = 'vp8';

/**
 * 音轨默认发布选项
 */
export const publishDefaults: TrackPublishDefaults = {
    audioPreset: AudioPresets.music,
    dtx: true,
    red: true,
    forceStereo: false,
    simulcast: true,
    screenShareEncoding: ScreenSharePresets.h1080fps15.encoding,
    stopMicTrackOnMute: false,
    videoCodec: defaultVideoCodec,
    backupCodec: true,
} as const;

/**
 * 音频默认选项
 */
export const audioDefaults: AudioCaptureOptions = {
    autoGainControl: true,
    echoCancellation: true,
    noiseSuppression: true,
};

/**
 * 视频默认选项
 */
export const videoDefaults: VideoCaptureOptions = {
    resolution: VideoPresets.h720.resolution,
};

/**
 * 房间默认选项
 */
export const roomOptionDefaults: InternalRoomOptions = {
    adaptiveStream: false,
    dynacast: false,
    stopLocalTrackOnUnpublish: true,
    reconnectPolicy: new DefaultReconnectPolicy(),
    disconnectOnPageLeave: true,
    webAudioMix: true,
} as const;

/**
 *  房间连接的默认选项
 */
export const roomConnectOptionDefaults: InternalRoomConnectOptions = {
    autoSubscribe: true,
    maxRetries: 1,
    peerConnectionTimeout: 15_000,
    websocketTimeout: 15_000,
} as const;