import RemoteTrack from "./RemoteTrack";
import {Track} from "./Track";
import {AudioReceiverStats, computeBitrate} from "../stats";
import {AudioOutputOptions} from "./options";
import {LoggerOptions} from "../types";
import {isReactNative, supportsSetSinkId} from "../utils";
import {TrackEvent} from "../TrackEvents";

/**
 * 远程音轨
 */
export default class RemoteAudioTrack extends RemoteTrack<Track.Kind.Audio> {

    /**
     * 前音频接收统计
     */
    private prevStats?: AudioReceiverStats;

    /**
     * 音频元素声音大小
     */
    private elementVolume: number | undefined;

    /**
     * 音频上下文
     */
    private audioContext?: AudioContext;

    /**
     * 代表音量的变化
     */
    private gainNode?: GainNode;

    /**
     * 一种 AudioNode，用作音频源，
     * 其媒体是从使用 WebRTC 或媒体捕获和流 API 获得的 MediaStream 接收的。
     */
    private sourceNode?: MediaStreamAudioSourceNode;

    /**
     * 网络音频插件
     */
    private webAudioPluginNodes: AudioNode[];

    private sinkId?: string;

    constructor(
        mediaTrack: MediaStreamTrack,
        sid: string,
        receiver?: RTCRtpReceiver,
        audioContext?: AudioContext,
        audioOutput?: AudioOutputOptions,
        loggerOptions?: LoggerOptions,
    ) {
        super(mediaTrack, sid, Track.Kind.Audio, receiver, loggerOptions);
        this.audioContext = audioContext;
        this.webAudioPluginNodes = [];
        if (audioContext) {
            this.sinkId = audioOutput?.deviceId;
        }
    }

    /**
     * 设置所有附加音频元素的音量
     */
    setVolume(volume: number) {
        for (const el of this.attachedElements) {
            if (this.audioContext) {
                this.gainNode?.gain.setTargetAtTime(volume, 0, 0.1);
            } else {
                el.volume = volume;
            }
        }
        if (isReactNative()) {
            // @ts-ignore
            this._mediaStreamTrack._setVolume(volume);
        }
        this.elementVolume = volume;
    }

    /**
     * 获取附加音频元素的音量（最大声）
     */
    getVolume(): number {
        if (this.elementVolume) {
            return this.elementVolume;
        }
        if (isReactNative()) {
            // 如果没有更改，RN 音量值默认为 1.0。
            return 1.0;
        }
        let highestVolume = 0;
        this.attachedElements.forEach((element) => {
            if (element.volume > highestVolume) {
                highestVolume = element.volume;
            }
        });
        return highestVolume;
    }

    /**
     * 在所有附加元素上调用 setSinkId（如果支持）
     * @param deviceId 音频输出设备
     */
    async setSinkId(deviceId: string) {
        this.sinkId = deviceId;
        await Promise.all(
            this.attachedElements.map((elm) => {
                if (!supportsSetSinkId(elm)) {
                    return;
                }
                /* @ts-ignore */
                return elm.setSinkId(deviceId) as Promise<void>;
            }),
        );
    }

    attach(): HTMLMediaElement ;
    attach(element: HTMLMediaElement): HTMLMediaElement;
    attach(element?: HTMLMediaElement): HTMLMediaElement {
        const needsNewWebAudioConnection = this.attachedElements.length === 0;
        if (!element) {
            element = super.attach();
        } else {
            super.attach(element);
        }

        if (this.sinkId && supportsSetSinkId(element)) {
            /* @ts-ignore */
            element.setSinkId(this.sinkId);
        }
        if (this.audioContext && needsNewWebAudioConnection) {
            this.log.debug('using audio context mapping', this.logContext);
            this.connectWebAudio(this.audioContext, element);
            element.volume = 0;
            element.muted = true;
        }

        if (this.elementVolume) {
            // 确保音量设置应用于新附加的元素
            this.setVolume(this.elementVolume);
        }

        return element;
    }

    /**
     * 与所有附加元素分离
     */
    detach(): HTMLMediaElement[];

