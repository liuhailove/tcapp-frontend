import log, {getLogger, LoggerNames} from '../logger';

// 内部选项
import {
    AddTrackRequest,
    ConnectionQualityUpdate,
    JoinResponse,
    LeaveRequest,
    MuteTrackRequest,
    Ping,
    ReconnectResponse,
    SessionDescription,
    SignalRequest,
    SignalResponse,
    SignalTarget,
    SimulateScenario,
    StreamStateUpdate,
    SubscribedQualityUpdate,
    SubscriptionPermission,
    SubscriptionPermissionUpdate,
    SubscriptionResponse,
    SyncState,
    TrackPermission,
    TrackPublishedResponse,
    TrackUnpublishedResponse,
    TrickleRequest,
    UpdateParticipantMetadata,
    UpdateSubscription,
    UpdateTrackSettings,
    UpdateVideoLayers,
} from "../protocol/tc_rtc_pb";
import {AsyncQueue} from "../utils/AsyncQueue";
import {
    ClientInfo,
    DisconnectReason,
    ParticipantInfo,
    ReconnectReason,
    Room,
    SpeakerInfo,
    VideoLayer
} from "../protocol/tc_models_pb";
import {getClientInfo, isReactNative, Mutex, sleep, toWebsocketUrl} from "../room/utils";
import {LoggerOptions} from "../room/types";
import {ConnectionError, ConnectionErrorReason} from "../room/errors";
import CriticalTimers from "../room/timers";
import {protoInt64} from "@bufbuild/protobuf";

interface ConnectOpts extends SignalOptions {
    /**
     * 是否重连
     * internal */
    reconnect?: boolean;
    /**
     * 重连原因
     * internal */
    reconnectReason?: number;
    /** internal */
    sid?: string;
}


// 公有选项
export interface SignalOptions {
    /**
     * 自动订阅
     */
    autoSubscribe: boolean;
    /**
     * 是否自适应流
     */
    adaptiveStream?: boolean;
    /**
     * 最大重试次数
     */
    maxRetries: number;
    e2eeEnabled: boolean;
    /**
     * websocket的超时时间
     */
    websocketTimeout: number;
}

/**
 * 信令消息
 */
type SignalMessage = SignalRequest['message'];

/**
 * 信令类型
 */
type SignalKind = NonNullable<SignalMessage>['case'];

/**
 * 通过队列信号
 */
const passThroughQueueSignals: Array<SignalKind> = [
    'syncState',
    'trickle',
    'offer',
    'answer',
    'simulate',
    'leave',
];

/**
 * 是否可以通过队列
 * @param req 信令请求
 */
function canPassThroughQueue(req: SignalMessage): boolean {
    const canPass = passThroughQueueSignals.indexOf(req!.case) >= 0;
    log.trace('request allowed to bypass queue:', {canPass, req});
    return canPass;
}

/**
 * 信号连接状态
 */
export enum SignalConnectionState {
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    DISCONNECTING,
    DISCONNECTED
}


/**
 * 信令客户端
 * @internal */
export class SignalClient {

    /**
     * 异步请求队列
     */
    requestQueue: AsyncQueue;

    /**
     * 已排队请求
     */
    queuedRequests: Array<() => Promise<void>>;

    useJSON: boolean;

    /** 信号rtt（以毫秒为单位） */
    rtt: number = 0;

    /** 通过延迟消息来模拟信令延迟 */
    signalLatency?: number;

    /**
     * 关闭事件
     */
    onClose?: (reason: string) => void;

    /**
     * answer事件
     */
    onAnswer?: (sd: RTCSessionDescriptionInit) => void;

    onOffer?: (sd: RTCSessionDescriptionInit) => void;

    // 当有新的 ICE 候选者可用时
    onTrickle?: (sd: RTCIceCandidateInit, target: SignalTarget) => void;

    /**
     * 参与者更新事件
     */
    onParticipantUpdate?: (updates: ParticipantInfo[]) => void;

    /**
     * 本地音轨发布事件
     */
    onLocalTrackPublished?: (res: TrackPublishedResponse) => void;

    /**
     * 协商请求事件
     */
    onNegotiateRequested?: () => void;

    /**
     * 发言人变更事件
     */
    onSpeakersChanged?: (res: SpeakerInfo[]) => void;

