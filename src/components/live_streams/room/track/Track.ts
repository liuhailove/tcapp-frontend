import {
    VideoQuality as ProtoQuality, StreamState as ProtoStreamState,
} from '../../protocol';
import {EventEmitter} from 'events';
import {TrackSource, TrackType} from "../../protocol/tc_models_pb";
import TypedEventEmitter from "typed-emitter";
import {LoggerOptions} from "../types";
import {TrackEvent} from '../TrackEvents';
import log, {getLogger, LoggerNames, StructureLogger} from "../../logger";
import {isFireFox, isSafari, isWeb} from "../utils";
import {TrackProcessor} from "./processor/types";
import {getLogContextFromTrack} from "./utils";
import {SignalClient} from "../../api/SignalClient";
// 背景相应延迟
const BACKGROUND_REACTION_DELAY = 5000;

// 分离时保留旧的音频元素，因为在 iOS 上我们会重新使用它们
// Safari 跟踪哪些音频元素已被用户“祝福”。
const recycledElements: Array<HTMLAudioElement> = [];

/**
 * 视频质量
 */
export enum VideoQuality {
    LOW = ProtoQuality.LOW,
    MEDIUM = ProtoQuality.MEDIUM,
    HIGH = ProtoQuality.HIGH,
}

/**
 * 抽象Track
 */
export abstract class Track<TrackKind extends Track.Kind = Track.Kind> extends (EventEmitter as new () => TypedEventEmitter<TrackEventCallbacks>) {
    /**
     * 音轨类型
     */
    readonly kind: TrackKind;

    /**
     * 附加到上面的媒体元素
     */
    attachedElements: HTMLMediaElement[] = [];

    /**
     * 是否静音
     */
    isMuted: boolean = false;

    /**
     * 媒体源
     */
    source: Track.Source;

    /**
     * sid 在轨道发布到服务器后设置，或者如果它是远程轨道
     */
    sid?: Track.SID;

    /**
     * 媒体流
     * @internal
     */
    mediaStream?: MediaStream;

    /**
     * 指示流的当前状态，如果轨道已被拥塞控制器暂停，它将指示“已暂停”
     */
    streamState: Track.StreamState = Track.StreamState.Active;

    /**
     * 媒体流轨道
     */
    protected _mediaStreamTrack: MediaStreamTrack;

    /**
     * 媒体流ID
     */
    protected _mediaStreamID: string;

    /**
     * 是否在后台
     */
    protected isInBackground: boolean = false;

    /**
     *  后台超时时间
     */
    private backgroundTimeout: ReturnType<typeof setTimeout> | undefined;

    private loggerContextCb: LoggerOptions['loggerContextCb'];

    /**
     *  当前比特率
     */
    protected _currentBitrate: number = 0;

    /**
     * 监控间隔
     */
    protected monitorInterval?: ReturnType<typeof setInterval>;

    /**
     * 日志
     */
    protected log: StructureLogger = log;

    protected constructor(
        mediaTrack: MediaStreamTrack,
        kind: TrackKind,
        loggerOptions: LoggerOptions = {},
    ) {
        super();
        this.log = getLogger(loggerOptions.loggerName ?? LoggerNames.Track);
        this.loggerContextCb = loggerOptions.loggerContextCb;

        this.setMaxListeners(100);
        this.kind = kind;
        this._mediaStreamTrack = mediaTrack;
        this._mediaStreamID = mediaTrack.id;
        this.source = Track.Source.Unknown;
    }

    /**
     * 获取loggerContext
     */
    protected get logContext() {
        return {
            ...this.loggerContextCb?.(),
            ...getLogContextFromTrack(this),
        };
    }

    /**
     * 当前每秒收到的比特率
     */
    get currentBitrate(): number {
        return this._currentBitrate;
    }

    get mediaStreamTrack() {
        return this._mediaStreamTrack;
    }

    /**
     * @internal
     * 用于保留mediaStream的第一个id，因为如果我们禁用/启用轨道,
     * 它的id可能会改变
     */
    get mediaStreamID(): string {
        return this._mediaStreamID;
    }

    /**
     * 创建一个新的 HTMLAudioElement 或 HTMLVideoElement，附加到它并返回它
     */
    attach(): HTMLMediaElement;

