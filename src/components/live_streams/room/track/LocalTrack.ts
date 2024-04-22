/**
 * 默认维度的超时时间
 */
import {attachToElement, detachTrack, Track} from "./Track";
import {VideoCodec} from "./options";
import {compareVersions, isMobile, Mutex, sleep} from "../utils";
import {TrackProcessor} from "./processor/types";
import {LoggerOptions} from "../types";
import {getBrowser} from "../../utils/browserParser";
import {DeviceUnsupportedError, TrackInvalidError} from "../errors";
import DeviceManager from "../DeviceManager";
import {TrackEvent} from "../TrackEvents";
import {debounce} from "ts-debounce";
import {ReplaceTrackOptions} from "@/components/live_streams/room/track/types.ts";

const defaultDimensionsTimeout = 1000;

/**
 * 本地音轨
 */
export default abstract class LocalTrack<TrackKind extends Track.Kind = Track.Kind> extends Track<TrackKind> {
    /**
     * 用于在发送方（sender）端发送实时传输协议（Real-Time Transport Protocol，简称 RTP）流
     * @internal
     */
    sender?: RTCRtpSender;

    /**
     * 视频编码
     * @internal
     */
    codec?: VideoCodec;

    /**
     * 获取媒体轨道约束
     */
    get constraints() {
        return this._constraints;
    }

    /**
     * MediaTrackConstraints（媒体轨道约束）是用于控制媒体轨道（MediaTrack）的属性和行为的对象。它是 WebRTC API 中用于配置媒体轨道的一种机制。
     *
     * 通过使用 MediaTrackConstraints，您可以指定要应用于媒体轨道的约束条件，例如摄像头的分辨率、帧率、音频采样率等。这些约束条件将影响媒体轨道的捕获或发送行为。
     *
     * MediaTrackConstraints 对象可以包含以下属性：
     *
     * width 和 height：指定视频轨道的宽度和高度，以控制视频的分辨率。
     *
     * aspectRatio：指定视频轨道的宽高比，以控制视频的宽高比例。
     *
     * frameRate：指定视频轨道的帧率，以控制视频的每秒帧数。
     *
     * facingMode：指定摄像头的朝向或类型，例如前置摄像头或后置摄像头。
     *
     * volume：指定音频轨道的音量级别。
     *
     * sampleRate 和 sampleSize：指定音频轨道的采样率和采样大小。
     *
     * echoCancellation：指定是否启用回声消除。
     *
     * autoGainControl：指定是否启用自动增益控制。
     *
     * noiseSuppression：指定是否启用降噪。
     */
    protected _constraints: MediaTrackConstraints;

    /**
     * 是否重新获取轨道
     */
    protected reacquireTrack: boolean;

    /**
     * 是否由用户提供
     */
    protected providedByUser: boolean;

    /**
     * 锁
     */
    protected muteLock: Mutex;

    /**
     * 暂停上游锁
     */
    protected pauseUpstreamLock: Mutex;

    /**
     * 处理器元素
     */
    protected processorElement?: HTMLMediaElement;

    /**
     * 轨道处理器
     */
    protected processor?: TrackProcessor<TrackKind, any>;

    /**
     * 处理器锁
     */
    protected processorLock: Mutex;

    /**
     * 音频上下文
     */
    protected audioContext?: AudioContext;

    /**
     * 重启锁
     */
    private restartLock: Mutex;

    /**
     *
     * @param mediaTrack
     * @param kind
     * @param constraints 重新启动或重新获取轨道时使用的 MediaTrackConstraints
     * @param userProvidedTrack 向 SDK 发出信号，指示 mediaTrack 是否应由 SDK 在内部管理（即释放和重新获取）
     @param loggerOptions 日志选项
     */
    protected constructor(
        mediaTrack: MediaStreamTrack,
        kind: TrackKind,
        constraints?: MediaTrackConstraints,
        userProvidedTrack = false,
        loggerOptions?: LoggerOptions,
    ) {
        super(mediaTrack, kind, loggerOptions);
        this.reacquireTrack = false;
        this.providedByUser = userProvidedTrack;
        this.pauseUpstreamLock = new Mutex();
        this.processorLock = new Mutex();
        this.restartLock = new Mutex();
        this.setMediaStreamTrack(mediaTrack, true);

        // 添加以满足TS编译器，约束与MediaStreamTrack同步
        this._constraints = mediaTrack.getConstraints();
        if (constraints) {
            this._constraints = constraints;
        }
    }

