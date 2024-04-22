import Participant, {ParticipantEventCallbacks} from "./Participant";
import {SignalClient} from "../../api/SignalClient";
import {Track} from "../track/Track";
import {AudioOutputOptions} from "../track/options";
import {ParticipantInfo, SubscriptionError} from "../../protocol/tc_models_pb";
import {LoggerOptions} from "../types";
import RemoteTrackPublication from "../track/RemoteTrackPublication";
import {ParticipantEvent, TrackEvent} from "../TrackEvents";
import {UpdateSubscription, UpdateTrackSettings} from "../../protocol/tc_rtc_pb";
import {getLogContextFromTrack} from "../track/utils";
import {TrackPublication} from "../track/TrackPublication";
import RemoteTrack from "../track/RemoteTrack";
import RemoteAudioTrack from "../track/RemoteAudioTrack";
import {AdaptiveStreamSettings} from "../track/types";
import RemoteVideoTrack from "../track/RemoteVideoTrack";

/**
 * 远程参与者
 */
export default class RemoteParticipant extends Participant {

    /**
     * 音频发布者
     */
    audioTrackPublications: Map<string, RemoteTrackPublication> = new Map();

    /**
     * 视频发布者
     */
    videoTrackPublications: Map<string, RemoteTrackPublication> = new Map();

    /**
     * 音轨发布Mao
     */
    trackPublications: Map<string, RemoteTrackPublication> = new Map();

    /**
     * 信令客户端
     */
    signalClient: SignalClient;

    /**
     * 音轨源--》声音大小mao
     */
    private volumeMap: Map<Track.Source, number>;

    /**
     * 音频输出选项
     */
    private audioOutput?: AudioOutputOptions;

    /** @internal */
    static fromParticipantInfo(signalClient: SignalClient, pi: ParticipantInfo): RemoteParticipant {
        return new RemoteParticipant(signalClient, pi.sid, pi.identity, pi.name, pi.metadata);
    }

    protected get logContext() {
        return {
            ...super.logContext,
            rpID: this.sid,
            remoteParticipant: this.identity,
        };
    }

    /** @internal */
    constructor(
        signalClient: SignalClient,
        sid: string,
        identity?: string,
        name?: string,
        metadata?: string,
        loggerOptions?: LoggerOptions,
    ) {
        super(sid, identity || '', name, metadata, loggerOptions);
        this.signalClient = signalClient;
        this.trackPublications = new Map();
        this.audioTrackPublications = new Map();
        this.videoTrackPublications = new Map();
        this.volumeMap = new Map<Track.Source, number>();
    }

    protected addTrackPublication(publication: RemoteTrackPublication) {
        super.addTrackPublication(publication);

        // 注册动作事件
        publication.on(TrackEvent.UpdateSettings, (settings: UpdateTrackSettings) => {
            this.log.debug('send update settings', {
                ...this.logContext,
                ...getLogContextFromTrack(publication),
            });
            this.signalClient.sendUpdateTrackSettings(settings);
        });
        publication.on(TrackEvent.UpdateSubscription, (sub: UpdateSubscription) => {
            sub.participantTracks.forEach((pt) => {
                pt.participantSid = this.sid;
            });
            this.signalClient.sendUpdateSubscription(sub);
        });
        publication.on(
            TrackEvent.SubscriptionPermissionChanged,
            (status: TrackPublication.PermissionStatus) => {
                this.emit(ParticipantEvent.TrackSubscriptionPermissionChanged, publication, status);
            },
        );
        publication.on(
            TrackEvent.SubscriptionStatusChanged,
            (status: TrackPublication.SubscriptionStatus) => {
                this.emit(ParticipantEvent.TrackSubscriptionStatusChanged, publication, status);
            },
        );
        publication.on(TrackEvent.Subscribed, (track: RemoteTrack) => {
            this.emit(ParticipantEvent.TrackSubscribed, track, publication);
        });
        publication.on(TrackEvent.Unsubscribed, (previousTrack: RemoteTrack) => {
            this.emit(ParticipantEvent.TrackUnsubscribed, previousTrack, publication);
        });
        publication.on(TrackEvent.SubscriptionFailed, (error: SubscriptionError) => {
            this.emit(ParticipantEvent.TrackSubscriptionFailed, publication.trackSid, error);
        });
    }

