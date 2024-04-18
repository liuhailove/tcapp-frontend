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
    ParticipantPermission,
    Room as RoomModel, ServerInfo,
    SubscriptionError,
} from "../protocol/tc_models_pb";
import RemoteTrack from "./track/RemoteTrack";
import {TrackPublication} from "./track/TrackPublication";
import {Track} from "./track/Track";
import RemoteTrackPublication from "./track/RemoteTrackPublication";
import RemoteParticipant from "@/components/live_streams/room/participant/RemoteParticipant";
import Participant from "@/components/live_streams/room/participant/Participant";
import LocalParticipant from "@/components/live_streams/room/participant/LocalParticipant";
import LocalTrackPublication from "@/components/live_streams/room/track/LocalTrackPublication";
import RTCEngine from "@/components/live_streams/room/RTCEngine";
import {
    InternalRoomConnectOptions,
    InternalRoomOptions,
    RoomConnectOptions,
    RoomOptions
} from "@/components/live_streams/options";
import {
    Future,
    isBrowserSupported,
    isCloud,
    isReactNative, isWeb,
    Mutex,
    toHttpUrl,
    unwrapConstraint
} from "@/components/live_streams/room/utils";
import {E2EEManager} from "@/components/live_streams/e2ee/E2eeManager";
import {
    audioDefaults,
    publishDefaults,
    roomOptionDefaults,
    videoDefaults
} from "@/components/live_streams/room/defaults";
import {EncryptionEvent} from "@/components/live_streams/e2ee";
import {EngineEvent, RoomEvent} from "@/components/live_streams/room/TrackEvents";
import DeviceManager from "@/components/live_streams/room/DeviceManager";
import {RegionUrlProvider} from "@/components/live_streams/room/RegionUrlProvider";
import {ConnectionError, ConnectionErrorReason, UnsupportedServer} from "@/components/live_streams/room/errors";
import {JoinResponse} from "@/components/live_streams/protocol/tc_rtc_pb";
import {join} from "typedoc/dist/lib/output/themes/lib";

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
            .on(EngineEvent.ParticipantUpdate, this.handleParticipantUpdate)
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
        this.handleParticipantUpdate([pi, ...joinResponse.otherParticipants]);

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
        if(this.regionUrlProvider?.isCloud()){
            this.engine.setRegionUrlProvider(this.regionUrlProvider);
        }

        this.acquireAudioContext();

        this.connOptions={...roomOptionDefaults,...opts} as InternalRoomConnectOptions;

        if(this.connOptions.rtcConfig){
            this.engine.rtcConfig=this.connOptions.rtcConfig;
        }
        if(this.connOptions.peerConnectionTimeout){
            this.engine.peerConnectionTimeout=this.connOptions.peerConnectionTimeout;
        }

        try{
            const joinResponse=await this.connectSignal(
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
        }catch (err){
            await this.engine.close();
            this.recreateEngine();
            const resultingError=new ConnectionError(`could not establish signal connection`);
            if(err instanceof Error){
                resultingError.message=`${resultingError.message}: ${err.message}`;
            }
            if(err instanceof ConnectionError){
                resultingError.reason=err.reason;
                resultingError.status=err.status;
            }
            this.log.debug(`error trying to establish signal connection`,{
                ...this.logContext,
                error:err,
            });
            throw resultingError;
        }

        if(abortController.signal.aborted){
            await this.engine.close();
            this.recreateEngine();
            throw new ConnectionError(`Connection attempt aborted`);
        }

        try{
            await this.engine.waitForPCInitialConnection(
                this.connOptions.peerConnectionTimeout,
                abortController,
            );
        }catch (e){
            await this.engine.close();
            this.recreateEngine();
            throw e;
        }

        // 还挂钩卸载事件
        if(isWeb() && this.options.disconnectOnPageLeave){
            // 捕获“pagehide”和“beforeunload”以捕获最广泛的浏览器行为
            window.addEventListener('pagehide',this.onPageLeave);
            window.addEventListener('beforeunload',this.onPageLeave);
        }
        if(isWeb()){
            document.addEventListener('freeze',thi.onPageLeave);
            navigator.mediaDevices?.addEventListener('devicechange',this.handleDeviceChange);
        }
        this.setAndEmitConnectionState(ConnectionState.Connected);
        this.emit(RoomEvent.Connected);
        this.registerConnectionReconcile();
    }
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