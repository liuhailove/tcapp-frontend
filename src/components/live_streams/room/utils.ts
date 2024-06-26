/**
 * 分隔符
 */
import CriticalTimers from "./timers";
import {DetectableBrowser, getBrowser} from "../utils/browserParser";
import {TCReactNativeInfo} from "./types";
import {ClientInfo, ClientInfo_SDK} from "../protocol/tc_models_pb";
import {protocolVersion, version} from "../version";
import {getNewAudioContext} from "./track/utils";
import {VideoCodec, videoCodecs} from "./track/options";
import LocalAudioTrack from "./track/LocalAudioTrack";
import RemoteAudioTrack from "./track/RemoteAudioTrack";

const separator = '|';
/**
 * 依赖描述扩展URI
 */
export const ddExtensionURI =
    'https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension';

/**
 * 解包流Id
 * @param packed
 */
export function unpackStreamId(packed: string): string[] {
    const parts = packed.split(separator);
    if (parts.length > 1) {
        return [parts[0], packed.substr(parts[0].length + 1)];
    }
    return [packed, ''];
}

/**
 * 导出一个sleep函数
 * @param duration sleep时间
 */
export async function sleep(duration: number): Promise<void> {
    return new Promise<void>((resolve) => CriticalTimers.setTimeout(resolve, duration));
}

/**
 * 检查当前环境是否支持 addTransceiver
 * @internal
 * */
export function supportsTransceiver() {
    return 'addTransceiver' in RTCPeerConnection.prototype;
}

/**
 * 检查当前环境是否支持 addTrack
 * @internal
 * */
export function supportsAddTrack() {
    return 'addTrack' in RTCPeerConnection.prototype;
}

/**
 * 检查当前环境是否支持自使用流
 */
export function supportsAdaptiveStream() {
    // ResizeObserver 是一个用于监听元素大小变化的接口，而 IntersectionObserver 是一个用于监听元素与视口交叉（intersection）情况的接口。
    // 这两个接口通常与自适应流一起使用，以便根据元素大小和可见性来选择适当的媒体流。
    return typeof ResizeObserver !== undefined && typeof IntersectionObserver !== undefined;
}

export function supportsDynacast() {
    return supportsTransceiver();
}

/**
 * 判断是否支持AV1
 */
export function supportsAV1(): boolean {
    if (!('getCapabilities' in RTCRtpSender)) {
        return false;
    }
    if (isSafari()) {
        // Safari 17 on iPhone14 reports AV1 capability, but does not actually support it
        return false;
    }
    const capabilities = RTCRtpSender.getCapabilities('video');
    let hasAV1 = false;
    if (capabilities) {
        for (const codec of capabilities.codecs) {
            if (codec.mimeType === 'video/AV1') {
                hasAV1 = true;
                break;
            }
        }
    }
    return hasAV1;
}

/**
 * 判断是否支持VP9
 */
export function supportsVP9(): boolean {
    if (!('getCapabilities' in RTCRtpSender)) {
        return false;
    }
    if (isFireFox()) {
        // technically speaking FireFox supports VP9, but SVC publishing is broken
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1633876
        return false;
    }
    if (isSafari()) {
        const browser = getBrowser();
        if (browser?.version && compareVersions(browser.version, '16') < 0) {
            // Safari 16 and below does not support VP9
            return false;
        }
    }
    const capabilities = RTCRtpSender.getCapabilities('video');
    let hasVP9 = false;
    if (capabilities) {
        for (const codec of capabilities.codecs) {
            if (codec.mimeType === 'video/VP9') {
                hasVP9 = true;
                break;
            }
        }
    }
    return hasVP9;
}

/**
 * 判断是否为SVC视频编码
 * @param codec 编码名称
 */
export function isSVCCodec(codec?: string): boolean {
    return codec === 'av1' || codec === 'vp9';
}

/**
 * 判断是否支持 SetSinkId，
 * setSinkId 是 WebRTC 中的一个方法，用于将音频流路由到特定的音频输出设备（如扬声器）
 * @param elm 媒体元素
 */
export function supportsSetSinkId(elm?: HTMLMediaElement): boolean {
    if (!document) {
        return false;
    }
    if (!elm) {
        elm = document.createElement('audio');
    }
    return 'setSinkId' in elm;
}

const setCodecPreferencesVersions: Record<DetectableBrowser, string> = {
    Chrome: '100',
    Safari: '15',
    Firefox: '100',
};

