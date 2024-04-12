import TypedEventEmitter from "typed-emitter";
import {EventEmitter} from 'events';
import {
    AddTrackRequest,
    ConnectionQualityUpdate,
    DataChannelInfo,
    JoinResponse,
    LeaveRequest,
    ReconnectResponse,
    SignalTarget,
    StreamStateUpdate,
    SubscribedQualityUpdate,
    SubscriptionPermissionUpdate,
    SubscriptionResponse,
    SyncState,
    TrackPublishedResponse,
    TrackUnpublishedResponse,
    UpdateSubscription
} from "../protocol/tc_rtc_pb";
import {
    ClientConfigSetting,
    ClientConfiguration,
    DataPacket,
    DataPacket_Kind,
    DisconnectReason,
    ParticipantInfo,
    ReconnectReason,
    Room as RoomModel,
    SpeakerInfo,
    TrackInfo,
    UserPacket,
} from "../protocol/tc_models_pb";
import {Track} from "./track/Track";
import {TrackPublishOptions, VideoCodec} from "./track/options";
import {SignalClient, SignalConnectionState, SignalOptions, toProtoSessionDescription} from "../api/SignalClient";
import {roomConnectOptionDefaults} from "./defaults";
import {PCTransportManager, PCTransportState} from "./PCTransportManager";
import {ReconnectContext, ReconnectPolicy} from "./ReconnectPolicy";
import {
    isVideoCodec,
    isWeb,
    Mutex,
    sleep,
    supportsAddTrack,
    supportsSetCodecPreferences,
    supportsTransceiver
} from "./utils";
import {RegionUrlProvider} from "./RegionUrlProvider";
import {LoggerOptions} from "./types";
import {InternalRoomOptions} from "../options";
import log, {getLogger, LoggerNames} from "../logger";
import PCTransport, {PCEvents} from "./PCTransport";
import {EngineEvent} from "./TrackEvents";
import {
    ConnectionError,
    ConnectionErrorReason,
    NegotiationError,
    TrackInvalidError,
    UnexpectedConnectionState
} from "./errors";
import LocalTrack from "./track/LocalTrack";
import LocalVideoTrack, {SimulcastTrackInfo} from "./track/LocalVideoTrack";
import CriticalTimers from "./timers";
import {MediaAttributes} from "sdp-transform";
import RemoteTrackPublication from "./track/RemoteTrackPublication";
import LocalTrackPublication from "./track/LocalTrackPublication";
import {getTrackPublicationInfo} from "./track/utils";

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
    /**
     * 信令客户端
     */
    client: SignalClient;

    /**
     * rtc配置信息
     */
    rtcConfig: RTCConfiguration = {};

    /**
     * 端到端连接超时
     */
    peerConnectionTimeout: number = roomConnectOptionDefaults.peerConnectionTimeout;

    /**
     * 下次是否时完整的连接
     */
    fullReconnectOnNext: boolean = false;

    /**
     * 对端连接通信管理
     */
    pcManager?: PCTransportManager;

    /**
     * 最近一次Join返回
     * @internal
     */
    latestJoinResponse?: JoinResponse;

    get isClosed() {
        return this._isClosed;
    }

    get pendingReconnect() {
        return !!this.reconnectTimeout;
    }

    /**
     * 有损数据渠道
     */
    private lossyDC?: RTCDataChannel;

    /**
     * 有损订阅者数据渠道
     */
        // @ts-ignore noUnusedLocals
    private lossyDCSub?: RTCDataChannel;

    /**
     * 可靠数据渠道
     */
    private reliableDC?: RTCDataChannel;

    /**
     *  数据包类型-》状态 map
     */
    private dcBufferStatus: Map<DataPacket_Kind, boolean>;

    /**
     * 可靠订阅者数据渠道
     */
    private reliableDCSub?: RTCDataChannel;

    /**
     * 是否为主要订阅者
     */
    private subscriberPrimary: boolean = false;

    /**
     * 对等连接状态
     */
    private pcState: PCState = PCState.New;

    /**
     * 是否已经关闭
     */
    private _isClosed: boolean = true;

    /**
     * 待处理的轨道解析器
     */
    private pendingTrackResolvers: {
        [key: string]: { resolve: (info: TrackInfo) => void; reject: () => void };
    } = {};

    // 保留连接信息以便重新连接，这可能是一个区域 url
    private url?: string;

    /**
     * 和server交互的token
     */
    private token?: string;

    /**
     * 信令选项
     */
    private signalOpts?: SignalOptions;

    /**
     * 重连尝试次数
     */
    private reconnectAttempts: number = 0;

    /**
     * 重连开始时间
     */
    private reconnectStart: number;

    /**
     * 客户端配置
     */
    private clientConfiguration?: ClientConfiguration;

    /**
     * 是否尝试重连
     */
    private attemptingReconnect: boolean = false;

    /**
     * 重连策略
     */
    private reconnectPolicy: ReconnectPolicy;

    /**
     * 重连超时时间
     */
    private reconnectTimeout?: ReturnType<typeof setTimeout>;

    /**
     * 参与者Sid
     */
    private participantSid?: string;

    /** 音轨尝试初始加入连接的频率 */
    private joinAttempts: number = 0;

    /** 指定允许初始加入连接重试的频率 */
    private maxJoinAttempts: number = 1;

    /**
     * 关闭时锁
     */
    private closingLock: Mutex;

    /**
     * 数据处理锁
     */
    private dataProcessLock: Mutex;

    /**
     * 下一步是否应该失败
     */
    private shouldFailNext: boolean = false;

    private log = log;

    /**
     * server区域url提供者
     */
    private regionUrlProvider?: RegionUrlProvider;

    /**
     * 日志选项
     */
    private loggerOptions: LoggerOptions;

    constructor(private options: InternalRoomOptions) {
        super();
        this.log = getLogger(options.loggerName ?? LoggerNames.Engine);
        this.loggerOptions = {
            loggerName: options.loggerName,
            loggerContextCb: () => this.logContext,
        };
        this.client = new SignalClient(undefined, this.loggerOptions);
        this.client.signalLatency = this.options.expSignalLatency;
        this.reconnectPolicy = this.options.reconnectPolicy;
        this.registerOnLineListener();
        this.closingLock = new Mutex();
        this.dataProcessLock = new Mutex();
        this.dcBufferStatus = new Map([
            [DataPacket_Kind.LOSSY, true],
            [DataPacket_Kind.RELIABLE, true],
        ]);

        this.client.onParticipantUpdate = (updates) =>
            this.emit(EngineEvent.ParticipantUpdate, updates);
        this.client.onConnectionQuality = (update) =>
            this.emit(EngineEvent.ConnectionQualityUpdate, update);
        this.client.onRoomUpdate = (update) => this.emit(EngineEvent.RoomUpdate, update);
        this.client.onSubscriptionError = (resp) => this.emit(EngineEvent.SubscriptionError, resp);
        this.client.onSubscriptionPermissionUpdate = (update) =>
            this.emit(EngineEvent.SubscriptionPermissionUpdate, update);
        this.client.onSpeakersChanged = (update) => this.emit(EngineEvent.SpeakersChanged, update);
        this.client.onStreamStateUpdate = (update) => this.emit(EngineEvent.StreamStateChanged, update);
    }

    /** @internal */
    get logContext() {
        return {
            room: this.latestJoinResponse?.room?.name,
            roomID: this.latestJoinResponse?.room?.sid,
            participant: this.latestJoinResponse?.participant?.identity,
            pID: this.latestJoinResponse?.participant?.sid,
        };
    }

    /**
     * 加入房间
     * @param url server地址
     * @param token 连接房间的token
     * @param opts 信令选项
     * @param abortSignal 中断信令
     */
    async join(
        url: string,
        token: string,
        opts: SignalOptions,
        abortSignal?: AbortSignal,
    ): Promise<JoinResponse> {
        this.url = url;
        this.token = token;
        this.signalOpts = opts;
        this.maxJoinAttempts = opts.maxRetries;
        try {
            this.joinAttempts += 1;

            this.setupSignalClientCallbacks();
            const joinResponse = await this.client.join(url, token, opts, abortSignal);
            this._isClosed = false;
            this.latestJoinResponse = joinResponse;

            this.subscriberPrimary = joinResponse.subscriberPrimary;
            if (!this.pcManager) {
                await this.configure(joinResponse);
            }

            // 创建offer
            if (!this.subscriberPrimary) {
                this.negotiate();
            }

            this.clientConfiguration = joinResponse.clientConfiguration;
            return joinResponse;
        } catch (e) {
            if (e instanceof ConnectionError) {
                if (e.reason === ConnectionErrorReason.ServerUnreachable) {
                    this.log.warn(
                        `Couldn't connect to server, attempt ${this.joinAttempts} of ${this.maxJoinAttempts}`,
                        this.logContext,
                    );
                    if (this.joinAttempts < this.maxJoinAttempts) {
                        // 重新加入尝试
                        return this.join(url, token, opts, abortSignal);
                    }
                }
            }
            throw e;
        }
    }

    /**
     * 关闭Engine
     */
    async close() {
        const unlock = await this.closingLock.lock();
        if (this.isClosed) {
            unlock();
            return;
        }
        try {
            this._isClosed = true;
            this.emit(EngineEvent.Closing);
            this.removeAllListeners();
            this.deregisterOnLineListener();
            this.clearPendingReconnect();
            await this.cleanupPeerConnections();
            await this.cleanupClient();
        } finally {
            unlock();
        }
    }

    /**
     * 清理对端连接
     */
    async cleanupPeerConnections() {
        await this.pcManager?.close();
        this.pcManager = undefined;

        const dcCleanup = (dc: RTCDataChannel | undefined) => {
            if (!dc) {
                return;
            }
            dc.close();
            dc.onbufferedamountlow = null;
            dc.onclose = null;
            dc.onerror = null;
            dc.onmessage = null;
            dc.onopen = null;
        };
        dcCleanup(this.lossyDC);
        dcCleanup(this.lossyDCSub);
        dcCleanup(this.reliableDC);
        dcCleanup(this.reliableDCSub);

        this.lossyDC = undefined;
        this.lossyDCSub = undefined;
        this.reliableDC = undefined;
        this.reliableDCSub = undefined;
    }

    /**
     * 清理client
     */
    async cleanupClient() {
        await this.client.close();
        this.client.resetCallbacks();
    }

    /**
     * 增加音轨
     * @param req 增加音轨请求
     */
    addTrack(req: AddTrackRequest): Promise<TrackInfo> {
        if (this.pendingTrackResolvers[req.cid]) {
            throw new TrackInvalidError('a track with the same ID has already been published');
        }
        return new Promise<TrackInfo>((resolve, reject) => {
            const publicationTimeout = setTimeout(() => {
                delete this.pendingTrackResolvers[req.cid];
                reject(
                    new ConnectionError('publication of local track timed out, no response from server'),
                );
            }, 10_000);
            this.pendingTrackResolvers[req.cid] = {
                resolve: (info: TrackInfo) => {
                    clearTimeout(publicationTimeout);
                    resolve(info);
                },
                reject: () => {
                    clearTimeout(publicationTimeout);
                    reject(new Error('Cancelled publication by calling unpublish'));
                },
            };
            this.client.sendAddTrack(req);
        });
    }

    /**
     * 从 PeerConnection 中删除发送者，如果删除成功并且需要协商则返回 true
     * @param sender
     * @returns
     */
    removeTrack(sender: RTCRtpSender): boolean {
        if (sender.track && this.pendingTrackResolvers[sender.track.id]) {
            const {reject} = this.pendingTrackResolvers[sender.track.id];
            if (reject) {
                reject();
            }
            delete this.pendingTrackResolvers[sender.track.id];
        }
        try {
            this.pcManager!.removeTrack(sender);
        } catch (e: unknown) {
            this.log.warn('failed to remove track', {...this.logContext, error: e});
        }
        return false;
    }

    /**
     * 更新静音状态
     * @param trackSid 音轨Sid
     * @param muted 是否静音
     */
    updateMuteStatus(trackSid: string, muted: boolean) {
        this.client.sendMuteTrack(trackSid, muted);
    }

    /**
     * 可靠数据去掉的订阅者准备状态
     */
    get dataSubscriberReadyState(): string | undefined {
        return this.reliableDCSub?.readyState;
    }

    /**
     * 获取连接的服务端地址
     */
    async getConnectedServerAddress(): Promise<string | undefined> {
        return this.pcManager?.getConnectedAddress();
    }

    /* @internal */
    setRegionUrlProvider(provider: RegionUrlProvider) {
        this.regionUrlProvider = provider;
    }

    private async configure(joinResponse: JoinResponse) {
        // 如果已经配置了，则直接返回
        if (this.pcManager && this.pcManager.currentState !== PCTransportState.NEW) {
            return;
        }

        this.participantSid = joinResponse.participant?.sid;

        const rtcConfig = this.makeRTCConfiguration(joinResponse);

        this.pcManager = new PCTransportManager(
            rtcConfig,
            joinResponse.subscriberPrimary,
            this.loggerOptions,
        );

        this.emit(EngineEvent.TransportsCreated, this.pcManager.publisher, this.pcManager.subscriber);

        this.pcManager.onIceCandidate = (candidate, target) => {
            this.client.sendIceCandidate(candidate, target);
        };

        this.pcManager.onPublisherOffer = (offer) => {
            this.client.sendOffer(offer);
        };

        this.pcManager.onDataChannel = this.handleDataChannel;
        this.pcManager.onStateChange = async (connectionState, publisherState, subscriberState) => {
            this.log.debug(`primary PC state changed ${connectionState}`, this.logContext);
            if (connectionState === PCTransportState.CONNECTED) {
                const shouldEmit = this.pcState === PCState.New;
                this.pcState = PCState.Connected;
                if (shouldEmit) {
                    this.emit(EngineEvent.Connected, joinResponse);
                }
            } else if (connectionState === PCTransportState.FAILED) {
                // 在 Safari 上，PeerConnection 在重新协商期间将切换为“断开连接”
                if (this.pcState === PCState.Connected) {
                    this.pcState = PCState.Disconnected;

                    this.handleDisconnect(
                        'peerconnection failed',
                        subscriberState === 'failed'
                            ? ReconnectReason.RR_SUBSCRIBER_FAILED
                            : ReconnectReason.RR_PUBLISHER_FAILED,
                    );
                }
            }

            // 检测信号客户端和对等连接都被切断的情况，并假设用户丢失了网络连接
            const isSignalSevered =
                this.client.isDisconnected ||
                this.client.currentState === SignalConnectionState.RECONNECTING;
            const isPCSevered = [
                PCTransportState.FAILED,
                PCTransportState.CLOSING,
                PCTransportState.CLOSED
            ].includes(connectionState);
            if (isSignalSevered && isPCSevered && !this._isClosed) {
                this.emit(EngineEvent.Offline);
            }
        };

        this.pcManager.onTrack = (ev: RTCTrackEvent) => {
            this.emit(EngineEvent.MediaTrackAdded, ev.track, ev.streams[0], ev.receiver);
        };

        this.createDataChannels();
    }

    private setupSignalClientCallbacks() {
        // 配置信令客户端
        this.client.onAnswer = async (sd) => {
            if (!this.pcManager) {
                return;
            }
            this.log.debug('received server answer', {...this.logContext, RTCSdpType: sd.type});
            await this.pcManager.setPublisherAnswer(sd);
        };

        // 在trickle上添加候选者
        this.client.onTrickle = (candidate, target) => {
            if (!this.pcManager) {
                return;
            }
            this.log.trace('got ICE candidate from peer', {...this.logContext, candidate, target});
            this.pcManager.addIceCandidate(candidate, target);
        };

        // 当服务器为客户端创建报价时
        this.client.onOffer = async (sd) => {
            if (!this.pcManager) {
                return;
            }
            const answer = await this.pcManager.createSubscriberAnswerFromOffer(sd);
            this.client.sendAnswer(answer);
        };

        this.client.onLocalTrackPublished = (res: TrackPublishedResponse) => {
            this.log.debug('received trackPublishedResponse', {
                ...this.logContext,
                cid: res.cid,
                track: res.track?.sid,
            });
            if (!this.pendingTrackResolvers[res.cid]) {
                this.log.error(`missing track resolver for ${res.cid}`, {
                    ...this.logContext,
                    cid: res.cid,
                });
                return;
            }
            const {resolve} = this.pendingTrackResolvers[res.cid];
            delete this.pendingTrackResolvers[res.cid];
            resolve(res.track!);
        };

        this.client.onLocalTrackUnpublished = (response: TrackUnpublishedResponse) => {
            this.emit(EngineEvent.LocalTrackUnpublished, response);
        };

        this.client.onTokenRefresh = (token: string) => {
            this.token = token;
        };

        this.client.onRemoteMuteChanged = (trackSid: string, muted: boolean) => {
            this.emit(EngineEvent.RemoteMute, trackSid, muted);
        };

        this.client.onSubscribedQualityUpdate = (update: SubscribedQualityUpdate) => {
            this.emit(EngineEvent.SubscribedQualityUpdate, update);
        };

        this.client.onClose = () => {
            this.handleDisconnect('signal', ReconnectReason.RR_SIGNAL_DISCONNECTED);
        };

        this.client.onLeave = (leave?: LeaveRequest) => {
            if (leave?.canReconnect) {
                this.fullReconnectOnNext = true;
                // 立即重新连接而不是等待下一次尝试
                this.handleDisconnect(leaveReconnect);
            } else {
                this.emit(EngineEvent.Disconnected, <DisconnectReason>leave?.reason);
                this.close();
            }
            this.log.debug('client leave request', {...this.logContext, reason: leave?.reason});
        };
    }

    private makeRTCConfiguration(serverResponse: JoinResponse | ReconnectResponse): RTCConfiguration {
        const rtcConfig = {...this.rtcConfig};

        if (this.signalOpts?.e2eeEnabled) {
            this.log.debug('E2EE - setting up transports with insertable streams', this.logContext);
            // 这确保在转换准备好之前不会发送任何数据
            // @ts-ignore
            rtcConfig.encodedInsertableStreams = true;
        }

        // 在创建 PeerConnection 之前更新 ICE 服务器
        if (serverResponse.iceServers && !rtcConfig.iceServers) {
            const rtcIceServers: RTCIceServer[] = [];
            serverResponse.iceServers.forEach((iceServer) => {
                const rtcIceServer: RTCIceServer = {
                    urls: iceServer.urls,
                };
                if (iceServer.username) {
                    rtcIceServer.username = iceServer.username;
                }
                if (iceServer.credential) {
                    rtcIceServer.credential = iceServer.credential;
                }
                rtcIceServers.push(rtcIceServer);
            });
            rtcConfig.iceServers = rtcIceServers;
        }

        if (
            serverResponse.clientConfiguration &&
            serverResponse.clientConfiguration.forceRelay === ClientConfigSetting.ENABLED
        ) {
            rtcConfig.iceTransportPolicy = 'relay';
        }

        // @ts-ignore
        rtcConfig.sdpSemantics = 'unified-plan';
        // @ts-ignore
        rtcConfig.continualGatheringPolicy = 'gather_continually';

        return rtcConfig;
    }

    /**
     * 创建数据渠道
     */
    private createDataChannels() {
        if (!this.pcManager) {
            return;
        }

        // 如果重新创建则清除旧数据通道回调
        if (this.lossyDC) {
            this.lossyDC.onmessage = null;
            this.lossyDC.onerror = null;
        }
        if (this.reliableDC) {
            this.reliableDC.onmessage = null;
            this.reliableDC.onerror = null;
        }

        // 创建数据通道
        this.lossyDC = this.pcManager.createPublisherDataChannel(lossyDataChannel, {
            // 将丢弃到达的旧数据包
            ordered: true,
            maxRetransmits: 0,
        });
        this.reliableDC = this.pcManager.createPublisherDataChannel(reliableDataChannel, {
            ordered: true,
        });

        // 还通过 pub 通道处理消息，以实现向后兼容性
        this.lossyDC.onmessage = this.handleDataMessage;
        this.reliableDC.onmessage = this.handleDataMessage;

        // 处理数据通道错误
        this.lossyDC.onerror = this.handleDataError;
        this.reliableDC.onerror = this.handleDataError;

        // 设置dc缓冲区阈值，设置为64kB（否则默认为0）
        this.lossyDC.bufferedAmountLowThreshold = 65535;
        this.reliableDC.bufferedAmountLowThreshold = 65535;

        // 处理缓冲区数量低事件
        this.lossyDC.onbufferedamountlow = this.handleBufferedAmountLow;
        this.reliableDC.onbufferedamountlow = this.handleBufferedAmountLow;
    }

    /**
     * 处理数据渠道
     * @param chanel 渠道
     */
    private handleDataChannel = async ({channel}: RTCDataChannelEvent) => {
        if (!channel) {
            return;
        }
        if (channel.label === reliableDataChannel) {
            this.reliableDCSub = channel;
        } else if (channel.label === lossyDataChannel) {
            this.lossyDCSub = channel;
        } else {
            return;
        }
        this.log.debug(`on data channel ${channel.id}, ${channel.label}`, this.logContext);
        channel.onmessage = this.handleDataMessage;
    };

    /**
     * 处理数据消息
     * @param message 消息
     */
    private handleDataMessage = async (message: MessageEvent) => {
        // 通过依次处理消息事件来确保尊重传入数据消息的顺序
        const unlock = await this.dataProcessLock.lock();
        try {
            // 解码
            let buffer: ArrayBuffer | undefined;
            if (message.data instanceof ArrayBuffer) {
                buffer = message.data;
            } else if (message.data instanceof Blob) {
                buffer = await message.data.arrayBuffer();
            } else {
                this.log.error('unsupported data type', {...this.logContext, data: message.data});
                return;
            }
            const dp = DataPacket.fromBinary(new Uint8Array(buffer));
            if (dp.value?.case === 'speaker') {
                // 发送发言人更新
                this.emit(EngineEvent.ActiveSpeakersUpdate, dp.value.value.speakers);
            } else if (dp.value?.case === 'user') {
                this.emit(EngineEvent.DataPacketReceived, dp.value.value, dp.kind);
            }
        } finally {
            unlock();
        }
    };

    /**
     * 处理数据错误
     * @param event 事件
     */
    private handleDataError = (event: Event) => {
        const channel = event.currentTarget as RTCDataChannel;
        const channelKind = channel.maxRetransmits === 0 ? 'lossy' : 'reliable';

        if (event instanceof ErrorEvent && event.error) {
            const {error} = event.error;
            this.log.error(`DataChannel error on ${channelKind}: ${event.message}`,
                ...this.logContext,
                error,
            );
        } else {
            this.log.error(`Unknown DataChannel error on ${channelKind}`, {...this.logContext, event});
        }
    };

    private handleBufferedAmountLow = (event: Event) => {
        const channel = event.currentTarget as RTCDataChannel;
        const channelKind =
            channel.maxRetransmits === 0 ? DataPacket_Kind.LOSSY : DataPacket_Kind.RELIABLE;
        this.updateAndEmitDCBufferStatus(channelKind);
    };

    private setPreferredCodec(
        transceiver: RTCRtpTransceiver,
        kind: Track.Kind,
        videoCodec: VideoCodec,
    ) {
        if (!('getCapabilities' in RTCRtpReceiver)) {
            return;
        }
        // 设置编解码器首选项时，需要从 RTCRtpReceiver 读取功能
        const cap = RTCRtpReceiver.getCapabilities(kind);
        if (!cap) {
            return;
        }
        this.log.debug('get receiver capabilities', {...this.logContext, cap});
        const matched: RTCRtpCodecCapability[] = [];
        const partialMatched: RTCRtpCodecCapability[] = [];
        const unmatched: RTCRtpCodecCapability[] = [];
        cap.codecs.forEach((c) => {
            const codec = c.mimeType.toLowerCase();
            if (codec === 'audio/opus') {
                matched.push(c);
                return;
            }
            const matchesVideoCodec = codec === `video/${videoCodec}`;
            if (!matchesVideoCodec) {
                unmatched.push(c);
                return;
            }
            // 对于具有 sdpFmtpLine 可用的 h264 编解码器，仅在以下情况下使用
            // profile-level-id 为 42e01f 以实现跨浏览器兼容性
            if (videoCodec === 'h264') {
                if (c.sdpFmtpLine && c.sdpFmtpLine.includes('profile-level-id=42e01f')) {
                    matched.push(c);
                } else {
                    partialMatched.push(c);
                }
                return;
            }

            matched.push(c);
        });

        if (supportsSetCodecPreferences(transceiver)) {
            transceiver.setCodecPreferences(matched.concat(partialMatched, unmatched));
        }
    }

    async createSender(
        track: LocalTrack,
        opts: TrackPublishOptions,
        encodings?: RTCRtpEncodingParameters[],
    ) {
        if (supportsTransceiver()) {
            return await this.createTransceiverRTCRtpSender(track, opts, encodings);
        }
        if (supportsAddTrack()) {
            this.log.warn('using add-track fallback', this.logContext);
            return await this.createRTCRtpSender(track.mediaStreamTrack);
        }
        throw new UnexpectedConnectionState('Required webRTC APIs not supported on this device');
    }

    /**
     * 创建联播发送者
     */
    async createSimulcastSender(
        track: LocalVideoTrack,
        simulcastTrack: SimulcastTrackInfo,
        opts: TrackPublishOptions,
        encodings?: RTCRtpEncodingParameters[],
    ) {
        // 存储 RTCRtpSender
        if (supportsTransceiver()) {
            return this.createSimulcastTransceiverSender(track, simulcastTrack, opts, encodings);
        }
        if (supportsAddTrack()) {
            this.log.debug('using add-track fallback', this.logContext);
            return this.createRTCRtpSender(track.mediaStreamTrack);
        }

        throw new UnexpectedConnectionState('Cannot stream on this device');
    }

    /**
     * 创建收发器 RTCRtpSender
     * @param track 本地音轨
     * @param opts 音轨发布选项
     * @param encodings 编码参数
     */
    private async createTransceiverRTCRtpSender(
        track: LocalTrack,
        opts: TrackPublishOptions,
        encodings?: RTCRtpEncodingParameters[],
    ) {
        if (!this.pcManager) {
            throw new UnexpectedConnectionState('publisher is closed');
        }

        const streams: MediaStream[] = [];

        if (track.mediaStream) {
            streams.push(track.mediaStream);
        }
        const transceiverInit: RTCRtpTransceiverInit = {direction: 'sendonly', streams};
        if (encodings) {
            transceiverInit.sendEncodings = encodings;
        }
        //react-native 的 addTransceiver 是异步的。 web 是同步的，但await 不会影响它。
        const transceiver = await this.pcManager.addPublisherTransceiver(
            track.mediaStreamTrack,
            transceiverInit,
        );

        if (track.kind === Track.Kind.Video && opts.videoCodec) {
            this.setPreferredCodec(transceiver, track.kind, opts.videoCodec);
            track.codec = opts.videoCodec;
        }
        return transceiver.sender;
    }

    /**
     * 创建联播收发器发送者
     * @param track 视频音轨
     * @param simulcastTrack 联播音轨信息
     * @param opts 发布选项
     * @param encodings 编码参数
     */
    private async createSimulcastTransceiverSender(
        track: LocalVideoTrack,
        simulcastTrack: SimulcastTrackInfo,
        opts: TrackPublishOptions,
        encodings?: RTCRtpEncodingParameters[],
    ) {
        if (!this.pcManager) {
            throw new UnexpectedConnectionState('publisher is closed');
        }
        const transceiverInit: RTCRtpTransceiverInit = {direction: 'sendonly'};
        if (encodings) {
            transceiverInit.sendEncodings = encodings;
        }
        //react-native 的 addTransceiver 是异步的。 web 是同步的，但await 不会影响它。
        const transceiver = await this.pcManager.addPublisherTransceiver(
            simulcastTrack.mediaStreamTrack,
            transceiverInit,
        );
        if (!opts.videoCodec) {
            return;
        }
        this.setPreferredCodec(transceiver, track.kind, opts.videoCodec);
        track.setSimulcastTrackSender(opts.videoCodec, transceiver.sender);
        return transceiver.sender;
    }

    /**
     * 创建RTCRtp发送者
     * @param track 媒体音轨
     */
    private async createRTCRtpSender(track: MediaStreamTrack) {
        if (!this.pcManager) {
            throw new UnexpectedConnectionState('publisher is closed');
        }
        return this.pcManager.addPublisherTrack(track);
    }

    // websocket 重新连接行为。 如果websocket中断，并且PeerConnection继续工作，
    // 我们可以在多次重试后重新连接到websocket以继续会话，我们将关闭并永久放弃
    private handleDisconnect = (connection: string, disconnectReason?: ReconnectReason) => {
        if (this._isClosed) {
            return;
        }
        this.log.warn(`${connection} disconnected`, this.logContext);
        if (this.reconnectAttempts == 0) {
            // 仅在第一次尝试时重置开始时间
            this.reconnectStart = Date.now();
        }

        const disconnect = (duration: number) => {
            this.log.warn(
                `could not recover connection after ${this.reconnectAttempts} attempts, ${duration}ms. giving up`,
                this.logContext,
            );
            this.emit(EngineEvent.Disconnected);
            this.close();
        };

        const duration = Date.now() - this.reconnectStart;
        let delay = this.getNextRetryDelay({
            elapsedMs: duration,
            retryCount: this.reconnectAttempts,
        });

        if (delay === null) {
            disconnect(duration);
            return;
        }
        if (connection === leaveReconnect) {
            delay = 0;
        }

        this.log.debug(`reconnecting in ${delay}ms`, this.logContext);

        this.clearReconnectTimeout();
        if (this.token && this.regionUrlProvider) {
            // 令牌可能已刷新，我们不想重新创建regionUrlProvider，
            // 因为当前引擎可能继承了区域url
            this.regionUrlProvider.updateToken(this.token);
        }
        this.reconnectTimeout = CriticalTimers.setTimeout(
            () =>
                this.attemptReconnect(disconnectReason).finally(() => (this.reconnectTimeout = undefined)),
            delay,
        );
    };

    /**
     * 尝试重连
     * @param reason 重连原因
     */
    private async attemptReconnect(reason?: ReconnectReason) {
        if (this._isClosed) {
            return;
        }
        // 在一次尝试尚未完成时多次尝试重新连接的保护
        if (this.attemptingReconnect) {
            log.warn('already attempting reconnect, running early', this.logContext);
            return;
        }
        if (
            this.clientConfiguration?.resumeConnection === ClientConfigSetting.DISABLED ||
            // 由于硬件睡眠，信令状态可能会更改为关闭
            // 这些连接无法恢复
            (this.pcManager?.currentState ?? PCTransportState.NEW) === PCTransportState.NEW

        ) {
            this.fullReconnectOnNext = true;
        }

        try {
            this.attemptingReconnect = true;
            if (this.fullReconnectOnNext) {
                await this.restartConnection();
            } else {
                await this.resumeConnection(reason);
            }
            this.clearPendingReconnect();
            this.fullReconnectOnNext = false;
        } catch (e) {
            this.reconnectAttempts += 1;
            let recoverable = true;
            if (e instanceof UnexpectedConnectionState) {
                this.log.debug('received unrecoverable error', {...this.logContext, error: e});
                // 无法恢复的
                recoverable = false;
            } else if (!(e instanceof SignalReconnectError)) {
                // 可以恢复
                this.fullReconnectOnNext = true;
            }

            if (recoverable) {
                this.handleDisconnect('reconnect', ReconnectReason.RR_UNKNOWN);
            } else {
                this.log.info(
                    `could not recover connection after ${this.reconnectAttempts} attempts, ${
                        Date.now() - this.reconnectStart
                    }ms. giving up`,
                    this.logContext,
                );
                this.emit(EngineEvent.Disconnected);
                await this.close();
            }
        } finally {
            this.attemptingReconnect = false;
        }
    }

    /**
     * 获取下一次的重试延迟
     * @param context 重试上下文
     */
    private getNextRetryDelay(context: ReconnectContext) {
        try {
            return this.reconnectPolicy.nextRetryDelayInMs(context);
        } catch (e) {
            this.log.warn('encountered error in reconnect policy', {...this.logContext, error: e});
        }

        // 使用提供的重新连接策略的用户代码中出现错误，停止重新连接
        return null;
    }

    /**
     * 重新启动连接
     * @param regionUrl 地区Url
     */
    private async restartConnection(regionUrl?: string) {
        try {
            if (!this.url || !this.token) {
                // 永久失败，不要尝试重新连接
                throw new UnexpectedConnectionState('could not reconnect, url or token not saved');
            }

            this.log.info(`reconnecting, attempt: ${this.reconnectAttempts}`, this.logContext);
            this.emit(EngineEvent.Restarting);

            if (!this.client.isDisconnected) {
                await this.client.sendLeave();
            }
            await this.cleanupPeerConnections();
            await this.cleanupClient();

            let joinResponse: JoinResponse;
            try {
                if (!this.signalOpts) {
                    this.log.warn(
                        'attempted connection restart, without signal options present',
                        this.logContext,
                    );
                    throw new SignalReconnectError();
                }
                // 如果传递了regionUrl，则区域URL优先
                joinResponse = await this.join(regionUrl ?? this.url, this.token, this.signalOpts);
            } catch (e) {
                if (e instanceof ConnectionError && e.reason === ConnectionErrorReason.NotAllowed) {
                    throw new UnexpectedConnectionState('could not reconnect, token might be expired');
                }
                throw new SignalReconnectError();
            }

            if (this.shouldFailNext) {
                this.shouldFailNext = false;
                throw new Error('simulated failure');
            }

            this.client.setReconnected();
            this.emit(EngineEvent.SignalRestarted, joinResponse);

            await this.waitForPCReconnected();

            // 在将引擎设置为恢复之前重新检查信号连接状态
            if (this.client.currentState !== SignalConnectionState.CONNECTED) {
                throw new SignalReconnectError('Signal connection get severed during reconnect');
            }

            this.regionUrlProvider?.resetAttempts();
            // 重连成功
            this.emit(EngineEvent.Restarted);
        } catch (error) {
            const nextRegionUrl = await this.regionUrlProvider?.getNextBestRegionUrl();
            if (nextRegionUrl) {
                await this.restartConnection(nextRegionUrl);
                return;
            } else {
                // 没有更多区域可供尝试（或者我们不在云上）
                this.regionUrlProvider?.resetAttempts();
                throw error;
            }
        }
    }

    /**
     * 恢复连接
     * @param reason 连接原因
     */
    private async resumeConnection(reason?: ReconnectReason): Promise<void> {
        if (!this.url || !this.token) {
            // 永久失败，不要尝试重新连接
            throw new UnexpectedConnectionState('could not reconnect, url or token not saved');
        }
        // 触发发布者重新连接
        if (!this.pcManager) {
            throw new UnexpectedConnectionState('publisher and subscriber connections unset');
        }

        this.log.info(`resuming signal connection, attempt ${this.reconnectAttempts}`, this.logContext);
        this.emit(EngineEvent.Resuming);
        let res: ReconnectResponse | undefined;
        try {
            this.setupSignalClientCallbacks();
            res = await this.client.reconnect(this.url, this.token, this.participantSid, reason);
        } catch (error) {
            let message = '';
            if (error instanceof Error) {
                message = error.message;
                this.log.error(error.message, {...this.logContext, error});
            }
            if (error instanceof ConnectionError && error.reason === ConnectionErrorReason.NotAllowed) {
                throw new UnexpectedConnectionState('could not reconnect, token might be expired');
            }
            if (error instanceof ConnectionError && error.reason === ConnectionErrorReason.LeaveRequest) {
                throw error;
            }
            throw new SignalReconnectError(message);
        }
        this.emit(EngineEvent.SignalResumed);

        if (res) {
            const rtcConfig = this.makeRTCConfiguration(res);
            this.pcManager.updateConfiguration(rtcConfig);
        } else {
            this.log.warn('Did not receive reconnect response', this, this.logContext);
        }

        if (this.shouldFailNext) {
            this.shouldFailNext = false;
            throw new Error('simulated failure');
        }

        await this.pcManager.triggerIceRestart();

        await this.waitForPCReconnected();

        // 在将引擎设置为恢复之前重新检查信号连接状态
        if (this.client.currentState !== SignalConnectionState.CONNECTED) {
            throw new SignalReconnectError('Signal connection got severed during reconnect');
        }

        this.client.setReconnected();

        // 如果 id 为 null，则重新创建发布数据通道
        //（对于 Safari https://bugs.webkit.org/show_bug.cgi?id=184688）
        if (this.reliableDC?.readyState === 'open' && this.reliableDC.id === null) {
            this.createDataChannels();
        }

        // 恢复成功
        this.emit(EngineEvent.Resumed);
    }

    /**
     * 等待对端戳实话连接
     * @param timeout 超时时间
     * @param abortController abort控制器
     */
    async waitForPCInitialConnection(timeout?: number, abortController?: AbortController) {
        if (!this.pcManager) {
            throw new UnexpectedConnectionState('PC manager is closed');
        }
        await this.pcManager.ensurePCTransportConnection(abortController, timeout);
    }

    /**
     * 等待PC重新连接
     */
    private async waitForPCReconnected() {
        this.pcState = PCState.Reconnecting;

        this.log.debug('waiting for peer connection to reconnect', this.logContext);
        try {
            // 再次修复 setTimeout 对于连接关键路径来说不理想
            await sleep(minReconnectWait);
            if (!this.pcManager) {
                throw new UnexpectedConnectionState('PC manager is closed');
            }
            await this.pcManager.ensurePCTransportConnection(undefined, this.peerConnectionTimeout);
            this.pcState = PCState.Connected;
        } catch (e: any) {
            // TODO 我们是否需要 PC 处于“失败”状态？
            this.pcState = PCState.Disconnected;
            throw new ConnectionError(`could not establish PC connection, ${e.message}`);
        }
    }

    /**
     * 等待重启
     */
    waitForRestarted = () => {
        return new Promise<void>((resolve, reject) => {
            if (this.pcState === PCState.Connected) {
                resolve();
            }
            const onRestarted = () => {
                this.off(EngineEvent.Disconnected, onDisconnected);
                resolve();
            };
            const onDisconnected = () => {
                this.off(EngineEvent.Restarted, onRestarted);
                reject();
            };
            this.once(EngineEvent.Restarted, onRestarted);
            this.once(EngineEvent.Disconnected, onDisconnected);
        });
    };

    /**
     * 发送数据包
     */

    /* @internal */
    async sendDataPacket(packet: DataPacket, kind: DataPacket_Kind) {
        const msg = packet.toBinary();

        // 确保我们确实有数据连接
        await this.ensurePublisherConnected(kind);

        const dc = this.dataChannelForKind(kind);
        if (dc) {
            dc.send(msg);
        }

        this.updateAndEmitDCBufferStatus(kind);
    }

    private updateAndEmitDCBufferStatus = (kind: DataPacket_Kind) => {
        const status = this.isBufferStatusLow(kind);
        if (typeof status !== 'undefined' && status !== this.dcBufferStatus.get(kind)) {
            this.dcBufferStatus.set(kind, status);
            this.emit(EngineEvent.DCBufferStatusChanged, status, kind);
        }
    };

    private isBufferStatusLow = (kind: DataPacket_Kind): boolean | undefined => {
        const dc = this.dataChannelForKind(kind);
        if (dc) {
            return dc.bufferedAmount <= dc.bufferedAmountLowThreshold;
        }
    };

    /**
     * @internal
     */
    async ensureDataTransportConnected(
        kind: DataPacket_Kind,
        subscriber: boolean = this.subscriberPrimary,
    ) {
        if (!this.pcManager) {
            throw  new UnexpectedConnectionState('PC manager is closed');
        }
        const transport = subscriber ? this.pcManager.subscriber : this.pcManager.publisher;
        const transportName = subscriber ? 'Subscriber' : 'Publisher';
        if (!transport) {
            throw new ConnectionError(`${transportName} connection not set`);
        }

        if (
            !subscriber &&
            !this.pcManager.publisher.isICEConnected &&
            this.pcManager.publisher.getICEConnectionState() !== 'checking'
        ) {
            // 开始协商
            this.negotiate();
        }

        const targetChannel = this.dataChannelForKind(kind, subscriber);
        if (targetChannel?.readyState === 'open') {
            return;
        }

        // 等待知道ICE连接
        const endTime = new Date().getTime() + this.peerConnectionTimeout;
        while (new Date().getTime() < endTime) {
            if (
                transport.isICEConnected &&
                this.dataChannelForKind(kind, subscriber)?.readyState === 'open'
            ) {
                return;
            }
            await sleep(50);
        }

        throw new ConnectionError(
            `could not establish ${transportName} connection, state: ${transport.getICEConnectionState()}`,
        );
    }

    private async ensurePublisherConnected(kind: DataPacket_Kind) {
        await this.ensureDataTransportConnected(kind, false);
    }

    /* @internal */
    verifyTransport(): boolean {
        if (!this.pcManager) {
            return false;
        }
        // 主要连接
        if (this.pcManager.currentState !== PCTransportState.CONNECTED) {
            return false;
        }
        // 确保信号已连接
        if (!this.client.ws || this.client.ws.readyState === WebSocket.CLOSED) {
            return false;
        }
        return true;
    }

    /**
     * 协商
     * @internal
     * */
    async negotiate(): Promise<void> {
        // 观察信令状态
        return new Promise<void>(async (resolve, reject) => {
            if (!this.pcManager) {
                reject(new NegotiationError('PC manager is closed'));
                return;
            }

            this.pcManager.requirePublisher();

            const abortController = new AbortController();

            const handleClosed = () => {
                abortController.abort();
                this.log.debug('engine disconnected while negotiation was ongoing', this.logContext);
                resolve();
                return;
            };

            if (this.isClosed) {
                reject('cannot negotiate on closed engine');
            }
            this.on(EngineEvent.Closing, handleClosed);

            this.pcManager.publisher.once(
                PCEvents.RTPVideoPayloadTypes,
                (rtpTypes: MediaAttributes['rtp']) => {
                    const rtpMap = new Map<number, VideoCodec>();
                    rtpTypes.forEach((rtp) => {
                        const codec = rtp.codec.toLowerCase();
                        if (isVideoCodec(codec)) {
                            rtpMap.set(rtp.payload, codec);
                        }
                    });
                    this.emit(EngineEvent.RTPVideoMapUpdate, rtpMap);
                },
            );

            try {
                await this.pcManager.negotiate(abortController);
                resolve();
            } catch (e: any) {
                if (e instanceof NegotiationError) {
                    this.fullReconnectOnNext = true;
                }
                this.handleDisconnect('negotiation', ReconnectReason.RR_UNKNOWN);
                reject(e);
            } finally {
                this.off(EngineEvent.Closing, handleClosed);
            }
        });
    }

    dataChannelForKind(kind: DataPacket_Kind, sub?: boolean): RTCDataChannel | undefined {
        if (!sub) {
            if (kind === DataPacket_Kind.LOSSY) {
                return this.lossyDC;
            }
            if (kind === DataPacket_Kind.RELIABLE) {
                return this.reliableDC;
            }
        } else {
            if (kind === DataPacket_Kind.LOSSY) {
                return this.lossyDCSub;
            }
            if (kind === DataPacket_Kind.RELIABLE) {
                return this.reliableDCSub;
            }
        }
    }

    /** @internal */
    sendSyncState(remoteTracks: RemoteTrackPublication[], localTracks: LocalTrackPublication[]) {
        if (!this.pcManager) {
            this.log.warn('sync state cannot be sent without peer connection setup', this.logContext);
            return;
        }
        const previousAnswer = this.pcManager.subscriber.getLocalDescription();
        const previousOffer = this.pcManager.subscriber.getRemoteDescription();


        /* 1. 自动订阅，所以订阅的曲目 = 所有曲目 - 取消订阅曲目，
                   在这种情况下，我们发送 unsub 轨道，因此服务器将所有轨道添加到此
                   订阅 pc 并从中取消订阅特殊曲目。
           2.自动订阅关闭，我们发送订阅的曲目。
         */
        const autoSubscribe = this.signalOpts?.autoSubscribe ?? true;
        const trackSids = new Array<string>();
        const trackSidsDisabled = new Array<string>();

        remoteTracks.forEach((track) => {
            if (track.isDesired !== autoSubscribe) {
                trackSids.push(track.trackSid);
            }
            if (!track.isEnabled) {
                trackSidsDisabled.push(track.trackSid);
            }
        });

        this.client.sendSyncState(
            new SyncState({
                answer: previousAnswer
                    ? toProtoSessionDescription({
                        sdp: previousAnswer.sdp,
                        type: previousAnswer.type
                    })
                    : undefined,
                offer: previousOffer
                    ? toProtoSessionDescription({
                        sdp: previousOffer.sdp,
                        type: previousOffer.type,
                    })
                    : undefined,
                subscription: new UpdateSubscription({
                    trackSids,
                    subscribe: !autoSubscribe,
                    participantTracks: [],
                }),
                publishTracks: getTrackPublicationInfo(localTracks),
                dataChannels: this.dataChannelsInfo(),
                trackSidsDisabled,
            })
        );
    }

    /* @internal */
    failNext() {
        // 使下一次重新连接/恢复尝试失败的调试方法
        this.shouldFailNext = true;
    }

    /**
     * 获取数据渠道信息
     */
    private dataChannelsInfo(): DataChannelInfo[] {
        const infos: DataChannelInfo[] = [];
        const getInfo = (dc: RTCDataChannel | undefined, target: SignalTarget) => {
            if (dc?.id !== undefined && dc.id !== null) {
                infos.push(
                    new DataChannelInfo({
                        label: dc.label,
                        id: dc.id,
                        target,
                    }),
                );
            }
        };
        getInfo(this.dataChannelForKind(DataPacket_Kind.LOSSY), SignalTarget.PUBLISHER);
        getInfo(this.dataChannelForKind(DataPacket_Kind.RELIABLE), SignalTarget.PUBLISHER);
        getInfo(this.dataChannelForKind(DataPacket_Kind.LOSSY, true), SignalTarget.PUBLISHER);
        getInfo(this.dataChannelForKind(DataPacket_Kind.RELIABLE, true), SignalTarget.SUBSCRIBER);
        return infos;
    }

    /**
     * 清除重连超时
     */
    private clearReconnectTimeout() {
        if (this.reconnectTimeout) {
            CriticalTimers.clearTimeout(this.reconnectTimeout);
        }
    }

    /**
     * 清除等待重连Timer
     */
    private clearPendingReconnect() {
        this.clearReconnectTimeout();
        this.reconnectAttempts = 0;
    }

    private handleBrowserOnLine = () => {
        // 如果引擎当前正在重新连接，请在浏览器状态更改为“onLine”后立即尝试重新连接
        if (this.client.currentState === SignalConnectionState.RECONNECTING) {
            this.clearReconnectTimeout();
            this.attemptReconnect(ReconnectReason.RR_SIGNAL_DISCONNECTED);
        }
    };

    private registerOnLineListener() {
        if (isWeb()) {
            window.addEventListener('online', this.handleBrowserOnLine);
        }
    }

    private deregisterOnLineListener() {
        if (isWeb()) {
            window.removeEventListener('online', this.handleBrowserOnLine);
        }
    }

}

/**
 * 信令重连失败
 */
class SignalReconnectError extends Error {
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
    subscribedQualityUpdate: (update: SubscribedQualityUpdate) => void;
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