import {TrackPublication} from "./TrackPublication";
import RemoteTrack from "./RemoteTrack";
import {Track} from "./Track";
import {ParticipantTracks, SubscriptionError, TrackInfo, VideoQuality} from "../../protocol/tc_models_pb";
import {LoggerOptions} from "../types";
import {UpdateSubscription, UpdateTrackSettings} from "../../protocol/tc_rtc_pb";
import {TrackEvent} from "../TrackEvents";
import RemoteVideoTrack from "./RemoteVideoTrack";

/**
 * 远程音轨发布
 */
export default class RemoteTrackPublication extends TrackPublication {
    /**
     * 远程音轨
     */
    track?: RemoteTrack = undefined;

    /** @internal */
    protected allowed = true;

    // 跟踪客户端订阅曲目的愿望，如果 autoSubscribe 处于活动状态，也为 true
    protected subscribed?: boolean;

    protected disabled: boolean = false;

    /**
     * 当前视频质量
     */
    protected currentVideoQuality?: VideoQuality = VideoQuality.HIGH;

    /**
     * 视频尺寸
     */
    protected videoDimensions?: Track.Dimensions;

    protected fps?: number;

    /**
     * 订阅错误
     */
    protected subscriptionError?: SubscriptionError;

    constructor(
        kind: Track.Kind,
        ti: TrackInfo,
        autoSubscribe: boolean | undefined,
        loggerOptions?: LoggerOptions,
    ) {
        super(kind, ti.sid, ti.name, loggerOptions);
        this.subscribed = autoSubscribe;
        this.updateInfo(ti);
    }

    /**
     * 订阅或取消订阅该远程曲目
     * @param subscribed true 表示订阅曲目， false 表示取消订阅
     */
    setSubscribed(subscribed: boolean) {
        const prevStatus = this.subscriptionStatus;
        const prevPermission = this.permissionStatus;
        this.subscribed = subscribed;
        // 当所需的订阅状态发生变化时重置允许的状态
        // 如果不允许，服务器会通过信号消息通知客户端
        if (subscribed) {
            this.allowed = true;
        }

        const sub = new UpdateSubscription({
            trackSids: [this.trackSid],
            subscribe: this.subscribed,
            participantTracks: [
                new ParticipantTracks({
                    // 发送一个空的参与者 ID，因为 TrackPublication 不保留它，
                    // 这由接收此消息的参与者填写
                    participantSid: '',
                    trackSids: [this.trackSid],
                }),
            ],
        });
        this.emit(TrackEvent.UpdateSubscription, sub);
        this.emitSubscriptionUpdateIfChanged(prevStatus);
        this.emitPermissionUpdateIfChanged(prevPermission);
    }

    /**
     * 获取订阅状态
     */
    get subscriptionStatus(): TrackPublication.SubscriptionStatus {
        if (this.subscribed === false) {
            return TrackPublication.SubscriptionStatus.Unsubscribed;
        }
        if (!super.isSubscribed) {
            return TrackPublication.SubscriptionStatus.Desired;
        }
        return TrackPublication.SubscriptionStatus.Subscribed;
    }

    /**
     * 获取允许状态
     */
    get permissionStatus(): TrackPublication.PermissionStatus {
        return this.allowed
            ? TrackPublication.PermissionStatus.Allowed
            : TrackPublication.PermissionStatus.NotAllowed;
    }

    /**
     * 如果曲目已订阅并准备好播放，则返回 true
     */
    get isSubscribed(): boolean {
        if (this.subscribed === false) {
            return false;
        }
        return super.isSubscribed;
    }

    // 返回客户端订阅曲目的愿望，如果启用了自动订阅，则也为 true
    get isDesired(): boolean {
        return this.subscribed !== false;
    }

    get isEnabled(): boolean {
        return !this.disabled;
    }

    /**
     * 禁止服务器发送该曲目的数据。
     * 当参与者离开屏幕时这很有用，您可以禁用流式传输他们的视频以减少带宽要求
     * @param enabled
     */
    setEnabled(enabled: boolean) {
        if (!this.isManualOperationAllowed() || this.disabled === !enabled) {
            return;
        }
        this.disabled = !enabled;

        this.emitTrackUpdate();
    }

    /**
     * 对于支持联播的曲目，调整订阅质量
     *
     * 这表示客户可以接受的最高质量。 如果网络
     * 带宽不允许，服务器会自动降低质量至
     * 优化不间断视频
     */
    setVideoQuality(quality: VideoQuality) {
        if (!this.isManualOperationAllowed() || this.currentVideoQuality === quality) {
            return;
        }
        this.currentVideoQuality = quality;
        this.videoDimensions = undefined;

        this.emitTrackUpdate();
    }

    /**
     * 设置视频尺寸
     */
    setVideoDimensions(dimensions: Track.Dimensions) {
        if (!this.isManualOperationAllowed()) {
            return;
        }
        if (
            this.videoDimensions?.width === dimensions.width &&
            this.videoDimensions?.height === dimensions.height
        ) {
            return;
        }
        if (this.track instanceof RemoteVideoTrack) {
            this.videoDimensions = dimensions;
        }
        this.currentVideoQuality = undefined;

        this.emitTrackUpdate();
    }

    /**
     * 设置视频祯数
     * @param fps 每秒帧数（Frames Per Second）
     */
    setVideoFPS(fps: number) {
        if (!this.isManualOperationAllowed()) {
            return;
        }

        if (!(this.track instanceof RemoteVideoTrack)) {
            return;
        }

        if (this.fps === fps) {
            return;
        }

        this.fps = fps;
        this.emitTrackUpdate();
    }