    /**
     * 远程静音已更改事件
     */
    onRemoteMuteChanged?: (trackSid: string, muted: boolean) => void;

    /**
     * room更新事件
     */
    onRoomUpdate?: (room: Room) => void;

    /**
     * 连接质量更新事件
     */
    onConnectionQuality?: (update: ConnectionQualityUpdate) => void;

    /**
     * 流状态更新
     */
    onStreamStateUpdate?: (update: StreamStateUpdate) => void;

    /**
     * 订阅质量更新
     */
    onSubscribedQualityUpdate?: (update: SubscribedQualityUpdate) => void;

    /**
     * 订阅权限变更
     */
    onSubscriptionPermissionUpdate?: (update: SubscriptionPermissionUpdate) => void;

    /**
     *  订阅错误事件
     */
    onSubscriptionError?: (update: SubscriptionResponse) => void;

    /**
     * 本地音轨取消发布
     */
    onLocalTrackUnpublished?: (res: TrackUnpublishedResponse) => void;

    /**
     * token刷新事件
     */
    onTokenRefresh?: (token: string) => void;

    /**
     * 离开请求事件
     */
    onLeave?: (leave: LeaveRequest) => void;

    /**
     * 连接选项
     */
    connectOptions?: ConnectOpts;

    /**
     * websocket对象
     */
    ws?: WebSocket;

    get currentState() {
        return this.state;
    }

    get isDisconnected() {
        return (
            this.state === SignalConnectionState.DISCONNECTING ||
            this.state === SignalConnectionState.DISCONNECTED
        );
    }

    private get isEstablishingConnection() {
        return (
            this.state == SignalConnectionState.CONNECTING ||
            this.state === SignalConnectionState.RECONNECTING
        );
    }

    /**
     * 信令选项
     */
    private options?: SignalOptions;

    /**
     * ping超时时间
     */
    private pingTimeout: ReturnType<typeof setTimeout> | undefined;

    /**
     * ping超时间隔
     */
    private pingTimeoutDuration: number | undefined;

    private pingIntervalDuration: number | undefined;

    /**
     * ping间隔
     */
    private pingInterval: ReturnType<typeof setInterval> | undefined;

    /**
     *  信令关闭时的锁
     */
    private closingLock: Mutex;

    /**
     * 信令连接状态
     */
    private state: SignalConnectionState = SignalConnectionState.DISCONNECTED;

    /**
     * 连接锁
     */
    private connectionLock: Mutex;

    /**
     * 日志
     */
    private log = log;

    /**
     * 日志选项
     */
    private loggerContextCb?: LoggerOptions['loggerContextCb'];

    constructor(useJSON: boolean = false, loggerOptions: LoggerOptions = {}) {
        this.log = getLogger(loggerOptions.loggerName ?? LoggerNames.Signal);
        this.loggerContextCb = loggerOptions.loggerContextCb;
        this.useJSON = useJSON;
        this.requestQueue = new AsyncQueue();
        this.queuedRequests = [];
        this.closingLock = new Mutex();
        this.connectionLock = new Mutex();
        this.state = SignalConnectionState.DISCONNECTED;
    }

    private get logContext() {
        return this.loggerContextCb?.() ?? {};
    }

    /**
     * 加入到远程的websocket server连接中
     * @param url 远程server地址
     * @param token 连接token，不同房间token有区别
     * @param opts 信令连接选项
     * @param abortSignal 终止回调
     */
    async join(
        url: string,
        token: string,
        opts: SignalOptions,
        abortSignal?: AbortSignal,
    ): Promise<JoinResponse> {
        // 在一个完整的重连时，我们希望开启一个时序，即便当前已经连接
        this.state = SignalConnectionState.CONNECTING;
        this.options = opts;
        const res = await this.connect(url, token, opts, abortSignal);
        return res as JoinResponse;
    }

