import TypedEventEmitter from "typed-emitter";
import {EventEmitter} from 'events';
import {Track} from "./Track";
import log, {getLogger, LoggerNames} from '../../logger';
import {UpdateSubscription, UpdateTrackSettings} from "../../protocol/tc_rtc_pb";
import {Encryption_Type, SubscriptionError, TrackInfo} from "../../protocol/tc_models_pb";
import {LoggerOptions} from "../types";
import {TrackEvent} from "../TrackEvents";
import {getLogContextFromTrack} from "./utils";
import LocalAudioTrack from "./LocalAudioTrack";
import RemoteAudioTrack from "./RemoteAudioTrack";
import LocalVideoTrack from "./LocalVideoTrack";
import RemoteVideoTrack from "./RemoteVideoTrack";
import RemoteTrack from "./RemoteTrack";

/**
 * 音轨发布
 */
export class TrackPublication extends (EventEmitter as new() => TypedEventEmitter<PublicationEventCallbacks>) {
    /**
     * 类型
     */
    kind: Track.Kind;
    /**
     * 音轨名称
     */
    trackName: string;
    /**
     * 音轨Sid
     */
    trackSid: Track.SID;
    /**
     * 音轨
     */
    track?: Track;
    /**
     * 音轨Source
     */
    source: Track.Source;
    /** 已发布曲目的 MimeType */
    mimeType?: string;
    /**
     * 原始发布流的尺寸，仅限视频
     */
    dimensions?: Track.Dimensions;
    /**
     * true 如果曲目被联播到服务器，仅视频
     */
    simulcasted?: boolean;
    /**
     * @internal
     * track信息
     */
    trackInfo?: TrackInfo;
    /**
     * 元数据静音
     */
    protected metadataMuted: boolean = false;
    /**
     * 加密类型
     */
    protected encryption: Encryption_Type = Encryption_Type.NONE;
    /**
     * log
     */
    protected log = log;
    /**
     * loggerContextCb
     */
    private loggerContextCb?: LoggerOptions['loggerContextCb'];

    constructor(kind: Track.Kind, id: string, name: string, loggerOptions?: LoggerOptions) {
        super();
        this.log = getLogger(loggerOptions?.loggerName ?? LoggerNames.Publication);
        this.setMaxListeners(100);
        this.kind = kind;
        this.trackSid = id;
        this.trackName = name;
        this.source = Track.Source.Unknown;
    }

    /** @internal */
    setTrack(track?: Track) {
        if (this.track) {
            this.track.off(TrackEvent.Muted, this.handleMuted);
            this.track.off(TrackEvent.Unmuted, this.handleUnmuted);
        }

        this.track = track;

        if (track) {
            // forward events
            track.on(TrackEvent.Muted, this.handleMuted);
            track.on(TrackEvent.Unmuted, this.handleUnmuted);
        }
    }

    /**
     * 获取logContext
     */
    protected get logContext() {
        return {
            ...this.loggerContextCb?.(),
            ...getLogContextFromTrack(this),
        };
    }

    /**
     * 是否静音
     */
    get isMuted(): boolean {
        return this.metadataMuted;
    }

    get isEnabled(): boolean {
        return true;
    }

    get isSubscribed(): boolean {
        return this.track !== undefined;
    }

    get isEncrypted(): boolean {
        return this.encryption !== Encryption_Type.NONE;
    }

    /**
     * 如果该出发布包含音轨，则为 [AudioTrack]
     */
    get audioTrack(): LocalAudioTrack | RemoteAudioTrack | undefined {
        if (this.track instanceof LocalAudioTrack || this.track instanceof RemoteAudioTrack) {
            return this.track;
        }
    }

    /**
     * 如果该发布包含视频轨道，则为 [VideoTrack]
     */
    get videoTrack(): LocalVideoTrack | RemoteVideoTrack | undefined {
        if (this.track instanceof LocalVideoTrack || this.track instanceof RemoteVideoTrack) {
            return this.track;
        }
    }

    /**
     * 处理静音
     */
    handleMuted = () => {
        this.emit(TrackEvent.Muted);
    };

    /**
     * 处理解除静音
     */
    handleUnmuted = () => {
        this.emit(TrackEvent.Unmuted);
    };

    /** @internal */
    updateInfo(info: TrackInfo) {
        this.trackSid = info.sid;
        this.trackName = info.name;
        this.source = Track.sourceFromProto(info.source);
        this.mimeType = info.mimeType;
        if (this.kind === Track.Kind.Video && info.width > 0) {
            this.dimensions = {
                width: info.width,
                height: info.height,
            };
            this.simulcasted = info.simulcast;
        }
        this.encryption = info.encryption;
        this.trackInfo = info;
        this.log.debug('update publication info', {...this.logContext, info});
    }
}

/**
 * 导出音轨发布命名空间
 */
export namespace TrackPublication {
    export enum SubscriptionStatus {
        Desired = 'desired',
        Subscribed = 'subscribed',
        Unsubscribed = 'unsubscribed',
    }

    export enum PermissionStatus {
        Allowed = 'allowed',
        NotAllowed = 'not_allowed',
    }
}

/**
 * 发布事件回调
 */
export type PublicationEventCallbacks = {
    /**
     * 静音
     */
    muted: () => void;
    /**
     * 取消静音
     */
    unmuted: () => void;
    /**
     * 结束
     * @param track 音轨
     */
    ended: (track?: Track) => void;
    /**
     * 更新音轨配置
     * @param settings 配置
     */
    updateSettings: (settings: UpdateTrackSettings) => void;
    /**
     * 订阅者权限更新
     * @param status 状态
     * @param prevStatus 上一个状态
     */
    subscriptionPermissionChanged: (
        status: TrackPublication.PermissionStatus,
        prevStatus: TrackPublication.PermissionStatus,
    ) => void;
    /**
     * 订阅者更新
     * @param sub 订阅者
     */
    updateSubscription: (sub: UpdateSubscription) => void;
    /**
     * 订阅
     * @param track 远程音轨
     */
    subscribed: (track: RemoteTrack) => void;
    /**
     * 取消订阅
     * @param track 远程音轨
     */
    unsubscribed: (track: RemoteTrack) => void;
    /**
     * 订阅者状态更新
     * @param status 更新为状态
     * @param prevStatus 前一状态
     */
    subscriptionStatusChanged: (
        status: TrackPublication.SubscriptionStatus,
        prevStatus: TrackPublication.SubscriptionStatus,
    ) => void;
    /**
     * 订阅失败
     * @param error 失败信息
     */
    subscriptionFailed: (error: SubscriptionError) => void;
};