    getTrackPublication(source: Track.Source): RemoteTrackPublication | undefined {
        const track = super.getTrackPublication(source);
        if (track) {
            return track as RemoteTrackPublication;
        }
    }

    /**
     * 设置参与者音轨的音量
     * 默认情况下，这会影响麦克风发布
     * 可以传入不同的源作为第二个参数
     * 如果不存在轨道，则添加麦克风轨道时将应用音量
     */
    setVolume(
        volume: number,
        source: Track.Source.Microphone | Track.Source.ScreenShareAudio = Track.Source.Microphone,
    ) {
        this.volumeMap.set(source, volume);
        const audioPublication = this.getTrackPublication(source);
        if (audioPublication?.track) {
            (audioPublication.track as RemoteAudioTrack).setVolume(volume);
        }
    }

    /**
     * 获取与会者麦克风轨道上的音量
     */
    getVolume(
        source: Track.Source.Microphone | Track.Source.ScreenShareAudio = Track.Source.Microphone,
    ) {
        const audioPublication = this.getTrackPublication(source);
        if (audioPublication?.track) {
            return (audioPublication.track as RemoteAudioTrack).getVolume();
        }
        return this.volumeMap.get(source);
    }

    /** @internal */
    addSubscribedMediaTrack(
        mediaTrack: MediaStreamTrack,
        sid: Track.SID,
        mediaStream: MediaStream,
        receiver?: RTCRtpReceiver,
        adaptiveStreamSettings?: AdaptiveStreamSettings,
        triesLeft?: number
    ) {
        // 查找曲目pub
        // 媒体轨道有可能在参与者信息之前到达
        let publication = this.getTrackPublicationBySid(sid);

        // 浏览器也有可能不尊重我们原始的曲目 ID
        // FireFox 将使用自己的本地 uuid 而不是服务器轨道 id
        if (!publication) {
            if (!sid.startsWith('TR')) {
                // 找到第一个匹配类型的曲目
                this.trackPublications.forEach((p) => {
                    if (!publication && mediaTrack.kind === p.kind.toString()) {
                        publication = p;
                    }
                });
            }
        }

        // 当我们无法找到曲目时，可能是元数据尚未到达。
        // 等待一段时间以使其到达，或者引发错误
        if (!publication) {
            if (triesLeft === 0) {
                this.log.error('could not find published track', {
                    ...this.logContext,
                    trackSid: sid,
                });
                this.emit(ParticipantEvent.TrackSubscriptionFailed, sid);
                return;
            }

            if (triesLeft === undefined) {
                triesLeft = 20;
            }
            setTimeout(() => {
                this.addSubscribedMediaTrack(
                    mediaTrack,
                    sid,
                    mediaStream,
                    receiver,
                    adaptiveStreamSettings,
                    triesLeft - 1,
                );
            }, 150);
            return;
        }

        if (mediaTrack.readyState === 'ended') {
            this.log.error(
                'unable to subscribe because MediaStreamTrack is ended. Do not call MediaStreamTrack.stop()',
                {...this.logContext, ...getLogContextFromTrack(publication)},
            );
            this.emit(ParticipantEvent.TrackSubscriptionFailed, sid);
            return;
        }

        const isVideo = mediaTrack.kind === 'video';
        let track: RemoteTrack;
        if (isVideo) {
            track = new RemoteVideoTrack(mediaTrack, sid, receiver, adaptiveStreamSettings);
        } else {
            track = new RemoteAudioTrack(mediaTrack, sid, receiver, this.audioContext, this.audioOutput);
        }

        // 设置音轨信息
        track.source = publication.source;
        // 保持发布的静音状态
        track.isMuted = publication.isMuted;
        track.setMediaStream(mediaStream);
        track.start();

        publication.setTrack(track);
        // 设置新音轨上的参与者音量
        if (this.volumeMap.has(publication.source) && track instanceof RemoteAudioTrack) {
            track.setVolume(this.volumeMap.get(publication.source)!);
        }

        return publication;
    }

