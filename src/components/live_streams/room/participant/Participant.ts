import {ConnectionQuality as ProtoQuality} from '../../protocol/tc_models_pb';
import {EventEmitter} from 'events';

import type TypedEmitter from 'typed-emitter';
import RemoteTrackPublication from "../track/RemoteTrackPublication";
import RemoteTrack from "../track/RemoteTrack";
import {DataPacket_Kind, ParticipantInfo, ParticipantPermission, SubscriptionError} from "../../protocol/tc_models_pb";
import {TrackPublication} from "../track/TrackPublication";
import {Track} from "../track/Track";
import LocalTrackPublication from "../track/LocalTrackPublication";
import log, {getLogger, LoggerNames, StructureLogger} from "../../logger";
import {LoggerOptions} from "../types";
import {ParticipantEvent, TrackEvent} from "../TrackEvents";
import RemoteAudioTrack from "../track/RemoteAudioTrack";
import LocalAudioTrack from "../track/LocalAudioTrack";

/**
 * 连接质量
 */
export enum ConnectionQuality {
    Excellent = 'excellent',
    Good = 'good',
    Poor = 'poor',
    /**
     * 表示参与者暂时（或永久）失去了与 TCApp 的连接。
     * 对于永久断开连接，超时后将发出“ParticipantDisconnected”事件
     */
    Lost = 'lost',
    Unknown = 'unknown',
}

function qualityFromProto(q: ProtoQuality): ConnectionQuality {
    switch (q) {
        case ProtoQuality.EXCELLENT:
            return ConnectionQuality.Excellent;
        case ProtoQuality.GOOD:
            return ConnectionQuality.Good;
        case ProtoQuality.POOR:
            return ConnectionQuality.Poor;
        // case ProtoQuality.LOST:
        //     return ConnectionQuality.Lost;
        default:
            return ConnectionQuality.Unknown;
    }
}

/**
 * 参与者
 */
export default class Participant extends (EventEmitter as new () => TypedEmitter<ParticipantEventCallbacks>) {

    /**
     * 参与者信息
     */
    protected participantInfo?: ParticipantInfo;

    /**
     * 音轨发布
     */
    audioTrackPublications: Map<string, TrackPublication>;

    /**
     * 视频轨道发布
     */
    videoTrackPublications: Map<string, TrackPublication>;

    /** track sid map => 所有已发布的轨道 */
    trackPublications: Map<string, TrackPublication>;

    /** 0-1.0之间的音频级别，1是最响亮，0是最柔和*/
    audioLevel: number = 0;

    /** 如果参与者当前正在发言 */
    isSpeaking: boolean = false;

    /** 服务器分配唯一的 id */
    sid: string;

    /** 客户端分配的身份，以 JWT 令牌编码 */
    identity: string;

    /** 客户端分配的显示名称，以 JWT 令牌编码 */
    name?: string;

    /** 客户端元数据，对 TCApp 不透明 */
    metadata?: string;

    /**
     * 最后发言时间
     */
    lastSpokeAt?: Date | undefined;

    /**
     * 参与者权限
     */
    permissions?: ParticipantPermission;

    /**
     * 连接质量
     */
    private _connectionQuality: ConnectionQuality = ConnectionQuality.Unknown;

    /**
     * 音频上下文
     */
    protected audioContext?: AudioContext;

    /**
     * 日志
     */
    protected log: StructureLogger = log;

    /**
     * 日志选项
     */
    protected loggerOptions?: LoggerOptions;

    /**
     * 日志上下文
     */
    protected get logContext() {
        return {
            ...this.loggerOptions?.loggerContextCb?.(),
        }
    }

    /**
     * 是否已加密
     */
    get isEncrypted() {
        return (
            this.trackPublications.size > 0 &&
            Array.from(this.trackPublications.values()).every((tr) => tr.isEncrypted)
        );
    }

    /**
     * 获取代理
     */
    get isAgent() {
        return this.permissions?.agent ?? false;
    }

    /** @internal */
    constructor(
        sid: string,
        identity: string,
        name?: string,
        metadata?: string,
        loggerOptions?: LoggerOptions,
    ) {
        super();

        this.log = getLogger(loggerOptions?.loggerName ?? LoggerNames.Participant);
        this.loggerOptions = loggerOptions;

        this.setMaxListeners(100);
        this.sid = sid;
        this.identity = identity;
        this.name = name;
        this.metadata = metadata;
        this.audioTrackPublications = new Map<string, TrackPublication>();
        this.videoTrackPublications = new Map<string, TrackPublication>();
        this.trackPublications = new Map<string, TrackPublication>();
    }

