import TypedEventEmitter from "typed-emitter";
import {EventEmitter} from 'events';
import {
    ConnectionQualityUpdate,
    JoinResponse,
    StreamStateUpdate, SubscribedQualityUpdate,
    SubscriptionPermissionUpdate,
    SubscriptionResponse, TrackUnpublishedResponse
} from "../protocol/tc_rtc_pb";
import {
    DataPacket_Kind,
    DisconnectReason,
    ParticipantInfo,
    SpeakerInfo,
    UserPacket,
    Room as RoomModel,
} from "../protocol/tc_models_pb";
import {Track} from "./track/Track";
import {VideoCodec} from "./track/options";

const lossyDataChannel = '_lossy';
const reliableDataChannel = '_reliable';
const minReconnectWait = 2 * 1000;
const leaveReconnect = 'leave-reconnect';

enum PCState {
    New,
    Connected,
    Disconnected,
    Reconnecting,
    Closed,
}

/** @internal */
export default class RTCEngine extends (EventEmitter as new() => TypedEventEmitter<EngineEventCallbacks>) {

}

/**
 * 引擎时间回调
 */
export type EngineEventCallbacks = {
    /**
     * 连接成功回调
     * @param joinResp 加入响应
     */
    connected: (joinResp: JoinResponse) => void;
    /**
     * 断开连接
     * @param reason 断开原因
     */
    disconnected: (reason?: DisconnectReason) => void;
    /**
     * 恢复中
     */
    resuming: () => void;
    /**
     * 已恢复
     */
    resumed: () => void;
    /**
     * 重启中
     */
    restarting: () => void;
    /**
     * 已重启
     */
    restarted: () => void;
    /**
     * 信号恢复
     */
    signalResumed: () => void;
    /**
     * 信号重新启动
     * @param joinResp 加入响应
     */
    signalRestarted: (joinResp: JoinResponse) => void;
    /**
     * 关闭中
     */
    closing: () => void;
    /**
     * 媒体曲目已添加
     * @param track 媒体曲目
     * @param streams 媒体流
     * @param receiver 接收器
     */
    mediaTrackAdded: (
        track: MediaStreamTrack,
        streams: MediaStream,
        receiver?: RTCRtpReceiver,
    ) => void;
    /**
     * 当前发言人更新
     * @param speakers 发言者列表
     */
    activeSpeakersUpdate: (speakers: Array<SpeakerInfo>) => void;
    /**
     *  收到数据包
     * @param userPacket 数据包
     * @param kind 类型
     */
    dataPacketReceived: (userPacket: UserPacket, kind: DataPacket_Kind) => void;
    /**
     * 通信已创建
     * @param publisher 发布者
     * @param subscriber 订阅者
     */
    transportsCreated: (publisher: PCTransport, subscriber: PCTransport) => void;
    /**
     *  音轨发送者已添加
     * @internal */
    trackSenderAdded: (track: Track, sender: RTCRtpSender) => void;
    /**
     *  rtp媒体map更新
     * @param rtpMap
     */
    rtpVideoMapUpdate: (rtpMap: Map<number, VideoCodec>) => void;
    /**
     * buffer状态改变
     * @param isLow
     * @param kind
     */
    dcBufferStatusChanged: (isLow: boolean, kind: DataPacket_Kind) => void;
    /**
     * 参与者更新
     * @param infos 参与者列表
     */
    participantUpdate: (infos: ParticipantInfo[]) => void;
    /**
     * 房间更新
     * @param room 房间信息
     */
    roomUpdate: (room: RoomModel) => void;
    /**
     * 连接质量更新
     * @param update 更新后的信息
     */
    connectionQualityUpdate: (update: ConnectionQualityUpdate) => void;
    /**
     * 发言者更新
     * @param speakerUpdates 发言者列表
     */
    speakersChanged: (speakerUpdates: SpeakerInfo[]) => void;
    /**
     * 流状态更新
     * @param update
     */
    streamStateChanged: (update: StreamStateUpdate) => void;
    /**
     *  订阅错误
     * @param resp 订阅返回
     */
    subscriptionError: (resp: SubscriptionResponse) => void;
    /**
     * 订阅权限更新
     * @param update 更新信息
     */
    subscriptionPermissionUpdate: (update: SubscriptionPermissionUpdate) => void;
    /**
     * 订阅质量更新
     * @param update 更新后的质量
     */
    subscriptionQualityUpdate: (update: SubscribedQualityUpdate) => void;
    /**
     * 本地音轨解除发布
     * @param unpublishedResponse 解除发布响应
     */
    localTrackUnpublished: (unpublishedResponse: TrackUnpublishedResponse) => void;
    /**
     * 远程静音
     * @param trackSid sid
     * @param muted 是否静音
     */
    remoteMute: (trackSid: string, muted: boolean) => void;
    /**
     * 下线
     */
    offline: () => void;
};