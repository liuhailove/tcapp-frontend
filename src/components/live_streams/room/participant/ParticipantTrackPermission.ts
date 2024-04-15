/**
 * 参与者音轨权限对象
 */
import {TrackPermission} from "../../protocol/tc_rtc_pb";

export interface ParticipantTrackPermission {

    /**
     * 此权限适用的参与者身份。
     * 您可以提供此值或“participantSid”
     */
    participantIdentity?: string;

    /**
     * 此权限适用的参与者服务器 ID。
     * 您可以提供此信息或“participantIdentity”
     */
    participantSid?: string;

    /**
     * 授予所有轨道的权限。 优先于 allowedTrackSids。
     * 如果未设置则为 false。
     */
    allowAll?: boolean;

    /**
     * 目标参与者可以订阅的曲目 ID 列表。
     * 取消设置后，它将允许参与者订阅所有曲目。
     * 如果为空，则不允许该参与者订阅任何曲目。
     */
    allowedTrackSids?: string[];
}

/**
 * 音轨权限对象转协议对象
 * @param perms 权限对象
 */
export function trackPermissionToProto(perms: ParticipantTrackPermission): TrackPermission {
    if (!perms.participantSid && !perms.participantIdentity) {
        throw new Error(
            'Invalid track permissions, must provide at least one of participantIdentity and participantSid',
        );
    }
    return new TrackPermission({
        participantIdentity: perms.participantIdentity ?? '',
        participantSid: perms.participantSid ?? '',
        allTracks: perms.allowAll ?? false,
        trackSids: perms.allowedTrackSids || [],
    });
}