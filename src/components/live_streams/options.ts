/**
 * 网络音频设置
 */
import {AdaptiveStreamSettings} from "./room/track/types";
import {AudioCaptureOptions, AudioOutputOptions, TrackPublishDefaults, VideoCaptureOptions} from "./room/track/options";
import {ReconnectPolicy} from "./room/ReconnectPolicy";
import {E2EEOptions} from "./e2ee/types";

export interface WebAudioSettings {
    audioContext: AudioContext;
}

/**
 * 内部房间选项
 * @internal
 */
export interface InternalRoomOptions {

    /**
     * AdaptiveStream 让 TCApp 自动管理订阅视频轨道的质量，以优化带宽和 CPU。
     * 当附加的视频元素可见时，它将根据附加的最大视频元素的大小选择适当的分辨率。
     *
     * 当所有视频元素都不可见时，它将暂时暂停数据流，直到它们再次可见。
     */
    adaptiveStream: AdaptiveStreamSettings | boolean;

    /**
     * 启用 Dynacast，默认关闭。 Dynacast 可以动态暂停任何订阅者未使用的视频层，从而显着减少发布 CPU 和带宽的使用。
     *
     * 如果使用 SVC 编解码器 (VP9/AV1)，将启用 Dynacast。 多编解码器联播需要 dynacast
     */
    dynacast: boolean;

    /**
     * 捕获用户音频时使用的默认选项
     */
    audioCaptureDefaults?: AudioCaptureOptions;

    /**
     * 捕获用户视频时使用的默认选项
     */
    videoCaptureDefaults?: VideoCaptureOptions;

    /**
     * 发布曲目时使用的默认选项
     */
    publishDefaults?: TrackPublishDefaults;

    /**
     * 房间音频输出
     */
    audioOutput?: AudioOutputOptions;

    /**
     * 本地曲目在未发布时是否应该停止。 默认为 true
     * 如果您希望手动清理未发布的本地曲目，请将其设置为 false。
     */
    stopLocalTrackOnUnpublish: boolean;

    /**
     * 尝试重新连接时使用的策略
     */
    reconnectPolicy: ReconnectPolicy;

    /**
     * 指定 sdk 是否应在“pagehide”和“beforeunload”事件上自动断开房间连接
     */
    disconnectOnPageLeave: boolean;

    /**
     * @internal
     * 实验标志，在发送信令消息之前引入延迟
     */
    expSignalLatency?: number;

    /**
     * 混合网络音频中的所有音轨，有助于解决一些音频自动播放问题，也允许传入您自己的 AudioContext 实例
     */
    webAudioMix: boolean | WebAudioSettings;

    /**
     * @experimental
     */
    e2ee?: E2EEOptions;

    loggerName?: string;
}

/**
 * 创建新房间时的选项
 */
export interface RoomOptions extends Partial<InternalRoomOptions> {
}

/**
 * @internal
 */
export interface InternalRoomConnectOptions {
    /** 加入后自动订阅房间曲目，默认为 true */
    autoSubscribe: boolean;

    /** PeerConnection建立的时间，默认15s */
    peerConnectionTimeout: number;

    /**
     * 用于覆盖任何 RTCConfiguration 选项。
     */
    rtcConfig?: RTCConfiguration;

    /** 指定允许初始加入连接重试的频率（仅适用于服务器不可访问的情况）*/
    maxRetries: number;

    /** Websocket连接建立的时间，默认15s */
    websocketTimeout: number;
}

/**
 * Options for Room.connect()
 */
export interface RoomConnectOptions extends Partial<InternalRoomConnectOptions> {
}