    /**
     * 获得发布的音轨
     */
    getTrackPublications(): TrackPublication[] {
        return Array.from(this.trackPublications.values());
    }

    /**
     * 查找与源过滤器匹配的第一首曲目，例如获取
     * 使用 getTrackBySource(Track.Source.Camera) 获取用户的相机轨迹。
     */
    getTrackPublication(source: Track.Source): TrackPublication | undefined {
        for (const [, pub] of this.trackPublications) {
            if (pub.source === source) {
                return pub;
            }
        }
    }

    /**
     * 查找与曲目名称匹配的第一首曲目。
     */
    getTrackPublicationByName(name: string): TrackPublication | undefined {
        for (const [, pub] of this.trackPublications) {
            if (pub.trackName === name) {
                return pub;
            }
        }
    }

    /**
     * 获取连接质量
     */
    get connectionQuality(): ConnectionQuality {
        return this._connectionQuality;
    }

    /**
     *  获取摄像头是否可用
     */
    get isCameraEnabled(): boolean {
        const track = this.getTrackPublication(Track.Source.Camera);
        return !(track?.isMuted ?? true);
    }

    /**
     * 获取麦克风是否可用
     */
    get isMicrophoneEnabled(): boolean {
        const track = this.getTrackPublication(Track.Source.Microphone);
        return !(track?.isMuted ?? true);
    }

    get isScreenShareEnabled(): boolean {
        const track = this.getTrackPublication(Track.Source.ScreenShare);
        return !!track;
    }

    get isLocal(): boolean {
        return false;
    }

    /**
     * 参与者加入房间的时间
     */
    get joinedAt(): Date | undefined {
        if (this.participantInfo) {
            return new Date(Number.parseInt(this.participantInfo.joinedAt.toString()) * 1000);
        }
        return new Date();
    }

    /** @internal */
    updateInfo(info: ParticipantInfo): boolean {
        // 由于重新连接序列期间的等待，更新可能会乱序应用。
        // 当发生这种情况时，服务器可能会在 JS 等待处理现有有效负载时发送更新版本的参与者信息。
        // 当参与者 sid 保持不变，并且我们已经有了更高版本的有效负载时，可以安全地跳过它们
        if (
            this.participantInfo &&
            this.participantInfo.sid === info.sid &&
            this.participantInfo.version > info.version
        ) {
            return false;
        }
        this.identity = info.identity;
        this.sid = info.sid;
        this._setName(info.name);
        this._setMetadata(info.metadata);
        if (info.permission) {
            this.setPermissions(info.permission);
        }
        // 将其设置为最后，以便 setMetadata 可以检测到更改
        this.participantInfo = info;
        this.log.trace('update participant info', {...this.logContext, info});
        return true;
    }

    /**
     * 从服务器更新元数据
     **/
    private _setMetadata(md: string) {
        const changed = this.metadata !== md;
        const prevMetadata = this.metadata;
        this.metadata = md;

        if (changed) {
            this.emit(ParticipantEvent.ParticipantMetadataChanged, prevMetadata);
        }
    }

    private _setName(name: string) {
        const changed = this.name !== name;
        this.name = name;

        if (changed) {
            this.emit(ParticipantEvent.ParticipantNameChanged, name);
        }
    }

    /** @internal */
    setPermissions(permissions: ParticipantPermission): boolean {
        const prevPermissions = this.permissions;
        const changed =
            permissions.canPublish !== this.permissions?.canPublish ||
            permissions.canSubscribe !== this.permissions?.canSubscribe ||
            permissions.canPublishData !== this.permissions?.canPublishData ||
            permissions.hidden !== this.permissions?.hidden ||
            permissions.recorder !== this.permissions?.recorder ||
            permissions.canPublishSources.length !== this.permissions.canPublishSources.length ||
            permissions.canPublishSources.some(
                (value, index) => value !== this.permissions?.canPublishSources[index],
            );
        this.permissions = permissions;

        if (changed) {
            if (prevPermissions instanceof ParticipantPermission) {
                this.emit(ParticipantEvent.ParticipantPermissionsChanged, prevPermissions);
            }
        }
        return changed;
    }

    /** @internal */
    setIsSpeaking(speaking: boolean) {
        if (speaking === this.isSpeaking) {
            return;
        }
        this.isSpeaking = speaking;
        if (speaking) {
            this.lastSpokeAt = new Date();
        }
        this.emit(ParticipantEvent.IsSpeakingChanged, speaking);
    }

    /** @internal */
    setConnectionQuality(q: ProtoQuality) {
        const prevQuality = this._connectionQuality;
        this._connectionQuality = qualityFromProto(q);
        if (prevQuality != this._connectionQuality) {
            this.emit(ParticipantEvent.ConnectionQualityChanged, this._connectionQuality);
        }
    }

