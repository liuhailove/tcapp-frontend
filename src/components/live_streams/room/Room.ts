/**
 * 连接状态
 */
import TypedEventEmitter from "typed-emitter";
import {
    ConnectionQuality,
    DataPacket_Kind,
    DisconnectReason,
    ParticipantPermission,
    SubscriptionError
} from "../protocol/tc_models_pb";
import RemoteTrack from "./track/RemoteTrack";
import {TrackPublication} from "./track/TrackPublication";
import {Track} from "./track/Track";
import RemoteTrackPublication from "./track/RemoteTrackPublication";

export enum ConnectionState {
    Disconnected = 'disconnected',
    Connecting = 'connecting',
    Connected = 'connected',
    Reconnecting = 'reconnecting',
}

/**
 * 连接协调频率
 */
const connectionReconcileFrequency = 2 * 1000;

/**
 * 在 TCApp 中，房间是参与者列表的逻辑分组。
 * 房间中的参与者可以发布曲目，并订阅其他人的曲目。
 *
 * 一个房间触发 [[RoomEvent | 房间活动]]。
 *
 * @noInheritDoc
 */
class Room extends (EventEmitter as new() => TypedEventEmitter<RoomEventCallbacks>) {

}


export default Room;

/**
 * room事件回调
 */
export type RoomEventCallbacks = {
    /**
     * 已连接事件
     */
    connected: () => void;
    /**
     * 重新连接中
     */
    reconnecting: () => void;
    /**
     * 重新连接成功
     */
    reconnected: () => void;
    /**
     * 断开连接
     * @param reason 断开原因
     */
    disconnected: (reason?: DisconnectReason) => void;
    /**
     * 连接状态变更
     * @param state 新的连接状态
     */
    connectionStateChanged: (state: ConnectionState) => void;
    /**
     * 媒体设备变更
     */
    mediaDevicesChanged: () => void;
    /**
     * 远程参与者连接
     * @param participant 参与者
     */
    participantConnected: (participant: RemoteParticipant) => void;
    /**
     * 参与者断开连接
     * @param participant 参与者
     */
    participantDisconnected: (participant: RemoteParticipant) => void;
    /**
     * 远程参与者发布音轨
     * @param publication 远程发布
     * @param participant 参与者
     */
    trackPublished: (publication: RemoteTrackPublication, participant: RemoteParticipant) => void;

    /**
     * 订阅音轨
     * @param track 远程音轨
     * @param publication 发布
     * @param participant 参与者
     */
    trackSubscribed: (
        track: RemoteTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
    ) => void;

    /**
     * 音轨订阅失败
     * @param trackSid sid
     * @param participant 参与者
     * @param reason 原因
     */
    trackSubscriptionFailed: (
        trackSid: string,
        participant: RemoteParticipant,
        reason?: SubscriptionError,
    ) => void;

    /**
     * 解除订阅
     * @param track
     * @param publication
     * @param participant
     */
    trackUnsubscribed: (
        track: RemoteTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipnt,
    ) => void;
    /**
     * 音轨静音
     * @param publication 音轨发布
     * @param participant 参与者
     */
    trackMuted: (publication: TrackPublication, participant: Participant) => void;
    /**
     * 音轨解除静音事件
     * @param publication 发布
     * @param participant 参与者
     */
    trackUnmuted: (publication: TrackPublication, participant: Participant) => void;
    /**
     * local音轨发布
     * @param publication
     * @param participant
     */
    localTrackPublished: (publication: LocalTrackPublication, participant: LocalParticipant) => void;
    /**
     * local音轨取消发布
     * @param publication
     * @param participant
     */
    localTrackUnpublished: (
        publication: LocalTrackPublication,
        participant: LocalParticipant,
    ) => void;

    /**
     * 本地音频静音检测
     * @param publication
     */
    localAudioSilenceDetected: (publication: LocalTrackPublication) => void;

    /**
     * 参与者元素句变化
     * @param metadata 原数据
     * @param participant 参与者
     */
    participantMetadataChanged: (
        metadata: string | undefined,
        participant: RemoteParticipant | LocalParticipant,
    ) => void;

    /**
     * 参与者名称变化
     * @param name 新的名称
     * @param participant 参与者
     */
    participantNameChanged: (name: string, participant: RemoteParticipant | LocalParticipant) => void;

    /**
     *  参与者权限变化
     * @param prevPermissions 之前的权限
     * @param participant 参与者
     */
    participantPermissionsChanged: (
        prevPermissions: ParticipantPermission | undefined,
        participant: RemoteParticipant | LocalParticipant,
    ) => void;

    /**
     * 活跃的发声者发声者变化
     * @param speakers 发声者
     */
    activeSpeakersChanged: (speakers: Array<Participant>) => void;

    /**
     * 房间原数据变化
     * @param metadata 原数据
     */
    roomMetadataChanged: (metadata: string) => void;

    /**
     * 收到数据
     * @param payload 负载
     * @param participant 参与者
     * @param kind 数据包类型
     * @param topic 主题
     */
    dataReceived: (
        payload: Uint8Array,
        participant?: RemoteParticipant,
        kind?: DataPacket_Kind,
        topic?: string,
    ) => void;

    /**
     * 连接质量发声变化
     * @param quality 连接质量
     * @param participant 参与者
     */
    connectionQualityChanged: (quality: ConnectionQuality, participant: Participant) => void;

    /**
     * 媒体设备错误
     * @param error 错误
     */
    mediaDevicesError: (error: Error) => void;

    /**
     * 音轨流撞塌变化
     * @param publication 远程音轨发布
     * @param streamState 流状态
     * @param participant 参与者
     */
    trackStreamStateChanged: (
        publication: RemoteTrackPublication,
        streamState: Track.StreamState,
        participant: RemoteParticipant,
    ) => void;

    /**
     * 音轨订阅权限变化
     * @param publication
     * @param status
     * @param participant
     */
    trackSubscriptionPermissionsChanged: (
        publication: RemoteTrackPublication,
        status: TrackPublication.PermissionStatus,
        participant: RemoteParticipant,
    ) => void;

    /**
     * 音轨订阅状态变化
     * @param publication
     * @param status
     * @param participant
     */
    trackSubscriptionStatusChanged: (
        publication: RemoteTrackPublication,
        status: TrackPublication.SubscriptionStatus,
        participant: RemoteParticipant,
    ) => void;

    /**
     * 音频播放已更改
     * @param playing 播放状态
     */
    audioPlaybackChanged: (playing: boolean) => void;

    /**
     * 视频播放状态变化
     * @param playing 播放状态
     */
    videoPlaybackChanged: (playing: boolean) => void;

    /**
     * 连接成功信号
     */
    signalConnected: () => void;

    /**
     * 录制状态变更
     * @param recording 是否在录制
     */
    recordingStatusChanged: (recording: boolean) => void;

    /**
     * 参与者加密状态已更改
     * @param encrypted 是否加密
     * @param participant 参与者
     */
    participantEncryptionStatusChanged: (encrypted: boolean, participant?: Participant) => void;

    /**
     * 加密错误
     * @param error 错误信息
     */
    encryptionError: (error: Error) => void;

    /**
     * 数据包的buffer状态变化
     * @param isLow
     * @param kind
     */
    dcBufferStatusChanged: (isLow: boolean, kind: DataPacket_Kind) => void;

    /**
     * 活跃设备变更
     * @param kind 设置类型
     * @param deviceId 设备ID
     */
    activeDeviceChanged: (kind: MediaDeviceKind, deviceId: string) => void;
};