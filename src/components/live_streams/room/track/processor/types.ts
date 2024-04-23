import {Track} from "../Track";
import {Room} from "../../../protocol/tc_models_pb";

/**
 * 处理器选项
 * @experimental
 */
export type ProcessorOptions<T extends Track.Kind> = {
    kind: T;
    track: MediaStreamTrack;
    element?: HTMLMediaElement;
    audioContext?: AudioContext;
};

/**
 * @experimental
 */
export interface AudioProcessorOptions extends ProcessorOptions<Track.Kind.Audio> {
    audioContext: AudioContext;
}

/**
 * @experimental
 */
export interface VideoProcessorOptions extends ProcessorOptions<Track.Kind.Video> {
}

/**
 * @experimental
 */
export interface TrackProcessor<T extends Track.Kind,
    U extends ProcessorOptions<T> = ProcessorOptions<T>,
> {
    /**
     * 名称
     */
    name: string;
    /**
     * 初始化
     * @param opts 选项
     */
    init: (opts: U) => Promise<void>;
    /**
     * 重启
     * @param opts 选项
     */
    restart: (opts: U) => Promise<void>;
    /**
     * 销毁
     */
    destroy: () => Promise<void>;
    /**
     * 处理过程track
     */
    processedTrack?: MediaStreamTrack;
    /**
     * 发布时触发
     * @param room 房间
     */
    onPublish?: (room: Room) => Promise<void>;
    /**
     * 取消发布
     */
    onUnpublish?: () => Promise<void>;
}
