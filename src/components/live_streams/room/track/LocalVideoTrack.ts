import LocalTrack from "./LocalTrack";
import {Track, VideoQuality} from "./Track";
import {VideoCaptureOptions, VideoCodec} from "./options";
import {SignalClient} from "../../api/SignalClient";
import {computeBitrate, monitorFrequency, VideoSenderStats} from "../stats";
import {SubscribedCodec, SubscribedQuality} from "../../protocol/tc_rtc_pb";
import {VideoLayer, VideoQuality as ProtoVideoQuality} from "../../protocol/tc_models_pb";

import {isFireFox, isMobile, isWeb, Mutex, unwrapConstraint} from "../utils";
import {LoggerOptions} from "../types";
import {constraintsForOptions} from "./utils";
import {TrackProcessor} from "./processor/types";
import {StructureLogger} from "../../logger";
import {ScalabilityMode} from "../participant/publishUtils";

/**
 * 联播音轨信息
 */
export class SimulcastTrackInfo {
    /**
     * 视频编码
     */
    codec: VideoCodec;

    /**
     * 媒体流轨道
     */
    mediaStreamTrack: MediaStreamTrack;

    /**
     * 发送器
     */
    sender?: RTCRtpSender;

    /**
     * 编码参数
     */
    encodings?: RTCRtpEncodingParameters[];

    constructor(codec: VideoCodec, mediaStreamTrack: MediaStreamTrack) {
        this.codec = codec;
        this.mediaStreamTrack = mediaStreamTrack;
    }
}

/**
 * 在新的编码设置后多久刷新订阅者编码
 */
const refreshSubscribedCodecAfterNewCodec = 5000;

export default class LocalVideoTrack extends LocalTrack<Track.Kind.Video> {
    /* @internal */
    signalClient?: SignalClient;

    /**
     * 上一视频发送统计
     */
    private prevStats?: Map<string, VideoSenderStats>;
    /**
     * 编码参数数组
     */
    private encodings?: RTCRtpEncodingParameters[];

    /*
    * 联播编码
    * @internal
    */
    simulcastCodecs: Map<VideoCodec, SimulcastTrackInfo> = new Map<VideoCodec, SimulcastTrackInfo>();

    /**
     * 订阅者的编码
     */
    private subscribedCodecs?: SubscribedCodec[];

    // 如果同时调用多个 get/setParameter，则阻止并发操作来跟踪发送者，
    // 由于缺少 `getParameter` 调用，某些事件时间可能会导致浏览器在 `setParameter` 中抛出异常。
    private senderLock: Mutex;

    /**
     *
     * @param mediaTrack
     * @param constraints 重新启动或重新获取轨道时使用的 MediaTrackConstraints
     * @param userProvidedTrack 向 SDK 发出信号，指示 mediaTrack 是否应由 SDK 在内部管理（即释放和重新获取）
     * @param loggerOptions 日志选项
     */
    constructor(
        mediaTrack: MediaStreamTrack,
        constraints?: MediaTrackConstraints,
        userProvidedTrack = true,
        loggerOptions?: LoggerOptions,
        ) {
        super(mediaTrack, Track.Kind.Video, constraints, userProvidedTrack, loggerOptions);
        this.senderLock = new Mutex();
    }

    /**
     * 判断是否支持联播
     */
    get isSimulcast(): boolean {
        return !!(this.sender && this.sender.getParameters().encodings.length > 1);
    }

    /**
     *  启动监听
     * @internal
     */
    startMonitor(signalClient?: SignalClient) {
        this.signalClient = signalClient;
        if (!isWeb()) {
            return;
        }
        // 保存原始编码
        // TODO : merge simulcast tracks stats
        const params = this.sender?.getParameters();
        if (params) {
            this.encodings = params.encodings;
        }

        if (this.monitorInterval) {
            return;
        }
        this.monitorInterval = setInterval(() => {
            this.monitorSender();
        }, monitorFrequency);
    }

