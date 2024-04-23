import {attachToElement, detachTrack, Track} from "./Track";
import RemoteTrack from "./RemoteTrack";
import {computeBitrate, VideoReceiverStats} from "../stats";
import {getDevicePixelRatio, getIntersectionObserver, getResizeObserver, isWeb, ObservableMediaElement} from "../utils";
import {AdaptiveStreamSettings} from "./types";
import {LoggerOptions} from "../types";
import {debounce} from "ts-debounce";
import CriticalTimers from "../timers";
import {TrackEvent} from "../TrackEvents";

const REACTION_DELAY = 100;

export default class RemoteVideoTrack extends RemoteTrack<Track.Kind.Video> {
    /**
     * 上一接收器统计
     */
    private prevStats?: VideoReceiverStats;

    /**
     * 元素信息
     */
    private elementInfos: ElementInfo[] = [];

    /**
     * 自适应流设置
     */
    private adaptiveStreamSettings?: AdaptiveStreamSettings;

    private lastVisible?: boolean;

    private lastDimensions?: Track.Dimensions;

    constructor(
        mediaTrack: MediaStreamTrack,
        sid: string,
        receiver?: RTCRtpReceiver,
        adaptiveStreamSettings?: AdaptiveStreamSettings,
        loggerOptions?: LoggerOptions,
    ) {
        super(mediaTrack, sid, Track.Kind.Video, receiver, loggerOptions);
        this.adaptiveStreamSettings = adaptiveStreamSettings;
    }

    /**
     * 判断是否为自适应流
     */
    get isAdaptiveStream(): boolean {
        return this.adaptiveStreamSettings !== undefined;
    }

    /**
     * 注意：使用adaptiveStream时，您需要使用remoteVideoTrack.attach()将轨道添加到HTMLVideoElement，否则您的视频轨道可能永远不会启动
     */
    get mediaStreamTrack() {
        return this._mediaStreamTrack;
    }

    /** @internal */
    setMuted(muted: boolean) {
        super.setMuted(muted);

        this.attachedElements.forEach((element) => {
            // 分离或者绑定
            if (muted) {
                detachTrack(this._mediaStreamTrack, element);
            } else {
                attachToElement(this._mediaStreamTrack, element);
            }
        });
    }

    attach(): HTMLMediaElement;
    attach(element: HTMLMediaElement): HTMLMediaElement;
    attach(element?: HTMLMediaElement): HTMLMediaElement {
        if (!element) {
            element = super.attach();
        } else {
            super.attach(element);
        }
        // 一个元素上的 Attach 可能会被多次调用。
        // 在这种情况下，我们希望避免添加重复的 elementInfos
        if (
            this.adaptiveStreamSettings &&
            this.elementInfos.find((info) => info.element === element) === undefined
        ) {
            const elementInfo = new HTMLElementInfo(element);
            this.observeElementInfo(elementInfo);
        }
        return element;
    }


    /**
     * 观察自适应流式传输时 ElementInfo 的变化。
     * @param elementInfo
     * @internal
     */
    observeElementInfo(elementInfo: ElementInfo) {
        if (
            this.adaptiveStreamSettings &&
            this.elementInfos.find((info) => info === elementInfo) === undefined
        ) {
            elementInfo.handleResize = () => {
                this.debouncedHandleResize();
            };
            elementInfo.handleVisibilityChanged = () => {
                this.updateVisibility();
            };
            this.elementInfos.push(elementInfo);
            elementInfo.observe();
            // 触发第一个调整大小更新周期
            // 如果选项卡处于后台，则初始调整大小事件不会触发，直到
            // 该选项卡第一次成为焦点。
            this.debouncedHandleResize();
            this.updateVisibility();
        } else {
            this.log.warn('visibility resize observer not triggered', this.logContext);
        }
    }

    /**
     * 停止观察 ElementInfo 的变化。
     * @param elementInfo
     * @internal
     */
    stopObservingElementInfo(elementInfo: ElementInfo) {
        if (!this.isAdaptiveStream) {
            this.log.warn('stopObservingElementInfo ignored', this.logContext);
            return;
        }
        const stopElementInfos = this.elementInfos.filter((info) => info === elementInfo);
        for (const info of stopElementInfos) {
            info.stopObserving();
        }
        this.elementInfos = this.elementInfos.filter((info) => info !== elementInfo);
        this.updateVisibility();
        this.debouncedHandleResize();
    }

    detach(): HTMLMediaElement[];
    detach(element: HTMLMediaElement): HTMLMediaElement;
    detach(element?: HTMLMediaElement): HTMLMediaElement | HTMLMediaElement[] {
        let detachedElements: HTMLMediaElement[] = [];
        if (element) {
            this.stopObservingElement(element);
            return super.detach(element);
        }
        detachedElements = super.detach();

        for (const e of detachedElements) {
            this.stopObservingElement(e);
        }

        return detachedElements;
    }

