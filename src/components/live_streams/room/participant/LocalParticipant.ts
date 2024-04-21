import Participant from "./Participant";
import LocalTrackPublication from "../track/LocalTrackPublication";
import {Track} from "../track/Track";
import LocalTrack from "../track/LocalTrack";
import {
    DataPacket,
    DataPacket_Kind,
    Encryption_Type, ParticipantInfo,
    ParticipantPermission,
    UserPacket
} from "../../protocol/tc_models_pb";
import {InternalRoomOptions} from "../../options";
import {Future, isFireFox, isSafari, isSafari17, isSVCCodec, isWeb, supportsAV1, supportsVP9} from "../utils";
import RTCEngine from "../RTCEngine";
import {EngineEvent, ParticipantEvent, TrackEvent} from "../TrackEvents";
import {
    AudioCaptureOptions,
    BackupVideoCodec,
    CreateLocalTrackOptions, isBackupCodec,
    ScreenShareCaptureOptions,
    ScreenSharePresets,
    TrackPublishOptions,
    VideoCaptureOptions,
    VideoPresets
} from "../track/options";
import {DeviceUnsupportedError, TrackInvalidError, UnexpectedConnectionState} from "../errors";
import {
    constraintsForOptions,
    getLogContextFromTrack,
    mergeDefaultOptions,
    mimeTypeToVideoCodecString,
    screenCaptureToDisplayMediaStreamOptions
} from "../track/utils";
import {computeTrackBackupEncodings, computeVideoEncodings, mediaTrackToLocalTrack} from "./publishUtils";
import LocalVideoTrack, {videoLayersFromEncodings} from "../track/LocalVideoTrack";
import LocalAudioTrack from "../track/LocalAudioTrack";
import {defaultVideoCodec} from "../defaults";
import {
    AddTrackRequest,
    SimulcastCodec,
    SubscribedQualityUpdate,
    TrackUnpublishedResponse
} from "../../protocol/tc_rtc_pb";
import {PCTransportState} from "../PCTransportManager";
import {DataPublishOptions} from "../types";


/**
 * 本地参与者
 */
export default class LocalParticipant extends Participant {
    audioTrackPublications: Map<string, LocalTrackPublication>;

    videoTrackPublications: Map<string, LocalTrackPublication>;

    /** map of track sid => all published tracks */
    trackPublications: Map<string, LocalTrackPublication>;

    /**
     * RTC引擎
     */
    engine: RTCEngine;

    /** @internal */
    activeDeviceMap: Map<MediaDeviceKind, string>;

    /**
     * 待发布的音频源
     */
    private pendingPublishing = new Set<Track.Source>;

    private pendingPublishPromises = new Map<LocalTrack, Promise<LocalTrackPublication>>();

    /**
     * 摄像头错误
     */
    private cameraError: Error | undefined;

    /**
     * micro错误
     */
    private microphoneError: Error | undefined;

    /**
     * 参与者音轨权限
     */
    private participantTrackPermissions: Array<ParticipantPermission> = [];

    /**
     * 是否所有参与者都可以订阅
     */
    private allParticipantsAllowedToSubscribe: boolean = true;

    // 保留指向房间选项的指针
    private roomOptions: InternalRoomOptions;

    /**
     * 加密类型
     */
    private encryptionType: Encryption_Type = Encryption_Type.NONE;

    private reconnectFuture?: Future<void>;

    /** @internal */
    constructor(sid: string, identity: string, engine: RTCEngine, options: InternalRoomOptions) {
        super(sid, identity, undefined, undefined, {
            loggerName: options.loggerName,
            loggerContextCb: () => this.engine.logContext,
        });
        this.audioTrackPublications = new Map();
        this.videoTrackPublications = new Map();
        this.trackPublications = new Map();
        this.engine = engine;
        this.roomOptions = options;
        this.setupEngine(engine);
        this.activeDeviceMap = new Map<MediaDeviceKind, string>();
    }

    get lastCameraError(): Error | undefined {
        return this.cameraError;
    }

    get lastMicrophoneError(): Error | undefined {
        return this.microphoneError;
    }

    get isE2EEEnabled(): boolean {
        return this.encryptionType !== Encryption_Type.NONE;
    }

    getTrackPublication(source: Track.Source): LocalTrackPublication | undefined {
        const track = super.getTrackPublication(source);
        if (track) {
            return track as LocalTrackPublication;
        }
    }

    getTrackPublicationByName(name: string): LocalTrackPublication | undefined {
        const track = super.getTrackPublicationByName(name);
        if (track) {
            return track as LocalTrackPublication;
        }
    }

    /**
     * @internal
     */
    setupEngine(engine: RTCEngine) {
        this.engine = engine;
        this.engine.on(EngineEvent.RemoteMute, (trackSid: string, muted: boolean) => {
            const pub = this.videoTrackPublications.get(trackSid);
            if (!pub || !pub.track) {
                return;
            }
            if (muted) {
                pub.mute();
            } else {
                pub.unmute();
            }
        });

        this.engine
            .on(EngineEvent.Connected, this.handleReconnected)
            .on(EngineEvent.SignalRestarted, this.handleReconnected)
            .on(EngineEvent.SignalResumed, this.handleReconnected)
            .on(EngineEvent.Restarting, this.handleReconnecting)
            .on(EngineEvent.Resuming, this.handleReconnceting)
            .on(EngineEvent.LocalTrackUnpublished, this.handleLocalTrackUnpublihsed)
            .on(EngineEvent.SubscribedQualityUpdate, this.handleSubscribedQualityUpdate)
            .on(EngineEvent.Disconnected, this.handleDisconnected);
    }

    /**
     * 处理重连
     */
    private handleReconnecting = () => {
        if (!this.reconnectFuture) {
            this.reconnectFuture = new Future<void>();
        }
    }

    /**
     * 处理重连完成
     */
    private handleReconnected = () => {
        this.reconnectFuture?.resolve?.();
        this.reconnectFuture = undefined;
        this.updateTrackSubscriptionPermissions();
    };

