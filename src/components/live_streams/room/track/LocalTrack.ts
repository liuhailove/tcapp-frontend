/**
 * 默认维度的超时时间
 */
const defaultDimensionsTimeout = 1000;

export default abstract class LocalTrack<TrackKind extends Track.Kind = Track.Kind> extends Track<TrackKind> {

}