    /**
     * 将轨道附加到现有的 HTMLAudioElement 或 HTMLVideoElement
     */
    attach(element: HTMLMediaElement): HTMLMediaElement;

    attach(element?: HTMLMediaElement): HTMLMediaElement {
        let elementType = 'audio';
        if (this.kind === Track.Kind.Video) {
            elementType = 'video';
        }
        if (this.attachedElements.length == 0 && Track.Kind.Video) {
            this.addAppVisibilityListener();
        }
        if (!element) {
            if (elementType === 'audio') {
                recycledElements.forEach((e) => {
                    if (e.parentElement === null && !element) {
                        element = e;
                    }
                });
                if (element) {
                    // 将其从池中移除
                    recycledElements.splice(recycledElements.indexOf(element), 1);
                }
            }
            if (!element) {
                element = <HTMLMediaElement>document.createElement(elementType);
            }
        }

        if (!this.attachedElements.includes(element)) {
            this.attachedElements.push(element);
        }

        // 即使我们相信它已经附加到元素上，
        // 元素的 srcObject 也可能被设置为带外的其他内容。
        // 在这种情况下我们需要重新附加它
        attachToElement(this.mediaStreamTrack, element);

        // 处理自动播放失败
        const allMediaStreamTracks = (element.srcObject as MediaStream).getTracks();
        const hasAudio = allMediaStreamTracks.some((tr) => tr.kind === 'audio');

        // 手动播放媒体以检测自动播放状态
        element
            .play()
            .then(() => {
                this.emit(hasAudio ? TrackEvent.AudioPlaybackStarted : TrackEvent.VideoPlaybackStarted);
            })
            .catch((e) => {
                if (e.name === 'NotAllowedError') {
                    this.emit(hasAudio ? TrackEvent.AudioPlaybackFailed : TrackEvent.VideoPlaybackFailed, e);
                } else if (e.name === 'AbortError') {
                    // 通常由另一个“play”请求触发，仅出于调试目的记录
                    log.debug(
                        `${hasAudio ? 'audio' : 'video'} playback aborted, likely due to new play request`,
                    );
                } else {
                    log.warn(`could not playback ${hasAudio ? 'audio' : 'video'}`, e);
                }
                // 如果不允许音频播放，请确保我们仍然播放视频
                if (
                    hasAudio &&
                    element &&
                    allMediaStreamTracks.some((tr) => tr.kind === 'video') &&
                    e.name === 'NotAllowedError'
                ) {
                    element.muted = true;
                    element.play().catch(() => {
                        // catch Safari，此时超出了自动播放媒体元素的选项
                    });
                }
            });

        this.emit(TrackEvent.ElementAttached, element);
        return element;
    }

    /**
     * 与所有附加元素分离
     */
    detach(): HTMLMediaElement[];

    /**
     * 从一单个元素分离
     */
    detach(element: HTMLMediaElement): HTMLMediaElement;
    detach(element?: HTMLMediaElement): HTMLMediaElement | HTMLMediaElement[] {
        try {
            // 从单个元素分离
            if (element) {
                detachTrack(this.mediaStreamTrack, element);
                const idx = this.attachedElements.indexOf(element);
                if (idx >= 0) {
                    this.attachedElements.splice(idx, 1);
                    this.recycleElement(element);
                    this.emit(TrackEvent.ElementDetached, element);
                }
                return element;
            }

            const detached: HTMLMediaElement[] = [];
            this.attachedElements.forEach((elm) => {
                detachTrack(this.mediaStreamTrack, elm);
                detached.push(elm);
                this.recycleElement(elm);
                this.emit(TrackEvent.ElementDetached, elm);
            });

            // 移除全部音轨
            this.attachedElements = [];
            return detached;
        } finally {
            if (this.attachedElements.length == 0) {
                this.removeAppVisibilityListener();
            }
        }
    }

    stop() {
        this.stopMonitor();
        this._mediaStreamTrack.stop();
    }

    protected enable() {
        this._mediaStreamTrack.enabled = true;
    }

    protected disable() {
        this._mediaStreamTrack.enabled = false;
    }

    /* @internal */
    abstract startMonitor(signalClient?: SignalClient): void;