    /**
     * @internal
     */
    setAudioContext(ctx: AudioContext | undefined) {
        this.audioContext = ctx;
        this.audioTrackPublications.forEach(
            (track) => {
                (track.track instanceof RemoteAudioTrack || track.track instanceof LocalAudioTrack) &&
                track.track.setAudioContext(ctx);
            }
        );
    }

    // 增加发布的音轨
    protected addTrackPublication(publication: TrackPublication) {
        // 转发发布驱动事件
        publication.on(TrackEvent.Muted, () => {
            this.emit(ParticipantEvent.TrackMuted, publication);
        });

        publication.on(TrackEvent.Unmuted, () => {
            this.emit(ParticipantEvent.TrackUnmuted, publication);
        });

        const pub = publication;
        if (pub.track) {
            pub.track.sid = publication.trackSid;
        }
        switch (publication.kind) {
            case Track.Kind.Audio:
                this.audioTrackPublications.set(publication.trackSid, publication);
                break;
            case Track.Kind.Video:
                this.videoTrackPublications.set(publication.trackSid, publication);
                break;
            default:
                break;
        }
    }
}

/**
 * 参与者事件回调
 */
export type ParticipantEventCallbacks = {
    /**
     * 音轨发布
     * @param publication 发布的音轨
     */
    trackPublished: (publication: RemoteTrackPublication) => void;

    /**
     * 音轨定缺
     * @param track 音轨
     * @param publication 远程音轨发布
     */
    trackSubscribed: (track: RemoteTrack, publication: RemoteTrackPublication) => void;

    /**
     * 音轨订阅失败
     * @param trackSid 音轨Sid
     * @param reason 失败原因
     */
    trackSubscriptionFailed: (trackSid: string, reason?: SubscriptionError) => void;
    /**
     * 音轨解除发布
     * @param publication 远程发布
     */
    trackUnpublished: (publication: RemoteTrackPublication) => void;

    /**
     * 音轨解除订阅
     * @param track
     * @param publication
     */
    trackUnsubscribed: (track: RemoteTrack, publication: RemoteTrackPublication) => void;

    /**
     * 音轨静音
     * @param publication
     */
    trackMuted: (publication: TrackPublication) => void;

    /**
     * 音轨解除静音
     * @param publication
     */
    trackUnmuted: (publication: TrackPublication) => void;

    /**
     * 本地音轨发布
     * @param publication
     */
    localTrackPublished: (publication: LocalTrackPublication) => void;

    /**
     * 本地音轨解除发布
     * @param publication
     */
    localTrackUnpublished: (publication: LocalTrackPublication) => void;

    /**
     * 参与者原数据变更
     * @param prevMetadata 之前的原数据
     * @param participant 参与者
     */
    participantMetadataChanged: (prevMetadata: string | undefined, participant?: any) => void;

    /**
     * 参与者名称变更
     * @param name 新的名称
     */
    participantNameChanged: (name: string) => void;

    /**
     * 接收数据
     * @param payload 负载
     * @param kind 数据包类型
     */
    dataReceived: (payload: Uint8Array, kind: DataPacket_Kind) => void;

    /**
     * 正在说话已更改
     * @param speaking
     */
    isSpeakingChanged: (speaking: boolean) => void;

    /**
     * 连接质量发声变化
     * @param connectionQuality 连接质量
     */
    connectionQualityChanged: (connectionQuality: ConnectionQuality) => void;

    /**
     * 音轨流状态变更
     * @param publication
     * @param streamState
     */
    trackStreamStateChanged: (
        publication: RemoteTrackPublication,
        streamState: Track.StreamState,
    ) => void;

    /**
     * 音轨订阅权限变更
     * @param publication
     * @param status
     */
    trackSubscriptionPermissionChanged: (
        publication: RemoteTrackPublication,
        status: TrackPublication.PermissionStatus,
    ) => void;

    /**
     * 媒体设置错误
     * @param error 错误信息
     */
    mediaDevicesError: (error: Error) => void;

    /**
     * 获取音频流
     */
    audioStreamAcquired: () => void;

    /**
     * 参与者权限变更
     * @param prevPermissions 变更前参与者
     */
    participantPermissionsChanged: (prevPermissions?: ParticipantPermission) => void;

    /**
     * 音轨订阅状态已变更
     * @param publication
     * @param status
     */
    trackSubscriptionStatusChanged: (
        publication: RemoteTrackPublication,
        status: TrackPublication.SubscriptionStatus,
    ) => void;
};