    stop() {
        this._mediaStreamTrack.getConstraints();
        this.simulcastCodecs.forEach((trackInfo) => {
            trackInfo.mediaStreamTrack.stop();
        });
        super.stop();
    }

    /**
     * 暂停上游
     */
    async pauseUpstream() {
        await super.pauseUpstream();
        for await (const sc of this.simulcastCodecs.values()) {
            await sc.sender?.replaceTrack(null as MediaStreamTrack);
        }
    }

    /**
     * 重启上游
     */
    async resumeUpstream() {
        await super.resumeUpstream();
        for await (const sc of this.simulcastCodecs.values()) {
            await sc.sender?.replaceTrack(sc.mediaStreamTrack);
        }
    }

    /**
     * 静音
     */
    async mute(): Promise<typeof this> {
        const unlock = await this.muteLock.lock();
        try {
            if (this.isMuted) {
                this.log.debug('Track already muted', this.logContext);
                return this;
            }

            if (this.source === Track.Source.Camera && !this.isUserProvided) {
                this.log.debug('stopping camera track', this.logContext);
                // 同时停止轨道，以便相机指示灯关闭
                this._mediaStreamTrack.stop();
            }
            await super.mute();
            return this;
        } finally {
            unlock();
        }
    }

    /**
     * 解除静音
     */
    async unmute(): Promise<typeof this> {
        const unlock = await this.muteLock.lock();
        try {
            if (!this.isMuted) {
                this.log.debug('Track already unmuted', this.logContext);
                return this;
            }

            if (this.source === Track.Source.Camera && !this.isUserProvided) {
                this.log.debug('reacquiring camera track', this.logContext);
                await this.restartTrack();
            }
            await super.unmute();
            return this;
        } finally {
            unlock();
        }
    }

    /**
     * 设置音轨是否静音
     * @param muted 是否静音参数
     */
    protected setTrackMuted(muted: boolean) {
        super.setTrackMuted(muted);
        for (const sc of this.simulcastCodecs.values()) {
            sc.mediaStreamTrack.enabled = !muted;
        }
    }

    /**
     * 获取发送统计
     */
    async getSenderStats(): Promise<VideoSenderStats[]> {
        if (!this.sender?.getStats) {
            return [];
        }

        const items: VideoSenderStats[] = [];

        const stats = await this.sender.getStats();
        stats.forEach((v) => {
            if (v.type === 'outbound-rtp') {
                const vs: VideoSenderStats = {
                    type: 'video',
                    streamId: v.id,
                    frameHeight: v.frameHeight,
                    frameWidth: v.frameWidth,
                    firCount: v.firCount,
                    pliCount: v.pliCount,
                    nackCount: v.nackCount,
                    packetsSent: v.packetsSent,
                    bytesSent: v.bytesSent,
                    framesSent: v.framesSent,
                    timestamp: v.timestamp,
                    rid: v.rid ?? v.id,
                    retransmittedPacketsSent: v.retransmittedPacketsSent,
                    qualityLimitationReason: v.qualityLimitationReason,
                    qualityLimitationResolutionChanges: v.qualityLimitationResolutionChanges,
                };

                // 找到适当的远程入站 rtp 项目
                const r = stats.get(v.remoteId);
                if (r) {
                    vs.jitter = r.jitter;
                    vs.packetsLost = r.packetsLost;
                    vs.roundTripTime = r.roundTripTime;
                }

                items.push(vs);
            }
        });

        return items;
    }

    /**
     * 设置发布质量
     * @param maxQuality 视频质量
     */
    setPublishingQuality(maxQuality: VideoQuality) {
        const qualities: SubscribedQuality[] = [];
        for (let q = VideoQuality.LOW; q <= VideoQuality.HIGH; q += 1) {
            qualities.push(
                new SubscribedQuality({
                    quality: q,
                    enabled: q <= maxQuality,
                })
            );
        }
        this.log.debug(`setting publishing quality. max quality ${maxQuality}`, this.logContext);
        this.setPublishingLayers(qualities);
    }