    /**
     * 获取媒体音轨Id
     */
    get id(): string {
        return this._mediaStreamTrack.id;
    }

    /**
     * 尺寸
     */
    get dimensions(): Track.Dimensions | undefined {
        if (this.kind !== Track.Kind.Video) {
            return undefined;
        }

        const {width, height} = this._mediaStreamTrack.getSettings();
        if (width && height) {
            return {
                width,
                height,
            };
        }
        return undefined;
    }

    /**
     * 是否上游暂停
     */
    private _isUpstreamPaused: boolean = false;

    get isUpstreamPaused() {
        return this._isUpstreamPaused;
    }

    get isUserProvided() {
        return this.providedByUser;
    }

    get mediaStreamTrack() {
        return this.processor?.processedTrack ?? this._mediaStreamTrack;
    }

    /**
     * 设置媒体流轨道
     * @param newTrack 新的音轨
     * @param force 是否强制替换
     */
    private async setMediaStreamTrack(newTrack: MediaStreamTrack, force?: boolean) {
        if (newTrack === this._mediaStreamTrack && !force) {
            return;
        }
        if (this._mediaStreamTrack) {
            // 分离
            this.attachedElements.forEach((el) => {
                detachTrack(this._mediaStreamTrack, el);
            });
            this.debouncedTrackMuteHandler.cancel('new-track');
            this._mediaStreamTrack.removeEventListener('ended', this.handleEnded);
            this._mediaStreamTrack.removeEventListener('mute', this.handleTrackMuteEvent);
            this._mediaStreamTrack.removeEventListener('unmute', this.handleTrackUnmuteEvent);
        }

        this.mediaStream = new MediaStream([newTrack]);
        if (newTrack) {
            newTrack.addEventListener('ended', this.handleEnded);

            // 当底层轨道发出静音时，表明设备无法
            // 生成媒体。 在这种情况下，我们需要用遥控器发出信号，表明轨道已“静音”
            // 注意这与 LocalTrack.mute 不同，因为我们不想
            // 触摸 MediaStreamTrack.enabled
            newTrack.addEventListener('mute', this.handleTrackMuteEvent);
            newTrack.addEventListener('unmute', this.handleTrackUnmuteEvent);
            this._constraints = newTrack.getConstraints();
        }
        let processedTrack: MediaStreamTrack | undefined;
        if (this.processor && newTrack) {
            const unlock = await this.processorLock.lock();
            try {
                this.log.debug('restarting processor', this.logContext);
                if (this.kind === 'unknown') {
                    throw TypeError('cannot set processor on track of unknown kind');
                }

                if (this.processorElement) {
                    attachToElement(newTrack, this.processorElement);
                    // 确保processorElement本身保持静音
                    this.processorElement.muted = true;
                }
                await this.processor.restart({
                    track: newTrack,
                    kind: this.kind,
                    element: this.processorElement,
                });
                processedTrack = this.processor.processedTrack;
            } finally {
                unlock();
            }
        }
        if (this.sender) {
            await this.sender.replaceTrack(processedTrack ?? newTrack);
        }
        // 如果 `newTrack` 与现有轨道不同，则停止
        // 替换之前的旧轨道
        if (!this.providedByUser && this._mediaStreamTrack !== newTrack) {
            this._mediaStreamTrack.stop();
        }
        this._mediaStreamTrack = newTrack;
        if (newTrack) {
            // 将静音状态与新提供的轨道的启用状态同步
            this._mediaStreamTrack.enabled = !this.isMuted;
            // 当有效的曲目被替换时，我们要开始生成
            await this.resumeUpstream();
            this.attachedElements.forEach((el) => {
                attachToElement(processedTrack ?? newTrack, el);
            });
        }
    }

