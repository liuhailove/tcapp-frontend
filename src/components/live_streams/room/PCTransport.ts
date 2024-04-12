import {EventEmitter} from 'events';
import log, {LoggerNames, getLogger} from '../logger';
import {LoggerOptions} from "./types";
import {debounce} from "ts-debounce";
import {MediaDescription, parse, write} from 'sdp-transform';
import {NegotiationError, UnexpectedConnectionState} from "./errors";
import {ddExtensionURI, isSVCCodec} from "./utils";

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

    constructor(config?: RTCConfiguration, loggerOptions: LoggerOptions = {}) {
        super();
        this.log = getLogger(loggerOptions.loggerName ?? LoggerNames.PCTransport);
        this.config = config;
        this._pc = this.createPC();
    }

    private createPC() {
        const pc = new RTCPeerConnection(this.config);

        pc.onicecandidate = (ev) => {
            if (!ev.candidate) {
                return;
            }
            this.onIceCandidate?.(ev.candidate);
        };
        pc.onicecandidateerror = (ev) => {
            this.onIceCandidateError?.(ev);
        };
        pc.oniceconnectionstatechange = () => {
            this.onIceConnectionStateChange?.(pc.iceConnectionState);
        };

        pc.onsignalingstatechange = () => {
            this.onSignalingStatechange?.(pc.signalingState);
        };

        pc.onconnectionstatechange = () => {
            this.onConnectionStateChange?.(pc.connectionState);
        };
        pc.ondatachannel = (ev) => {
            this.onDataChannel?.(ev);
        };
        pc.ontrack = (ev) => {
            this.onTrack?.(ev);
        };
        return pc;
    }

    private get logContext() {
        return {
            ...this.loggerOptions.loggerContextCb?.(),
        };
    }

    /**
     * 判断ICE是否已经连接上
     */
    get isICEConnected(): boolean {
        return (
            this._pc !== null &&
            (this.pc.iceConnectionState === 'connected' || this.pc.iceConnectionState === 'completed')
        );
    }

    /**
     * 添加ice候选
     * @param candidate ice候选
     */
    async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
        if (this.pc.remoteDescription && !this.restartingIce) {
            return this.pc.addIceCandidate(candidate);
        }
        this.pendingCandidates.push(candidate);
    }

    /**
     * 设置远程描述
     * @param sd rtc会话描述
     */
    async setRemoteDescription(sd: RTCSessionDescriptionInit): Promise<void> {
        let mungedSDP: string | undefined = undefined;
        if (sd.type === 'offer') {
            let {stereoMids, nackMids} = extractStereoAndNackAudioFromOffer(sd);
            this.remoteStereoMids = stereoMids;
            this.remoteNackMids = nackMids;
        } else if (sd.type === 'answer') {
            const sdpParsed = parse(sd.sdp ?? '');
            sdpParsed.media.forEach((media) => {
                if (media.type === 'audio') {
                    // mung sdp 用于 opus 比特率设置
                    this.trackBitrates.some((trackbr): boolean => {
                        if (!trackbr.transceiver || media.mid != trackbr.transceiver.mid) {
                            return false;
                        }

                        let codecPayload = 0;
                        media.rtp.some((rtp): boolean => {
                            if (rtp.codec.toUpperCase() === trackbr.codec.toUpperCase()) {
                                codecPayload = rtp.payload;
                                return true;
                            }
                            return false;
                        });

                        if (codecPayload === 0) {
                            return true;
                        }

                        let fmtpFound = false;
                        for (const fmtp of media.fmtp) {
                            if (fmtp.payload === codecPayload) {
                                fmtp.config = fmtp.config
                                    .split(';')
                                    .filter((attr) => !attr.includes('maxaveragebitrate'))
                                    .join(';');
                                if (trackbr.maxbr > 0) {
                                    fmtp.config += `;maxaveragebitrate=${trackbr.maxbr * 1000}`;
                                }
                                fmtpFound = true;
                                break;
                            }
                        }

                        if (!fmtpFound) {
                            if (trackbr.maxbr > 0) {
                                media.fmtp.push({
                                    payload: codecPayload,
                                    config: `maxaveragebitrate=${trackbr.maxbr * 1000}`,
                                });
                            }
                        }

                        return true;
                    });
                }
            });
            mungedSDP = write(sdpParsed);
        }
        await this.setMungedSDP(sd, mungedSDP, true);

        this.pendingCandidates.forEach((candidate) => {
            this.pc.addIceCandidate(candidate);
        });
        this.pendingCandidates = [];
        this.restartingIce = false;

        if (this.renegotiate) {
            this.renegotiate = false;
            await this.createAndSendOffer();
        } else if (sd.type === 'answer') {
            this.emit(PCEvents.NegotiationComplete);
            if (sd.sdp) {
                const sdpParsed = parse(sd.sdp);
                sdpParsed.media.forEach((media) => {
                    if (media.type === 'video') {
                        this.emit(PCEvents.RTPVideoPayloadTypes, media.rtp);
                    }
                });
            }
        }
    }

    // 去抖协商接口
    negotiate = debounce(async (onError?: (e: Error) => void) => {
        this.emit(PCEvents.NegotiationStarted);
        try {
            await this.createAndSendOffer();
        } catch (e) {
            if (onError) {
                onError(e as Error);
            } else {
                throw e;
            }
        }
    }, 100);

    async createAndSendOffer(options?: RTCOfferOptions) {
        if (this.onOffer === undefined) {
            return;
        }

        if (options?.iceRestart) {
            this.log.debug('restarting ICE', this.logContext);
            this.restartingIce = true;
        }

        if (this._pc && this._pc.signalingState === 'have-local-offer') {
            // 我们正在等待对方接受我们的offer，所以我们就等待
            // 唯一的例外是需要重新启动 ICE 时
            const currentSD = this._pc.remoteDescription;
            if (options?.iceRestart && currentSD) {
                // TODO: 需要重启 ICE 但我们没有远程描述时处理
                // 最好的办法是重新创建对等连接
                await this._pc.setRemoteDescription(currentSD);
            } else {
                this.renegotiate = true;
                return;
            }
        } else if (!this._pc || this._pc.signalingState === 'closed') {
            this.log.warn('could not createOffer with closed peer connection', this.logContext);
            return;
        }

        // 实际协商
        this.log.debug('starting to negotiate', this.logContext);
        const offer = await this.pc.createOffer(options);

        const sdpParsed = parse(offer.sdp ?? '');
        sdpParsed.media.forEach((media) => {
            if (media.type === 'audio') {
                ensureAudioNackAndStereo(media, [], []);
            } else if (media.type === 'video') {
                ensureVideoDDExtensionForSVC(media);
                // mung sdp 用于编解码器比特率设置，无法通过 sendEncoding 应用
                this.trackBitrates.some((trackbr): boolean => {
                    if (!media.msid || !trackbr.cid || !media.msid.includes(trackbr.cid)) {
                        return false;
                    }

                    let codecPayload = 0;
                    media.rtp.some((rtp): boolean => {
                        if (rtp.codec.toUpperCase() === trackbr.codec.toUpperCase()) {
                            codecPayload = rtp.payload;
                            return true;
                        }
                        return false;
                    });

                    if (codecPayload === 0) {
                        return true;
                    }

                    const startBitrate = Math.round(trackbr.maxbr * startBitrateForSVC);

                    for (const fmtp of media.fmtp) {
                        if (fmtp.payload === codecPayload) {
                            // 如果已经设置了另一个轨道的 fmtp，我们无法覆盖比特率，
                            // 这会带来不幸的后果，即被迫对所有轨道使用初始轨道的比特率
                            if (!fmtp.config.includes('x-google-start-bitrate')) {
                                fmtp.config += `;x-google-start-bitrate=${startBitrate}`;
                            }
                            break;
                        }
                    }
                    return true;
                });
            }
        });

        await this.setMungedSDP(offer, write(sdpParsed));
        this.onOffer(offer);
    }

    async createAndSetAnswer(): Promise<RTCSessionDescriptionInit> {
        const answer = await this.pc.createAnswer();
        const sdpParsed = parse(answer.sdp ?? '');
        sdpParsed.media.forEach((media) => {
            if (media.type === 'audio') {
                ensureAudioNackAndStereo(media, this.remoteStereoMids, this.remoteNackMids);
            }
        });
        await this.setMungedSDP(answer, write(sdpParsed));
        return answer;
    }

    createDataChannel(label: string, dataChannelDict: RTCDataChannelInit) {
        return this.pc.createDataChannel(label, dataChannelDict);
    }

    addTransceiver(mediaStreamTrack: MediaStreamTrack, transceiverInit: RTCRtpTransceiverInit) {
        return this.pc.addTransceiver(mediaStreamTrack, transceiverInit);
    }

    addTrack(track: MediaStreamTrack) {
        if (!this._pc) {
            throw new UnexpectedConnectionState('PC closed, cannot add track');
        }
        return this._pc.addTrack(track);
    }

    setTrackCodecBitrate(info: TrackBitrateInfo) {
        this.trackBitrates.push(info);
    }

    setConfiguration(rtcConfig: RTCConfiguration) {
        if (!this._pc) {
            throw new UnexpectedConnectionState('PC closed, cannot configure');
        }
        return this._pc?.setConfiguration(rtcConfig);
    }

    /**
     * 判断是否可以移除音轨
     */
    canRemoveTrack(): boolean {
        return !!this._pc?.removeTrack;
    }

    /**
     * 移除音轨
     */
    removeTrack(sender: RTCRtpSender) {
        return this._pc?.removeTrack(sender);
    }

    /**
     * 获取连接状态
     */
    getConnectionState() {
        return this._pc?.connectionState ?? 'closed';
    }

    /**
     * 获取ICE的连接状态
     */
    getICEConnectionState() {
        return this._pc?.iceConnectionState ?? 'closed';
    }

    /**
     * 获取信令状态
     */
    getSignallingState() {
        return this._pc?.signalingState ?? 'closed';
    }

    /**
     * 获取收发器
     */
    getTransceivers() {
        return this._pc?.getTransceivers() ?? [];
    }

    /**
     * 获取发送者
     */
    getSenders() {
        return this._pc?.getSenders() ?? [];
    }

    /**
     * 获取本地描述
     */
    getLocalDescription() {
        return this._pc?.localDescription;
    }

    getRemoteDescription() {
        return this.pc?.remoteDescription;
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return this.pc.getStats();
    }

    /**
     * 获取连接地址
     */
    async getConnectedAddress(): Promise<string | undefined> {
        if (!this._pc) {
            return;
        }
        let selectedCandidatePairId = '';
        const candidatePairs = new Map<string, RTCIceCandidatePairStats>();
        // id -> candidate ip
        const candidates = new Map<string, string>();
        const stats: RTCStatsReport = await this._pc.getStats();
        stats.forEach((v) => {
            switch (v.type) {
                case 'transport':
                    selectedCandidatePairId = v.selectedCandidatePairId;
                    break;
                case 'candidate-pair':
                    if (selectedCandidatePairId === '' && v.selected) {
                        selectedCandidatePairId = v.id;
                    }
                    candidatePairs.set(v.id, v);
                    break;
                case 'remote-candidate':
                    candidates.set(v.id, `${v.address}:${v.port}`);
                    break;
                default:
            }
        });

        if (selectedCandidatePairId === '') {
            return undefined;
        }
        const selectedID = candidatePairs.get(selectedCandidatePairId)?.remoteCandidateId;
        if (selectedID === undefined) {
            return undefined;
        }
        return candidates.get(selectedID);
    }

    /**
     * 关闭pc
     */
    close = () => {
        if (!this._pc) {
            return;
        }
        this._pc.close();
        this._pc.onconnectionstatechange = null;
        this._pc.oniceconnectionstatechange = null;
        this._pc.onicegatheringstatechange = null;
        this._pc.ondatachannel = null;
        this._pc.onnegotiationneeded = null;
        this._pc.onsignalingstatechange = null;
        this._pc.onicecandidate = null;
        this._pc.ontrack = null;
        this._pc.onconnectionstatechange = null;
        this._pc = null;
    }

    private async setMungedSDP(sd: RTCSessionDescriptionInit, munged?: string, remote?: boolean) {
        if (munged) {
            const originalSdp = sd.sdp;
            sd.sdp = munged;
            try {
                this.log.debug(
                    `setting munged ${remote ? 'remote' : 'local'} description`,
                    this.logContext,
                );
                if (remote) {
                    await this.pc.setRemoteDescription(sd);
                } else {
                    await this.pc.setLocalDescription(sd);
                }
            } catch (e) {
                this.log.warn(`not able to set ${sd.type}, falling back to unmodified sdp`, {
                    ...this.logContext,
                    error: e,
                    sdp: munged,
                });
                sd.sdp = originalSdp;
            }
        }

        try {
            if (remote) {
                await this.pc.setRemoteDescription(sd);
            } else {
                await this.pc.setLocalDescription(sd);
            }
        } catch (e) {
            // 这个错误并不总是能够被捕获。
            // 如果本地描述有setCodecPreferences错误，该错误将不会被捕获
            let msg = 'unknown error';
            if (e instanceof Error) {
                msg = e.message;
            } else if (typeof e === 'string') {
                msg = e;
            }

            const fields: any = {
                error: msg,
                sdp: sd.sdp,
            };
            if (!remote && this.pc.remoteDescription) {
                fields.remoteSdp = this.pc.remoteDescription;
            }
            this.log.error(`unable to set ${sd.type}`, {...this.logContext, fields});
            throw new NegotiationError(msg);
        }
    }
}