    /**
     * 处理断开连接
     */
    private handleDisconnected = () => {
        if (this.reconnectFuture) {
            this.reconnectFuture.promise.catch((e) => this.log.warn(e.message, this.logContext));
            this.reconnectFuture?.reject?.('Got disconnected during reconnection attempt');
            this.reconnectFuture = undefined;
        }
    };

    /**
     * 设置和更新本地参与者的元数据。
     * 更改不会立即生效。
     * 如果成功，本地参与者将发出“ParticipantEvent.MetadataChanged”事件。
     * 注意：这需要 `canUpdateOwnMetadata` 权限。
     * @参数 matada
     */
    setMetadata(metadata: string): void {
        this.engine.client.sendUpdateLocalMetadata(metadata, this.name ?? '');
    }

    /**
     * 启用或禁用参与者的摄像机轨迹。
     *
     * 如果曲目已发布，它将将该曲目静音或取消静音。
     * 如果成功，则解析为“LocalTrackPublication”实例，否则解析为“未定义”
     */
    setCameraEnabled(
        enabled: boolean,
        options?: VideoCaptureOptions,
        publishOptions?: TrackPublishOptions,
    ): Promise<LocalTrackPublication | undefined> {
        return this.setTrackEnabled(Track.Source.Camera, enabled, options, publishOptions);
    }

    /**
     * 启用或禁用与会者的麦克风轨道。
     *
     * 如果曲目已发布，它将将该曲目静音或取消静音。
     * 如果成功，则解析为“LocalTrackPublication”实例，否则解析为“未定义”
     */
    setMicrophoneEnabled(
        enabled: boolean,
        options?: AudioCaptureOptions,
        publishOptions?: TrackPublishOptions,
    ): Promise<LocalTrackPublication | undefined> {
        return this.setTrackEnabled(Track.Source.Microphone, enabled, options, publishOptions);
    }

    /**
     * 开始或停止共享参与者的屏幕
     * 如果成功，则解析为“LocalTrackPublication”实例，否则解析为“未定义”
     */
    setScreenShareEnabled(
        enabled: boolean,
        options?: ScreenShareCaptureOptions,
        publishOptions?: TrackPublishOptions,
    ): Promise<LocalTrackPublication | undefined> {
        return this.setTrackEnabled(Track.Source.ScreenShare, enabled, options, publishOptions);
    }

    /** @internal */
    setPermissions(permissions: ParticipantPermission): boolean {
        const prevPermissions = this.permissions;
        const changed = super.setPermissions(permissions);
        if (changed && prevPermissions) {
            this.emit(ParticipantEvent.ParticipantPermissionsChanged, prevPermissions);
        }
        return changed;
    }

    /** @internal */
    async setE2EEEnabled(enabled: boolean) {
        this.encryptionType = enabled ? Encryption_Type.GCM : Encryption_Type.NONE;
        await this.republishAllTracks(undefined, false);
    }

    /**
     * 启用或禁用按源发布曲目。 这是管理公共轨道（摄像头、麦克风或屏幕共享）的简单方法。
     * 如果成功则用 LocalTrackPublication 解决，否则无效
     */
    private async setTrackEnabled(
        source: Extract<Track.Source, Track.Source.Camera>,
        enabled: boolean,
        options?: VideoCaptureOptions,
        publishOptions?: TrackPublishOptions,
    ): Promise<LocalTrackPublication | undefined>;

    private async setTrackEnabled(
        source: Extract<Track.Source, Track.Source.Microphone>,
        enabled: boolean,
        options?: AudioCaptureOptions,
        publishOptions?: TrackPublishOptions,
    ): Promise<LocalTrackPublication | undefined>;

    private async setTrackEnabled(
        source: Extract<Track.Source, Track.Source.ScreenShare>,
        enabled: boolean,
        options?: ScreenShareCaptureOptions,
        publishOptions?: TrackPublishOptions,
    ): Promise<LocalTrackPublication | undefined>;

    private async setTrackEnabled(
        source: Track.Source,
        enabled: true,
        options?: VideoCaptureOptions | AudioCaptureOptions | ScreenShareCaptureOptions,
        publishOptions?: TrackPublishOptions,
    ) {
        this.log.debug('setTrackEnabled', {...this.logContext, source, enabled});
        let track = this.getTrackPublication(source);
        if (enabled) {
            if (track) {
                await track.unmute();
            } else {
                let localTracks: Array<LocalTrack> | undefined;
                if (this.pendingPublishing.has(source)) {
                    this.log.info('skipping duplicate published source', {...this.logContext, source});
                    // 没有操作，已经被请求过了
                    return;
                }
                this.pendingPublishing.add(source);
                try {
                    switch (source) {
                        case Track.Source.Camera:
                            localTracks = await this.createTracks({
                                video: (options as VideoCaptureOptions | undefined) ?? true,
                            });

                            break;
                        case Track.Source.Microphone:
                            localTracks = await this.createTracks({
                                audio: (options as AudioCaptureOptions | undefined) ?? true,
                            });
                            break;
                        case Track.Source.ScreenShare:
                            localTracks = await this.createScreenTracks({
                                ...(options as ScreenShareCaptureOptions | undefined),
                            });
                            break;
                        default:
                            throw new TrackInvalidError(source);
                    }
                    const publishPromises: Array<Promise<LocalTrackPublication>> = [];
                    for (const localTrack of localTracks) {
                        this.log.info('publishing track', {
                            ...this.logContext,
                            ...getLogContextFromTrack(localTrack)
                        });
                        publishPromises.push(this.publishTrack(localTrack, publishOptions));
                    }

                    const publishedTracks = await Promise.all(publishPromises);
                    // 对于包括音频的屏幕共享出版物，这只会返回屏幕共享出版物，而不是屏幕共享音频
                    // 如果我们想返回 v2 的曲目数组，请重新访问
                    [track] = publishedTracks;
                } catch (e) {
                    localTracks?.forEach((tr) => {
                        tr.stop();
                    });
                    if (e instanceof Error && !(e instanceof TrackInvalidError)) {
                        this.emit(ParticipantEvent.MediaDevicesError, e);
                    }
                    throw e;
                } finally {
                    this.pendingPublishing.delete(source);
                }
            }
        } else if (track && track.track) {
            // 屏幕共享无法静音，请取消发布
            if (source === Track.Source.ScreenShare) {
                track = await this.unpublishTrack(track.track);
                const screenAudioTrack = this.getTrackPublication(Track.Source.ScreenShareAudio);
                if (screenAudioTrack && screenAudioTrack.track) {
                    this.unpublishTrack(screenAudioTrack.track);
                }
            } else {
                await track.mute();
            }
        }
        return track;
    }