    /* @internal */
    stopMonitor() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
        }
    }

    /** @internal */
    updateLoggerOptions(loggerOptions: LoggerOptions) {
        if (loggerOptions.loggerName) {
            this.log = getLogger(loggerOptions.loggerName);
        }
        if (loggerOptions.loggerContextCb) {
            this.loggerContextCb = loggerOptions.loggerContextCb;
        }
    }

    /**
     * 循环利用元素
     * @param element media元素
     */
    private recycleElement(element: HTMLMediaElement) {
        if (element instanceof HTMLAudioElement) {
            // 重用单个元素
            let shouldCache = true;
            element.pause();
            recycledElements.forEach((e) => {
                if (!e.parentElement) {
                    shouldCache = false;
                }
            });
            if (shouldCache) {
                recycledElements.push(element);
            }
        }
    }

    /**
     * 可见性监听
     */
    protected appVisibilityChangedListener = () => {
        if (this.backgroundTimeout) {
            clearTimeout(this.backgroundTimeout);
        }
        // 如果应用程序隐藏，则延迟应用程序可见性更新
        // 如果焦点回到焦点则立即更新
        if (document.visibilityState === 'hidden') {
            this.backgroundTimeout = setTimeout(
                () => this.handleAppVisibilityChanged(),
                BACKGROUND_REACTION_DELAY,
            );
        } else {
            this.handleAppVisibilityChanged();
        }
    };

    /**
     * 异步处理可见行变更
     */
    protected async handleAppVisibilityChanged() {
        this.isInBackground = document.visibilityState === 'hidden';
    }

    /**
     * 增加app可见性监听
     */
    protected addAppVisibilityListener() {
        if (isWeb()) {
            this.isInBackground = document.visibilityState === 'hidden';
            document.addEventListener('visibilitychange', this.appVisibilityChangedListener);
        } else {
            this.isInBackground = false;
        }
    }

    /**
     * 移除App可见性监听
     */
    protected removeAppVisibilityListener() {
        if (isWeb()) {
            document.removeEventListener('visibilitychange', this.appVisibilityChangedListener);
        }
    }
}

/**
 * 媒体音轨附加到元素
 * @param track 媒体音轨
 * @param element 媒体元素
 */
export function attachToElement(track: MediaStreamTrack, element: HTMLMediaElement) {
    let mediaStream: MediaStream;
    if (element.srcObject instanceof MediaStream) {
        mediaStream = element.srcObject;
    } else {
        mediaStream = new MediaStream();
    }

    // 检查音轨是否与现有音轨匹配
    let existingTracks: MediaStreamTrack[];
    if (track.kind === 'audio') {
        existingTracks = mediaStream.getAudioTracks();
    } else {
        existingTracks = mediaStream.getVideoTracks();
    }
    if (!existingTracks.includes(track)) {
        existingTracks.forEach((et) => {
            mediaStream.removeTrack(et);
        });
        mediaStream.addTrack(track);
    }

    if (!isSafari() || !(element instanceof HTMLVideoElement)) {
        // 在低功耗模式下（适用于 macOS 和 iOS），当设置了“自动播放”属性的视频启动时，Safari 将显示播放/暂停叠加层。
        // 我们通过_不_在 safari 上设置 autoplay 属性来解决这个问题，而是进一步调用 `setTimeout(() => el.play(),0)`
        element.autoplay = true;
    }

    // 如果媒体流上没有音轨，我们将元素设置为静音以确保自动播放正常工作
    element.muted = mediaStream.getAudioTracks().length == 0;
    if (element instanceof HTMLVideoElement) {
        element.playsInline = true;
    }

    // 避免闪烁
    if (element.srcObject !== mediaStream) {
        element.srcObject = mediaStream;
        if ((isSafari() || isFireFox()) && element instanceof HTMLVideoElement) {
            // Firefox 还有一个计时问题，除非在带外执行，否则视频实际上不会附加
            // Safari 15 有一个错误，在某些布局中，视频元素会呈现
            // 黑色，直到调整页面大小或发生其他更改。
            // 重置 src 会触发它进行渲染。
            // https://developer.apple.com/forums/thread/690523
            setTimeout(() => {
                element.srcObject = mediaStream;
                // Safari 15 有时无法启动视频
                // 当窗口在绘制第一帧之前处于背景状态时
                // 在这里手动调用 play 似乎可以解决这个问题
                element.play().catch(() => {
                    /** do nothing */
                });
            }, 0)
        }
    }
}