/**
 * 判断是否支持设置编码偏好
 * @param transceiver RTCRtp对象
 */
export function supportsSetCodecPreferences(transceiver: RTCRtpTransceiver): boolean {
    if (!isWeb()) {
        return false;
    }
    // 在 WebRTC 中，您可以使用 RTCRtpSender 对象的 setCodecPreferences 方法来设置编解码器的偏好
    if (!('setCodecPreferences' in transceiver)) {
        return false;
    }
    const browser = getBrowser();
    if (!browser?.name || !browser.version) {
        // version is required
        return false;
    }
    const v = setCodecPreferencesVersions[browser.name];
    if (v) {
        return compareVersions(browser.version, v) >= 0;
    }
    return false;
}

/**
 * 检测浏览器是否支持 WebRTC 的函数
 */
export function isBrowserSupported() {
    if (typeof RTCPeerConnection === 'undefined') {
        return false;
    }
    return supportsTransceiver() || supportsAddTrack();
}

/**
 * 判断是否为FireFox
 */
export function isFireFox(): boolean {
    return getBrowser()?.name === 'Firefox';
}

/**
 * 判断是否基于Chrome浏览器
 */
export function isChromiumBased(): boolean {
    return getBrowser()?.name === 'Chrome';
}

/**
 * 判断是否为Safari浏览器
 */
export function isSafari(): boolean {
    return getBrowser()?.name === 'Safari';
}

/**
 * 判断是否为Safari 17版本
 */
export function isSafari17(): boolean {
    const b = getBrowser();
    return b?.name === 'Safari' && b.version.startsWith('17.');
}

/**
 * 判断是不是手机
 */
export function isMobile(): boolean {
    if (!isWeb()) return false;
    return /Tablet|iPad|Mobile|Android|BlackBerry/.test(navigator.userAgent);
}

/**
 * 判断是不是web
 */
export function isWeb(): boolean {
    return typeof document !== 'undefined';
}

/**
 * 判断是不是ReactNative
 */
export function isReactNative(): boolean {
    // navigator.product is deprecated on browsers, but will be set appropriately for react-native.
    return navigator.product == 'ReactNative';
}

/**
 * 判断服务端是否为云
 * @param serverUrl 云URL
 */
export function isCloud(serverUrl: URL) {
    return (
        serverUrl.hostname.endsWith('.tc.cloud') || serverUrl.hostname.endsWith('.tc.run')
    );
}

/**
 * 获取ReactNative信息
 */
function getTCReactNativeInfo(): TCReactNativeInfo | undefined {
    // global defined only for ReactNative.
    // @ts-ignore
    if (global && global.TCReactNativeGlobal) {
        // @ts-ignore
        return global.TCReactNativeGlobal as TCReactNativeInfo;
    }

    return undefined;
}

/**
 * 获取ReactNative的平台OS
 */
export function getReactNativeOs(): string | undefined {
    if (!isReactNative()) {
        return undefined;
    }

    let info = getTCReactNativeInfo();
    if (info) {
        return info.platform;
    }

    return undefined;
}

/**
 * 获取设备的像素比
 */
export function getDevicePixelRatio(): number {
    if (isWeb()) {
        return window.devicePixelRatio;
    }

    if (isReactNative()) {
        let info = getTCReactNativeInfo();
        if (info) {
            return info.devicePixelRatio;
        }
    }

    return 1;
}

/**
 * 版本对比，如果版本相等返回0，
 * 如果v1>v2，返回1，否则返回-1
 * @param v1 版本v1
 * @param v2 版本v2
 */
export function compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.');
    const parts2 = v2.split('.');
    const k = Math.min(parts1.length, parts2.length);
    for (let i = 0; i < k; ++i) {
        const p1 = parseInt(parts1[i], 10);
        const p2 = parseInt(parts2[i], 10);
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
        if (i === k - 1 && p1 === p2) return 0;
    }
    if (v1 === '' && v2 !== '') {
        return -1;
    } else if (v2 === '') {
        return 1;
    }
    return parts1.length == parts2.length ? 0 : parts1.length < parts2.length ? -1 : 1;
}

/**
 * 处理调整大小的回调函数
 * @param entries
 */
function roDispatchCallback(entries: ResizeObserverEntry[]) {
    for (const entry of entries) {
        (entry.target as ObservableMediaElement).handleResize(entry);
    }
}

/**
 * 处理可见性回调
 * @param entries
 */
function ioDispatchCallback(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
        (entry.target as ObservableMediaElement).handleVisibilityChanged(entry);
    }
}