    /**
     * 重新连接
     * @param url websocket server地址
     * @param token 连接token，不同房间token有区别
     * @param sid 唯一标识
     * @param reason 重连原因
     */
    async reconnect(
        url: string,
        token: string,
        sid?: string,
        reason?: ReconnectReason,
    ): Promise<ReconnectResponse | undefined> {
        if (!this.options) {
            this.log.warn(
                'attempted to reconnect without signal options being set, ignoring',
                this.logContext,
            );
            return;
        }
        this.state = SignalConnectionState.RECONNECTING;
        // 清楚ping间隔并且重连时重新启动一次
        this.clearPingInterval();

        const res = await this.connect(url, token, {
            ...this.options,
            reconnect: true,
            sid,
            reconnectReason: reason,
        });
        return res;
    }

    /**
     * 建立连接
     * @param url 远程server地址
     * @param token 连接地址
     * @param opts 连接选项
     * @param abortSignal 中断信令
     */
    private connect(
        url: string,
        token: string,
        opts: ConnectOpts,
        abortSignal?: AbortSignal,
    ): Promise<JoinResponse | ReconnectResponse | undefined> {
        this.connectOptions = opts;
        url = toWebsocketUrl(url);
        // 去掉尾部斜杠
        url = url.replace(/\/$/, '');
        url += '/rtc';

        const clientInfo = getClientInfo();
        const params = createConnectionParams(token, clientInfo, opts);

        return new Promise<JoinResponse | ReconnectResponse | undefined>(async (resolve, reject) => {
            const unlock = await this.connectionLock.lock();
            try {
                const abortHandler = async () => {
                    this.close();
                    clearTimeout(wsTimeout);
                    reject(new ConnectionError('room connection has been cancelled (signal)'));
                };

                const wsTimeout = setTimeout(() => {
                    this.close();
                    reject(new ConnectionError('room connection has timed out (signal)'));
                }, opts.websocketTimeout);

                if (abortSignal?.aborted) {
                    abortHandler();
                }
                abortSignal?.addEventListener('abort', abortHandler);
                this.log.debug(`connecting to ${url + params}`, this.logContext);
                if (this.ws) {
                    await this.close(false);
                }
                this.ws = new WebSocket(url + params);
                this.ws.binaryType = 'arraybuffer';

                this.ws.onopen = () => {
                    clearTimeout(wsTimeout);
                };

                this.ws.onerror = async (ev: Event) => {
                    if (this.state !== SignalConnectionState.CONNECTED) {
                        this.state = SignalConnectionState.DISCONNECTED;
                        clearTimeout(wsTimeout);
                        try {
                            const resp = await fetch(`http${url.substring(2)}/validate${params}`);
                            if (resp.status.toFixed(0).startsWith('4')) {
                                const msg = await resp.text();
                                reject(new ConnectionError(msg, ConnectionErrorReason.NotAllowed, resp.status));
                            } else {
                                reject(
                                    new ConnectionError(
                                        'Internal error',
                                        ConnectionErrorReason.InternalError,
                                        resp.status,
                                    ),
                                );
                            }
                        } catch (e) {
                            reject(
                                new ConnectionError(
                                    'server was not reachable',
                                    ConnectionErrorReason.ServerUnreachable,
                                ),
                            );
                        }
                        return;
                    }
                    // 其他错误，处理
                    this.handleWSError(ev);
                };

                this.ws.onmessage = async (ev: MessageEvent) => {
                    // 在收到 JoinResponse 之前不认为已连接
                    let resp: SignalResponse;
                    if (typeof ev.data === 'string') {
                        const json = JSON.parse(ev.data);
                        resp = SignalResponse.fromJson(json, {ignoreUnknownFields: true});
                    } else if (ev.data instanceof ArrayBuffer) {
                        resp = SignalResponse.fromBinary(new Uint8Array(ev.data));
                    } else {
                        this.log.error(
                            `could not decode websocket message: ${typeof ev.data}`,
                            this.logContext,
                        );
                        return;
                    }

                    if (this.state !== SignalConnectionState.CONNECTED) {
                        let shouldProcessMessage = false;
                        // 只处理连接消息
                        if (resp.message?.case === 'join') {
                            this.state = SignalConnectionState.CONNECTED;
                            abortSignal?.removeEventListener('abort', abortHandler);
                            this.pingTimeoutDuration = resp.message.value.pingTimeout;
                            this.pingIntervalDuration = resp.message.value.pingInterval;

                            if (this.pingTimeoutDuration && this.pingTimeoutDuration > 0) {
                                this.log.debug('ping config', {
                                    ...this.logContext,
                                    timeout: this.pingTimeoutDuration,
                                    interval: this.pingIntervalDuration,
                                });
                                this.startPingInterval();
                            }
                            resolve(resp.message.value);
                        } else if (
                            this.state === SignalConnectionState.RECONNECTING &&
                            resp.message.case !== 'leave'
                        ) {
                            // 在重新连接时，收到任何消息都意味着信号已重新连接
                            this.state = SignalConnectionState.CONNECTED;
                            abortSignal?.removeEventListener('abort', abortHandler);
                            this.startPingInterval();
                            if (resp.message?.case === 'reconnect') {
                                resolve(resp.message.value);
                            } else {
                                this.log.debug(
                                    'declaring signal reconnected without reconnect response received',
                                    this.logContext,
                                );
                                resolve(undefined);
                                shouldProcessMessage = true;
                            }
                        } else if (this.isEstablishingConnection && resp.message.case === 'leave') {
                            reject(
                                new ConnectionError(
                                    'Received leave request while trying to (re)connect',
                                    ConnectionErrorReason.LeaveRequest,
                                ),
                            );
                        } else if (!opts.reconnect) {
                            // 非重连情况，应该首先收到加入响应
                            reject(
                                new ConnectionError(
                                    `did not receive join response, got ${resp.message?.case} instead`,
                                ),
                            );
                        }
                        if (!shouldProcessMessage) {
                            return;
                        }
                    }

                    if (this.signalLatency) {
                        await sleep(this.signalLatency);
                    }
                    this.handleSignalResponse(resp);
                };

                this.ws.onclose = (ev: CloseEvent) => {
                    if (this.isEstablishingConnection) {
                        reject(new ConnectionError('Websocket got closed during a (re)connection attempt'));
                    }

                    this.log.warn(`websocket closed`, {
                        ...this.logContext,
                        reason: ev.reason,
                        code: ev.code,
                        wasClean: ev.wasClean,
                        state: this.state,
                    });
                    this.handleOnClose(ev.reason);
                };
            } finally {
                unlock();
            }
        });
    }

