import Participant from "./Participant";
import LocalTrackPublication from "../track/LocalTrackPublication";
import {Track} from "../track/Track";
import LocalTrack from "../track/LocalTrack";
import {Encryption_Type, ParticipantPermission} from "../../protocol/tc_models_pb";
import {InternalRoomOptions} from "../../options";
import {Future} from "../utils";

/**
 * 本地参与者
 */
export default class LocalParticipant extends Participant {
    audioTrackPublications: Map<string, LocalTrackPublication>;

    videoTrackPublications: Map<string, LocalTrackPublication>;

    /** map of track sid => all published tracks */
    trackPublications: Map<string, LocalTrackPublication>;

    engine: RTCEngine;

    /** @internal */
    activeDeviceMap: Map<MediaDeviceKind, string>;

    /**
     * 待发布的音频源
     */
    private pendingPublishing = new Set<Track.Source>;

    private pendingPublishPromise = new Map<LocalTrack, Promise<LocalTrackPublication>>();

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
        super();
    }
}