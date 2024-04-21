/**
 * 连接状态
 */
import TypedEventEmitter from "typed-emitter";
import {EventEmitter} from "events";
import log, {getLogger, LoggerNames} from '../logger';

import {
    ConnectionQuality,
    DataPacket_Kind,
    DisconnectReason,
    ParticipantInfo,
    ParticipantInfo_State,
    ParticipantPermission,
    Room as RoomModel,
    ServerInfo,
    SpeakerInfo,
    SubscriptionError,
    TrackInfo,
    TrackSource,
    TrackType,
    UserPacket,
} from "../protocol/tc_models_pb";
import RemoteTrack from "./track/RemoteTrack";
import {TrackPublication} from "./track/TrackPublication";
import {Track} from "./track/Track";
import RemoteTrackPublication from "./track/RemoteTrackPublication";
import RemoteParticipant from "./participant/RemoteParticipant";
import Participant from "./participant/Participant";
import LocalParticipant from "./participant/LocalParticipant";
import LocalTrackPublication from "./track/LocalTrackPublication";
import RTCEngine from "./RTCEngine";
import {
    InternalRoomConnectOptions,
    InternalRoomOptions,
    RoomConnectOptions,
    RoomOptions
} from "../options";
import {
    createDummyVideoStreamTrack,
    Future,
    getEmptyAudioStreamTrack,
    isBrowserSupported,
    isCloud,
    isReactNative,
    isWeb,
    Mutex,
    supportsSetSinkId,
    toHttpUrl,
    unpackStreamId,
    unwrapConstraint
} from "./utils";
import {E2EEManager} from "../e2ee/E2eeManager";
import {
    audioDefaults,
    publishDefaults,
    roomOptionDefaults,
    videoDefaults
} from "./defaults";
import {EncryptionEvent} from "../e2ee";
import {EngineEvent, ParticipantEvent, RoomEvent, TrackEvent} from "./TrackEvents";
import DeviceManager from "./DeviceManager";
import {RegionUrlProvider} from "./RegionUrlProvider";
import {ConnectionError, ConnectionErrorReason, UnsupportedServer} from "./errors";
import {
    ConnectionQualityUpdate,
    JoinResponse,
    LeaveRequest,
    SimulateScenario,
    StreamStateUpdate,
    SubscriptionPermissionUpdate,
    SubscriptionResponse
} from "../protocol/tc_rtc_pb";
import {getBrowser} from "../utils/browserParser";
import {getNewAudioContext, sourceToKind} from "./track/utils.ts";
import CriticalTimers from "./timers.ts";
import {TrackProcessor} from "./track/processor/types.ts";
import LocalAudioTrack from "./track/LocalAudioTrack.ts";
import {SimulationOptions} from "./types.ts";
import {protoInt64} from "@bufbuild/protobuf";
import LocalVideoTrack from "./track/LocalVideoTrack.ts";
import {AdaptiveStreamSettings} from "./track/types.ts";

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
    /**
     * 链接状态
     */
    state: ConnectionState = ConnectionState.Disconnected;

    /**
     * identity->RemoteParticipant映射
     */
    remoteParticipants: Map<string, RemoteParticipant>;

    /**
     * 列举活跃发言的参与者.事件[[RoomEvent.ActiveSpeakersChanged]]会触发列表变化
     */
    activeSpeakers: Participant[] = [];

    /**
     * rtc引擎
     */
    /** @internal */
    engine!: RTCEngine;

    /**
     * 当前参与者
     */
    localParticipant: LocalParticipant;

    /**
     * room选项
     */
    options: InternalRoomOptions;

    /**
     * 本地参与者发送加密状态的反应
     */
    isE2EEEnabled: boolean = false;

    /**
     * 房间信息
     */
    private roomInfo?: RoomModel;

    /**
     * sid->identity映射
     */
    private sidToIdentity: Map<string, string>;

    /**
     * 房间连接选项
     */
    private connOptions?: InternalRoomConnectOptions;

    /**
     * 是否启用音频
     */
    private audioEnabled = true;

    /**
     * 音频上下文
     */
    private audioContext?: AudioContext;

    /**
     * 中断和TCApp服务待连接的请求
     * @private
     */
    private abortController?: AbortController;

    /**
     * 保持客户端初始化连接尝试
     */
    private connectFuture?: Future<void>;

    /**
     * 断开连接锁
     */
    private disconnectLock: Mutex;

    /**
     * e2ee管理
     */
    private e2eeManager: E2EEManager | undefined;

    /**
     * 连接协调间隔
     */
    private connectionReconcileInterval?: ReturnType<typeof setInterval>;

    /**
     * 区域Url提供者
     */
    private regionUrlProvider?: RegionUrlProvider;

    /**
     * 区域URL
     */
    private regionUrl?: string;

    /**
     * 视频播放被阻止
     */
    private isVideoPlaybackBlocked: boolean = false;

    /**
     * 日志
     */
    private log = log;

    /**
     * 缓存的事件
     */
    private bufferedEvents: Array<any> = [];

    /**
     * 是否正在恢复
     */
    private isResuming: boolean = false;

    /**
     * 创建一个新的 Room，这是 LiveKit 会话的主要构造。
     * @param options
     */
    constructor(options?: RoomOptions) {
        super();
        this.setMaxListeners(100);
        this.remoteParticipants = new Map();
        this.sidToIdentity = new Map();
        this.options = {...roomOptionDefaults, ...options};

        this.log = getLogger(this.options.loggerName ?? LoggerNames.Room);

        this.options.audioCaptureDefaults = {
            ...audioDefaults,
            ...options?.audioCaptureDefaults,
        };
        this.options.videoCaptureDefaults = {
            ...videoDefaults,
            ...options?.videoCaptureDefaults,
        };
        this.options.publishDefaults = {
            ...publishDefaults,
            ...options?.publishDefaults,
        };

        this.maybeCreateEngine();

        this.disconnectLock = new Mutex();

        this.localParticipant = new LocalParticipant('', '', this.engine, this.options);

        if (this.options.videoCaptureDefaults.deviceId) {
            this.localParticipant.activeDeviceMap.set(
                'videoinput',
                unwrapConstraint(this.options.videoCaptureDefaults.deviceId),
            );
        }
        if (this.options.audioCaptureDefaults.deviceId) {
            this.localParticipant.activeDeviceMap.set(
                'audioinput',
                unwrapConstraint(this.options.audioCaptureDefaults.deviceId),
            );
        }
        if (this.options.audioOutput?.deviceId) {
            this.switchActiveDevice(
                'audiooutput',
                unwrapConstraint(this.options.audioOutput.deviceId),
            ).catch((e) => this.log.warn(`Could not set audio output: ${e.message}`));
        }

        if (this.options.e2ee) {
            this.setupE2EE();
        }
    }

    /**
     * @experimental
     */
    async setE2EEEnabled(enabled: boolean) {
        if (this.e2eeManager) {
            await Promise.all([this.localParticipant.setE2EEEnabled(enabled)]);
            if (this.localParticipant.identity !== '') {
                this.e2eeManager.setParticipantCryptorEnabled(enabled, this.localParticipant.identity);
            }
        } else {
            throw Error('e2ee not configured, please set e2ee settings within the room options');
        }
    }

    /**
     * 是否使用E2EE
     */
    private setupE2EE() {
        if (this.options.e2ee) {
            this.e2eeManager = new E2EEManager(this.options.e2ee);
            this.e2eeManager.on(
                EncryptionEvent.ParticipantEncryptionStatusChanged,
                (enabled, participant) => {
                    if (participant instanceof LocalParticipant) {
                        this.isE2EEEnabled = enabled;
                    }
                    this.emit(RoomEvent.ParticipantEncryptionStatusChanged, enabled, participant);
                },
            );
            this.e2eeManager.on(EncryptionEvent.EncryptionError, (error) => {
                this.emit(RoomEvent.EncryptionError, error);
            });
            this.e2eeManager?.setup(this);
        }
    }

    private get logContext() {
        return {
            room: this.name,
            roomId: this.roomInfo?.sid,
            participant: this.localParticipant.identity,
            pID: this.localParticipant.sid,
        };
    }

    /**
     * 如果当前房间有一个参与者，其 JWT 授权中包含“recorder: true”
     */
    get isRecording(): boolean {
        return this.roomInfo?.activeRecording ?? false;
    }

    /**
     * 服务器分配唯一的房间 ID。
     * 服务器发出 sid 后返回。
     */
    async getSid(): Promise<string> {
        if (this.state === ConnectionState.Disconnected) {
            return '';
        }
        if (this.roomInfo && this.roomInfo.sid !== '') {
            return this.roomInfo.sid;
        }
        return new Promise<string>((resolve, reject) => {
            const handleRoomUpdate = (roomInfo: RoomModel) => {
                if (roomInfo.sid !== '') {
                    this.engine.off(EngineEvent.RoomUpdate, handleRoomUpdate);
                    resolve(roomInfo.sid);
                }
            };
            this.engine.on(EngineEvent.RoomUpdate, handleRoomUpdate);
            this.once(RoomEvent.Disconnected, () => {
                this.engine.off(EngineEvent.RoomUpdate, handleRoomUpdate);
                reject('Room disconnected before room server id was available');
            });
        });
    }

    /** 用户分配的名称，源自 JWT 令牌 */
    get name(): string {
        return this.roomInfo?.name ?? '';
    }

    /**
     * 房间原数据
     */
    get metadata(): string | undefined {
        return this.roomInfo?.metadata;
    }

    /**
     * 房间的参与者数量
     */
    get numParticipants(): number {
        return this.roomInfo?.numParticipants ?? 0;
    }

    /**
     * 可能要创建引擎
     */
    private maybeCreateEngine() {
        if (this.engine && !this.engine.isClosed) {
            return;
        }

        this.engine = new RTCEngine(this.options);

        this.engine
            .on(EngineEvent.ParticipantUpdate, this.handleParticipantUpdates)
            .on(EngineEvent.RoomUpdate, this.handleRoomUpdate)
            .on(EngineEvent.SpeakersChanged, this.handleSpeakersChanged)
            .on(EngineEvent.StreamStateChanged, this.handleStreamStateUpdate)
            .on(EngineEvent.ConnectionQualityUpdate, this.handleConnectionQualityUpdate)
            .on(EngineEvent.SubscriptionError, this.handleSubscriptionError)
            .on(EngineEvent.SubscriptionPermissionUpdate, this.handleSubscriptionPermissionUpdate)
            .on(
                EngineEvent.MediaTrackAdded,
                (mediaTrack: MediaStreamTrack, stream: MediaStream, receiver?: RTCRtpReceiver) => {
                    this.onTrackAdded(mediaTrack, stream, receiver);
                },
            )
            .on(EngineEvent.Disconnected, (reason?: DisconnectReason) => {
                this.handleDisconnect(this.options.stopLocalTrackOnUnpublish, reason);
            })
            .on(EngineEvent.ActiveSpeakersUpdate, this.handleActiveSpeakersUpdate)
            .on(EngineEvent.DataPacketReceived, this.handleDataPacket)
            .on(EngineEvent.Resuming, () => {
                this.clearConnectionReconcile();
                this.isResuming = true;
                this.log.info('Resuming signal connection', this.logContext);
            })
            .on(EngineEvent.Resumed, () => {
                this.registerConnectionReconcile();
                this.isResuming = false;
                this.log.info('Resumed signal connection', this.logContext);
                this.updateSubscriptions();
                this.emitBufferedEvents();
            })
            .on(EngineEvent.SignalResumed, () => {
                this.bufferedEvents = [];
                if (this.state === ConnectionState.Reconnecting || this.isResuming) {
                    this.sendSyncState();
                }
            })
            .on(EngineEvent.Restarting, this.handleRestarting)
            .on(EngineEvent.SignalRestarted, this.handleSignalRestarted)
            .on(EngineEvent.Offline, () => {
                if (this.setAndEmitConnectionState(ConnectionState.Reconnecting)) {
                    this.emit(RoomEvent.Reconnecting);
                }
            })
            .on(EngineEvent.DCBufferStatusChanged, (status, kind) => {
                this.emit(RoomEvent.DCBufferStatusChanged, status, kind);
            });

        if (this.localParticipant) {
            this.localParticipant.setupEngine(this.engine);
        }
        if (this.e2eeManager) {
            this.e2eeManager.setupEngine(this.engine);
        }
    }

    /**
     * getLocalDevices 抽象 navigator.mediaDevices.enumerateDevices。
     * 特别是，它处理 Chrome 创建“default”的独特行为
     * 设备。 遇到时，它将从设备列表中删除。
     * 实际的默认设备将放置在顶部。
     * @param kind
     * @return 可用本地设备列表
     */
    static getLocalDevices(
        kind?: MediaDeviceKind,
        requestPermissions: boolean = true,
    ): Promise<MediaDeviceInfo[]> {
        return DeviceManager.getInstance().getDevices(kind, requestPermissions);
    }

    /**
     * 页面加载后应立即调用prepareConnection，以便
     * 加快连接尝试速度。 该功能将
     * - 执行 DNS 解析并预热 DNS 缓存
     * - 建立 TLS 连接并缓存 TLS 密钥
     *
     * 借助TcApp Cloud，它还将确定最佳的边缘数据中心
     * 如果提供了令牌，则连接到当前客户端。
     */
    async prepareConnection(url: string, token?: string) {
        if (this.state !== ConnectionState.Disconnected) {
            return;
        }
        this.log.debug(`prepareConnection to ${url}`, this.logContext);
        try {
            if (isCloud(new URL(url)) && token) {
                this.regionUrlProvider = new RegionUrlProvider(url, token);
                const regionUrl = await this.regionUrlProvider.getNextBestRegionUrl();
                // 如果尝试已经开始，我们将不会替换regionUrl
                // 避免在新的连接尝试开始后覆盖 RegionUrl
                if (regionUrl && this.state === ConnectionState.Disconnected) {
                    this.regionUrl = regionUrl;
                    await fetch(toHttpUrl(regionUrl), {method: 'HEAD'});
                    this.log.debug(`prepared connection to ${regionUrl}`, this.logContext);
                }
            } else {
                await fetch(toHttpUrl(url), {method: 'HEAD'});
            }
        } catch (e) {
            this.log.warn('could not prepare connection', {...this.logContext, error: e});
        }
    }

    /**
     * 连接函数
     */
    connect = async (url: string, token: string, opts?: RoomConnectOptions): Promise<void> => {
        if (!isBrowserSupported()) {
            if (isReactNative()) {
                throw Error("WebRTC isn't detected, have you called registerGlobals?");
            } else {
                throw Error(
                    "TcApp doesn't seem to be supported on this browser. Try to update your browser and make sure no browser extensions disabling webRTC.",
                );
            }
        }

        // 如果在连接调用之前发生了断开连接调用，请通过等待其锁定来确保首先完成断开连接
        const unlockDisconnect = await this.disconnectLock.lock();

        if (this.state === ConnectionState.Connected) {
            // 当状态为重连或已连接时，该函数立即返回
            this.log.info(`already connected to room ${this.name}`, this.logContext);
            unlockDisconnect();
            return Promise.resolve();
        }

        if (this.connectFuture) {
            unlockDisconnect();
            return this.connectFuture.promise;
        }

        this.setAndEmitConnectionState(ConnectionState.Connecting);
        if (this.regionUrlProvider?.getServerUrl().toString() !== url) {
            this.regionUrl = undefined;
            this.regionUrlProvider = undefined;
        }
        if (isCloud(new URL(url))) {
            if (this.regionUrlProvider === undefined) {
                this.regionUrlProvider = new RegionUrlProvider(url, token);
            } else {
                this.regionUrlProvider.updateToken(token);
            }
            // 触发第一次获取而不等待响应
            // 如果初始连接失败，这将加快后续运行中选择区域 URL 的速度
            this.regionUrlProvider.fetchRegionSettings().catch((e) => {
                this.log.warn('could not fetch region settings', {...this.logContext, error: e});
            });
        }

        const connectFn = async (
            resolve: () => void,
            reject: (reason: any) => void,
            regionUrl?: string,
        ) => {
            if (this.abortController) {
                this.abortController.abort();
            }

            // 显式创建本地变量，以满足 TS 编译器的需要，并将其传递给“attemptConnection”
            const abortController = new AbortController();
            this.abortController = abortController;

            // 此时连接的意图已被发出，因此我们可以再次通过disconnect()取消连接
            unlockDisconnect?.();

            try {
                await this.attemptConnection(regionUrl ?? url, token, opts, abortController);
                this.abortController = undefined;
                resolve();
            } catch (e) {
                if (
                    this.regionUrlProvider &&
                    e instanceof ConnectionError &&
                    e.reason !== ConnectionErrorReason.Cancelled &&
                    e.reason !== ConnectionErrorReason.NotAllowed
                ) {
                    let nextUrl: string | null = null;
                    try {
                        nextUrl = await this.regionUrlProvider.getNextBestRegionUrl(
                            this.abortController?.signal,
                        );
                    } catch (error) {
                        if (
                            error instanceof ConnectionError &&
                            (error.status === 401 || error.reason === ConnectionErrorReason.Cancelled)
                        ) {
                            this.handleDisconnect(this.options.stopLocalTrackOnUnpublish);
                            reject(error);
                            return;
                        }
                    }
                    if (nextUrl) {
                        this.log.info(
                            `Initial connection failed with ConnectionError: ${e.message}. Retrying with another region: ${nextUrl}`,
                            this.logContext,
                        );
                        this.recreateEngine();
                        await connectFn(resolve, reject, nextUrl);
                    } else {
                        this.handleDisconnect(this.options.stopLocalTrackOnUnpublish);
                        reject(e);
                    }
                } else {
                    this.handleDisconnect(this.options.stopLocalTrackOnUnpublish);
                    reject(e);
                }
            }
        };

        const regionUrl = this.regionUrl;
        this.regionUrl = undefined;
        this.connectFuture = new Future(
            (resolve, reject) => {
                connectFn(resolve, reject, regionUrl);
            },
            () => {
                this.clearConnectionFutures();
            },
        );

        return this.connectFuture.promise;
    };

    /**
     * 连接信号
     */
    private connectSignal = async (
        url: string,
        token: string,
        engine: RTCEngine,
        connectOptions: InternalRoomConnectOptions,
        roomOptions: InternalRoomOptions,
        abortController: AbortController,
    ): Promise<JoinResponse> => {
        const joinResponse = await engine.join(
            url,
            token,
            {
                autoSubscribe: connectOptions.autoSubscribe,
                adaptiveStream:
                    typeof roomOptions.adaptiveStream === 'object' ? true : roomOptions.adaptiveStream,
                maxRetries: connectOptions.maxRetries,
                e2eeEnabled: !!this.e2eeManager,
                websocketTimeout: connectOptions.websocketTimeout,
            },
            abortController.signal,
        );

        let serverInfo: Partial<ServerInfo> | undefined = joinResponse.serverInfo;
        if (!serverInfo) {
            serverInfo = {version: joinResponse.serverVersion, region: joinResponse.serverRegion};
        }

        this.log.debug(
            `connected to TcApp Server ${Object.entries(serverInfo)
                .map(([key, value]) => `${key}: ${value}`)
                .join(', ')}`,
            {
                room: joinResponse.room?.name,
                roomSid: joinResponse.room?.sid,
                identity: joinResponse.participant?.identity,
            },
        );

        if (!joinResponse.serverVersion) {
            throw new UnsupportedServer('unknown server version');
        }

        if (joinResponse.serverVersion === '0.15.1' && this.options.dynacast) {
            this.log.debug('disabling dynacast due to server version', this.logContext);
            // dynacast has a bug in 0.15.1, so we cannot use it then
            roomOptions.dynacast = false;
        }

        return joinResponse;
    }

    /**
     * 应用joinResponse
     * @param joinResponse
     */
    private applyJoinResponse = (joinResponse: JoinResponse) => {
        const pi = joinResponse.participant!;

        this.localParticipant.sid = pi.sid;
        this.localParticipant.identity = pi.identity;

        if (this.options.e2ee && this.e2eeManager) {
            try {
                this.e2eeManager.setSifTrailer(joinResponse.sifTrailer);
            } catch (e: any) {
                this.log.error(e instanceof Error ? e.message : 'Could not set SifTrailer', {
                    ...this.logContext,
                    error: e,
                });
            }
        }

        // 填充远程参与者，这些不应触发新事件
        this.handleParticipantUpdates([pi, ...joinResponse.otherParticipants]);

        if (joinResponse.room) {
            this.handleRoomUpdate(joinResponse.room);
        }
    };

    /**
     * 尝试连接
     */
    private attemptConnection = async (
        url: string,
        token: string,
        opts: RoomConnectOptions | undefined,
        abortController: AbortController,
    ) => {
        if (
            this.state === ConnectionState.Reconnecting ||
            this.isResuming ||
            this.engine?.pendingReconnect
        ) {
            this.log.info('Reconnection attempt replaced by new connection attempt', this.logContext);
            // 确保我们关闭并重新创建现有引擎，以消除任何可能正在进行的重新连接尝试
            this.recreateEngine();
        } else {
            // 如果之前断开连接，则创建引擎
            this.maybeCreateEngine();
        }
        if (this.regionUrlProvider?.isCloud()) {
            this.engine.setRegionUrlProvider(this.regionUrlProvider);
        }

        this.acquireAudioContext();

        this.connOptions = {...roomOptionDefaults, ...opts} as InternalRoomConnectOptions;

        if (this.connOptions.rtcConfig) {
            this.engine.rtcConfig = this.connOptions.rtcConfig;
        }
        if (this.connOptions.peerConnectionTimeout) {
            this.engine.peerConnectionTimeout = this.connOptions.peerConnectionTimeout;
        }

        try {
            const joinResponse = await this.connectSignal(
                url,
                token,
                this.engine,
                this.connOptions,
                this.options,
                abortController,
            );

            this.applyJoinResponse(joinResponse);
            // 转发本地参与者更改的元数据
            this.setupLocalParticipantEvents();
            this.emit(RoomEvent.SignalConnected);
        } catch (err) {
            await this.engine.close();
            this.recreateEngine();
            const resultingError = new ConnectionError(`could not establish signal connection`);
            if (err instanceof Error) {
                resultingError.message = `${resultingError.message}: ${err.message}`;
            }
            if (err instanceof ConnectionError) {
                resultingError.reason = err.reason;
                resultingError.status = err.status;
            }
            this.log.debug(`error trying to establish signal connection`, {
                ...this.logContext,
                error: err,
            });
            throw resultingError;
        }

        if (abortController.signal.aborted) {
            await this.engine.close();
            this.recreateEngine();
            throw new ConnectionError(`Connection attempt aborted`);
        }

        try {
            await this.engine.waitForPCInitialConnection(
                this.connOptions.peerConnectionTimeout,
                abortController,
            );
        } catch (e) {
            await this.engine.close();
            this.recreateEngine();
            throw e;
        }

        // 还挂钩卸载事件
        if (isWeb() && this.options.disconnectOnPageLeave) {
            // 捕获“pagehide”和“beforeunload”以捕获最广泛的浏览器行为
            window.addEventListener('pagehide', this.onPageLeave);
            window.addEventListener('beforeunload', this.onPageLeave);
        }
        if (isWeb()) {
            document.addEventListener('freeze', this.onPageLeave);
            navigator.mediaDevices?.addEventListener('devicechange', this.handleDeviceChange);
        }
        this.setAndEmitConnectionState(ConnectionState.Connected);
        this.emit(RoomEvent.Connected);
        this.registerConnectionReconcile();
    }

    /**
     * 断开房间连接，发出 [[RoomEvent.Disconnected]]
     */
    disconnect = async (stopTracks = true) => {
        const unlock = await this.disconnectLock.lock();
        try {
            if (this.state === ConnectionState.Disconnected) {
                this.log.debug('already disconnected', this.logContext);
                return;
            }
            this.log.info('disconnect from room', {
                ...this.logContext,
            });
            if (
                this.state === ConnectionState.Connecting ||
                this.state === ConnectionState.Reconnecting ||
                this.isResuming
            ) {
                // 尝试中止挂起的连接尝试
                this.log.warn('abort connection attempt', this.logContext);
                this.abortController?.abort();
                // 如果中止控制器无法取消连接尝试，则显式拒绝连接承诺
                this.connectFuture?.reject?.(new ConnectionError('Client initiated disconnect'));
                this.connectFuture = undefined;
            }
            // 发送离开通知
            if (!this.engine?.client.isDisconnected) {
                await this.engine.client.sendLeave();
            }
            // 关闭引擎（同时关闭客户端）
            if (this.engine) {
                await this.engine.close();
            }
            this.handleDisconnect(stopTracks, DisconnectReason.CLIENT_INITIATED);
            /* @ts-ignore */
            this.engine = undefined;
        } finally {
            unlock();
        }
    };

    /**
     * 通过身份检索参与者
     * @param identity
     */
    getParticipantByIdentity(identity: string): Participant | undefined {
        if (this.localParticipant.identity === identity) {
            return this.localParticipant;
        }
        return this.remoteParticipants.get(identity);
    }

    private clearConnectionFutures() {
        this.connectFuture = undefined;
    }


    /**
     * @internal 测试使用
     */
    async simulateScenario(scenario: SimulateScenario, arg?: any) {
        let postAction = () => {
        };
        let req: SimulateScenario | undefined;
        switch (scenario) {
            case 'signal-reconnect':
                // @ts-expect-error function is private
                await this.engine.client.handleOnClose('simulate disconnect');
                break;
            case 'speaker':
                req = new SimulateScenario({
                    scenario: {
                        case: 'speakerUpdate',
                        value: 3,
                    },
                });
                break;
            case 'node-failure':
                req = new SimulateScenario({
                    scenario: {
                        case: 'speakerUpdate',
                        value: 3,
                    },
                });
                break;
            case 'server-leave':
                req = new SimulateScenario({
                    scenario: {
                        case: 'serverLeave',
                        value: true,
                    },
                });
                break;
            case 'migration':
                req = new SimulateScenario({
                    scenario: {
                        case: 'migration',
                        value: true,
                    },
                });
                break;
            case 'resume-reconnect':
                this.engine.failNext();
                // @ts-expect-error function is private
                await this.engine.client.handleOnClose('simulate resume-disconnect');
                break;
            case 'disconnect-signal-on-resume':
                postAction = async () => {
                    // @ts-expect-error function is private
                    await this.engine.client.handleOnClose('simulate resume-disconnect');
                };
                req = new SimulateScenario({
                    scenario: {
                        case: 'disconnectSignalOnResume',
                        value: true,
                    },
                });
                break;
            case 'disconnect-signal-on-resume-no-message':
                postAction = async () => {
                    // @ts-expect-error function is private
                    await this.engine.client.handleOnClose('simulate resume-disconnect');
                };
                req = new SimulateScenario({
                    scenario: {
                        case: 'disconnectSignalOnResumeNoMessages',
                        value: true,
                    },
                });
                break;
            case 'full-reconnect':
                this.engine.fullReconnectOnNext = true;
                // @ts-expect-error function is private
                await this.engine.client.handleOnClose('simulate full-reconnect');
                break;
            case 'force-tcp':
            case 'force-tls':
                req = new SimulateScenario({
                    scenario: {
                        case: 'switchCandidateProtocol',
                        value: scenario === 'force-tls' ? 2 : 1,
                    },
                });
                postAction = async () => {
                    const onLeave = this.engine.client.onLeave;
                    if (onLeave) {
                        onLeave(
                            new LeaveRequest({
                                reason: DisconnectReason.CLIENT_INITIATED,
                                canReconnect: true,
                            }),
                        );
                    }
                };
                break;
            case 'subscriber-bandwidth':
                if (arg === undefined || typeof arg !== 'number') {
                    throw new Error('subscriber-bandwidth requires a number as argument');
                }
                req = new SimulateScenario({
                    scenario: {
                        case: 'subscriberBandwidth',
                        value: BigInt(arg),
                    },
                });
                break;

            default:
        }
        if (req) {
            await this.engine.client.sendSimulateScenario(req);
            await postAction();
        }
    }

    /**
     * 离开页面处理
     */
    private onPageLeave = async () => {
        this.log.info('Page leave detected, disconnecting', this.logContext);
        await this.disconnect();
    };

    /**
     * 浏览器对于音频播放有不同的政策。 大多数需要某种形式的用户交互（单击/点击/等）。
     * 在这些情况下，音频将保持静音，直到单击/点击触发以下其中一项
     * - `开始音频`
     * - `getUserMedia`
     */
    startAudio = async () => {
        const elements: Array<HTMLMediaElement> = [];
        const browser = getBrowser();
        if (browser && browser.os === 'iOS') {
            /**
             * iOS 会阻止音频元素播放，如果
             * - 用户没有自己发布音频并且
             * - 没有其他音频源正在播放
             *
             * 作为解决方法，我们创建一个带有空轨道的音频元素，以便
             * 始终播放无声音频
             */
            const audioId = 'tc-dummy-audio-el';
            let dummyAudioEl = document.getElementById(audioId) as HTMLAudioElement | null;
            if (!dummyAudioEl) {
                dummyAudioEl = document.createElement('audio');
                dummyAudioEl.id = audioId;
                dummyAudioEl.autoplay = true;
                dummyAudioEl.hidden = true;
                const track = getEmptyAudioStreamTrack();
                track.enabled = true;
                const stream = new MediaStream([track]);
                dummyAudioEl.srcObject = stream;
                document.addEventListener('visibilitychange', () => {
                    if (!dummyAudioEl) {
                        return;
                    }
                    // 在页面隐藏时将 srcObject 设置为 null 以防止锁定屏幕控件显示出来
                    dummyAudioEl.srcObject = document.hidden ? null : stream;
                    if (!document.hidden) {
                        this.log.debug(
                            'page visible again, triggering startAudio to resume playback and update playback status',
                            this.logContext,
                        );
                        this.startAudio();
                    }
                });
                document.body.append(dummyAudioEl);
                this.once(RoomEvent.Disconnected, () => {
                    dummyAudioEl?.remove();
                    dummyAudioEl = null;
                });
            }
            elements.push(dummyAudioEl);
        }

        this.remoteParticipants.forEach((p) => {
            p.audioTrackPublications.forEach((t) => {
                if (t.track) {
                    t.track.attachedElements.forEach((e) => {
                        elements.push(e);
                    });
                }
            });
        });

        try {
            await Promise.all([
                this.acquireAudioContext(),
                ...elements.map((e) => {
                    e.muted = false;
                    return e.play();
                }),
            ]);
            this.handleAudioPlaybackStarted();
        } catch (err) {
            this.handleAudioPlaybackFailed(err);
            throw err;
        }
    };

    startVideo = async () => {
        const elements: HTMLMediaElement[] = [];
        for (const p of this.remoteParticipants.values()) {
            p.videoTrackPublications.forEach((tr) => {
                tr.track?.attachedElements.forEach((el) => {
                    if (!elements.includes(el)) {
                        elements.push(el);
                    }
                });
            });
        }

        await Promise.all(elements.map((el) => el.play()))
            .then(() => {
                this.handleVideoPlaybackStarted();
            })
            .catch((e) => {
                if (e.name === 'NotAllowedError') {
                    this.handleVideoPlaybackFailed();
                } else {
                    this.log.warn(
                        'Resuming video playback failed, make sure you call `startVideo` directly in a user gesture handler',
                        this.logContext,
                    );
                }
            });

    };

    /**
     * 如果启用音频播放则返回 true
     */
    get canPlaybackAudio(): boolean {
        return this.audioEnabled;
    }

    /**
     * 如果启用视频播放则返回 true
     */
    get canPlaybackVideo(): boolean {
        return !this.isVideoPlaybackBlocked;
    }

    getActiveDevice(kind: MediaDeviceKind): string | undefined {
        return this.localParticipant.activeDeviceMap.get(kind);
    }

    /**
     * 将此房间中使用的所有活动设备切换到给定设备。
     *
     * 注意：某些浏览器不支持设置 AudioOutput。 请参阅[setSinkId](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId#browser_compatibility)
     *
     * @param kind 使用 `videoinput` 作为摄像机轨道，
     * 用于麦克风轨道的“音频输入”，
     * `audiooutput` 为所有传入音轨设置扬声器
     * @param deviceId
     */
    async switchActiveDevice(kind: MediaDeviceKind, deviceId: string, exact: boolean = false) {
        let deviceHasChanged = false;
        let success = true;
        const deviceConstraint = exact ? {exact: deviceId} : deviceId;
        if (kind === 'audioinput') {
            const prevDeviceId = this.options.audioCaptureDefaults!.deviceId;
            this.options.audioCaptureDefaults!.deviceId = deviceConstraint;
            deviceHasChanged = prevDeviceId !== deviceConstraint;
            const tracks = Array.from(this.localParticipant.audioTrackPublications.values()).filter(
                (track) => track.source === Track.Source.Microphone,
            );
            try {
                success = (
                    await Promise.all(tracks.map((t) => t.audioTrack?.setDeviceId(deviceConstraint)))
                ).every((val) => val === true);
            } catch (e) {
                this.options.audioCaptureDefaults!.deviceId = prevDeviceId;
                throw e;
            }
        } else if (kind === 'videoinput') {
            const prevDeviceId = this.options.videoCaptureDefaults!.deviceId;
            this.options.videoCaptureDefaults!.deviceId = deviceConstraint;
            deviceHasChanged = prevDeviceId !== deviceConstraint;
            const tracks = Array.from(this.localParticipant.videoTrackPublications.values()).filter(
                (track) => track.source === Track.Source.Camera,
            );
            try {
                success = (
                    await Promise.all(tracks.map((t) => t.videoTrack?.setDeviceId(deviceConstraint)))
                ).every((val) => val === true);
            } catch (e) {
                this.options.videoCaptureDefaults!.deviceId = prevDeviceId;
                throw e;
            }
        } else if (kind === 'audiooutput') {
            if (
                (!supportsSetSinkId() && !this.options.webAudioMix) ||
                (this.options.webAudioMix && this.audioContext && !('setSinkId' in this.audioContext))
            ) {
                throw new Error('cannot switch audio output, setSinkId not supported');
            }
            if (this.options.webAudioMix) {
                // 为网络音频输出设置“default”不起作用，因此我们需要先规范化 id
                deviceId =
                    (await DeviceManager.getInstance().normalizeDeviceId('audiooutput', deviceId)) ?? '';
            }
            this.options.audioOutput ??= {};
            const prevDeviceId = this.options.audioOutput.deviceId;
            this.options.audioOutput.deviceId = deviceId;
            deviceHasChanged = prevDeviceId !== deviceConstraint;

            try {
                if (this.options.webAudioMix) {
                    // @ts-expect-error setSinkId is not yet in the typescript type of AudioContext
                    this.audioContext?.setSinkId(deviceId);
                } else {
                    await Promise.all(
                        Array.from(this.remoteParticipants.values()).map((p) => p.setAudioOutput({deviceId})),
                    );
                }
            } catch (e) {
                this.options.audioOutput.deviceId = prevDeviceId;
                throw e;
            }
        }
        if (deviceHasChanged && success) {
            this.localParticipant.activeDeviceMap.set(kind, deviceId);
            this.emit(RoomEvent.ActiveDeviceChanged, kind, deviceId);
        }

        return success;
    }

    private setupLocalParticipantEvents() {
        this.localParticipant
            .on(ParticipantEvent.ParticipantMetadataChanged, this.onLocalParticipantMetadataChanged)
            .on(ParticipantEvent.ParticipantNameChanged, this.onLocalParticipantNameChanged)
            .on(ParticipantEvent.TrackMuted, this.onLocalTrackMuted)
            .on(ParticipantEvent.TrackUnmuted, this.onLocalTrackUnmuted)
            .on(ParticipantEvent.LocalTrackPublished, this.onLocalTrackPublished)
            .on(ParticipantEvent.LocalTrackUnpublished, this.onLocalTrackUnpublished)
            .on(ParticipantEvent.ConnectionQualityChanged, this.onLocalConnectionQualityChanged)
            .on(ParticipantEvent.MediaDevicesError, this.onMediaDevicesError)
            .on(ParticipantEvent.AudioStreamAcquired, this.startAudio)
            .on(
                ParticipantEvent.ParticipantPermissionsChanged,
                this.onLocalParticipantPermissionsChanged,
            );
    }

    private recreateEngine() {
        this.engine?.close();
        /* @ts-ignore */
        this.engine = undefined;
        this.isResuming = false;

        // 清除现有的远程参与者，因为他们可能已附加
        // 旧引擎
        this.remoteParticipants.clear();
        this.sidToIdentity.clear();
        this.bufferedEvents = [];
        this.maybeCreateEngine();
    }

    private onTrackAdded(
        mediaTrack: MediaStreamTrack,
        stream: MediaStream,
        receiver?: RTCRtpReceiver,
    ) {
        // 连接时不要触发 onSubscribed
        // 一旦在offer上调用 setRemoteDescription，WebRTC 就会触发 onTrack，此时 ICE 连接尚未建立，因此技术上未订阅该轨道。
        // 我们将推迟这些事件，直到房间连接或最终断开连接。
        if (this.state === ConnectionState.Connecting || this.state === ConnectionState.Reconnecting) {
            const reconnectedHandler = () => {
                this.onTrackAdded(mediaTrack, stream, receiver);
                cleanup();
            };
            const cleanup = () => {
                this.off(RoomEvent.Reconnected, reconnectedHandler);
                this.off(RoomEvent.Connected, reconnectedHandler);
                this.off(RoomEvent.Disconnected, cleanup);
            };
            this.once(RoomEvent.Reconnected, reconnectedHandler);
            this.once(RoomEvent.Connected, reconnectedHandler);
            this.once(RoomEvent.Disconnected, cleanup);
            return;
        }
        if (this.state === ConnectionState.Disconnected) {
            this.log.warn('skipping incoming track after Room disconnected', this.logContext);
            return;
        }
        const parts = unpackStreamId(stream.id);
        const participantSid = parts[0];
        let streamId = parts[1];
        let trackId = mediaTrack.id;
        // firefox 将获取streamId (pID|trackId) 而不是 (pID|streamId)，因为它不支持按流同步轨道
        // 并生成自己的轨道 id，而不是从 sdp 轨道 id 推断。
        if (streamId && streamId.startsWith('TR')) {
            trackId = streamId;
        }

        if (participantSid === this.localParticipant.sid) {
            this.log.warn('tried to create RemoteParticipant for local participant', this.logContext);
            return;
        }

        const participant = Array.from(this.remoteParticipants.values()).find(
            (p) => p.sid === participantSid,
        ) as RemoteParticipant | undefined;

        if (!participant) {
            this.log.error(
                `Tried to add a track for a participant, that's not present. Sid: ${participantSid}`,
                this.logContext,
            );
            return;
        }

        let adaptiveStreamSettings: AdaptiveStreamSettings | undefined;
        if (this.options.adaptiveStream) {
            if (typeof this.options.adaptiveStream === 'object') {
                adaptiveStreamSettings = this.options.adaptiveStream;
            } else {
                adaptiveStreamSettings = {};
            }
        }
        participant.addSubscribedMediaTrack(
            mediaTrack,
            trackId,
            stream,
            receiver,
            adaptiveStreamSettings,
        );
    }


    /**
     * 处理重启
     */
    private handleRestarting = () => {
        this.clearConnectionReconcile();
        // 如果我们从恢复到完全重新连接，请确保将其反映在 isResuming 标志上
        this.isResuming = false;
        // 还解除现有参与者和现有订阅
        for (const p of this.remoteParticipants.values()) {
            this.handleParticipantDisconnected(p.identity, p);
        }

        if (this.setAndEmitConnectionState(ConnectionState.Reconnecting)) {
            this.emit(RoomEvent.Reconnecting);
        }
    };

    /**
     * 处理信令重启
     * @param joinResponse 加入响应
     */
    private handleSignalRestarted = async (joinResponse: JoinResponse) => {
        this.log.debug(`signal reconnected to server, region ${joinResponse.serverRegion}`, {
            ...this.logContext,
            region: joinResponse.serverRegion,
        });
        this.bufferedEvents = [];

        this.applyJoinResponse(joinResponse);

        try {
            // 取消发布并重新发布曲目
            await this.localParticipant.republishAllTracks(undefined, true);
        } catch (error) {
            this.log.error('error trying to re-publish tracks after reconnection', {
                ...this.logContext,
                error
            });
        }

        try {
            await this.engine.waitForRestarted();
            this.log.debug(`fully reconnected to server`, {
                ...this.logContext,
                region: joinResponse.serverRegion,
            });
        } catch {
            // 重连失败，handleDisconnect已经被调用，直接返回这里
            return;
        }
        this.setAndEmitConnectionState(ConnectionState.Connected);
        this.emit(RoomEvent.Reconnected);
        this.registerConnectionReconcile();
        this.emitBufferedEvents();
    };

    /**
     * 处理断开连接
     * @param shouldStopTracks 是否停止音轨
     * @param reason 断开原因
     */
    private handleDisconnect(shouldStopTracks = true, reason?: DisconnectReason) {
        this.clearConnectionReconcile();
        this.isResuming = false;
        this.bufferedEvents = [];
        if (this.state === ConnectionState.Disconnected) {
            return;
        }

        this.regionUrl = undefined;

        try {
            this.remoteParticipants.forEach((p) => {
                p.trackPublications.forEach((pub) => {
                    p.unpublishTrack(pub.trackSid)
                });
            });

            this.localParticipant.trackPublications.forEach((pub) => {
                if (pub.track) {
                    this.localParticipant.unpublishTrack(pub.track, shouldStopTracks);
                }
                if (shouldStopTracks) {
                    pub.track?.detach();
                    pub.track?.stop();
                }
            });

            this.localParticipant
                .off(ParticipantEvent.ParticipantMetadataChanged, this.onLocalParticipantMetadataChanged)
                .off(ParticipantEvent.ParticipantNameChanged, this.onLocalParticipantNameChanged)
                .off(ParticipantEvent.TrackMuted, this.onLocalTrackMuted)
                .off(ParticipantEvent.LocalTrackPublished, this.onLocalTrackPublished)
                .off(ParticipantEvent.LocalTrackUnpublished, this.onLocalTrackUnpublished)
                .off(ParticipantEvent.ConnectionQualityChanged, this.onLocalConnectionQualityChanged)
                .off(ParticipantEvent.MediaDevicesError, this.onMediaDevicesError)
                .off(ParticipantEvent.AudioStreamAcquired, this.startAudio)
                .off(
                    ParticipantEvent.ParticipantPermissionsChanged,
                    this.onLocalParticipantPermissionsChanged,
                );

            this.localParticipant.trackPublications.clear();
            this.localParticipant.videoTrackPublications.clear();
            this.localParticipant.audioTrackPublications.clear();

            this.remoteParticipants.clear();
            this.sidToIdentity.clear();
            this.activeSpeakers = [];
            if (this.audioContext && typeof this.options.webAudioMix === 'boolean') {
                this.audioContext.close();
                this.audioContext = undefined;
            }
            if (isWeb()) {
                window.removeEventListener('beforeunload', this.onPageLeave);
                window.removeEventListener('pagehide', this.onPageLeave);
                window.removeEventListener('freeze', this.onPageLeave);
                navigator.mediaDevices?.removeEventListener('devicechange', this.handleDeviceChange);
            }
        } finally {
            this.setAndEmitConnectionState(ConnectionState.Disconnected);
            this.emit(RoomEvent.Disconnected, reason);
        }
    }

    /**
     * 处理参与者更新
     * @param participantInfos 参与者信息
     */
    private handleParticipantUpdates = (participantInfos: ParticipantInfo[]) => {
        // 处理参与者状态的变化，并发送事件
        participantInfos.forEach((info) => {
            if (info.identity === this.localParticipant.identity) {
                this.localParticipant.updateInfo(info);
                return;
            }

            // TcApp 服务器在 1.5.2 之前的版本中不会在断开连接更新中发送身份信息
            // 所以我们尝试手动将空身份映射到已知的 sID
            if (info.identity === '') {
                info.identity = this.sidToIdentity.get(info.sid) ?? '';
            }

            let remoteParticipant = this.remoteParticipants.get(info.identity);

            // 断开连接时，发送更新
            if (info.state === ParticipantInfo_State.DISCONNECTED) {
                this.handleParticipantDisconnected(info.identity, remoteParticipant);
            } else {
                // 如果不存在则创建参与者
                remoteParticipant = this.getOrCreateParticipant(info.identity, info);
            }
        });

    };

    /**
     * 处理参与者断开连接
     * @param identity 参与者唯一标识
     * @param participant 参与者
     */
    private handleParticipantDisconnected(identity: string, participant?: RemoteParticipant) {
        // 删除并发送事件
        this.remoteParticipants.delete(identity);
        if (!participant) {
            return;
        }

        participant.trackPublications.forEach((publication) => {
            participant.unpublishTrack(publication.trackSid, true);
        });
        this.emit(RoomEvent.ParticipantDisconnected, participant);
    }

    // 仅当发言者顺序发生变化时才发送更新
    private handleActiveSpeakersUpdate = (speakers: SpeakerInfo[]) => {
        const activeSpeakers: Participant[] = [];
        const seenSids: any = {};
        speakers.forEach((speaker) => {
            seenSids[speaker.sid] = true;
            if (speaker.sid === this.localParticipant.sid) {
                this.localParticipant.audioLevel = speaker.level;
                this.localParticipant.setIsSpeaking(true);
                activeSpeakers.push(this.localParticipant);
            } else {
                const p = this.getRemoteParticipantBySid(speaker.sid);
                if (p) {
                    p.audioLevel = speaker.level;
                    p.setIsSpeaking(true);
                    activeSpeakers.push(p);
                }
            }
        });
        if (!seenSids[this.localParticipant.sid]) {
            this.localParticipant.audioLevel = 0;
            this.localParticipant.setIsSpeaking(false);
        }
        this.remoteParticipants.forEach((p) => {
            if (!seenSids[p.sid]) {
                p.audioLevel = 0;
                p.setIsSpeaking(false);
            }
        });

        this.activeSpeakers = activeSpeakers;
        this.emitWhenConnected(RoomEvent.ActiveSpeakersChanged, activeSpeakers);
    };

    // 处理已更改发言人的列表
    private handleSpeakersChanged = (speakerUpdates: SpeakerInfo[]) => {
        const lastSpeakers = new Map<string, Participant>();
        this.activeSpeakers.forEach((p) => {
            lastSpeakers.set(p.sid, p);
        });
        speakerUpdates.forEach((speaker) => {
            let p: Participant | undefined = this.getRemoteParticipantBySid(speaker.sid);
            if (speaker.sid === this.localParticipant.sid) {
                p = this.localParticipant;
            }
            if (!p) {
                return;
            }
            p.audioLevel = speaker.level;
            p.setIsSpeaking(speaker.active);

            if (speaker.active) {
                lastSpeakers.set(speaker.sid, p);
            } else {
                lastSpeakers.delete(speaker.sid);
            }
        });
        const activeSpeakers = Array.from(lastSpeakers.values());
        activeSpeakers.sort((a, b) => b.audioLevel - a.audioLevel);
        this.activeSpeakers = activeSpeakers;
        this.emitWhenConnected(RoomEvent.ActiveSpeakersChanged, activeSpeakers);
    };

    /**
     * 处理流状态更新
     */
    private handleStreamStateUpdate = (streamStateUpdate: StreamStateUpdate) => {
        streamStateUpdate.streamStates.forEach((streamState) => {
            const participant = this.getRemoteParticipantBySid(streamState.participantSid);
            if (!participant) {
                return;
            }
            const pub = participant.getTrackPublicationBySid(streamState.trackSid);
            if (!pub || !pub.track) {
                return;
            }
            pub.track.streamState = Track.streamStateFromProto(streamState.state);
            participant.emit(ParticipantEvent.TrackStreamStateChanged, pub, pub.track.streamStates);
            this.emitWhenConnected(
                RoomEvent.TrackStreamStateChanged,
                pub,
                pub.track.streamState,
                participant,
            );
        });
    };

    /**
     * 处理订阅权限更新
     * @param update 更新的权限对象
     */
    private handleSubscriptionPermissionUpdate = (update: SubscriptionPermissionUpdate) => {
        const participant = this.getRemoteParticipantBySid(update.participantSid);
        if (!participant) {
            return;
        }
        const pub = participant.getTrackPublicationBySid(update.trackSid);
        if (!pub) {
            return;
        }

        pub.setAllowed(update.allowed);
    };

    /**
     * 处理订阅错误
     * @param update 订阅响应
     */
    private handleSubscriptionError = (update: SubscriptionResponse) => {
        const participant = Array.from(this.remoteParticipants.values()).find((p) => {
            p.trackPublications.has(update.trackSid);
        });
        if (!participant) {
            return;
        }
        const pub = participant.getTrackPublicationBySid(update.trackSid);
        if (!pub) {
            return;
        }
        pub.setSubscriptionError(update.err);
    };

    /**
     * 处理数据包
     * @param userPacket 用户数据包
     * @param kind 数据包类型
     */
    private handleDataPacket = (userPacket: UserPacket, kind: DataPacket_Kind) => {
        // 查找参与者
        const participant = this.remoteParticipants.get(userPacket.participantIdentity);

        this.emit(RoomEvent.DataReceived, userPacket.payload, participant, kind, userPacket.topic);

        // 也向参与者发出
        participant?.emit(ParticipantEvent.DataReceived, userPacket.payload, kind);
    };

    /**
     * 处理音频播放开始
     */
    private handleAudioPlaybackStarted = () => {
        if (this.canPlaybackAudio) {
            return;
        }
        this.audioEnabled = true;
        this.emit(RoomEvent.AudioPlaybackStatusChanged, true);
    };

    /**
     * 处理播放音频失败
     */
    private handleAudioPlaybackFailed = (e: any) => {
        this.log.warn('could not playback audio', {...this.logContext, error: e});
        if (!this.canPlaybackAudio) {
            return;
        }
        this.audioEnabled = false;
        this.emit(RoomEvent.AudioPlaybackStatusChanged, false);
    };

    /**
     * 处理开始播放视频
     */
    private handleVideoPlaybackStarted = () => {
        if (this.isVideoPlaybackBlocked) {
            this.isVideoPlaybackBlocked = false;
            this.emit(RoomEvent.VideoPlaybackStatusChanged, true);
        }
    };

    /**
     * 处理视频播放失败
     */
    private handleVideoPlaybackFailed = () => {
        if (!this.isVideoPlaybackBlocked) {
            this.isVideoPlaybackBlocked = true;
            this.emit(RoomEvent.VideoPlaybackStatusChanged, false);
        }
    }

    /**
     * 处理设备改变
     */
    private handleDeviceChange = async () => {
        this.emit(RoomEvent.MediaDevicesChanged);
    };

    /**
     * 处理房间更新
     */
    private handleRoomUpdate = (room: RoomModel) => {
        const oldRoom = this.roomInfo;
        this.roomInfo = room;
        if (oldRoom && oldRoom.metadata !== room.metadata) {
            this.emitWhenConnected(RoomEvent.RoomMetadataChanged, room.metadata);
        }
        if (oldRoom?.activeRecording !== room.activeRecording) {
            this.emitWhenConnected(RoomEvent.RecordingStatusChanged, room.activeRecording);
        }
    };

    /**
     * 处理连接质量更新
     * @param update 网络质量
     */
    private handleConnectionQualityUpdate = (update: ConnectionQualityUpdate) => {
        update.updates.forEach((info) => {
            if (info.participantSid === this.localParticipant.sid) {
                this.localParticipant.setConnectionQuality(info.quality);
                return;
            }
            const participant = this.getRemoteParticipantBySid(info.participantSid);
            if (participant) {
                participant.setConnectionQuality(info.quality);
            }
        });
    };

    /**
     * 获取audio上下文
     */
    private async acquireAudioContext() {
        if (typeof this.options.webAudioMix !== 'boolean' && this.options.webAudioMix.audioContext) {
            // 如果用户提供了自定义音频上下文，则覆盖音频上下文
            this.audioContext = this.options.webAudioMix.audioContext;
        } else if (!this.audioContext || this.audioContext.state === 'closed') {
            // 通过使用 AudioContext，可以减少音频元素的延迟
            // https://stackoverflow.com/questions/9811429/html5-audio-tag-on-safari-has-a-delay/54119854#54119854
            this.audioContext = getNewAudioContext() ?? undefined;
        }

        if (this.audioContext && this.audioContext.state === 'suspended') {
            // 对于 iOS，新创建的 AudioContext 始终处于“挂起”状态。
            // 我们尽力恢复这里的上下文，如果这不起作用，我们就继续常规处理
            try {
                await this.audioContext.resume();
            } catch (e: any) {
                this.log.warn('Could not resume audio context', {...this.logContext, error: e});
            }
        }

        if (this.options.webAudioMix) {
            this.remoteParticipants.forEach((participant) => {
                participant.setAudioContext(this.audioContext);
            });
        }

        this.localParticipant.setAudioContext(this.audioContext);

        const newContextIsRunning = this.audioContext?.state === 'running';
        if (newContextIsRunning !== this.canPlaybackAudio) {
            this.audioEnabled = newContextIsRunning;
            this.emit(RoomEvent.AudioPlaybackStatusChanged, newContextIsRunning);
        }
    }

    /**
     * 创建参与者
     * @param identity 唯一标识
     * @param info 参与者信息
     */
    private createParticipant(identity: string, info?: ParticipantInfo): RemoteParticipant {
        let participant: RemoteParticipant;
        if (info) {
            participant = RemoteParticipant.fromParticipantInfo(this.engine.client, info);
        } else {
            participant = new RemoteParticipant(this.engine.client, '', identity, undefined, undefined, {
                loggerContextCb: () => this.logContext,
                loggerName: this.options.loggerName,
            });
        }
        if (this.options.audioOutput?.deviceId) {
            participant
                .setAudioOutput(this.options.audioOutput)
                .catch((e) => this.log.warn(`Could not set audio output: ${e.message}`, this.logContext));
        }
        return participant;
    }

    /**
     * 获取或者创建参与者
     */
    private getOrCreateParticipant(identity: string, info: ParticipantInfo): RemoteParticipant {
        if (this.remoteParticipants.has(identity)) {
            const existingParticipant = this.remoteParticipants.get(identity)!;
            if (info) {
                const wasUpdated = existingParticipant.updateInfo(info);
                if (wasUpdated) {
                    this.sidToIdentity.set(info.sid, info.identity);
                }
            }
            return existingParticipant;
        }
        const participant = this.createParticipant(identity, info);
        this.remoteParticipants.set(identity, participant);

        this.sidToIdentity.set(info.sid, info.identity);
        // 如果我们有有效的信息并且参与者之前不在Map中，我们可以假设参与者是新触发的，
        // 以确保 `ParticipantConnected` 在初始跟踪事件之前触发
        this.emitWhenConnected(RoomEvent.ParticipantConnected, participant);

        // 也转发事件
        // trackPublished 仅在本地参与者之后添加的曲目时触发
        // 远程参与者加入房间
        participant
            .on(ParticipantEvent.TrackPublished, (trackPublication: RemoteTrackPublication) => {
                this.emitWhenConnected(RoomEvent.TrackPublished, trackPublication, participant)
            })
            .on(
                ParticipantEvent.TrackSubscribed,
                (track: RemoteTrack, publication: RemoteTrackPublication) => {
                    // 监听播放状态
                    if (track.kind === Track.Kind.Audio) {
                        track.on(TrackEvent.AudioPlaybackStarted, this.handleAudioPlaybackStarted);
                        track.on(TrackEvent.AudioPlaybackFailed, this.handleAudioPlaybackFailed);
                    } else if (track.kind === Track.Kind.Video) {
                        track.on(TrackEvent.VideoPlaybackStarted, this.handleVideoPlaybackStarted);
                        track.on(TrackEvent.VideoPlaybackFailed, this.handleVideoPlaybackFailed);
                    }
                    this.emit(RoomEvent.TrackSubscribed, track, publication, participant);
                },
            )
            .on(ParticipantEvent.TrackUnpublished, (publication: RemoteTrackPublication) => {
                this.emit(RoomEvent.TrackUnpublished, publication, participant);
            })
            .on(
                ParticipantEvent.TrackUnsubscribed,
                (track: RemoteTrack, publication: RemoteTrackPublication) => {
                    this.emit(RoomEvent.TrackUnsubscribed, track, publication, participant);
                }
            )
            .on(ParticipantEvent.TrackSubscriptionFailed, (sid: string) => {
                this.emit(RoomEvent.TrackSubscriptionFailed, sid, participant);
            })
            .on(ParticipantEvent.TrackMuted, (pub: TrackPublication) => {
                this.emitWhenConnected(RoomEvent.TrackMuted, pub, participant);
            })
            .on(ParticipantEvent.TrackUnmuted, (pub: TrackPublication) => {
                this.emitWhenConnected(RoomEvent.TrackUnmuted, pub, participant);
            })
            .on(ParticipantEvent.ParticipantMetadataChanged, (metadata: string | undefined) => {
                this.emitWhenConnected(RoomEvent.ParticipantMetadataChanged, metadata, participant);
            })
            .on(ParticipantEvent.ParticipantNameChanged, (name) => {
                this.emitWhenConnected(RoomEvent.ParticipantNameChanged, name, participant);
            })
            .on(ParticipantEvent.ConnectionQualityChanged, (quality: ConnectionQuality) => {
                this.emitWhenConnected(RoomEvent.ConnectionQualityChanged, quality, participant);
            })
            .on(
                ParticipantEvent.ParticipantPermissionsChanged,
                (prevPermissions?: ParticipantPermission) => {
                    this.emitWhenConnected(
                        RoomEvent.ParticipantPermissionsChanged,
                        prevPermissions,
                        participant,
                    );
                },
            )
            .on(ParticipantEvent.TrackSubscriptionStatusChanged, (pub, status) => {
                this.emitWhenConnected(RoomEvent.TrackSubscriptionStatusChanged, pub, status, participant);
            })
            .on(ParticipantEvent.TrackSubscriptionFailed, (trackSid, error) => {
                this.emit(RoomEvent.TrackSubscriptionFailed, trackSid, participant, error);
            })
            .on(ParticipantEvent.TrackSubscriptionPermissionChanged, (pub, status) => {
                this.emitWhenConnected(
                    RoomEvent.TrackSubscriptionPermissionChanged,
                    pub,
                    status,
                    participant,
                );
            });

        // 设置回调后最后更新信息
        if (info) {
            participant.updateInfo(info);
        }

        return participant;
    }

    /**
     * 发送同步状态
     */
    private sendSyncState() {
        const remoteTracks = Array.from(this.remoteParticipants.values()).reduce((acc, participant) => {
            acc.push(...(participant.getTrackPublications() as RemoteTrackPublication[])); // FIXME would be nice to have this return RemoteTrackPublications directly instead of the type cast
            return acc;
        }, [] as RemoteTrackPublication[]);
        const localTracks = this.localParticipant.getTrackPublications() as LocalTrackPublication[]; // FIXME would be nice to have this return LocalTrackPublications directly instead of the type cast
        this.engine.sendSyncState(remoteTracks, localTracks);
    }

    /**
     * 恢复后，我们需要通知服务器当前的情况
     * 订阅设置。
     */
    private updateSubscriptions() {
        for (const p of this.remoteParticipants.values()) {
            for (const pub of p.videoTrackPublications.values()) {
                if (pub.isSubscribed && pub instanceof RemoteTrackPublication) {
                    pub.emitTrackUpdate();
                }
            }
        }
    }

    /**
     * 通过sid获取远程参与者
     * @param sid sid
     */
    private getRemoteParticipantBySid(sid: string): RemoteParticipant | undefined {
        const identity = this.sidToIdentity.get(sid);
        if (identity) {
            return this.remoteParticipants.get(identity);
        }
    }

    /**
     * 注册连接协调
     */
    private registerConnectionReconcile() {
        this.clearConnectionFutures();
        // 连续失败次数
        let consecutiveFailures = 0;
        this.connectionReconcileInterval = CriticalTimers.setInterval(() => {
            if (
                // ensure we didn't tear it down
                !this.engine ||
                // engine detected close, but Room missed it
                this.engine.isClosed ||
                // transports failed without notifying engine
                !this.engine.verifyTransport()
            ) {
                consecutiveFailures++;
                this.log.warn('detected connection state mismatch', {
                    ...this.logContext,
                    numFailures: consecutiveFailures,
                    engine: {
                        closed: this.engine.isClosed,
                        transportsConnected: this.engine.verifyTransport(),
                    },
                });
                if (consecutiveFailures >= 3) {
                    this.recreateEngine();
                    this.handleDisconnect(
                        this.options.stopLocalTrackOnUnpublish,
                        DisconnectReason.STATE_MISMATCH,
                    );
                }
            } else {
                consecutiveFailures = 0;
            }
        }, connectionReconcileFrequency);
    }

    /**
     * 清除连接协调
     */
    private clearConnectionReconcile() {
        if (this.connectionReconcileInterval) {
            CriticalTimers.clearInterval(this.connectionReconcileInterval);
        }
    }

    /**
     * 设置并发出连接状态
     * @param state 连接状态
     */
    private setAndEmitConnectionState(state: ConnectionState): boolean {
        if (state == this.state) {
            // 未改变
            return false;
        }
        this.state = state;
        this.emit(RoomEvent.ConnectionStateChanged, this.state);
        return true;
    }

    /**
     * 发出缓冲事件
     */
    private emitBufferedEvents() {
        this.bufferedEvents.forEach(([ev, args]) => {
            this.emit(ev, ...args);
        });
        this.bufferedEvents = [];
    }

    /**
     * 连接时发出
     * @param event 事件
     * @param args 参数
     */
    private emitWhenConnected<E extends keyof RoomEventCallbacks>(
        event: E,
        ...args: Parameters<RoomEventCallbacks[E]>
    ): boolean {
        if (
            this.state === ConnectionState.Reconnecting ||
            this.isResuming ||
            !this.engine ||
            this.engine.pendingReconnect
        ) {
            // 如果房间正在重新连接，请在发出 RoomEvent.Reconnected 后触发事件来缓冲事件
            this.bufferedEvents.push([event, args]);
        } else if (this.state === ConnectionState.Connected) {
            return this.emit(event, ...args);
        }
        return false;
    }

    /**
     * 本地参与者元数据已更改事件
     * @param metadata 原数据
     */
    private onLocalParticipantMetadataChanged = (metadata: string | undefined) => {
        this.emit(RoomEvent.ParticipantMetadataChanged, metadata, this.localParticipant);
    };

    /**
     * 本地参与者名称更改事件
     * @param name 参与者名称
     */
    private onLocalParticipantNameChanged = (name: string) => {
        this.emit(RoomEvent.ParticipantNameChanged, name, this.localParticipant);
    };

    /**
     * 在本地轨道上静音事件
     * @param pub 音轨发布事件
     */
    private onLocalTrackMuted = (pub: TrackPublication) => {
        this.emit(RoomEvent.TrackMuted, pub, this.localParticipant);
    };

    /**
     * 在本地轨道上取消静音
     * @param pub 音轨发布
     */
    private onLocalTrackUnmuted = (pub: TrackPublication) => {
        this.emit(RoomEvent.TrackUnmuted, pub, this.localParticipant);
    };

    /**
     * 跟踪处理器更新
     * @param processor 处理器
     */
    private onTrackProcessorUpdate = (processor?: TrackProcessor<Track.Kind, any>) => {
        processor?.onPublish?.(this);
    };

    /**
     * 在本地轨道上发布
     * @param pub 本地音轨
     */
    private onLocalTrackPublished = async (pub: LocalTrackPublication) => {
        pub.track?.on(TrackEvent.TrackProcessorUpdate, this.onTrackProcessorUpdate);
        pub.track?.getProcessor()?.onPublish?.(this);

        this.emit(RoomEvent.LocalTrackPublished, pub, this.localParticipant);

        if (pub.track instanceof LocalAudioTrack) {
            const trackIsSilent = await pub.track.checkForSilence();
            if (trackIsSilent) {
                this.emit(RoomEvent.LocalAudioSilenceDetected, pub);
            }
        }
        const deviceId = await pub.track?.getDeviceId();
        const deviceKind = sourceToKind(pub.source);
        if (
            deviceKind &&
            deviceId &&
            deviceId !== this.localParticipant.activeDeviceMap.get(deviceKind)
        ) {
            this.localParticipant.activeDeviceMap.set(deviceKind, deviceId);
            this.emit(RoomEvent.ActiveDeviceChanged, deviceKind, deviceId);
        }
    };

    /**
     * 本地轨道上解除发布
     * @param pub 本地音轨发布
     */
    private onLocalTrackUnpublished = async (pub: LocalTrackPublication) => {
        pub.track?.off(TrackEvent.TrackProcessorUpdate, this.onTrackProcessorUpdate);
        this.emit(RoomEvent.LocalTrackUnpublished, pub, this.localParticipant);
    };

    /**
     * 本地连接质量改变
     */
    private onLocalConnectionQualityChanged = (quality: ConnectionQuality) => {
        this.emit(RoomEvent.ConnectionQualityChanged, quality, this.localParticipant);
    };

    /**
     * 媒体设备错误
     * @param e 设置错误
     */
    private onMediaDevicesError = (e: Error) => {
        this.emit(RoomEvent.MediaDevicesError, e);
    };

    private onLocalParticipantPermissionsChanged = (prevPermissions?: ParticipantPermission) => {
        this.emit(RoomEvent.ParticipantPermissionsChanged, prevPermissions, this.localParticipant);
    };

    /**
     * 允许在房间中填充模拟参与者。
     * 不会建立与服务器的实际连接，所有状态都是
     * @实验
     */
    async simulateParticipants(options: SimulationOptions) {
        const publishOptions = {
            audio: true,
            video: true,
            useRealTracks: false,
            ...options.publish,
        };
        const participantOptions = {
            count: 9,
            audio: false,
            video: true,
            aspectRatios: [1.66, 1.7, 1.3],
            ...options.participants,
        };
        this.handleDisconnect();
        this.roomInfo = new RoomModel({
            sid: 'RM_SIMULATED',
            name: 'simulated-room',
            emptyTimeout: 0,
            maxParticipants: 0,
            creationTime: protoInt64.parse(new Date().getTime()),
            metadata: '',
            numParticipants: 1,
            numPublishers: 1,
            turnPassword: '',
            enabledCodecs: [],
            activeRecording: false,
        });

        this.localParticipant.updateInfo(
            new ParticipantInfo({
                identity: 'simulated-local',
                name: 'local-name',
            }),
        );
        this.setupLocalParticipantEvents();
        this.emit(RoomEvent.SignalConnected);
        this.emit(RoomEvent.Connected);
        this.setAndEmitConnectionState(ConnectionState.Connected);
        if (publishOptions.video) {
            const camPub = new LocalTrackPublication(
                Track.Kind.Video,
                new TrackInfo({
                    source: TrackSource.CAMERA,
                    sid: Math.floor(Math.random() * 10_000).toString(),
                    type: TrackType.AUDIO,
                    name: 'video-dummy',
                }),
                new LocalVideoTrack(
                    publishOptions.useRealTracks
                        ? (
                            await window.navigator.mediaDevices.getUserMedia({video: true})
                        ).getVideoTracks()[0]
                        : createDummyVideoStreamTrack(
                            160 * (participantOptions.aspectRatios[0] ?? 1),
                            160,
                            true,
                            true,
                        ),
                    undefined,
                    false,
                    {loggerName: this.options.loggerName, loggerContextCb: () => this.logContext},
                ),
                {loggerName: this.options.loggerName, loggerContextCb: () => this.logContext},
            );

            // @ts-ignore
            this.localParticipant.addTrackPublication(camPub);
            this.localParticipant.emit(ParticipantEvent.LocalTrackPublished, camPub);
        }
        if (publishOptions.audio) {
            const audioPub = new LocalTrackPublication(
                Track.Kind.Audio,
                new TrackInfo({
                    source: TrackSource.MICROPHONE,
                    sid: Math.floor(Math.random() * 10_000).toString(),
                    type: TrackType.AUDIO,
                }),
                new LocalAudioTrack(
                    publishOptions.useRealTracks
                        ? (await navigator.mediaDevices.getUserMedia({audio: true})).getAudioTracks()[0]
                        : getEmptyAudioStreamTrack(),
                    undefined,
                    false,
                    this.audioContext,
                    {loggerName: this.options.loggerName, loggerContextCb: () => this.logContext},
                ),
                {loggerName: this.options.loggerName, loggerContextCb: () => this.logContext},
            );
            // @ts-ignore
            this.localParticipant.addTrackPublication(audioPub);
            this.localParticipant.emit(ParticipantEvent.LocalTrackPublished, audioPub);
        }

        for (let i = 0; i < participantOptions.count - 1; i += 1) {
            let info: ParticipantInfo = new ParticipantInfo({
                sid: Math.floor(Math.random() * 10_000).toString(),
                identity: `simulated-${i}`,
                state: ParticipantInfo_State.ACTIVE,
                tracks: [],
                joinedAt: protoInt64.parse(Date.now()),
            });
            const p = this.getOrCreateParticipant(info.identity, info);
            if (participantOptions.video) {
                const dummyVideo = createDummyVideoStreamTrack(
                    160 * (participantOptions.aspectRatios[i % participantOptions.aspectRatios.length] ?? 1),
                    160,
                    false,
                    true,
                );
                const videoTrack = new TrackInfo({
                    source: TrackSource.CAMERA,
                    sid: Math.floor(Math.random() * 10_000).toString(),
                    type: TrackType.AUDIO,
                });
                p.addSubscribedMediaTrack(dummyVideo, videoTrack.sid, new MediaStream([dummyVideo]));
                info.tracks = [...info.tracks, videoTrack];
            }
            if (participantOptions.audio) {
                const dummyTrack = getEmptyAudioStreamTrack();
                const audioTrack = new TrackInfo({
                    source: TrackSource.MICROPHONE,
                    sid: Math.floor(Math.random() * 10_000).toString(),
                    type: TrackType.AUDIO,
                });
                p.addSubscribedMediaTrack(dummyTrack, audioTrack.sid, new MediaStream([dummyTrack]));
                info.tracks = [...info.tracks, audioTrack];
            }

            p.updateInfo(info);
        }
    }

    // /** @internal */
    emit<E extends keyof RoomEventCallbacks>(
        event: E,
        ...args: Parameters<RoomEventCallbacks[E]>
    ): boolean {
        // 当前发言人的更新太垃圾了
        if (event !== RoomEvent.ActiveSpeakersChanged) {
            // 仅从参数中提取 logContext 以避免记录整个对象树
            const minimizedArgs = mapArgs(args).filter((arg: unknown) => arg !== undefined);
            this.log.debug(`room event ${event}`, {...this.logContext, event, args: minimizedArgs});
        }
        return super.emit(event, ...args);
    }
}

function mapArgs(args: unknown[]): any {
    return args.map((arg: unknown) => {
        if (!arg) {
            return;
        }
        if (Array.isArray(arg)) {
            return mapArgs(arg);
        }
        if (typeof arg === 'object') {
            return 'logContext' in arg && arg.logContext;
        }
        return arg;
    });
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

    trackUnpublished: (publication: RemoteTrackPublication, participant: RemoteParticipant) => void;

    /**
     * 解除订阅
     * @param track
     * @param publication
     * @param participant
     */
    trackUnsubscribed: (
        track: RemoteTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
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
    trackSubscriptionPermissionChanged: (
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