    /** @internal */
    resetCallbacks = () => {
        this.onAnswer = undefined;
        this.onLeave = undefined;
        this.onLocalTrackPublished = undefined;
        this.onLocalTrackUnpublished = undefined;
        this.onNegotiateRequested = undefined;
        this.onOffer = undefined;
        this.onRemoteMuteChanged = undefined;
        this.onSubscribedQualityUpdate = undefined;
        this.onTokenRefresh = undefined;
        this.onTrickle = undefined;
        this.onClose = undefined;
    };

    /**
     * 关闭
     * @param updateState 是否更新state
     */
    async close(updateState: boolean = true) {
        const unlock = await this.closingLock.lock();
        try {
            if (updateState) {
                this.state = SignalConnectionState.DISCONNECTING;
            }
            if (this.ws) {
                this.ws.onmessage = null;
                this.ws.onopen = null;
                this.ws.onclose = null;

                // 调用 `ws.close()` 仅开始关闭握手（CLOSING 状态），最好等到状态实际 CLOSED
                const closePromise = new Promise<void>((resolve) => {
                    if (this.ws) {
                        this.ws.onclose = () => {
                            resolve();
                        };
                    } else {
                        resolve();
                    }
                });

                if (this.ws.readyState < this.ws.CLOSING) {
                    this.ws.close();
                    // 250ms 宽限期，让 ws 优雅关闭
                    await Promise.race([closePromise, sleep(250)]);
                }
                this.ws = undefined;
            }
        } finally {
            if (updateState) {
                this.state = SignalConnectionState.DISCONNECTED;
            }
            this.clearPingInterval();
            unlock();
        }
    }

    // 加入后的初始offer
    sendOffer(offer: RTCSessionDescriptionInit) {
        this.log.debug('sending offer', {...this.logContext, offerSdp: offer.sdp});
        this.sendRequest({
            case: 'offer',
            value: toProtoSessionDescription(offer),
        });
    }

    // 应答服务器发起的offer
    sendAnswer(answer: RTCSessionDescriptionInit) {
        this.log.debug('sending answer', {...this.logContext, answerSdp: answer.sdp});
        return this.sendRequest({
            case: 'answer',
            value: toProtoSessionDescription(answer),
        });
    }