    /**
     * 等待维度信息
     * @param timeout 超时时间
     */
    async waitForDimensions(timeout = defaultDimensionsTimeout): Promise<Track.Dimensions> {
        if (this.kind === Track.Kind.Audio) {
            throw new Error('cannot get dimensions for audio tracks');
        }

        if (getBrowser()?.os === 'iOS') {
            // 浏览器在 iOS 上报告错误的初始分辨率。
            // 当稍微延迟对 .getSettings() 的调用时，会报告正确的分辨率
            await sleep(10);
        }

        const started = Date.now();
        while (Date.now() - started < timeout) {
            const dims = this.dimensions;
            if (dims) {
                return dims;
            }
            await sleep(50);
        }
        throw new TrackInvalidError('unable to get track dimensions after timeout');
    }

    /**
     * @returns 当前用于该轨道的设备的 DeviceID
     */
    async getDeviceId(): Promise<string | undefined> {
        // 屏幕共享没有可用的设备 ID
        if (this.source === Track.Source.ScreenShare) {
            return;
        }
        const {deviceId, groupId} = this._mediaStreamTrack.getSettings();
        const kind = this.kind === Track.Kind.Audio ? 'audioinput' : 'videoinput';

        return DeviceManager.getInstance().normalizeDeviceId(kind, deviceId, groupId);
    }

    async mute() {
        this.setTrackMuted(true);
        return this;
    }

    async unmute() {
        this.setTrackMuted(false);
        return this;
    }

    async replaceTrack(track: MediaStreamTrack, options?: ReplaceTrackOptions): Promise<typeof LocalTrack>;
    async replaceTrack(track: MediaStreamTrack, userProvidedTrack?: boolean): Promise<typeof LocalTrack>;
    async replaceTrack(
        track: MediaStreamTrack,
        userProvidedOrOptions: boolean | ReplaceTrackOptions | undefined,
    ) {
        if (!this.sender) {
            throw new TrackInvalidError('unable to replace an unpublished track');
        }

        let userProvidedTrack: boolean | undefined;
        let stopProcessor: boolean | undefined;

        if (typeof userProvidedOrOptions === 'boolean') {
            userProvidedTrack = userProvidedOrOptions;
        } else if (userProvidedOrOptions !== undefined) {
            userProvidedTrack = userProvidedOrOptions.userProvidedTrack;
            stopProcessor = userProvidedOrOptions.stopProcessor;
        }

        this.providedByUser = userProvidedTrack ?? true;

        this.log.debug('replace MediaStreamTrack', this.logContext);
        await this.setMediaStreamTrack(track);

        // 这必须在上面设置 mediaStreamTrack *之后同步，因为它依赖于
        // 之前的状态以便清理
        if (stopProcessor && this.processor) {
            await this.stopProcessor();
        }
        return this;
    }

    /**
     *  重启媒体流
     * @param constraints
     */
    protected async restart(constraints?: MediaTrackConstraints) {
        const unlock = await this.restartLock.lock();
        try {
            if (!constraints) {
                constraints = this._constraints;
            }
            this.log.debug('restating track with constraints', {...this.logContext, constraints});

            const streamConstraints: MediaStreamConstraints = {
                audio: false,
                video: false,
            };

            if (this.kind === Track.Kind.Video) {
                streamConstraints.video = constraints;
            } else {
                streamConstraints.audio = constraints;
            }

            // 这些步骤与 setMediaStreamTrack 重复，
            // 因为我们必须在获取新轨道之前停止之前的轨道
            this.attachedElements.forEach((el) => {
                detachTrack(this.mediaStreamTrack, el);
            });
            this._mediaStreamTrack.removeEventListener('ended', this.handleEnded);
            // 在 Safari 上，在尝试获取新音轨之前必须停止旧音轨，否则新音轨将停止
            // 'MediaStreamTrack 由于捕获失败而结束`
            this._mediaStreamTrack.stop();
            // 创建新轨道并附加
            const mediaStream = await navigator.mediaDevices.getUserMedia(streamConstraints);
            const newTrack = mediaStream.getTracks()[0];
            newTrack.addEventListener('ended', this.handleEnded);
            this.log.debug('re-acquired MediaStreamTrack', this.logContext);

            await this.setMediaStreamTrack(newTrack);
            this._constraints = constraints;

            this.emit(TrackEvent.Restarted, this);
            return this;
        } finally {
            unlock();
        }
    }

