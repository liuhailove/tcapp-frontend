import PCTransport, {PCEvents} from "./PCTransport";
import {roomConnectOptionDefaults} from "./defaults";
import {SignalTarget} from "../protocol/tc_rtc_pb";
import {Mutex, sleep} from "./utils";
import log, {getLogger, LoggerNames} from '../logger';
import {LoggerOptions} from "./types";
import CriticalTimers from "./timers";
import {ConnectionError, ConnectionErrorReason} from "./errors";

export enum PCTransportState {
    NEW,
    CONNECTING,
    CONNECTED,
    FAILED,
    CLOSING,
    CLOSED,
}

/**
 * 通信管理
 */
export class PCTransportManager {
    /**
     * 发布者
     */
    public publisher: PCTransport;

    /**
     * 订阅者
     */
    public subscriber: PCTransport;

    /**
     * 对等连接超时时间
     */
    public peerConnectionTimeout: number = roomConnectOptionDefaults.peerConnectionTimeout;

    /**
     * 是否需要发布者连接
     */
    public get needsPublisher() {
        return this.isPublisherConnectionRequired;
    }

    /**
     * 是否需要订阅者连接
     */
    public get needsSubscriber() {
        return this.isSubscriberConnectionRequired;
    }

    /**
     * 当前状态
     */
    public get currentState() {
        return this.state;
    }

    /**
     * 状态变更事件
     */
    public onStateChange?: (
        state: PCTransportState,
        pubState: RTCPeerConnectionState,
        subState: RTCPeerConnectionState,
    ) => void;

    /**
     * ice候选事件
     */
    public onIceCandidate?: (ev: RTCIceCandidate, target: SignalTarget) => void;

    /**
     * 数据渠道事件
     */
    public onDataChannel?: (ev: RTCDataChannelEvent) => void;

    /**
     * 音轨事件
     */
    public onTrack?: (ev: RTCTrackEvent) => void;

    /**
     * 发布者offer事件
     */
    public onPublisherOffer?: (offer: RTCSessionDescriptionInit) => void;

    /**
     * 是否需要发布者连接
     */
    private isPublisherConnectionRequired: boolean;

    /**
     * 是否需要订阅者连接
     */
    private isSubscriberConnectionRequired: boolean;

    /**
     *  通信状态
     */
    private state: PCTransportState;

    /**
     * 连接锁
     */
    private connectionLock: Mutex;

    /**
     * log
     */
    private log = log;

    /**
     * log选项
     */
    private loggerOptions: LoggerOptions;

    constructor(
        rtcConfig: RTCConfiguration,
        subscriberPrimary: boolean,
        loggerOptions: LoggerOptions,
    ) {
        this.log = getLogger(loggerOptions.loggerName ?? LoggerNames.PCManager);
        this.loggerOptions = loggerOptions;

        this.isPublisherConnectionRequired = !subscriberPrimary;
        this.isSubscriberConnectionRequired = subscriberPrimary;
        this.publisher = new PCTransport(rtcConfig, loggerOptions);
        this.subscriber = new PCTransport(rtcConfig, loggerOptions);

        this.publisher.onConnectionStateChange = this.updateState;
        this.subscriber.onConnectionStateChange = this.updateState;
        this.publisher.onIceConnectionStateChange = this.updateState;
        this.subscriber.onIceConnectionStateChange = this.updateState;
        this.publisher.onSignalingStatechange = this.updateState;
        this.subscriber.onSignalingStatechange = this.updateState;
        this.publisher.onIceCandidate = (candidate) => {
            this.onIceCandidate?.(candidate, SignalTarget.PUBLISHER);
        };
        this.subscriber.onIceCandidate = (candidate) => {
            this.onIceCandidate?.(candidate, SignalTarget.SUBSCRIBER);
        };
        // 在订阅者主模式下，服务器端打开子数据通道。
        this.subscriber.onDataChannel = (ev) => {
            this.onDataChannel?.(ev);
        };
        this.subscriber.onTrack = (ev) => {
            this.onTrack?.(ev);
        };
        this.publisher.onOffer = (offer) => {
            this.onPublisherOffer?.(offer);
        };

        this.state = PCTransportState.NEW;

        this.connectionLock = new Mutex();
    }