/**
 * @internal
 * track 分离
 */
export function detachTrack(track: MediaStreamTrack, element: HTMLMediaElement) {
    if (element.srcObject instanceof MediaStream) {
        const mediaStream = element.srcObject;
        mediaStream.removeTrack(track);
        if (mediaStream.getTracks().length > 0) {
            element.srcObject = mediaStream;
        } else {
            element.srcObject = null;
        }
    }
}

/**
 * 定义Track命名空间
 */
export namespace Track {
    /**
     * 类型
     */
    export enum Kind {
        Audio = 'audio',
        Video = 'video',
        Unknown = 'unknown',
    }

    export type SID = string;

    /**
     * track源
     */
    export enum Source {
        Camera = 'camera',
        Microphone = 'microphone',
        ScreenShare = 'screen_share',
        ScreenShareAudio = 'screen_share_audio',
        Unknown = 'unknown',
    }

    /**
     * 流状态
     */
    export enum StreamState {
        Active = 'active',
        Paused = 'paused',
        Unknown = 'unknown',
    }

    /**
     * 尺寸
     */
    export interface Dimensions {
        width: number;
        height: number;
    }

    /** @internal */
    export function kindToProto(k: Kind): TrackType {
        switch (k) {
            case Kind.Audio:
                return TrackType.AUDIO;
            case Kind.Video:
                return TrackType.VIDEO;
            default:
                return TrackType.DATA;
        }
    }

    /** @internal */
    export function kindFromProto(t: TrackType): Kind | undefined {
        switch (t) {
            case TrackType.AUDIO:
                return Kind.Audio;
            case TrackType.VIDEO:
                return Kind.Video;
            default:
                return Kind.Unknown;
        }
    }

    /** @internal */
    export function sourceToProto(s: Source): TrackSource {
        switch (s) {
            case Source.Camera:
                return TrackSource.CAMERA;
            case Source.Microphone:
                return TrackSource.MICROPHONE;
            case Source.ScreenShare:
                return TrackSource.SCREEN_SHARE;
            case Source.ScreenShareAudio:
                return TrackSource.SCREEN_SHARE_AUDIO;
            default:
                return TrackSource.UNKNOWN;
        }
    }

    /** @internal */
    export function sourceFromProto(s: TrackSource): Source {
        switch (s) {
            case TrackSource.CAMERA:
                return Source.Camera;
            case TrackSource.MICROPHONE:
                return Source.Microphone;
            case TrackSource.SCREEN_SHARE:
                return Source.ScreenShare;
            case TrackSource.SCREEN_SHARE_AUDIO:
                return Source.ScreenShareAudio;
            default:
                return Source.Unknown;
        }
    }

    /** @internal */
    export function streamStateFromProto(s: ProtoStreamState): StreamState {
        switch (s) {
            case ProtoStreamState.ACTIVE:
                return StreamState.Active;
            case ProtoStreamState.PAUSED:
                return StreamState.Paused;
            default:
                return StreamState.Unknown;
        }
    }
}

/**
 * Track事件回调
 */
export type TrackEventCallbacks = {
    message: () => void;
    muted: (track?: any) => void;
    unmuted: (track?: any) => void;
    restarted: (track?: any) => void;
    ended: (track?: any) => void;
    updateSettings: () => void;
    updateSubscription: () => void;
    audioPlaybackStarted: () => void;
    audioPlaybackFailed: (error?: Error) => void;
    audioSilenceDetected: () => void;
    visibilityChanged: (visible: boolean, track?: any) => void;
    videoDimensionsChanged: (dimensions: Track.Dimensions, track?: any) => void;
    videoPlaybackStarted: () => void;
    videoPlaybackFailed: (error?: Error) => void;
    elementAttached: (element: HTMLMediaElement) => void;
    elementDetached: (element: HTMLMediaElement) => void;
    upstreamPaused: (track: any) => void;
    upstreamResumed: (track: any) => void;
    trackProcessorUpdate: (processor?: TrackProcessor<Track.Kind, any>) => void;
};