    /**
     * 设置轨道静音
     * @param muted 静音
     */
    protected setTrackMuted(muted: boolean) {
        this.log.debug(`setting ${this.kind} track ${muted ? 'muted' : 'unmuted'}`, this.logContext);

        if (this.isMuted === muted && this._mediaStreamTrack.enabled !== muted) {
            return;
        }

        this.isMuted = muted;
        this._mediaStreamTrack.enabled = !muted;
        this.emit(muted ? TrackEvent.Muted : TrackEvent.Unmuted, this);
    }

    /**
     * 需求采购
     */
    protected get needsReAcquisition(): boolean {
        return (
            this._mediaStreamTrack.readyState !== 'live' ||
            this._mediaStreamTrack.muted ||
            !this._mediaStreamTrack.enabled ||
            this.reacquireTrack
        );
    }

    /**
     * 处理应用可见行改变
     */
    protected async handleAppVisibilityChanged() {
        await super.handleAppVisibilityChanged();
        if (!isMobile()) {
            return;
        }
        this.log.debug(`visibility changed, is in Background: ${this.isInBackground}`, this.logContext);

        if (!this.isInBackground && this.needsReAcquisition && !this.isUserProvided && !this.isMuted) {
            this.log.debug(`track needs to be reacquired, restarting ${this.source}`, this.logContext);
            await this.restart();
            this.reacquireTrack = false;
        }
    }

    /**
     *  处理轨道静音时间
     */
    private handleTrackMuteEvent = () =>
        this.debouncedTrackMuteHandler().catch(() =>
            this.log.debug('track mute bounce got cancelled by an unmute event', this.logContext),
        );

    /**
     * 去除轨道静音处理
     * 防抖动debounce主要解决函数在短时间内多次触发的问题
     */
    private debouncedTrackMuteHandler = debounce(async () => {
        await this.pauseUpstream();
    }, 5000);

    /**
     * 处理轨道解除静音事件
     */
    private handleTrackUnmuteEvent = async () => {
        this.debouncedTrackMuteHandler.cancel('unmute');
        await this.resumeUpstream();
    };

    /**
     * 处理音轨结束事件
     */
    private handleEnded = () => {
        if (this.isInBackground) {
            this.reacquireTrack = true;
        }
        this._mediaStreamTrack.removeEventListener('mute', this.handleTrackMuteEvent);
        this._mediaStreamTrack.removeEventListener('unmute', this.handleTrackUnmuteEvent);
        this.emit(TrackEvent.Ended, this);
    }

    stop() {
        super.stop();

        this._mediaStreamTrack.removeEventListener('ended', this.handleEnded);
        this._mediaStreamTrack.removeEventListener('mute', this.handleTrackMuteEvent);
        this._mediaStreamTrack.removeEventListener('unmute', this.handleTrackUnmuteEvent);
        this.processor?.destroy();
        this.processor = undefined;
    }