// 调整大小的观察者对象
let resizeObserver: ResizeObserver | null = null;

/**
 * 获取调整大小的观察者对象
 */
export const getResizeObserver = () => {
    if (!resizeObserver) {
        resizeObserver = new ResizeObserver(roDispatchCallback);
    }
    return resizeObserver;
}

// 调整可见性的观察者对象
let intersectionObserver: IntersectionObserver | null = null;

/**
 * 获取可见行对象
 */
export const getIntersectionObserver = () => {
    if (!intersectionObserver) {
        intersectionObserver = new IntersectionObserver(ioDispatchCallback, {
            root: null,
            rootMargin: '0px',
        });
    }
    return intersectionObserver;
};

/**
 * 定义观察媒体元素接口
 */
export interface ObservableMediaElement extends HTMLMediaElement {
    /**
     * 处理调整大小
     * @param entry 需要调整大小的Entry
     */
    handleResize: (entry: ResizeObserverEntry) => void;
    /**
     * 处理可见性
     * @param entry IntersectionObserverEntry 是一个接口，用于表示 IntersectionObserver 观察的目标元素与视口（或指定容器）的交叉信息
     */
    handleVisibilityChanged: (entry: IntersectionObserverEntry) => void;
}

/**
 * 获取客户端信息
 */
export function getClientInfo(): ClientInfo {
    const info = new ClientInfo({
        sdk: ClientInfo_SDK.JS,
        protocol: protocolVersion,
        version,
    });

    if (isReactNative()) {
        info.os = getReactNativeOs() ?? '';
    }

    return info;
}

// 空视频流音轨
let emptyVideoStreamTrack: MediaStreamTrack | undefined;

/**
 * 获取空的视频流
 */
export function getEmptyVideoStreamTrack() {
    if (!emptyVideoStreamTrack) {
        emptyVideoStreamTrack = createDummyVideoStreamTrack();
    }
    return emptyVideoStreamTrack?.clone();
}

/**
 * 创建亚元的视频流
 * @param width 宽
 * @param height 高
 * @param enabled 视频流是否enable
 * @param paintContent 是否绘制
 */
export function createDummyVideoStreamTrack(
    width: number = 16,
    height: number = 16,
    enabled: boolean = false,
    paintContent: boolean = false,
) {
    const canvas = document.createElement('canvas');
    // the canvas size is set to 16 by default, because electron apps seem to fail with smaller values
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx?.fillRect(0, 0, canvas.width, canvas.height);
    if (paintContent && ctx) {
        ctx.beginPath();
        ctx.arc(width / 2, height / 2, 50, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.fillStyle = 'grey';
        ctx.fill();
    }
    // @ts-ignore
    const dummyStream = canvas.captureStream();
    const [dummyTrack] = dummyStream.getTracks();
    if (!dummyTrack) {
        throw Error('Could not get empty media stream video track');
    }
    dummyTrack.enabled = enabled;

    return dummyTrack;
}

// 空音频流
let emptyAudioStreamTrack: MediaStreamTrack | undefined;

/**
 * 获取亚元音频
 */
export function getEmptyAudioStreamTrack() {
    if (!emptyAudioStreamTrack) {
        // implementation adapted from https://blog.mozilla.org/webrtc/warm-up-with-replacetrack/
        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, 0);
        const dst = ctx.createMediaStreamDestination();
        oscillator.connect(gain);
        gain.connect(dst);
        oscillator.start();
        [emptyAudioStreamTrack] = dst.stream.getAudioTracks();
        if (!emptyAudioStreamTrack) {
            throw Error('Could not get empty media stream audio track');
        }
        emptyAudioStreamTrack.enabled = false;
    }
    return emptyAudioStreamTrack.clone();
}

/**
 * 导出一个Future类
 */
export class Future<T> {
    promise: Promise<T>;

    resolve?: (arg: T) => void;

    reject?: (e: any) => void;

    onFinally?: () => void;

    constructor(futureBase?: (resolve: (arg: T) => void, reject: (e: any) => void) => void,
                onFinally?: () => void,
    ) {
        this.onFinally = onFinally;
        this.promise = new Promise<T>(async (resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
            if (futureBase) {
                await futureBase(resolve, reject);
            }
        }).finally(() => this.onFinally?.());
    }
}


/**
 * 音频分析选项
 */