    /**
     * 设置服务deviceId
     * @param deviceId 设备ID
     */
    async setDeviceId(deviceId: ConstrainDOMString): Promise<boolean> {
        if (
            this._constraints.deviceId === deviceId &&
            this._mediaStreamTrack.getSettings().deviceId === unwrapConstraint(deviceId)
        ) {
            return true;
        }
        this._constraints.deviceId = deviceId;

        // 当视频静音时，底层媒体流轨道将停止并稍后重新启动
        if (!this.isMuted) {
            await this.restartTrack();
        }
        return (this.isMuted || unwrapConstraint(deviceId) === this._mediaStreamTrack.getSettings().deviceId);
    }

    /**
     * 重启track
     * @param options 视频捕获选项
     */
    async restartTrack(options?: VideoCaptureOptions) {
        let constraints: MediaTrackConstraints | undefined;
        if (options) {
            const streamConstraints = constraintsForOptions({video: options});
            if (typeof streamConstraints.video !== 'boolean') {
                constraints = streamConstraints.video;
            }
        }
        await this.restart(constraints);

        for await (const sc of this.simulcastCodecs.values()) {
            if (sc.sender) {
                sc.mediaStreamTrack = this.mediaStreamTrack.clone();
                await sc.sender.replaceTrack(sc.mediaStreamTrack);
            }
        }
    }

    /**
     * 设置处理器
     * @param processor
     * @param showProcessedStreamLocally
     */
    async setProcessor(processor: TrackProcessor<Track.Kind>, showProcessedStreamLocally = true) {
        await super.setProcessor(processor, showProcessedStreamLocally);

        if (this.processor?.processedTrack) {
            for await (const sc of this.simulcastCodecs.values()) {
                await sc.sender?.replaceTrack(this.processor.processedTrack);
            }
        }
    }

    /**
     * 添加联播的编码
     * @param codec 新增编码
     * @param encodings 编码参数
     */
    addSimulcastTrack(
        codec: VideoCodec,
        encodings?: RTCRtpEncodingParameters[],
    ): SimulcastTrackInfo | undefined {
        if (this.simulcastCodecs.has(codec)) {
            this.log.error(`${codec} already added, skipping adding simulcast codec`, this.logContext);
            return;
        }
        const simulcastCodecInfo: SimulcastTrackInfo = {
            codec,
            mediaStreamTrack: this.mediaStreamTrack.clone(),
            sender: undefined,
            encodings,
        };
        this.simulcastCodecs.set(codec, simulcastCodecInfo);
        return simulcastCodecInfo;
    }

    setSimulcastTrackSender(codec: VideoCodec, sender: RTCRtpSender) {
        const simulcastCodecInfo = this.simulcastCodecs.get(codec);
        if (!simulcastCodecInfo) {
            return;
        }
        simulcastCodecInfo.sender = sender;
        // 浏览器将在新编解码器发布后启用禁用的编解码器/层，
        // 因此在发布新编解码器后刷新订阅的编解码器
        setTimeout(() => {
            if (this.subscribedCodecs) {
                this.setPublishingCodecs(this.subscribedCodecs);
            }
        }, refreshSubscribedCodecAfterNewCodec);
    }