    /**
     * 暂停发布到服务器而不禁用本地MediaStreamTrack
     * 这用于在本地显示用户自己的视频，同时暂停发布到服务器。
     * 由于存在错误，此 API 在 Safari < 12 上不受支持
     **/
    async pauseUpstream() {
        const unlock = await this.pauseUpstreamLock.lock();
        try {
            if (this._isUpstreamPaused) {
                return;
            }
            if (!this.sender) {
                this.log.warn('unable to pause upstream for an unpublished track', this.logContext);
                return;
            }

            this._isUpstreamPaused = true;
            this.emit(TrackEvent.UpstreamPaused, this);
            const browser = getBrowser();
            if (browser?.name === 'Safari' && compareVersions(browser.version, '12.0') < 0) {
                // https://bugs.webkit.org/show_bug.cgi?id=184911
                throw new DeviceUnsupportedError('pauseUpstream is not supported on Safari <12.');
            }
            await this.sender.replaceTrack(null as MediaStreamTrack);

        } finally {
            unlock();
        }
    }

    /**
     * 恢复发布到服务器
     */
    async resumeUpstream() {
        const unlock = await this.pauseUpstreamLock.lock();
        try {
            if (!this._isUpstreamPaused) {
                return;
            }
            if (!this.sender) {
                this.log.warn('unable to resume upstream for an unpublished track', this.logContext);
                return;
            }
            this._isUpstreamPaused = false;
            this.emit(TrackEvent.UpstreamResumed, this);

            // 如果 mediastreamtrack 已经被发送，则此操作为 noop
            await this.sender.replaceTrack(this._mediaStreamTrack);
        } finally {
            unlock();
        }
    }

    /**
     * 获取LocalTrack底层RTCRtpSender的RTCStatsReport
     * 请参阅 https://developer.mozilla.org/en-US/docs/Web/API/RTCStatsReport
     *
     * @returns Promise<RTCStatsReport> | undefined
     */
    async getRTCStatsReport(): Promise<RTCStatsReport | undefined> {
        if (!this.sender?.getStats) {
            return;
        }
        return await this.sender.getStats();
    }

    /**
     * 在此轨道上设置处理器。
     * See https://github.com/livekit/track-processors-js for example usage
     *
     * @experimental
     *
     * @param processor
     * @param showProcessedStreamLocally
     * @returns
     */
    async setProcessor(processor: TrackProcessor<TrackKind>, showProcessedStreamLocally = true) {
        const unlock = await this.processorLock.lock();
        try {
            this.log.debug('setting up processor', this.logContext);
            if (this.processor) {
                await this.stopProcessor();
            }
            if (this.kind === 'unknown') {
                throw TypeError('cannot set processor on track of unknown kind');
            }
            this.processorElement =
                this.processorElement ?? (document.createElement(this.kind) as HTMLMediaElement);

            attachToElement(this._mediaStreamTrack, this.processorElement);
            this.processorElement.muted = true;

            this.processorElement
                .play()
                .catch((error) => {
                    this.log.error('failed to play processor element', {...this.logContext, error});
                });

            const processorOptions = {
                kind: this.kind,
                track: this._mediaStreamTrack,
                element: this.processorElement,
                audioContext: this.audioContext,
            };

            await processor.init(processorOptions);
            this.processor = processor;
            if (this.processor.processedTrack) {
                for (const el of this.attachedElements) {
                    if (el !== this.processorElement && showProcessedStreamLocally) {
                        detachTrack(this._mediaStreamTrack, el);
                        attachToElement(this.processor.processedTrack, el);
                    }
                }
                await this.sender?.replaceTrack(this.processor.processedTrack);
            }
            this.emit(TrackEvent.TrackProcessorUpdate, this.processor);
        } finally {
            unlock();
        }
    }

    getProcessor() {
        return this.processor;
    }

    /**
     * 停止轨道处理器
     * 请参阅 https://github.com/livekit/track-processors-js 了解示例用法
     *
     * @experimental
     * @returns
     */
    async stopProcessor() {
        if (!this.processor) {
            return;
        }

        this.log.debug('stopping processor', this.logContext);
        this.processor.processedTrack?.stop();
        await this.processor.destroy();
        this.processor = undefined;
        this.processorElement?.remove();
        this.processorElement = undefined;
        await this.restart();
        this.emit(TrackEvent.TrackProcessorUpdate);
    }

    protected abstract monitorSender(): void;
}