    sendIceCandidate(candidate: RTCIceCandidateInit, target: SignalTarget) {
        this.log.trace('sending ice candidate', {...this.logContext, candidate});
        return this.sendRequest({
            case: 'trickle',
            value: new TrickleRequest({
                candidateInit: JSON.stringify(candidate),
                target,
            }),
        });
    }

    sendMuteTrack(trackSid: string, muted: boolean) {
        return this.sendRequest({
            case: 'mute',
            value: new MuteTrackRequest({
                sid: trackSid,
                muted,
            }),
        });
    }

    /**
     * 发送添加音轨请求
     * @param req 添加请求
     */
    sendAddTrack(req: AddTrackRequest) {
        return this.sendRequest({
            case: 'addTrack',
            value: req,
        });
    }

    /**
     * 发送更新本地原数据请求
     * @param metadata 原数据
     * @param name 名称
     */
    sendUpdateLocalMetadata(metadata: string, name: string) {
        return this.sendRequest({
            case: 'updateMetadata',
            value: new UpdateParticipantMetadata({
                metadata,
                name,
            }),
        });
    }

    /**
     * 发送更新音轨设置的请求
     * @param settings 更新音轨设置的请求
     */
    sendUpdateTrackSettings(settings: UpdateTrackSettings) {
        this.sendRequest({
            case: 'trackSetting',
            value: settings,
        });
    }

    /**
     * 发送更新订阅信息的请求
     * @param sub 更新订阅的请求
     */
    sendUpdateSubscription(sub: UpdateSubscription) {
        return this.sendRequest({
            case: 'subscription',
            value: sub,
        });
    }

    /**
     * 发送同步状态的请求
     * @param sync 同步状态
     */
    sendSyncState(sync: SyncState) {
        return this.sendRequest({
            case: 'syncState',
            value: sync,
        });
    }

    /**
     * 发送更新视频层请求
     * @param trackSid 音轨sid
     * @param layers 视频层
     */
    sendUpdateVideoLayers(trackSid: string, layers: VideoLayer[]) {
        return this.sendRequest({
            case: 'updateLayers',
            value: new UpdateVideoLayers({
                trackSid,
                layers,
            }),
        });
    }

    /**
     * 发送更新订阅者权限
     */
    sendUpdateSubscriptionPermissions(allParticipants: boolean, trackPermissions: TrackPermission[]) {
        return this.sendRequest({
            case: 'subscriptionPermission',
            value: new SubscriptionPermission({
                allParticipants,
                trackPermissions,
            }),
        });
    }

    /**
     * 发送联播场景
     * @param scenario 联播场景
     */
    sendSimulateScenario(scenario: SimulateScenario) {
        return this.sendRequest({
            case: 'simulate',
            value: scenario,
        });
    }

    sendPing() {
        /** 发送 ping 和 pingReq 以兼容新旧服务器 */
        return Promise.all([
            this.sendRequest({
                case: 'ping',
                value: protoInt64.parse(Date.now()),
            }),
            this.sendRequest({
                case: 'pingReq',
                value: new Ping({
                    timestamp: protoInt64.parse(Date.now()),
                    rtt: protoInt64.parse(this.rtt),
                }),
            }),
        ]);
    }

    sendLeave() {
        return this.sendRequest({
            case: 'leave',
            value: new LeaveRequest({
                canReconnect: false,
                reason: DisconnectReason.CLIENT_INITIATED,
            }),
        });
    }

    /**
     * 发送消息
     * @param message 消息
     * @param fromQueue 是否来资源队列
     */
    async sendRequest(message: SignalMessage, fromQueue: boolean = false) {
        // 重新连接时捕获所有请求并将它们放入队列中
        // 除非请求来自队列，否则不要再次入队
        const canQueue = !fromQueue && !canPassThroughQueue(message);
        if (canQueue && this.state === SignalConnectionState.RECONNECTING) {
            this.queuedRequests.push(async () => {
                await this.sendRequest(message, true);
            });
            return;
        }
        // 确保先前排队的请求首先被发送
        if (!fromQueue) {
            await this.requestQueue.flush();
        }
        if (this.signalLatency) {
            await sleep(this.signalLatency);
        }
        if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
            this.log.error(
                `cannot send signal request before connected, type: ${message?.case}`,
                this.logContext,
            );
            return;
        }
        const req = new SignalRequest({message});