    private get logContext() {
        return {
            ...this.loggerOptions.loggerContextCb?.(),
        };
    }

    requirePublisher(require = true) {
        this.isPublisherConnectionRequired = require;
        this.updateState();
    }

    requireSubscriber(require = true) {
        this.isSubscriberConnectionRequired = require;
        this.updateState();
    }

    createAndSendPublisherOffer(options?: RTCOfferOptions) {
        return this.publisher.createAndSendOffer(options);
    }

    setPublisherAnswer(sd: RTCSessionDescriptionInit) {
        return this.publisher.setRemoteDescription(sd);
    }

    removeTrack(sender: RTCRtpSender) {
        return this.publisher.removeTrack(sender);
    }

    async close() {
        if (this.publisher && this.publisher.getSignallingState() !== 'closed') {
            const publisher = this.publisher;
            for (const sender of publisher.getSenders()) {
                try {
                    // TODO：react-native-webrtc 还没有removeTrack。
                    if (publisher.canRemoveTrack()) {
                        publisher.removeTrack(sender);
                    }
                } catch (e) {
                    this.log.warn('could not removeTrack', {...this.logContext, error: e});
                }
            }
        }
        await Promise.all([this.publisher.close(), this.subscriber.close()]);
        this.updateState();
    }

    /**
     * 触发Ice重启
     */
    async triggerIceRestart() {
        this.subscriber.restartingIce = true;
        // 仅在需要时重新启动发布者
        if (this.needsPublisher) {
            await this.createAndSendPublisherOffer({iceRestart: true});
        }
    }

    /**
     * 添加候选
     * @param candidate 候选
     * @param target 信令目标
     */
    async addIceCandidate(candidate: RTCIceCandidateInit, target: SignalTarget) {
        if (target === SignalTarget.PUBLISHER) {
            await this.publisher.addIceCandidate(candidate);
        } else {
            await this.subscriber.addIceCandidate(candidate);
        }
    }


    /**
     * 根据offer创建订阅者Answer
     * @param sd 会话描述
     */
    async createSubscriberAnswerFromOffer(sd: RTCSessionDescriptionInit) {
        this.log.debug('received server offer', {
            ...this.logContext,
            RTCSdpType: sd.type,
            sdp: sd.sdp,
            signalingState: this.subscriber.getSignallingState().toString(),
        });
        await this.subscriber.setRemoteDescription(sd);

        // 应答offer
        return await this.subscriber.createAndSetAnswer();
    }

    /**
     * 更新配置
     * @param config 配置信息
     * @param iceRestart 是否重启
     */
    updateConfiguration(config: RTCConfiguration, iceRestart?: boolean) {
        this.publisher.setConfiguration(config);
        this.subscriber.setConfiguration(config);
        if (iceRestart) {
            this.triggerIceRestart();
        }
    }

    /**
     * 确保PC通信连接
     * @param abortController 中断处理
     * @param timeout 超时时间
     */
    async ensurePCTransportConnection(abortController?: AbortController, timeout?: number) {
        const unlock = await this.connectionLock.lock();
        try {
            if (
                this.isPublisherConnectionRequired &&
                this.publisher.getConnectionState() !== 'connected' &&
                this.publisher.getConnectionState() !== 'connecting'
            ) {
                this.log.debug('negotiation required, start negotiating', this.logContext);
                this.publisher.negotiate();
            }
            await Promise.all(
                this.requiredTransports?.map((transport) =>
                    this.ensureTransportConnected(transport, abortController, timeout),
                ),
            );
        } finally {
            unlock();
        }
    }

    /**
     * 协商
     */
    async negotiate(abortController: AbortController) {
        return new Promise<void>(async (resolve, reject) => {
            const negotiationTimeout = setTimeout(() => {
                reject('negotiation timed out');
            }, this.peerConnectionTimeout);

            const abortHandler = () => {
                clearTimeout(negotiationTimeout);
                reject('negotiation aborted');
            };

            abortController.signal.addEventListener('abort', abortHandler);
            this.publisher.once(PCEvents.NegotiationStarted, () => {
                if (abortController.signal.aborted) {
                    return;
                }
                this.publisher.once(PCEvents.NegotiationComplete, () => {
                    clearTimeout(negotiationTimeout);
                    resolve();
                });
            });

            await this.publisher.negotiate((e) => {
                clearTimeout(negotiationTimeout);
                reject(e);
            });
        });
    }

