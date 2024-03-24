import {Track} from "./Track";
import {LoggerOptions} from "../types";
import {TrackEvent} from "../TrackEvents";
import {monitorFrequency} from "../stats";

export default abstract class RemoteTrack<TrackKind extends Track.Kind = Track.Kind,
    > extends Track<TrackKind> {

    /**
     * 接收媒体流
     * @internal
     */
    receiver?: RTCRtpReceiver;

    constructor(
        mediaTrack: MediaStreamTrack,
        sid: string,
        kind: TrackKind,
        receiver?: RTCRtpReceiver,
        loggerOptions?: LoggerOptions,
    ) {
        super(mediaTrack, kind, loggerOptions);

        this.sid = sid;
        this.receiver = receiver;
    }

    /**
     * 设置静音
     * @internal
     */
    setMuted(muted: boolean) {
        if (this.isMuted !== muted) {
            this.isMuted = muted;
            this._mediaStreamTrack.enabled = !muted;
            this.emit(muted ? TrackEvent.Muted : TrackEvent.Unmuted, this);
        }
    }

    /**
     * 设置媒体流
     * @internal
     */
    setMediaStream(stream: MediaStream) {
        // 这需要确定曲目何时完成
        this.mediaStream = stream;
        const onRemoveTrack = (event: MediaStreamTrackEvent) => {
            if (event.track === this._mediaStreamTrack) {
                stream.removeEventListener('removetrack', onRemoveTrack);
                this.receiver = undefined;
                this._currentBitrate = 0;
                this.emit(TrackEvent.Ended, this);
            }
        };
        stream.addEventListener('removetrack', onRemoveTrack);
    }

    /**
     * 开始
     */
    start() {
        this.startMonitor();
        // 使用 track 的 `enabled` 来启用收发器的重用
        super.enable();
    }

    stop() {
        this.stopMonitor();
        // 使用 track 的 `enabled` 来启用收发器的重用
        super.disable();
    }

    /**
     * 获取RemoteTrack底层RTCRtpReceiver的RTCStatsReport
     * 请参阅 https://developer.mozilla.org/en-US/docs/Web/API/RTCStatsReport
     *
     * @returns Promise<RTCStatsReport> | 不明确的
     */
    async getRTCStatsReport(): Promise<RTCStatsReport | undefined> {
        if (!this.receiver?.getStats) {
            return;
        }
        return await this.receiver.getStats();
    }

    /* @internal */
    startMonitor() {
        if (!this.monitorInterval) {
            this.monitorInterval = setInterval(() => this.monitorReceiver(), monitorFrequency);
        }
    }

    protected abstract monitorReceiver(): void;
}