import {TrackPublication} from "./TrackPublication";
import LocalTrack from "./LocalTrack";
import {Track} from "./Track";
import {TrackInfo} from "../../protocol/tc_models_pb";
import {LoggerOptions} from "../types";
import {TrackEvent} from "../TrackEvents";
import LocalAudioTrack from "./LocalAudioTrack";
import LocalVideoTrack from "./LocalVideoTrack";
import {TrackPublishOptions} from "./options";

/**
 * 本地音轨发布
 */
export default class LocalTrackPublication extends TrackPublication {

    /**
     * 本地音轨
     */
    track?: LocalTrack = undefined;

    options?: TrackPublishOptions;


    /**
     * 上游已暂停
     */
    get isUpstreamPaused() {
        return this.track?.isUpstreamPaused;
    }

    constructor(kind: Track.Kind, ti: TrackInfo, track?: LocalTrack, loggerOptions?: LoggerOptions) {
        super(kind, ti.sid, ti.name, loggerOptions);

        this.updateInfo(ti);
        this.setTrack(track);
    }

    setTrack(track?: Track) {
        if (this.track) {
            this.track.off(TrackEvent.Ended, this.handleTrackEnded);
        }

        super.setTrack(track);

        if (track) {
            track.on(TrackEvent.Ended, this.handleTrackEnded);
        }
    }

    get isMuted(): boolean {
        if (this.track) {
            return this.track.isMuted;
        }
        return super.isMuted;
    }

    /**
     * 获取音轨
     */
    get audioTrack(): LocalAudioTrack | undefined {
        return super.audioTrack as LocalAudioTrack | undefined;
    }

    /**
     * 获取视频音轨
     */
    get videoTrack(): LocalVideoTrack | undefined {
        return super.videoTrack as LocalVideoTrack | undefined;
    }

    /**
     * 将与此发布相关的曲目静音
     */
    async mute() {
        return this.track?.mute();
    }

    /**
     * 取消与本发布相关的曲目静音
     */
    async unmute() {
        return this.track?.unmute();
    }

    /**
     * 暂停与此发布相关的媒体流轨道发送到服务器
     * 并向其他参与者发出“静音”事件信号
     * 如果您想暂停流而不暂停本地媒体流轨道，则很有用
     */
    async pauseUpstream() {
        await this.track?.pauseUpstream();
    }

    /**
     * 在调用 [[pauseUpstream()]] 后恢复将与此发布相关的媒体流轨道发送到服务器
     * 并向其他参与者发出“未静音”事件信号（除非轨道被明确静音）
     */
    async resumeUpstream() {
        await this.track?.resumeUpstream();
    }

    /**
     * 处理音轨结束
     */
    handleTrackEnded = () => {
        this.emit(TrackEvent.Ended);
    };
}