    addPublisherTransceiver(track: MediaStreamTrack, transceiverInit: RTCRtpTransceiverInit) {
        return this.publisher.addTransceiver(track, transceiverInit);
    }

    addPublisherTrack(track: MediaStreamTrack) {
        return this.publisher.addTrack(track);
    }

    createPublisherDataChannel(label: string, dataChannelDict: RTCDataChannelInit) {
        return this.publisher.createDataChannel(label, dataChannelDict);
    }

    /**
     * 如果没有指定明确的目标，则返回第一个所需传输的地址
     */
    getConnectedAddress(target?: SignalTarget) {
        if (target === SignalTarget.PUBLISHER) {
            return this.publisher.getConnectedAddress();
        } else if (target === SignalTarget.SUBSCRIBER) {
            return this.publisher.getConnectedAddress();
        }
        return this.requiredTransports[0].getConnectedAddress();
    }

    private get requiredTransports() {
        const transports: PCTransport[] = [];
        if (this.isPublisherConnectionRequired) {
            transports.push(this.publisher);
        }
        if (this.isSubscriberConnectionRequired) {
            transports.push(this.subscriber);
        }
        return transports;
    }

    /**
     * 更新状态
     */
    private updateState = () => {
        const previousState = this.state;

        const connectionStates = this.requiredTransports.map((tr) => tr.getConnectionState());
        if (connectionStates.every((st) => st === 'connected')) {
            this.state = PCTransportState.CONNECTED;
        } else if (connectionStates.some((st) => st === 'failed')) {
            this.state = PCTransportState.FAILED;
        } else if (connectionStates.some((st) => st === 'connecting')) {
            this.state = PCTransportState.CONNECTING;
        } else if (connectionStates.every((st) => st === 'closed')) {
            this.state = PCTransportState.CLOSED;
        } else if (connectionStates.some((st) => st === 'closed')) {
            this.state = PCTransportState.CLOSING;
        } else if (connectionStates.every((st) => st === 'new')) {
            this.state = PCTransportState.NEW;
        }

        if (previousState !== this.state) {
            this.log.debug(
                `pc state change: from ${PCTransportState[previousState]} to ${
                    PCTransportState[this.state]
                }`,
                this.logContext,
            );
            this.onStateChange?.(
                this.state,
                this.publisher.getConnectionState(),
                this.subscriber.getConnectionState(),
            );
        }
    };

    private async ensureTransportConnected(
        pcTransport: PCTransport,
        abortController?: AbortController,
        timeout: number = this.peerConnectionTimeout,
    ) {
        const connectionState = pcTransport.getConnectionState();
        if (connectionState === 'connected') {
            return;
        }

        return new Promise<void>(async (resolve, reject) => {
            const abortHandler = () => {
                this.log.warn('abort transport connection', this.logContext);
                CriticalTimers.clearTimeout(connectTimeout);

                reject(
                    new ConnectionError(
                        'room connection has been cancelled',
                        ConnectionErrorReason.Cancelled,
                    ),
                );
            };
            if (abortController?.signal.aborted) {
                abortHandler();
            }
            abortController?.signal.addEventListener('abort', abortHandler);

            const connectTimeout = CriticalTimers.setTimeout(() => {
                abortController?.signal.removeEventListener('abort', abortHandler);
                reject(new ConnectionError('could not establish pc connection'));
            }, timeout);

            while (this.state !== PCTransportState.CONNECTED) {
                //修复我们不应该依赖连接路径中的“sleep”，因为它会调用“setTimeout”，而浏览器实现会极大地限制它
                await sleep(50);
                if (abortController?.signal.aborted) {
                    reject(
                        new ConnectionError(
                            'room connection has been cancelled',
                            ConnectionErrorReason.Cancelled,
                        ),
                    );
                    return;
                }
            }
            CriticalTimers.clearTimeout(connectTimeout);
            abortController?.signal.removeEventListener('abort', abortHandler);
            resolve();
        });
    }
}