    /** @internal */
    get hasMetadata(): boolean {
        return !!this.participantInfo;
    }

    /**
     * @internal
     */
    getTrackPublicationBySid(sid: Track.SID): RemoteTrackPublication | undefined {
        return this.trackPublications.get(sid);
    }

    /** @internal */
    updateInfo(info: ParticipantInfo): boolean {
        if (!super.updateInfo(info)) {
            return false;
        }

        // 我们正在获取所有可用曲目的列表，请在此处进行协调
        // 并发送更改事件

        // 协调跟踪发布，仅当元数据已存在时才发布事件
        // 即自本地参与者加入以来发生的变化
        const validTracks = new Map<string, RemoteTrackPublication>();
        const newTracks = new Map<string, RemoteTrackPublication>();

        info.tracks.forEach((ti) => {
            let publication = this.getTrackPublicationBySid(ti.sid);
            if (!publication) {
                // 新的发布
                const kind = Track.kindFromProto(ti.type);
                if (!kind) {
                    return;
                }
                publication = new RemoteTrackPublication(
                    kind,
                    ti,
                    this.signalClient.connectOptions?.autoSubscribe,
                    {loggerContextCb: () => this.logContext, loggerName: this.loggerOptions?.loggerName},
                );
                publication.updateInfo(ti);
                newTracks.set(ti.sid, publication);
                const existingTrackOfSource = Array.from(this.trackPublications.values()).find(
                    (publicationTrack) => publicationTrack.source === publication?.source,
                );
                if (existingTrackOfSource && publication.source !== Track.Source.Unknown) {
                    this.log.debug(
                        `received a second track publication for ${this.identity} with the same source: ${publication.source}`,
                        {
                            ...this.logContext,
                            oldTrack: getLogContextFromTrack(existingTrackOfSource),
                            newTrack: getLogContextFromTrack(publication),
                        },
                    );
                }
                this.addTrackPublication(publication);
            } else {
                publication.updateInfo(ti);
            }
            validTracks.set(ti.sid, publication);
        });

        // 检测移除的音轨
        this.trackPublications.forEach((publication) => {
            if (!validTracks.has(publication.trackSid)) {
                this.log.trace('detected removed track on remote participant, unpublish', {
                    ...this.logContext,
                    ...getLogContextFromTrack(publication),
                });
                this.unpublishTrack(publication.trackSid, true);
            }
        });

        // 总是为新的发布发出事件，Room 不会转发它们，除非它准备好了
        newTracks.forEach((publication) => {
            this.emit(ParticipantEvent.TrackPublished, publication);
        });
        return true;
    }

    /** @internal */
    unpublishTrack(sid: Track.SID, sendUnpublish?: boolean) {
        const publication = this.trackPublications.get(sid);
        if (!publication) {
            return;
        }

        // also send unsubscribe, if track is actively subscribed
        const {track} = publication;
        if (track) {
            track.stop();
            publication.setTrack();
        }

        // remove track from maps only after unsubscribed has been fired
        this.trackPublications.delete(sid);

        // remove from the right type map
        switch (publication.kind) {
            case Track.Kind.Audio:
                this.audioTrackPublications.delete(sid);
                break;
            case Track.Kind.Video:
                this.videoTrackPublications.delete(sid);
                break;
            default:
                break;
        }

        if (sendUnpublish) {
            this.emit(ParticipantEvent.TrackUnpublished, publication);
        }
    }

    /**
     * @internal
     */
    async setAudioOutput(output: AudioOutputOptions) {
        this.audioOutput = output;
        const promise: Promise<void>[] = [];
        this.audioTrackPublications.forEach((pub) => {
            if (pub.track instanceof RemoteAudioTrack) {
                promise.push(pub.track.setSinkId(output.deviceId ?? 'default'));
            }
        });
        await Promise.all(promise);
    }

    /** @internal */
    emit<E extends keyof ParticipantEventCallbacks>(
        event: E,
        ...args: Parameters<ParticipantEventCallbacks[E]>
    ): boolean {
        this.log.trace('participant event', {...this.logContext, event, args});
        return super.emit(event, ...args);
    }
}