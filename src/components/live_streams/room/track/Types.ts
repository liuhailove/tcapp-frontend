import RemoteAudioTrack from "./RemoteAudioTrack";
import LocalAudioTrack from "./LocalAudioTrack";
import RemoteVideoTrack from "./RemoteVideoTrack";
import LocalVideoTrack from "./LocalVideoTrack";

export type AudioTrack = RemoteAudioTrack | LocalAudioTrack;
export type VideoTrack = RemoteVideoTrack | LocalVideoTrack;

/**
 * 自适应流设着
 */
export type AdaptiveStreamSettings = {
    /**
     *设置自定义像素密度。 高密度屏幕（3+）或
     * 1否则。
     *在超高清屏幕上流式传输视频时此设置
     *让您说明这些屏幕的设备pixelratio。
     *将其设置为“屏幕”以使用屏幕的实际像素密度
     *注意：这可能会大大增加人们消耗的带宽
     *在高清屏幕上流式传输。
     */
    pixelDensity?: number | 'screen';
    /**
     * 如果为 true，则切换到另一个选项卡时视频会暂停。
     * 默认为 true。
     */
    pauseVideoInBackground?: boolean;
};

/**
 * 替换音轨选项
 */
export interface ReplaceTrackOptions {
    /**
     * 用户提供的曲目
     */
    userProvidedTrack?: boolean;
    /**
     * 停止处理器
     */
    stopProcessor?: boolean;
}