    /**
     * 分离单个元素
     */
    detach(element: HTMLMediaElement): HTMLMediaElement;
    detach(element?: HTMLMediaElement): HTMLMediaElement | HTMLMediaElement[] {
        let detached: HTMLMediaElement | HTMLMediaElement[];
        if (!element) {
            detached = super.detach();
            this.disconnectWebAudio();
        } else {
            detached = super.detach(element);
            // 如果分离后仍然有任何附加元素，则将 webaudio 连接到剩下的第一个元素，
            // 否则断开 webaudio
            if (this.audioContext) {
                if (this.attachedElements.length > 0) {
                    this.connectWebAudio(this.audioContext, this.attachedElements[0]);
                } else {
                    this.disconnectWebAudio();
                }
            }
        }
        return detached;
    }

    /**
     * @internal
     * @experimental
     */
    setAudioContext(audioContext: AudioContext | undefined) {
        this.audioContext = audioContext;
        if (audioContext && this.attachedElements.length > 0) {
            this.connectWebAudio(audioContext, this.attachedElements[0]);
        } else if (!audioContext) {
            this.disconnectWebAudio();
        }
    }

    /**
     * @internal
     * @experimental
     * @param {AudioNode[]} nodes - WebAudio 节点数组。 这些节点在传递时不应相互连接，因为 sdk 会按照数组的顺序连接它们。
     */
    setWebAudioPlugins(nodes: AudioNode[]) {
        this.webAudioPluginNodes = nodes;
        if (this.attachedElements.length > 0 && this.audioContext) {
            this.connectWebAudio(this.audioContext, this.attachedElements[0]);
        }
    }

    /**
     * 连接到web音频
     * @param context
     * @param element
     * @private
     */
    private connectWebAudio(context: AudioContext, element: HTMLMediaElement) {
        this.disconnectWebAudio();
        // @ts-ignore 附加元素总是有一个 srcObject 集合
        this.sourceNode = context.createMediaStreamSource(element.srcObject);
        let lastNode: AudioNode = this.sourceNode;
        this.webAudioPluginNodes.forEach((node) => {
            lastNode.connect(node);
            lastNode = node;
        });
        this.gainNode = context.createGain();
        lastNode.connect(this.gainNode);
        this.gainNode.connect(context.destination);

        if (this.elementVolume) {
            this.gainNode.gain.setTargetAtTime(this.elementVolume, 0, 0.1);
        }

        // 如果上下文尚未运行，则尝试恢复上下文
        if (context.state !== 'running') {
            context
                .resume()
                .then(() => {
                    if (context.state !== 'running') {
                        this.emit(
                            TrackEvent.AudioPlaybackFailed,
                            new Error("Audio Context couldn't be started automatically"),
                        );
                    }
                })
                .catch((e) => {
                    this.emit(TrackEvent.AudioPlaybackFailed, e);
                });
        }
    }

    /**
     * 断开web音频
     */
    private disconnectWebAudio() {
        this.gainNode?.disconnect();
        this.sourceNode?.disconnect();
        this.gainNode = undefined;
        this.sourceNode = undefined;
    }

    /**
     * 监听接收器
     */
    protected monitorReceiver = async () => {
        if (!this.receiver) {
            this._currentBitrate = 0;
            return;
        }
        const stats = await this.getReceiverStats();

        if (stats && this.prevStats && this.receiver) {
            this._currentBitrate = computeBitrate(stats, this.prevStats);
        }

        this.prevStats = stats;
    };

    /**
     * 获取接收器统计
     */
    protected async getReceiverStats(): Promise<AudioReceiverStats | undefined> {
        if (!this.receiver || !this.receiver.getStats) {
            return;
        }

        const stats = await this.receiver.getStats();
        let receiverStats: AudioReceiverStats | undefined;
        stats.forEach((v) => {
            if (v.type === 'inbound-rtp') {
                receiverStats = {
                    type: 'audio',
                    timestamp: v.timestamp,
                    jitter: v.jitter,
                    bytesReceived: v.bytesReceived,
                    concealedSamples: v.concealedSamples,
                    concealmentEvents: v.concealmentEvents,
                    silentConcealedSamples: v.silentConcealedSamples,
                    silentConcealmentEvents: v.silentConcealmentEvents,
                    totalAudioEnergy: v.totalAudioEnergy,
                    totalSamplesDuration: v.totalSamplesDuration,
                };
            }
        });
    }

}