        try {
            if (this.useJSON) {
                this.ws.send(req.toJsonString());
            } else {
                this.ws.send(req.toBinary());
            }
        } catch (e) {
            this.log.error('error sending signal message', {...this.logContext, error: e});
        }
    }

    /**
     * 处理信令响应
     */
    private handleSignalResponse(res: SignalResponse) {
        const msg = res.message;
        if (msg === undefined) {
            this.log.debug('received unsupported message', this.logContext);
            return;
        }

        let pingHandled = false;
        if (msg.case === 'answer') {
            const sd = fromProtoSessionDescription(msg.value);
            if (this.onAnswer) {
                this.onAnswer(sd);
            }
        } else if (msg.case === 'offer') {
            const sd = fromProtoSessionDescription(msg.value);
            if (this.onOffer) {
                this.onOffer(sd);
            }
        } else if (msg.case === 'trickle') {
            const candidate: RTCIceCandidateInit = JSON.parse(msg.value.candidateInit!);
            if (this.onTrickle) {
                this.onTrickle(candidate, msg.value.target);
            }
        } else if (msg.case === 'update') {
            if (this.onParticipantUpdate) {
                this.onParticipantUpdate(msg.value.participants ?? []);
            }
        } else if (msg.case === 'trackPublished') {
            if (this.onLocalTrackPublished) {
                this.onLocalTrackPublished(msg.value);
            }
        } else if (msg.case === 'speakersChanged') {
            if (this.onSpeakersChanged) {
                this.onSpeakersChanged(msg.value.speakers ?? []);
            }
        } else if (msg.case === 'leave') {
            if (this.onLeave) {
                this.onLeave(msg.value);
            }
        } else if (msg.case === 'mute') {
            if (this.onRemoteMuteChanged) {
                this.onRemoteMuteChanged(msg.value.sid, msg.value.muted);
            }
        } else if (msg.case === 'roomUpdate') {
            if (this.onRoomUpdate && msg.value.room) {
                this.onRoomUpdate(msg.value.room);
            }
        } else if (msg.case === 'connectionQuality') {
            if (this.onConnectionQuality) {
                this.onConnectionQuality(msg.value);
            }
        } else if (msg.case === 'streamStateUpdate') {
            if (this.onStreamStateUpdate) {
                this.onStreamStateUpdate(msg.value);
            }
        } else if (msg.case === 'subscribedQualityUpdate') {
            if (this.onSubscribedQualityUpdate) {
                this.onSubscribedQualityUpdate(msg.value);
            }
        } else if (msg.case === 'subscriptionPermissionUpdate') {
            if (this.onSubscriptionPermissionUpdate) {
                this.onSubscriptionPermissionUpdate(msg.value);
            }
        } else if (msg.case === 'refreshToken') {
            if (this.onTokenRefresh) {
                this.onTokenRefresh(msg.value);
            }
        } else if (msg.case === 'trackUnpublished') {
            if (this.onLocalTrackUnpublished) {
                this.onLocalTrackUnpublished(msg.value);
            }
        } else if (msg.case === 'subscriptionResponse') {
            if (this.onSubscriptionError) {
                this.onSubscriptionError(msg.value);
            }
        } else if (msg.case === 'pong') {
        } else if (msg.case === 'pongResp') {
            this.rtt = Date.now() - Number.parseInt(msg.value.lastPingTimestamp.toString());
            this.resetPingTimeout();
            pingHandled = true;
        } else {
            this.log.debug('unsupported message', {...this.logContext, msgCase: msg.case});
        }

        if (!pingHandled) {
            this.resetPingTimeout();
        }
    }

    /**
     * 设置重新连接
     */
    setReconnected() {
        while (this.queuedRequests.length > 0) {
            const req = this.queuedRequests.shift();
            if (req) {
                this.requestQueue.run(req);
            }
        }
    }

    /**
     * 处理关闭消息
     */
    private async handleOnClose(reason: string) {
        if (this.state === SignalConnectionState.DISCONNECTED) {
            return;
        }
        const onCloseCallback = this.onClose;
        await this.close();
        this.log.debug(`websocket connection closed: ${reason}`, {...this.logContext, reason});
        if (onCloseCallback) {
            onCloseCallback(reason);
        }
    }

    /**
     * 处理websocket错误
     * @param ev 事件
     */
    private handleWSError(ev: Event) {
        this.log.error('websocket error', {...this.logContext, error: ev});
    }

    /**
     * 重置 ping 超时并开始新的超时。
     * 收到pong消息后调用此方法
     */
    private resetPingTimeout() {
        this.clearPingTimeout();
        if (!this.pingTimeoutDuration) {
            this.log.warn('ping timeout duration not set', this.logContext);
            return;
        }
        this.pingTimeout = CriticalTimers.setTimeout(() => {
            this.log.warn(
                `ping timeout triggered. last pong received at: ${new Date(
                    Date.now() - this.pingTimeoutDuration! * 1000,
                ).toUTCString()}`,
                this.logContext,
            );
            this.handleOnClose('ping timeout');
        }, this.pingTimeoutDuration * 1000);
    }

    /**
     * 清除 ping 超时（不启动新的超时）
     */
    private clearPingTimeout() {
        if (this.pingTimeout) {
            CriticalTimers.clearTimeout(this.pingTimeout);
        }
    }

    /**
     * 开始Ping间隔
     */
    private startPingInterval() {
        this.clearPingInterval();
        this.resetPingTimeout();
        if (!this.pingIntervalDuration) {
            this.log.warn('ping interval duration not set', this.logContext);
            return;
        }
        this.log.debug('start ping interval', this.logContext);
        this.pingInterval = CriticalTimers.setInterval(() => {
            this.sendPing();
        }, this.pingIntervalDuration * 1000);
    }

    /**
     * 清除Ping间隔
     */
    private clearPingInterval() {
        this.log.debug('clearing ping interval', this.logContext);
        this.clearPingTimeout();
        if (this.pingInterval) {
            CriticalTimers.clearInterval(this.pingInterval);
        }
    }
}