    /**
     * @internal
     * 设置应该发布的编解码器，返回尚未发布的新编解码器
     */
    async setPublishingCodecs(codecs: SubscribedCodec[]): Promise<VideoCodec[]> {
        this.log.debug('setting publishing codecs', {
            ...this.logContext,
            codecs,
            currentCodec: this.codec,
        });
        // 仅启用已设置的首选项编解码器的联播编解码器
        if (!this.codec && codecs.length > 0) {
            await this.setPublishingLayers(codecs[0].qualities);
            return [];
        }

        this.subscribedCodecs = codecs;

        const newCodecs: VideoCodec[] = [];
        for await (const codec of codecs) {
            if (!this.codec || this.codec === codec.codec) {
                await this.setPublishingLayers(codec.qualities);
            } else {
                const simulcastCodecInfo = this.simulcastCodecs.get(codec.codec as VideoCodec);
                this.log.debug(`try setPublishingCodec for ${codec.codec}`, {
                    ...this.logContext,
                    simulcastCodecInfo,
                });
                if (!simulcastCodecInfo || !simulcastCodecInfo.sender) {
                    for (const q of codec.qualities) {
                        if (q.enabled) {
                            newCodecs.push(codec.codec as VideoCodec);
                            break;
                        }
                    }
                } else if (simulcastCodecInfo.encodings) {
                    this.log.debug(`try setPublishingLayersForSender ${codec.codec}`, this.logContext);
                    await setPublishingLayersForSender(
                        simulcastCodecInfo.sender,
                        simulcastCodecInfo.encodings!,
                        codec.qualities,
                        this.senderLock,
                        this.log,
                        this.logContext,
                    );
                }
            }
        }
        return newCodecs;
    }

    /**
     * @internal
     * 设置应该发布的图层
     */
    async setPublishingLayers(qualities: SubscribedQuality[]) {
        this.log.debug('setting publishing layers', {...this.logContext, qualities});
        if (!this.sender || !this.encodings) {
            return;
        }

        await setPublishingLayersForSender(
            this.sender,
            this.encodings,
            qualities,
            this.senderLock,
            this.log,
            this.logContext,
        );
    }

    protected monitorSender = async () => {
        if (!this.sender) {
            this._currentBitrate = 0;
            return;
        }

        let stats: VideoSenderStats[] | undefined;
        try {
            stats = await this.getSenderStats();
        } catch (e) {
            this.log.error('could not get audio sender stats', {...this.logContext, error: e});
            return;
        }

        const statsMap = new Map<string, VideoSenderStats>(stats.map((s) => [s.rid, s]));

        if (this.prevStats) {
            let totalBitrate = 0;
            statsMap.forEach((s, key) => {
                const prev = this.prevStats?.get(key);
                totalBitrate += computeBitrate(s, prev);
            });
            this._currentBitrate = totalBitrate;
        }
        this.prevStats = statsMap;
    };

    /**
     * 处理app可见性改变
     */
    protected async handleAppVisibilityChanged() {
        await super.handleAppVisibilityChanged();
        if (!isMobile()) {
            return;
        }
        if (this.isInBackground && this.source === Track.Source.Camera) {
            this._mediaStreamTrack.enabled = false;
        }
    }
}