    /**
     * 获取视频质量
     */
    get videoQuality(): VideoQuality | undefined {
        return this.currentVideoQuality;
    }

    /** @internal */
    setTrack(track?: RemoteTrack) {
        const prevStatus = this.subscriptionStatus;
        const prevPermission = this.permissionStatus;
        const prevTrack = this.track;
        if (prevTrack === track) {
            return;
        }
        if (prevTrack) {
            // 解除监听
            prevTrack.off(TrackEvent.VideoDimensionsChanged, this.handleVideoDimensionsChange);
            prevTrack.off(TrackEvent.VisibilityChanged, this.handleVisibilityChange);
            prevTrack.off(TrackEvent.Ended, this.handleEnded);
            prevTrack.detach();
            prevTrack.stopMonitor();
            this.emit(TrackEvent.Unsubscribed, prevTrack);
        }
        super.setTrack(track);
        if (track) {
            track.sid = this.trackSid;
            track.on(TrackEvent.VideoDimensionsChanged, this.handleVideoDimensionsChange);
            track.on(TrackEvent.VisibilityChanged, this.handleVisibilityChange);
            track.on(TrackEvent.Ended, this.handleEnded);
            this.emit(TrackEvent.Subscribed, track);
        }
        this.emitPermissionUpdateIfChanged(prevPermission);
        this.emitSubscriptionUpdateIfChanged(prevStatus);
    }

    /** @internal */
    setAllowed(allowed: boolean) {
        const prevStatus = this.subscriptionStatus;
        const prevPermission = this.permissionStatus;
        this.allowed = allowed;
        this.emitPermissionUpdateIfChanged(prevPermission);
        this.emitSubscriptionUpdateIfChanged(prevStatus);
    }

    /** @internal */
    setSubscriptionError(error: SubscriptionError) {
        this.emit(TrackEvent.SubscriptionFailed, error);
    }

    /** @internal */
    updateInfo(info: TrackInfo) {
        super.updateInfo(info);
        const prevMetadataMuted = this.metadataMuted;
        this.metadataMuted = info.muted;
        if (this.track) {
            this.track.setMuted(info.muted);
        } else if (prevMetadataMuted !== info.muted) {
            this.emit(info.muted ? TrackEvent.Muted : TrackEvent.Unmuted);
        }
    }

    /**
     * 如果更改，发出订阅更新
     * @param previousStatus
     * @private
     */
    private emitSubscriptionUpdateIfChanged(previousStatus: TrackPublication.SubscriptionStatus) {
        const currentStatus = this.subscriptionStatus;
        if (previousStatus === currentStatus) {
            return;
        }
        this.emit(TrackEvent.SubscriptionStatusChanged, currentStatus, previousStatus);
    }

    /**
     * 如果变更，发出权限更新通知
     */
    private emitPermissionUpdateIfChanged(
        previousPermissionStatus: TrackPublication.PermissionStatus,
    ) {
        const currentPermissionStatus = this.permissionStatus;
        if (currentPermissionStatus !== previousPermissionStatus) {
            this.emit(
                TrackEvent.SubscriptionPermissionChanged,
                this.permissionStatus,
                previousPermissionStatus,
            );
        }
    }

    /**
     * 是否允许手动操作
     */
    private isManualOperationAllowed(): boolean {
        if (this.kind === Track.Kind.Video && this.isAdaptiveStream) {
            this.log.warn(
                'adaptive stream is enabled, cannot change video track settings',
                this.logContext,
            );
            return false;
        }
        if (!this.isDesired) {
            this.log.warn('cannot update track settings when not subscribed', this.logContext);
            return false;
        }
        return true;
    }

    /**
     * 处理结束信号
     */
    protected handleEnded = (track: RemoteTrack) => {
        this.setTrack(undefined);
        this.emit(TrackEvent.Ended, track);
    };

    protected get isAdaptiveStream(): boolean {
        return this.track instanceof RemoteVideoTrack && this.track.isAdaptiveStream;
    }

    /**
     * 处理可见性改变
     */
    protected handleVisibilityChange = (visible: boolean) => {
        this.log.debug(
            `adaptivestream video visibility ${this.trackSid}, visible=${visible}`,
            this.logContext,
        );
        this.disabled = !visible;
        this.emitTrackUpdate();
    };

    /**
     * 处理视频尺寸改变
     */
    protected handleVideoDimensionsChange = (dimensions: Track.Dimensions) => {
        this.log.debug(
            `adaptivestream video dimensions ${dimensions.width}x${dimensions.height}`,
            this.logContext,
        );
        this.videoDimensions = dimensions;
        this.emitTrackUpdate();
    };

    /* @internal */
    emitTrackUpdate() {
        const settings: UpdateTrackSettings = new UpdateTrackSettings({
            trackSids: [this.trackSid],
            disabled: this.disabled,
            fps: this.fps,
        });
        if (this.videoDimensions) {
            settings.width = Math.ceil(this.videoDimensions.width);
            settings.height = Math.ceil(this.videoDimensions.height);
        } else if (this.currentVideoQuality !== undefined) {
            settings.quality = this.currentVideoQuality;
        } else {
            // 默认为高质量
            settings.quality = VideoQuality.HIGH;
        }

        this.emit(TrackEvent.UpdateSettings, settings);
    }
}