export type AudioAnalyserOptions = {
    /**
     * 如果设置为 true，分析器将使用基础媒体流轨道的克隆版本，该版本不会受到轨道静音的影响。
     * 在实现“看起来你静音，但试图说话”之类的情况时，对于本地轨道很有用。
     * 默认为假
     */
    cloneTrack?: boolean;
    /**
     * fftSize 是用于设置 Fast Fourier Transform（快速傅里叶变换）的大小的属性。
     * 在音频处理和频谱分析中经常使用 FFT 来将时域信号转换为频域信号。
     * see https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/fftSize
     */
    fftSize?: number;
    /**
     * see https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/smoothingTimeConstant
     */
    smoothingTimeConstant?: number;
    /**
     * 最小分贝
     * see https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/minDecibels
     */
    minDecibels?: number;
    /**
     * 最大分贝
     * see https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/maxDecibels
     */
    maxDecibels?: number;
};

/**
 * 创建并返回附加到所提供轨道的分析器网络音频节点。
 * 另外返回一个便捷方法“calculateVolume”以在该轨道上执行即时音量读数。
 * 调用返回的“cleanup”函数来关闭为此助手实例创建的audioContext
 */
export function createAudioAnalyser(
    track: LocalAudioTrack | RemoteAudioTrack,
    options?: AudioAnalyserOptions,
) {
    const opts = {
        cloneTrack: false,
        fftSize: 2048,
        smoothingTimeConstant: 0.8,
        minDecibels: -100,
        maxDecibels: -80,
        ...options,
    };
    const audioContext = getNewAudioContext();

    if (!audioContext) {
        throw new Error('Audio Context not supported on this browser');
    }
    const streamTrack = opts.cloneTrack ? track.mediaStreamTrack.clone() : track.mediaStreamTrack;
    const mediaStreamSource = audioContext.createMediaStreamSource(new MediaStream([streamTrack]));
    const analyser = audioContext.createAnalyser();
    analyser.minDecibels = opts.minDecibels;
    analyser.maxDecibels = opts.maxDecibels;
    analyser.fftSize = opts.fftSize;
    analyser.smoothingTimeConstant = opts.smoothingTimeConstant;

    mediaStreamSource.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    // 计算曲目的当前音量，范围为0到1
    const calculateVolume = () => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (const amplitude of dataArray) {
            sum += Math.pow(amplitude / 255, 2);
        }
        const volume = Math.sqrt(sum / dataArray.length);
        return volume;
    };

    const cleanup = async () => {
        await audioContext.close();
        if (opts.cloneTrack) {
            streamTrack.stop();
        }
    };

    return {calculateVolume, analyser, cleanup};
}

export class Mutex {
    private _locking: Promise<void>;

    private _locks: number;

    constructor() {
        this._locking = Promise.resolve();
        this._locks = 0;
    }

    isLocked() {
        return this._locks > 0;
    }

    lock() {
        this._locks += 1;

        let unlockNext: () => void;

        const willLock = new Promise<void>(
            (resolve) =>
                (unlockNext = () => {
                    this._locks -= 1;
                    resolve();
                }),
        );

        const willUnlock = this._locking.then(() => unlockNext);

        this._locking = this._locking.then(() => willLock);

        return willUnlock;
    }
}

/**
 * 判断是否为video codec编码
 * @param maybeCodec 编码值
 */
export function isVideoCodec(maybeCodec: string): maybeCodec is VideoCodec {
    return videoCodecs.includes(maybeCodec as VideoCodec);
}

/**
 * 展开约束
 * @param constraint 约束串
 */
export function unwrapConstraint(constraint: ConstrainDOMString): string {
    if (typeof constraint === 'string') {
        return constraint;
    }

    if (Array.isArray(constraint)) {
        return constraint[0];
    }
    if (constraint.exact) {
        if (Array.isArray(constraint.exact)) {
            return constraint.exact[0];
        }
        return constraint.exact;
    }
    if (constraint.ideal) {
        if (Array.isArray(constraint.ideal)) {
            return constraint.ideal[0];
        }
        return constraint.ideal;
    }
    throw Error('could not unwrap constraint');
}

/**
 * 转换为websocket url
 * @param url url
 */
export function toWebsocketUrl(url: string): string {
    if (url.startsWith('http')) {
        return url.replace(/^(http)/, 'ws');
    }
    return url;
}

/**
 * 转换为http url
 * @param url websocket url
 */
export function toHttpUrl(url: string): string {
    if (url.startsWith('ws')) {
        return url.replace(/^(ws)/, 'http');
    }
    return url;
}