    /** @internal */
    getDecoderImplementation(): string | undefined {
        return this.prevStats?.decoderImplementation;
    }

    protected monitorReceiver = async () => {
        if (!this.receiver) {
            this._currentBitrate = 0;
            return;
        }
        const stats = await this.getReceiverStats();

        if (stats && this.prevStats && this.receiver) {
            this._currentBitrate = computeBitrate(stats, this.prevStats);
        }

        this.prevStats = stats;
    };

    /**
     * 获取接收器统计
     */
    private async getReceiverStats(): Promise<VideoReceiverStats | undefined> {
        if (!this.receiver || !this.receiver.getStats) {
            return;
        }

        const stats = await this.receiver.getStats();
        let receiverStats: VideoReceiverStats | undefined;
        let codecID = '';
        let codecs = new Map<string, any>();
        stats.forEach((v) => {
            if (v.type === 'inbound-rtp') {
                codecID = v.codecId;
                receiverStats = {
                    type: 'video',
                    framesDecoded: v.framesDecoded,
                    framesDropped: v.framesDropped,
                    framesReceived: v.framesReceived,
                    packetsReceived: v.packetsReceived,
                    packetsLost: v.packetsLost,
                    frameWidth: v.frameWidth,
                    frameHeight: v.frameHeight,
                    pliCount: v.pliCount,
                    firCount: v.firCount,
                    nackCount: v.nackCount,
                    jitter: v.jitter,
                    timestamp: v.timestamp,
                    bytesReceived: v.bytesReceived,
                    decoderImplementation: v.decoderImplementation,
                };
            } else if (v.type === 'codec') {
                codecs.set(v.id, v);
            }
        });
        if (receiverStats && codecID !== '' && codecs.get(codecID)) {
            receiverStats.mimeType = codecs.get(codecID).mimeType;
        }
        return receiverStats;
    }

    private stopObservingElement(element: HTMLMediaElement) {
        const stopElementInfos = this.elementInfos.filter((info) => info.element === element);
        for (const info of stopElementInfos) {
            this.stopObservingElementInfo(info);
        }
    }

    protected async handleAppVisibilityChanged() {
        await super.handleAppVisibilityChanged();
        if (!this.isAdaptiveStream) {
            return;
        }
        this.updateVisibility();
    }

    private readonly debouncedHandleResize = debounce(() => {
        this.updateDimensions();
    }, REACTION_DELAY);

    /**
     * 更新可见性
     */
    private updateVisibility() {
        const lastVisibilityChange = this.elementInfos.reduce(
            (prev, info) => Math.max(prev, info.visibilityChangedAt || 0),
            0,
        );

        const backgroundPause =
            this.adaptiveStreamSettings?.pauseVideoInBackground ?? true //默认为true
                ? this.isInBackground
                : false;
        const isPiPMode = this.elementInfos.some((info) => info.pictureInPicture);
        const isVisible =
            (this.elementInfos.some((info) => info.visible) && !backgroundPause);

        if (this.lastVisible === isVisible) {
            return;
        }

        if (!isVisible && Date.now() - lastVisibilityChange < REACTION_DELAY) {
            // 延迟隐藏事件
            CriticalTimers.setTimeout(() => {
                this.updateVisibility();
            }, REACTION_DELAY);
            return;
        }

        this.lastVisible = isVisible;
        this.emit(TrackEvent.VisibilityChanged, isVisible, this);
    }

    /**
     * 更新尺寸
     */
    private updateDimensions() {
        let maxWidth = 0;
        let maxHeight = 0;
        const pixelDensity = this.getPixelDensity();
        for (const info of this.elementInfos) {
            const currentElementWidth = info.width() * pixelDensity;
            const currentElementHeight = info.height() * pixelDensity;
            if (currentElementWidth + currentElementHeight > maxWidth + maxHeight) {
                maxWidth = currentElementWidth;
                maxHeight = currentElementHeight;
            }
        }

        if (this.lastDimensions?.width === maxWidth && this.lastDimensions?.height === maxHeight) {
            return;
        }

        this.lastDimensions = {
            width: maxWidth,
            height: maxHeight,
        };

        this.emit(TrackEvent.VideoDimensionsChanged, this.lastDimensions, this);
    }

    /**
     * 获取像素浓度
     */
    private getPixelDensity(): number {
        const pixelDensity = this.adaptiveStreamSettings?.pixelDensity;
        if (pixelDensity === 'screen') {
            return getDevicePixelRatio();
        } else if (!pixelDensity) {
            // 当取消设置时，我们将在这里选择一个合理的默认值。
            // 对于更高像素密度的设备（手机等），我们将使用 2
            // 否则默认为1
            const devicePixelRatio = getDevicePixelRatio();
            if (devicePixelRatio > 2) {
                return 2;
            } else {
                return 1;
            }
        }
        return pixelDensity;
    }

}

