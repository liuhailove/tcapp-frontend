import {EventEmitter} from 'events';
import log, {LoggerNames, getLogger} from '../logger';
import {LoggerOptions} from "./types";

/**
 * 音轨比特信息
 * @internal
 */
interface TrackBitrateInfo {
    cid?: string;
    transceiver?: RTCRtpTransceiver;
    codec: string;
    maxbr: number;
}

/**
 *  svc 编解码器 (av1/vp9) 在开始时会使用非常低的比特率，
 * 通过带宽估计器缓慢增加，直到达到目标比特率。 这
 * 该过程通常花费超过 10 秒，因为订阅者将在以下位置看到模糊的视频
 * 最初的几秒钟。 因此我们在这里使用目标比特率的 70% 作为起始比特率
 * 消除这个问题。
 */
const startBitrateForSVC = 0.7;

/**
 * 点对点事件
 */
export const PCEvents = {
    NegotiationStarted: 'negotiationStarted',
    NegotiationComplete: 'negotiationComplete',
    RTPVideoPayloadTypes: 'rtpVideoPayloadTypes',
} as const;

/**
 * 点对点通信
 * @internal */
export default class PCTransport extends EventEmitter {
    /**
     * RTCPeerConnection 允许浏览器之间通过网络传输音频、视频和数据，实现实时通信功能，例如音视频通话、视频会议、屏幕共享等。
     */
    private _pc: RTCPeerConnection | null;

    private get pc() {
        if (!this._pc) {
            this._pc = this.createPC();
        }
        return this._pc;
    }

    /**
     * rtc配置
     */
    private config?: RTCConfiguration;

    /**
     * log
     * @private
     */
    private log = log;

    /**
     * logger选项
     */
    private loggerOptions: LoggerOptions;

    /**
     * 待定候选人
     */
    pendingCandidates: RTCIceCandidateInit[] = [];

    /**
     * 重启ICE
     */
    restartingIce: boolean = false;

    /**
     * 重新谈判
     */
    renegotiate: boolean = false;

    /**
     * 音轨比特率
     */
    trackBitrates: TrackBitrateInfo[] = [];

    /**
     * 远程立体声中频
     */
    remoteStereoMids: string[] = [];

    /**
     * 远程Nack中频
     */
    remoteNackMids: string[] = [];

    /**
     * SDP offer 是一个包含本地设备的媒体信息和网络地址的描述。
     * 当你想要建立一个点对点连接时，你可以创建一个 SDP offer，并将其发送给远程对等方。
     */
    onOffer?: (offer: RTCSessionDescriptionInit) => void;

    /**
     * Ice候选加入事件
     */
    onIceCandidate?: (candidate: RTCIceCandidate) => void;

    /**
     * 在 WebRTC 中，onicecandidateerror 事件用于处理 ICE（Interactive Connectivity Establishment）候选者错误。
     * 当 ICE 候选者生成过程中发生错误时，该事件将被触发
     */
    onIceCandidateError?: (ev: Event) => void;

    /**
     * 连接状态改变
     */
    onConnectionStateChange?: (state: RTCPeerConnectionState) => void;

    /**
     * ice状态变化
     */
    onIceConnectionStateChange?: (state: RTCIceConnectionState) => void;

    /**
     * 信令状态改变
     */
    onSignalingStatechange?: (state: RTCSignalingState) => void;

    /**
     * 数据渠道事件
     */
    onDataChannel?: (ev: RTCDataChannelEvent) => void;

    /**
     * 音轨
     */
    onTrack?: (ev: RTCTrackEvent) => void;
}