async function setPublishingLayersForSender(
    sender: RTCRtpSender,
    senderEncodings: RTCRtpEncodingParameters[],
    qualities: SubscribedQuality[],
    senderLock: Mutex,
    log: StructureLogger,
    logContext: Record<string, unknown>,
) {
    const unlock = await senderLock.lock();
    log.debug('setPublishingLayersForSender', {...logContext, sender, qualities, senderEncodings});
    try {
        const params = sender.getParameters();
        const {encodings} = params;
        if (!encodings) {
            return;
        }

        if (encodings.length !== senderEncodings.length) {
            log.warn('cannot set publishing layers, encodings mismatch', {
                ...logContext,
                encodings,
                senderEncodings,
            });
            return;
        }

        let hasChanged = false;
        /* 禁用可关闭的空间层，因为它与当前服务器/客户端存在视频模糊/冻结问题
           1. chrome 113：当切换到具有可扩展性模式更改的上层时，会生成
             低分辨率帧，恢复速度非常快，但值得注意
           2. tcapp sfu：额外的 pli 请求导致视频冻结几帧，也很明显 */
        const closableSpatial = false;
        /* @ts-ignore */
        if (closableSpatial && encodings[0].scalabilityMode) {
            // svc 动态编码
            const encoding = encodings[0];
            /* @ts-ignore */
            let maxQuality = ProtoVideoQuality.OFF;
            qualities.forEach((q) => {
                if (q.enabled && (maxQuality === ProtoVideoQuality.OFF || q.quality > maxQuality)) {
                    maxQuality = q.quality;
                }
            });

            if (maxQuality === ProtoVideoQuality.OFF) {
                if (encoding.active) {
                    encoding.active = false;
                    hasChanged = true;
                }
            } else if (!encoding.active) {
                hasChanged = true;
                encoding.active = true;
            }
        } else {
            // 联播动态编码
            encodings.forEach((encoding, idx) => {
                let rid = encoding.rid ?? '';
                if (rid === '') {
                    rid = 'q';
                }
                const quality = videoQualityForRid(rid);
                const subscribedQuality = qualities.find((q) => q.quality === quality);
                if (!subscribedQuality) {
                    return;
                }
                if (encoding.active !== subscribedQuality.enabled) {
                    hasChanged = true;
                    encoding.active = subscribedQuality.enabled;
                    log.debug(
                        `setting layer ${subscribedQuality.quality} to ${
                            encoding.active ? 'enabled' : 'disabled'
                        }`,
                        logContext,
                    );

                    // FireFox不支持将encoding.active设置为false，所以我们
                    // 有一个解决方法，将其比特率和分辨率降低到最小值。
                    if (isFireFox()) {
                        if (subscribedQuality.enabled) {
                            encoding.scaleResolutionDownBy = senderEncodings[idx].scaleResolutionDownBy;
                            encoding.maxBitrate = senderEncodings[idx].maxBitrate;
                            /* @ts-ignore */
                            encoding.maxFramerate = senderEncodings[idx].maxFramerate;
                        } else {
                            encoding.scaleResolutionDownBy = 4;
                            encoding.maxBitrate = 10;
                            /* @ts-ignore */
                            encoding.maxFramerate = 2;
                        }
                    }
                }
            });
        }

        if (hasChanged) {
            params.encodings = encodings;
            log.debug(`setting encodings`, {...logContext, encodings: params.encodings});
            await sender.setParameters(params);
        }
    } finally {
        unlock();
    }
}

export function videoQualityForRid(rid: string): VideoQuality {
    switch (rid) {
        case 'f':
            return VideoQuality.HIGH;
        case 'h':
            return VideoQuality.MEDIUM;
        case 'q':
            return VideoQuality.LOW;
        default:
            return VideoQuality.HIGH;
    }
}


export function videoLayersFromEncodings(
    width: number,
    height: number,
    encodings?: RTCRtpEncodingParameters[],
    svc?: boolean,
): VideoLayer[] {
    // default to a single layer, HQ
    if (!encodings) {
        return [
            new VideoLayer({
                quality: VideoQuality.HIGH,
                width,
                height,
                bitrate: 0,
                ssrc: 0,
            }),
        ];
    }

    if (svc) {
        // svc layers
        /* @ts-ignore */
        const encodingSM = encodings[0].scalabilityMode as string;
        const sm = new ScalabilityMode(encodingSM);
        const layers = [];
        for (let i = 0; i < sm.spatial; i += 1) {
            layers.push(
                new VideoLayer({
                    quality: VideoQuality.HIGH - i,
                    width: Math.ceil(width / 2 ** i),
                    height: Math.ceil(height / 2 ** i),
                    bitrate: encodings[0].maxBitrate ? Math.ceil(encodings[0].maxBitrate / 3 ** i) : 0,
                    ssrc: 0,
                }),
            );
        }
        return layers;
    }

    return encodings.map((encoding) => {
        const scale = encoding.scaleResolutionDownBy ?? 1;
        let quality = videoQualityForRid(encoding.rid ?? '');
        return new VideoLayer({
            quality,
            width: Math.ceil(width / scale),
            height: Math.ceil(height / scale),
            bitrate: encoding.maxBitrate ?? 0,
            ssrc: 0,
        });
    });
}