/**
 * 元素信息
 */
export interface ElementInfo {
    /**
     * 元素对象
     */
    element: object;

    /**
     * 宽
     */
    width(): number;

    /**
     * 高
     */
    height(): number;

    /**
     * 可见性
     */
    visible: boolean;

    /**
     * 画中画
     */
    pictureInPicture: boolean;

    /**
     * 可见性变更时间
     */
    visibilityChangedAt: number | undefined;

    /**
     * 处理调整大小
     */
    handleResize?: () => void;

    /**
     * 处理可见性已更改
     */
    handleVisibilityChanged?: () => void;

    /**
     * 观察
     */
    observe(): void;

    /**
     * 停止观察
     */
    stopObserving(): void;
}

/**
 * html元素信息
 */
class HTMLElementInfo implements ElementInfo {
    /**
     * html媒体元素
     */
    element: HTMLMediaElement;

    get visible(): boolean {
        return this.isPiP || this.isIntersecting;
    }

    get pictureInPicture(): boolean {
        return this.isPiP;
    }

    /**
     * 可见行变更时间
     */
    visibilityChangedAt: number | undefined;

    /**
     * 处理调整大小
     */
    handleResize?: () => void;

    /**
     * 处理可见性变更
     */
    handleVisibilityChanged?: () => void;

    /**
     * 是否为画中画
     */
    private isPiP: boolean;

    /**
     * 是否相交
     */
    private isIntersecting: boolean;

    constructor(element: HTMLMediaElement, visible?: boolean) {
        this.element = element;
        this.isIntersecting = visible ?? isElementInViewport(element);
        this.isPiP = isWeb() && document.pictureInPictureElement === element;
        this.visibilityChangedAt = 0;
    }

    width(): number {
        return this.element.clientWidth;
    }

    height(): number {
        return this.element.clientHeight;
    }

    observe() {
        // 确保一旦我们开始观察就更新当前的可见状态
        this.isIntersecting = isElementInViewport(this.element);
        this.isPiP = document.pictureInPictureElement === this.element;

        (this.element as ObservableMediaElement).handleResize = () => {
            this.handleResize?.();
        };
        (this.element as ObservableMediaElement).handleVisibilityChanged = this.onVisibilityChanged;

        getIntersectionObserver().observe(this.element);
        getResizeObserver().observe(this.element);
        (this.element as HTMLVideoElement).addEventListener('enterpictureinpicture', this.onEnterPiP);
        (this.element as HTMLVideoElement).addEventListener('leavepictureinpicture', this.onLeavePiP);
    }

    /**
     * 可见性变更
     * @param entry IntersectionObserverEntry（交叉观察器条目）是 Intersection Observer API 返回的一个对象，
     * 用于描述目标元素与其根元素或视窗之间的交叉信息。
     *
     * 当使用 Intersection Observer API 监测元素的可见性时，
     * 每当目标元素进入或离开视窗或根元素的可见部分时，都会生成一个 IntersectionObserverEntry 对象。
     */
    private onVisibilityChanged = (entry: IntersectionObserverEntry) => {
        const {target, isIntersecting} = entry;
        if (target === this.element) {
            this.isIntersecting = isIntersecting;
            this.visibilityChangedAt = Date.now();
            this.handleVisibilityChanged?.();
        }
    };

    /**
     * 进入画中画
     */
    private onEnterPiP = () => {
        this.isPiP = true;
        this.handleVisibilityChanged?.();
    };

    /**
     * 离开画中画
     */
    private onLeavePiP = () => {
        this.isPiP = false;
        this.handleVisibilityChanged?.();
    };

    /**
     * 停止监听
     */
    stopObserving() {
        getIntersectionObserver()?.unobserve(this.element);
        getResizeObserver()?.unobserve(this.element);
        (this.element as HTMLVideoElement).removeEventListener(
            'enterpictureinpicture',
            this.onEnterPiP,
        );
        (this.element as HTMLVideoElement).removeEventListener(
            'leavepictureinpicture',
            this.onLeavePiP,
        );
    }
}

/**
 * 判断元素是否在视口中
 * 不考虑其他元素的遮挡
 * @param el
 */
function isElementInViewport(el: HTMLElement) {
    let top = el.offsetTop;
    let left = el.offsetLeft;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const {hidden} = el;
    const {opacity, display} = getComputedStyle(el);

    while (el.offsetParent) {
        el = el.offsetParent as HTMLElement;
        top += el.offsetTop;
        left += el.offsetLeft;
    }

    return (
        top < window.pageYOffset + window.innerHeight &&
        left < window.pageXOffset + window.innerWidth &&
        top + height > window.pageYOffset &&
        left + width > window.pageXOffset &&
        !hidden &&
        (opacity !== '' ? parseFloat(opacity) > 0 : true) &&
        display !== 'none'
    );
}