    async enableCameraAndMicrophone() {
        if (
            this.pendingPublishing.has(Track.Source.Camera) ||
            this.pendingPublishing.has(Track.Source.Microphone)
        ) {
            // 没有操作，因为已经被请求过了
            return;
        }

        this.pendingPublishing.add(Track.Source.Camera);
        this.pendingPublishing.add(Track.Source.Microphone);
        try {
            const tracks: LocalTrack[] = await this.createTracks({
                audio: true,
                video: true,
            });

            await Promise.all(tracks.map((track) => this.publishTrack(track)));
        } finally {
            this.pendingPublishing.delete(Track.Source.Camera);
            this.pendingPublishing.delete(Track.Source.Microphone);
        }
    }

    /**
     * 创建本地视频或者麦克风音轨
     */
    async createTracks(options?: CreateLocalTrackOptions): Promise<LocalTrack[]> {
        const opts = mergeDefaultOptions(
            options,
            this.roomOptions?.audioCaptureDefaults,
            this.roomOptions?.videoCaptureDefaults,
        );

        const constraints = constraintsForOptions(opts);
        let stream: MediaStream | undefined;
        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
            if (err instanceof Error) {
                if (constraints.audio) {
                    this.microphoneError = err;
                }
                if (constraints.video) {
                    this.cameraError = err;
                }
            }

            throw err;
        }

        if (constraints.audio) {
            this.microphoneError = undefined;
            this.emit(ParticipantEvent.AudioStreamAcquired);
        }
        if (constraints.video) {
            this.cameraError = undefined;
        }