function ensureAudioNackAndStereo(
    media: {
        type: string;
        port: number;
        protocol: string;
        payload?: string | undefined;
    } & MediaDescription,
    stereoMids: string[],
    nackMids: string[],
) {
    // 找到opus编解码器来添加nack fb
    let opusPayload = 0;
    media.rtp.some((rtp): boolean => {
        if (rtp.codec === 'opus') {
            opusPayload = rtp.payload;
            return true;
        }
        return false;
    });

    // 如果不存在则添加 nack rtcpfb
    if (opusPayload > 0) {
        if (!media.rtcpFb) {
            media.rtcpFb = [];
        }

        if (
            nackMids.includes(media.mid!) &&
            !media.rtcpFb.some((fb) => fb.payload === opusPayload && fb.type === 'nack')
        ) {
            media.rtcpFb.push({
                payload: opusPayload,
                type: 'nack',
            });
        }

        if (stereoMids.includes(media.mid!)) {
            media.fmtp.some((fmtp): boolean => {
                if (fmtp.payload === opusPayload) {
                    if (!fmtp.config.includes('stereo=1')) {
                        fmtp.config += ';stereo=1';
                    }
                    return true;
                }
                return false;
            });
        }
    }
}

function ensureVideoDDExtensionForSVC(
    media: {
        type: string;
        port: number;
        protocol: string;
        payloads?: string | undefined;
    } & MediaDescription,
) {
    const codec = media.rtp[0]?.codec?.toLowerCase();
    if (!isSVCCodec(codec)) {
        return;
    }

    let maxID = 0;
    const ddFound = media.ext?.some((ext): boolean => {
        if (ext.uri === ddExtensionURI) {
            return true;
        }
        if (ext.value > maxID) {
            maxID = ext.value;
        }
        return false;
    });

    if (!ddFound) {
        media.ext?.push({
            value: maxID + 1,
            uri: ddExtensionURI,
        });
    }
}

function extractStereoAndNackAudioFromOffer(offer: RTCSessionDescriptionInit): {
    stereoMids: string[];
    nackMids: string[];
} {
    const stereoMids: string[] = [];
    const nackMids: string[] = [];
    const sdpParsed = parse(offer.sdp ?? '');
    let opusPayload = 0;
    sdpParsed.media.forEach((media) => {
        if (media.type === 'audio') {
            media.rtp.some((rtp): boolean => {
                if (rtp.codec === 'opus') {
                    opusPayload = rtp.payload;
                    return true;
                }
                return false;
            });

            if (media.rtcpFb?.some((fb) => fb.payload === opusPayload && fb.type === 'nack')) {
                nackMids.push(media.mid!);
            }

            media.fmtp.some((fmtp): boolean => {
                if (fmtp.payload === opusPayload) {
                    if (fmtp.config.includes('sprop-stereo=1')) {
                        stereoMids.push(media.mid!);
                    }
                    return true;
                }
                return false;
            });
        }
    });
    return {stereoMids, nackMids};
}