/**
 *  从协议会议描述转换为RTC的会话描述
 * @param sd 协议描述信息
 */
function fromProtoSessionDescription(sd: SessionDescription): RTCSessionDescriptionInit {
    const rsd: RTCSessionDescriptionInit = {
        type: 'offer',
        sdp: sd.sdp,
    };
    switch (sd.type) {
        case 'answer':
        case 'offer':
        case 'pranswer':
        case 'rollback':
            rsd.type = sd.type;
            break;
        default:
            break;
    }
    return rsd;
}

/**
 * 把RTC描述信息转换为协议描述信息
 * @param rsd
 */
export function toProtoSessionDescription(
    rsd: RTCSessionDescription | RTCSessionDescriptionInit
): SessionDescription {
    return new SessionDescription({
        sdp: rsd.sdp!,
        type: rsd.type!,
    });
}

/**
 * 创建连接的参数
 */
function createConnectionParams(token: string, info: ClientInfo, opts: ConnectOpts): string {
    const params = new URLSearchParams();
    params.set('access_token', token);

    // 选项
    if (opts.reconnect) {
        params.set('reconnect', '1');
        if (opts.sid) {
            params.set('sid', opts.sid);
        }
    }

    params.set('auto_subscribe', opts.autoSubscribe ? '1' : '0');

    // 客户信息
    params.set('sdk', isReactNative() ? 'reactnative' : 'js');
    params.set('version', info.version!);
    params.set('protocol', info.protocol!.toString());
    if (info.deviceModel) {
        params.set('device_model', info.deviceModel);
    }
    if (info.os) {
        params.set('os', info.os);
    }
    if (info.osVersion) {
        params.set('os_version', info.osVersion);
    }
    if (info.browser) {
        params.set('browser', info.browser);
    }
    if (info.browserVersion) {
        params.set('browser_version', info.browserVersion);
    }
    if (opts.adaptiveStream) {
        params.set('adaptive_stream', '1');
    }
    if (opts.reconnectReason) {
        params.set('reconnect_reason', opts.reconnectReason.toString());
    }
    // @ts-ignore
    if (navigator.connection?.type) {
        // @ts-ignore
        params.set('network', navigator.connection.type);
    }

    return `?${params.toString()}`;
}