        return stream.getTracks().map((mediaStreamTrack) => {
            const isAudio = mediaStreamTrack.kind === 'audio';
            let trackOptions = isAudio ? options!.audio : options!.video;
            if (typeof trackOptions === 'boolean' || !trackOptions) {
                trackOptions = {};
            }
            let trackConstraints: MediaTrackConstraints | undefined;
            const conOrBool = isAudio ? constraints.audio : constraints.video;
            if (typeof conOrBool !== 'boolean') {
                trackConstraints = conOrBool;
            }
            const track = mediaTrackToLocalTrack(mediaStreamTrack, trackConstraints, {
                loggerName: this.roomOptions.loggerName,
                loggerContextCb: () => this.logContext,
            });
            if (track.kind === Track.Kind.Video) {
                track.source = Track.Source.Camera;
            } else if (track.kind === Track.Kind.Audio) {
                track.source = Track.Source.Microphone;
            }
            track.mediaStream = stream;
            return track;
        });
    }

    /**
     * Creates a screen capture tracks with getDisplayMedia().
     * A LocalVideoTrack is always created and returned.
     * If { audio: true }, and the browser supports audio capture, a LocalAudioTrack is also created.
     */
    async createScreenTracks(options?: ScreenShareCaptureOptions): Promise<Array<LocalTrack>> {
        if (options === undefined) {
            options = {};
        }

        if (navigator.mediaDevices.getDisplayMedia === undefined) {
            throw new DeviceUnsupportedError('getDisplayMedia not supported');
        }

        if (options.resolution === undefined && !isSafari17()) {
            // we need to constrain the dimensions, otherwise it could lead to low bitrate
            // due to encoding a huge video. Encoding such large surfaces is really expensive
            // unfortunately Safari 17 has a bug and cannot be constrained by default
            options.resolution = ScreenSharePresets.h1080fps30.resolution;
        }

        const constraints = screenCaptureToDisplayMediaStreamOptions(options);
        const stream: MediaStream = await navigator.mediaDevices.getDisplayMedia(constraints);

        const tracks = stream.getVideoTracks();
        if (tracks.length === 0) {
            throw new TrackInvalidError('no video track found');
        }
        const screenVideo = new LocalVideoTrack(tracks[0], undefined, false, {
            loggerName: this.roomOptions.loggerName,
            loggerContextCb: () => this.logContext,
        });
        screenVideo.source = Track.Source.ScreenShare;
        if (options.contentHint) {
            screenVideo.mediaStreamTrack.contentHint = options.contentHint;
        }

        const localTracks: Array<LocalTrack> = [screenVideo];
        if (stream.getAudioTracks().length > 0) {
            this.emit(ParticipantEvent.AudioStreamAcquired);
            const screenAudio = new LocalAudioTrack(
                stream.getAudioTracks()[0],
                undefined,
                false,
                this.audioContext,
                {loggerName: this.roomOptions.loggerName, loggerContextCb: () => this.logContext},
            );
            screenAudio.source = Track.Source.ScreenShareAudio;
            localTracks.push(screenAudio);
        }
        return localTracks;
    }

    /**
     * 向房间发送音轨
     */
    async publishTrack(
        track: LocalTrack | MediaStreamTrack,
        options?: TrackPublishOptions,
    ): Promise<LocalTrackPublication> {
        if (track instanceof LocalAudioTrack) {
            track.setAudioContext(this.audioContext);
        }

        await this.reconnectFuture?.promise;
        if (track instanceof LocalTrack && this.pendingPublishPromises.has(track)) {
            await this.pendingPublishPromises.get(track);
        }
        let defaultConstraints: MediaTrackConstraints | undefined;
        if (track instanceof MediaStreamTrack) {
            defaultConstraints = track.getConstraints();
        } else {
            // we want to access constraints directly as `track.mediaStreamTrack`
            // might be pointing to a non-device track (e.g. processed track) already
            defaultConstraints = track.constraints;
            let deviceKind: MediaDeviceKind | undefined = undefined;
            switch (track.source) {
                case Track.Source.Microphone:
                    deviceKind = 'audioinput';
                    break;
                case Track.Source.Camera:
                    deviceKind = 'videoinput';
                    break;
                default:
                    break;
            }
            if (deviceKind && this.activeDeviceMap.has(deviceKind)) {
                defaultConstraints = {
                    ...defaultConstraints,
                    deviceId: this.activeDeviceMap.get(deviceKind),
                };
            }
        }
        // convert raw media track into audio or video track
        if (track instanceof MediaStreamTrack) {
            switch (track.kind) {
                case 'audio':
                    track = new LocalAudioTrack(track, defaultConstraints, true, this.audioContext, {
                        loggerName: this.roomOptions.loggerName,
                        loggerContextCb: () => this.logContext,
                    });
                    break;
                case 'video':
                    track = new LocalVideoTrack(track, defaultConstraints, true, {
                        loggerName: this.roomOptions.loggerName,
                        loggerContextCb: () => this.logContext,
                    });
                    break;
                default:
                    throw new TrackInvalidError(`unsupported MediaStreamTrack kind ${track.kind}`);
            }
        } else {
            track.updateLoggerOptions({
                loggerName: this.roomOptions.loggerName,
                loggerContextCb: () => this.logContext,
            });
        }

        // is it already published? if so skip
        let existingPublication: LocalTrackPublication | undefined;
        this.trackPublications.forEach((publication) => {
            if (!publication.track) {
                return;
            }
            if (publication.track === track) {
                existingPublication = <LocalTrackPublication>publication;
            }
        });

        if (existingPublication) {
            this.log.warn('track has already been published, skipping', {
                ...this.logContext,
                ...getLogContextFromTrack(existingPublication),
            });
            return existingPublication;
        }

        const isStereoInput =
            ('channelCount' in track.mediaStreamTrack.getSettings() &&
                // @ts-ignore `channelCount` on getSettings() is currently only available for Safari, but is generally the best way to determine a stereo track https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/channelCount
                track.mediaStreamTrack.getSettings().channelCount === 2) ||
            track.mediaStreamTrack.getConstraints().channelCount === 2;
        const isStereo = options?.forceStereo ?? isStereoInput;

        // disable dtx for stereo track if not enabled explicitly
        if (isStereo) {
            if (!options) {
                options = {};
            }
            if (options.dtx === undefined) {
                this.log.info(
                    `Opus DTX will be disabled for stereo tracks by default. Enable them explicitly to make it work.`,
                    {
                        ...this.logContext,
                        ...getLogContextFromTrack(track),
                    },
                );
            }
            if (options.red === undefined) {
                this.log.info(
                    `Opus RED will be disabled for stereo tracks by default. Enable them explicitly to make it work.`,
                );
            }
            options.dtx ??= false;
            options.red ??= false;
        }
        const opts: TrackPublishOptions = {
            ...this.roomOptions.publishDefaults,
            ...options,
        };

        // disable simulcast if e2ee is set on safari
        if (isSafari() && this.roomOptions.e2ee) {
            this.log.info(
                `End-to-end encryption is set up, simulcast publishing will be disabled on Safari`,
                {
                    ...this.logContext,
                },
            );
            opts.simulcast = false;
        }
        const publishPromise = this.publish(track, opts, isStereo);
        this.pendingPublishPromises.set(track, publishPromise);
        try {
            return await publishPromise;
        } catch (e) {
            throw e;
        } finally {
            this.pendingPublishPromises.delete(track);
        }
    }

    /**
     * 发布音轨
     * @param track 本地音轨
     * @param opts 发布选项
     * @param isStereo 是否为立体声
     */
    private async publish(track: LocalTrack, opts: TrackPublishOptions, isStereo: boolean) {
        const existingTrackOfSource = Array.from(this.trackPublications.values()).find(
            (publishedTrack) => track instanceof LocalTrack && publishedTrack.source === track.source,
        );
        if (existingTrackOfSource && track.source !== Track.Source.Unknown) {
            this.log.info(`publishing a second track with the same source: ${track.source}`, {
                ...this.logContext,
                ...getLogContextFromTrack(track),
            });
        }
        if (opts.stopMicTrackOnMute && track instanceof LocalAudioTrack) {
            track.stopOnMute = true;
        }

        if (track.source === Track.Source.ScreenShare && isFireFox()) {
            // Firefox 不能很好地使用联播屏幕共享
            // 启用后，我们经常无法获取第 0 层的数据
            opts.simulcast = false;
        }

        // 使用前需要完整的 AV1/VP9 SVC 支持
        if (opts.videoCodec === 'av1' && !supportsAV1()) {
            opts.videoCodec = undefined;
        }
        if (opts.videoCodec === 'vp9' && !supportsVP9()) {
            opts.videoCodec = undefined;
        }
        if (opts.videoCodec === undefined) {
            opts.videoCodec = defaultVideoCodec;
        }
        const videoCodec = opts.videoCodec;

        // 处理音轨动作
        track.on(TrackEvent.Muted, this.onTrackMuted);
        track.on(TrackEvent.Unmuted, this.onTrackUnmuted);
        track.on(TrackEvent.Ended, this.handleTrackEnded);
        track.on(TrackEvent.UpstreamPaused, this.onTrackUpstreamPaused);
        track.on(TrackEvent.UpstreamResumed, this.onTrackUpstreamResumed);

        // 从track创建track发布
        const req = new AddTrackRequest({
            // 获取本地轨道 ID 以供在发布期间使用
            cid: track.mediaStreamTrack.id,
            name: opts.name,
            type: Track.kindToProto(track.kind),
            muted: track.isMuted,
            source: Track.sourceToProto(track.source),
            disableDtx: !(opts.dtx ?? true),
            encryption: this.encryptionType,
            stereo: isStereo,
            disableRed: this.isE2EEEnabled || !(opts.red ?? true),
            stream: opts?.stream,
        });

        // 计算视频的编码和层
        let encodings: RTCRtpEncodingParameters[] | undefined;
        if (track.kind === Track.Kind.Video) {
            let dims: Track.Dimensions = {
                width: 0,
                height: 0,
            };
            try {
                dims = await track.waitForDimensions();
            } catch (e) {
                // 使用默认值，如果没有联播，拥塞控制会很痛苦
                // 因此根据发布设置使用默认的暗淡
                const defaultRes =
                    this.roomOptions.videoCaptureDefaults?.resolution ?? VideoPresets.h720.resolution;
                dims = {
                    width: defaultRes.width,
                    height: defaultRes.height,
                };
                // 记录失败
                this.log.error('could not determine track dimensions, using defaults', {
                    ...this.logContext,
                    ...getLogContextFromTrack(track),
                    dims,
                });
            }
            // 应为视频定义宽度和高度
            req.width = dims.width;
            req.height = dims.height;
            // 对于 svc 编解码器，禁用联播并使用 vp8 作为备份编解码器
            if (track instanceof LocalVideoTrack) {
                if (isSVCCodec(videoCodec)) {
                    if (track.source === Track.Source.ScreenShare) {
                        // 带有屏幕共享的 vp9 svc 无法编码多个空间层
                        // 这样做会将发布分辨率降低到最小分辨率
                        opts.scalabilityMode = 'L1T3';
                        // Chrome 不允许 L1T3 超过 5 fps，并且 L3T3 存在编码错误
                        // 它有不同的屏幕共享处理路径，并且似乎未经测试/有错误
                        // 作为解决方法，我们设置 contentHint 来强制它经历相同的过程
                        // 作为常规相机视频的路径。 虽然这不是最佳的，但它提供了性能
                        // 我们需要的
                        if ('contentHint' in track.mediaStreamTrack) {
                            track.mediaStreamTrack.contentHint = 'motion';
                            this.log.info('forcing contentHint to motion for screenshare with SVC codecs', {
                                ...this.logContext,
                                ...getLogContextFromTrack(track),
                            });
                        }
                    }
                    // 默认情况下将scalabilityMode设置为“L3T3_KEY”
                    opts.scalabilityMode = opts.scalabilityMode ?? 'L3T3_KEY';
                }

                req.simulcastCodecs = [
                    new SimulcastCodec({
                        codec: videoCodec,
                        cid: track.mediaStreamTrack.id,
                    }),
                ];

                // 建立备份
                if (opts.backupCodec &&
                    videoCodec !== opts.backupCodec.codec &&
                    // TODO 一旦备份编解码器支持 e2ee，就删除它
                    req.encryption === Encryption_Type.NONE
                ) {
                    // 多编解码器联播需要 dynacast
                    if (!this.roomOptions.dynacast) {
                        this.roomOptions.dynacast = true;
                    }
                    req.simulcastCodecs.push(
                        new SimulcastCodec({
                            codec: opts.backupCodec.codec,
                            cid: '',
                        }),
                    );
                }
            }

            encodings = computeVideoEncodings(
                track.source === Track.Source.ScreenShare,
                req.width,
                req.height,
                opts,
            );
            req.layers = videoLayersFromEncodings(
                req.width,
                req.height,
                encodings,
                isSVCCodec(opts.videoCodec),
            );
        } else if (track.kind === Track.Kind.Audio) {
            encodings = [
                {
                    maxBitrate: opts.audioPreset?.maxBitrate,
                    priority: opts.audioPreset?.priority ?? 'high',
                    networkPriority: opts.audioPreset?.priority ?? 'high',
                },
            ];
        }

        if (!this.engine || this.engine.isClosed) {
            throw new UnexpectedConnectionState('cannot publish track when not connected');
        }

        const ti = await this.engine.addTrack(req);
        // 服务器可能不支持客户端请求的编解码器，在这种情况下，回退
        // 到支持的编解码器
        let primaryCodecMime: string | undefined;
        ti.codecs.forEach((codec) => {
            if (primaryCodecMime === undefined) {
                primaryCodecMime = codec.mimeType;
            }
        });
        if (primaryCodecMime && track.kind === Track.Kind.Video) {
            const updatedCodec = mimeTypeToVideoCodecString(primaryCodecMime);
            if (updatedCodec !== videoCodec) {
                this.log.debug('falling back to server selected codec', {
                    ...this.logContext,
                    ...getLogContextFromTrack(track),
                    codec: updatedCodec,
                });
                /* @ts-ignore */
                opts.videoCodec = updatedCodec;

                // 重新计算编码，因为比特率等可能已经改变
                encodings = computeVideoEncodings(
                    track.source === Track.Source.ScreenShare,
                    req.width,
                    req.height,
                    opts,
                );
            }
        }

        const publication = new LocalTrackPublication(track.kind, ti, track, {
            loggerName: this.roomOptions.loggerName,
            loggerContextCb: () => this.logContext,
        });
        // 保存需要再次重新发布时的选项
        publication.options = opts;
        track.sid = ti.sid;

        if (!this.engine.pcManager) {
            throw new UnexpectedConnectionState('pcManager is not ready');
        }
        this.log.debug(`publishing ${track.kind} with encodings`, {
            ...this.logContext,
            encodings,
            trackInfo: ti,
        });

        track.sender = await this.engine.createSender(track, opts, encodings);

        if (encodings) {
            if (isFireFox() && track.kind === Track.Kind.Audio) {
                /* 参考RFC https://datatracker.ietf.org/doc/html/rfc7587#section-6.1,
            tc-server 在应答 sdp 中使用 maxaveragebitrate=510000 来允许客户端
            发布高品质音轨。 但firefox总是使用这个值作为实际值
            比特率，导致在任何立体声情况下音频比特率意外上升至 510Kbps。
            因此，客户端需要将应答 sdp 中的 maxaveragebitrates 修改为用户提供的值
            解决问题。 */
                let trackTransceiver: RTCRtpTransceiver | undefined = undefined;
                for (const transceiver of this.engine.pcManager.publisher.getTransceivers()) {
                    if (transceiver.sender === track.sender) {
                        trackTransceiver = transceiver;
                        break;
                    }
                }
                if (trackTransceiver) {
                    this.engine.pcManager.publisher.setTrackCodecBitrate({
                        transceiver: trackTransceiver,
                        codec: 'opus',
                        maxbr: encodings[0]?.maxBitrate ? encodings[0].maxBitrate / 1000 : 0,
                    });
                }
            } else if (track.codec && track.codec === 'av1' && encodings[0]?.maxBitrate) {
                // AV1需要在SDP中设置x-start-bitrate
                this.engine.pcManager.publisher.setTrackCodecBitrate({
                    cid: req.cid,
                    codec: track.codec,
                    maxbr: encodings[0].maxBitrate / 1000,
                });
            }
        }

        if (track.kind === Track.Kind.Video && track.source === Track.Source.ScreenShare) {
            // 我们强制执行此设置而不允许覆盖的一些原因：
            // 1. 如果没有这个，Chrome 似乎会积极调整 SVC 视频的大小，并声明“质量限制：带宽”，即使 BW 不是问题
            // 2. 由于我们要重写 contentHint 来进行运动（以解决 L1T3 发布问题），因此它会将默认的degradationPreference 重写为 `balanced`
            try {
                this.log.debug(`setting degradationPreference to maintain-resolution`);
                const params = track.sender.getParameters();
                params.degradationPreference = 'maintain-resolution';
                await track.sender.setParameters(params);
            } catch (e) {
                this.log.warn(`failed to set degradationPreference: ${e}`);
            }
        }

        await this.engine.negotiate();

        if (track instanceof LocalVideoTrack) {
            track.startMonitor(this.engine.client);
        } else if (track instanceof LocalAudioTrack) {
            track.startMonitor();
        }

        this.addTrackPublication(publication);
        // 发送事件以供发布
        this.emit(ParticipantEvent.LocalTrackPublished, publication);
        return publication;
    }

    override get isLocal(): boolean {
        return true;
    }

    /**
     * 将额外的编解码器发布到现有轨道
     * @internal
     */
    async publishAdditionalCodecForTrack(
        track: LocalTrack | MediaStreamTrack,
        videoCodec: BackupVideoCodec,
        options?: TrackPublishOptions,
    ) {
        // TODO 一旦备份轨道支持 e2ee，就会删除
        if (this.encryptionType !== Encryption_Type.NONE) {
            return;
        }

        // 还没有发布吗？ 如果是这样跳过
        let existingPublication: LocalTrackPublication | undefined;
        this.trackPublications.forEach((publication) => {
            if (!publication.track) {
                return;
            }
            if (publication.track === track) {
                existingPublication = <LocalTrackPublication>publication;
            }
        });

        if (!existingPublication) {
            throw new TrackInvalidError('track is not published');
        }

        if (!(track instanceof LocalVideoTrack)) {
            throw new TrackInvalidError('track is not a video track');
        }

        const opts: TrackPublishOptions = {
            ...this.roomOptions?.publishDefaults,
            ...options,
        };

        const encodings = computeTrackBackupEncodings(track, videoCodec, opts);
        if (!encodings) {
            this.log.info(
                `backup codec has been disabled, ignoring request to add additional codec for track`,
                {
                    ...this.logContext,
                    ...getLogContextFromTrack(track),
                },
            );
            return;
        }
        const simulcastTrack = track.addSimulcastTrack(videoCodec, encodings);
        if (!simulcastTrack) {
            return;
        }
        const req = new AddTrackRequest({
            cid: simulcastTrack.mediaStreamTrack.id,
            type: Track.kindToProto(track.kind),
            muted: track.isMuted,
            source: Track.sourceToProto(track.source),
            sid: track.sid,
            simulcastCodecs: [
                {
                    codec: opts.videoCodec,
                    cid: simulcastTrack.mediaStreamTrack.id,
                }
            ],
        });
        req.layers = videoLayersFromEncodings(req.width, req.height, encodings);

        if (!this.engine || this.engine.isClosed) {
            throw new UnexpectedConnectionState('cannot publish track when not connected');
        }

        const ti = await this.engine.addTrack(req);

        const transceiverInit: RTCRtpTransceiverInit = {direction: 'sendonly'};
        if (encodings) {
            transceiverInit.sendEncodings = encodings;
        }
        await this.engine.createSimulcastSender(track, simulcastTrack, opts, encodings);

        await this.engine.negotiate();
        this.log.debug(`published ${videoCodec} for track ${track.sid}`, {
            ...this.logContext,
            encodings,
            trackInfo: ti,
        });
    }

    async unpublishTrack(
        track: LocalTrack | MediaStreamTrack,
        stopOnUnpublish?: boolean
    ): Promise<LocalTrackPublication | undefined> {
        // 查看所有已发布的曲目以找到正确的曲目
        const publication = this.getPublicationForTrack(track);

        const pubLogContext = publication ? getLogContextFromTrack(publication) : undefined;

        this.log.debug('unpublishing track', {
            ...this.logContext,
            ...pubLogContext,
        });

        if (!publication || !publication.track) {
            this.log.warn('track was not unpublished because no publication was found', {
                ...this.logContext,
                ...pubLogContext,
            });
            return undefined;
        }

        track = publication.track;
        track.off(TrackEvent.Muted, this.onTrackMuted);
        track.off(TrackEvent.Unmuted, this.onTrackUnmuted);
        track.off(TrackEvent.Ended, this.handleTrackEnded);
        track.off(TrackEvent.UpstreamPaused, this.onTrackUpstreamPaused);
        track.off(TrackEvent.UpstreamResumed, this.onTrackUpstreamResumed);

        if (stopOnUnpublish === undefined) {
            stopOnUnpublish = this.roomOptions?.stopLocalTrackOnUnpublish ?? true;
        }
        if (stopOnUnpublish) {
            track.stop();
        }

        let negotiationNeeded = false;
        const trackSender = track.sender;
        track.sender = undefined;
        if (
            this.engine.pcManager &&
            this.engine.pcManager.currentState < PCTransportState.FAILED &&
            trackSender
        ) {
            try {
                for (const transceiver of this.engine.pcManager.publisher.getTransceivers()) {
                    // 如果发送者当前没有发送（在replaceTrack(null)之后）
                    //removeTrack 不会有任何效果。
                    // 为了确保我们最终成功删除轨道，请手动设置
                    // 收发器处于非活动状态
                    if (transceiver.sender === trackSender) {
                        transceiver.direction = 'inactive';
                        negotiationNeeded = true;
                    }
                }
                if (this.engine.removeTrack(trackSender)) {
                    negotiationNeeded = true;
                }
                if (track instanceof LocalVideoTrack) {
                    for (const [, trackInfo] of track.simulcastCodecs) {
                        if (trackInfo.sender) {
                            if (this.engine.removeTrack(trackInfo.sender)) {
                                negotiationNeeded = true;
                            }
                            trackInfo.sender = undefined;
                        }
                    }
                    track.simulcastCodecs.clear();
                }
            } catch (e) {
                this.log.warn('failed to unpublish track', {
                    ...this.logContext,
                    ...pubLogContext,
                    error: e,
                });
            }
        }

        // 从我们的maps中删除
        this.trackPublications.delete(publication.trackSid);
        switch (publication.kind) {
            case Track.Kind.Audio:
                this.audioTrackPublications.delete(publication.trackSid);
                break;
            case Track.Kind.Video:
                this.videoTrackPublications.delete(publication.trackSid);
                break;
            default:
                break;
        }

        this.emit(ParticipantEvent.LocalTrackUnpublished, publication);
        publication.setTrack(undefined);

        if (negotiationNeeded) {
            await this.engine.negotiate();
        }
        return publication;
    }

    async unpublishTracks(
        tracks: LocalTrack[] | MediaStreamTrack[],
    ): Promise<LocalTrackPublication[]> {
        const results = await Promise.all(tracks.map((track) => this.unpublishTrack(track)));
        return results.filter(
            (track) => track instanceof LocalTrackPublication,
        ) as LocalTrackPublication[];
    }

    async republishAllTracks(options?: TrackPublishOptions, restartTracks: boolean = true) {
        const localPubs: LocalTrackPublication[] = [];
        this.trackPublications.forEach((pub) => {
            if (pub.track) {
                if (options) {
                    pub.options = {...pub.options, ...options};
                }
                localPubs.push(pub);
            }
        });

        await Promise.all(
            localPubs.map(async (pub) => {
                const track = pub.track!;
                await this.unpublishTrack(track, false);
                if (
                    restartTracks &&
                    !track.isMuted &&
                    track.source !== Track.Source.ScreenShare &&
                    track.source !== Track.Source.ScreenShareAudio &&
                    (track instanceof LocalAudioTrack || track instanceof LocalVideoTrack) &&
                    !track.isUserProvided
                ) {
                    // 通常我们需要在发布之前重新启动轨道，通常是完全重新连接
                    // 是必要的，因为计算机已经进入睡眠状态。
                    this.log.debug('restarting existing track', {
                        ...this.logContext,
                        track: pub.trackSid,
                    });
                    await track.restartTrack();
                }
                await this.publishTrack(track, pub.options);
            }),
        );
    }

    /**
     * 向房间发布新的数据有效负载。 数据将被转发到每个
     * 如果publishOptions中的目的地字段为空，则参与房间
     *
     * @param data 有效负载的 Uint8Array。 要发送字符串数据，请使用 TextEncoder.encode
     * @param options 可选地指定“reliable”、“topic”和“destination”
     */
    async publishData(data: Uint8Array, options: DataPublishOptions = {}): Promise<void> {
        const kind = options.reliable ? DataPacket_Kind.RELIABLE : DataPacket_Kind.LOSSY;
        const destinationIdentities = options.destinationIdentities;
        const topic = options.topic;

        const packet = new DataPacket({
            kind: kind,
            value: {
                case: 'user',
                value: new UserPacket({
                    participantIdentity: this.identity,
                    payload: data,
                    destinationIdentities,
                    topic,
                }),
            },
        });

        await this.engine.sendDataPacket(packet, kind);
    }

    /**
     * 控制谁可以订阅 LocalParticipant 已发布的曲目。
     *
     * 默认情况下，所有参与者都可以订阅。 这允许细粒度的控制
     * 谁能够在参与者和跟踪级别订阅。
     *
     * 注意：如果在赛道级别授予访问权限（即 [allParticipantsAllowed] 和
     * [ParticipantTrackPermission.allTracksAllowed] 为 false），任何较新发布的曲目
     * 不会向任何参与者授予权限，并且需要后续的
     * 权限更新以允许订阅。
     *
     * @param allParticipantsAllowed 允许所有参与者订阅所有曲目。
     * 如果设置为 true，则优先于 [[participantTrackPermissions]]。
     * 默认情况下，此设置为 true。
     * @paramparticipantTrackPermissions 每个权限的完整列表
     * 参与者/轨道。 任何遗漏的参与者将不会获得任何权限。
     */
    setTrackSubscriptionPermissions(
        allParticipantsAllowed: boolean,
        participantTrackPermissions: ParticipantPermission[] = [],
    ) {
        this.participantTrackPermissions = participantTrackPermissions;
        this.allParticipantsAllowedToSubscribe = allParticipantsAllowed;
        if (!this.engine.client.isDisconnected) {
            this.updateTrackSubscriptionPermissions();
        }
    }

    /** @internal */
    updateInfo(info: ParticipantInfo): boolean {
        if (info.sid !== this.sid) {
            // 删除指定错误 sid 的更新。
            // 本地参与者的 sid 仅在加入和完全重新连接时显式设置
            return false;
        }
        if (!super.updateInfo(info)) {
            return false;
        }

        // 协调轨道静音状态。
        // 如果服务器的轨道静音状态与实际不匹配，我们必须更新
        // 服务器的副本
        info.tracks.forEach((ti) => {
            const pub = this.trackPublications.get(ti.sid);

            if (pub) {
                const mutedOnServer = pub.isMuted || (pub.track?.isUpstreamPaused ?? false);
                if (mutedOnServer !== ti.muted) {
                    this.log.debug('updating server mute state after reconcile', {
                        ...this.logContext,
                        ...getLogContextFromTrack(pub),
                        mutedOnServer,
                    });
                    this.engine.client.sendMuteTrack(ti.sid, mutedOnServer);
                }
            }
        });
        return true;
    }

    private updateTrackSubscriptionPermissions = () => {
        this.log.debug('updating track subscription permissions', {
            ...this.logContext,
            allParticipantsAllowed: this.allParticipantsAllowedToSubscribe,
            participantTrackPermissions: this.participantTrackPermissions,
        });
        this.engine.client.sendUpdateSubscriptionPermissions(
            this.allParticipantsAllowedToSubscribe,
            this.participantTrackPermissions.map((p) => trackPermissionToProto(p)),
        );
    };

    /** @internal */
    private onTrackUnmuted = (track: LocalTrack) => {
        this.onTrackMuted(track, track.isUpstreamPaused);
    };

    // 当本地轨道的静音状态发生变化时，我们会通知服务器
    /** @internal */
    private onTrackMuted = (track: LocalTrack, muted?: boolean) => {
        if (muted === undefined) {
            muted = true;
        }

        if (!track.sid) {
            this.log.error('could not update status for unpublished track', {
                ...this.logContext,
                ...getLogContextFromTrack(track),
            });
            return;
        }

        this.engine.updateMuteStatus(track.sid, muted);
    };


    private onTrackUpstreamPaused = (track: LocalTrack) => {
        this.log.debug('upstream paused', {
            ...this.logContext,
            ...getLogContextFromTrack(track),
        });
        this.onTrackMuted(track, true);
    };

    private onTrackUpstreamResumed = (track: LocalTrack) => {
        this.log.debug('upstream resumed', {
            ...this.logContext,
            ...getLogContextFromTrack(track),
        });
        this.onTrackMuted(track, track.isMuted);
    };

    private handleSubscribedQualityUpdate = async (update: SubscribedQualityUpdate) => {
        if (!this.roomOptions?.dynacast) {
            return;
        }
        const pub = this.videoTrackPublications.get(update.trackSid);
        if (!pub) {
            this.log.warn('received subscribed quality update for unknown track', {
                ...this.logContext,
                trackSid: update.trackSid,
            });
            return;
        }
        if (update.subscribedCodecs.length > 0) {
            if (!pub.videoTrack) {
                return;
            }
            const newCodecs = await pub.videoTrack.setPublishingCodecs(update.subscribedCodecs);
            for await (const codec of newCodecs) {
                if (isBackupCodec(codec)) {
                    this.log.debug(`publish ${codec} for ${pub.videoTrack.sid}`, {
                        ...this.logContext,
                        ...getLogContextFromTrack(pub),
                    });
                    await this.publishAdditionalCodecForTrack(pub.videoTrack, codec, pub.options);
                }
            }
        } else if (update.subscribedQualities.length > 0) {
            await pub.videoTrack?.setPublishingLayers(update.subscribedQualities);
        }
    };

    private handleLocalTrackUnpublished = (unpublished: TrackUnpublishedResponse) => {
        const track = this.trackPublications.get(unpublished.trackSid);
        if (!track) {
            this.log.warn('received unpublished event for unknown track', {
                ...this.logContext,
                trackSid: unpublished.trackSid,
            });
            return;
        }
        this.unpublishTrack(track.track!);
    }

    private handleTrackEnded = async (track: LocalTrack) => {
        if (
            track.source === Track.Source.ScreenShare ||
            track.source === Track.Source.ScreenShareAudio
        ) {
            this.log.debug('unpublishing local track due to TrackEnded', {
                ...this.logContext,
                ...getLogContextFromTrack(track),
            });
            this.unpublishTrack(track);
        } else if (track.isUserProvided) {
            await track.mute();
        } else if (track instanceof LocalAudioTrack || track instanceof LocalVideoTrack) {
            try {
                if (isWeb()) {
                    try {
                        const currentPermissions = await navigator?.permissions.query({
                            // Safari 和 Firefox 目前不支持摄像头和麦克风的权限查询
                            // @ts-ignore
                            name: track.source === Track.Source.Camera ? 'camera' : 'microphone',
                        });
                        if (currentPermissions && currentPermissions.state === 'denied') {
                            this.log.warn(`user has revoked access to ${track.source}`, {
                                ...this.logContext,
                                ...getLogContextFromTrack(track),
                            });

                            // 在权限被拒绝后检测授予的更改，然后尝试恢复
                            currentPermissions.onchange = () => {
                                if (currentPermissions.state !== 'denied') {
                                    if (!track.isMuted) {
                                        track.restartTrack();
                                    }
                                    currentPermissions.onchange = null;
                                }
                            };
                            throw new Error('GetUserMedia Permission denied');
                        }
                    } catch (e: any) {
                        // Firefox 的权限查询失败，我们继续并尝试重新启动轨道
                    }
                }
            } catch (e) {
                this.log.warn(`could not restart track, muting instead`, {
                    ...this.logContext,
                    ...getLogContextFromTrack(track),
                });
                await track.mute();
            }
        }
    };

    private getPublicationForTrack(
        track: LocalTrack | MediaStreamTrack,
    ): LocalTrackPublication | undefined {
        let publication: LocalTrackPublication | undefined;
        this.trackPublications.forEach((pub) => {
            const localTrack = pub.track;
            if (!localTrack) {
                return;
            }

            // 由于这个对象树，这看起来过于复杂
            if (track instanceof MediaStreamTrack) {
                if (localTrack instanceof LocalAudioTrack || localTrack instanceof LocalVideoTrack) {
                    if (localTrack.mediaStreamTrack === track) {
                        publication = <LocalTrackPublication>pub;
                    }
                }
            } else if (track === localTrack) {
                publication = <LocalTrackPublication>pub;
            }
        });
        return publication;
    }
}