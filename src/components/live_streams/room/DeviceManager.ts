import log from '../logger';
import {isSafari} from "./utils";

/**
 * 默认设置ID
 */
const defaultId = 'default';

/**
 * 设置管理，通过单例模式实现
 */
export default class DeviceManager {
    /**
     *  私有实例
     */
    private static instance?: DeviceManager;

    static getInstance(): DeviceManager {
        if (this.instance === undefined) {
            this.instance = new DeviceManager();
        }
        return this.instance;
    }

    /**
     * 用户媒体map<device类型，媒体流>
     */
    static userMediaPromiseMap: Map<MediaDeviceKind, Promise<MediaStream>> = new Map();

    /**
     * 获取设置
     * @param kind 设置类型
     * @param requestPermission 请求权限
     */
    async getDevices(
        kind?: MediaDeviceKind,
        requestPermission: boolean = true,
    ): Promise<MediaDeviceInfo[]> {
        if (DeviceManager.userMediaPromiseMap?.size > 0) {
            log.debug('awaiting getUserMedia promise');
            try {
                if (kind) {
                    await DeviceManager.userMediaPromiseMap.get(kind);
                } else {
                    await Promise.all(DeviceManager.userMediaPromiseMap.values());
                }
            } catch (e: any) {
                log.warn('error waiting for media permissions');
            }
        }
        let devices = await navigator.mediaDevices.enumerateDevices();

        if (
            requestPermission &&
            // 对于 safari，我们需要跳过此检查，否则它将重新获取用户媒体并在 iOS 上失败 https://bugs.webkit.org/show_bug.cgi?id=179363
            !(isSafari() && this.hasDeviceInUse(kind))
        ) {
            const isDummyDeviceOrEmpty =
                devices.length === 0 ||
                devices.some((device) => {
                    const noLabel = device.label === '';
                    const isRelevant = kind ? device.kind === kind : true;
                    return noLabel && isRelevant;
                });

            if (isDummyDeviceOrEmpty) {
                const permissionsToAcquire = {
                    video: kind !== 'audioinput' && kind !== 'audiooutput',
                    audio: kind !== 'videoinput',
                };
                const stream = await navigator.mediaDevices.getUserMedia(permissionsToAcquire);
                devices = await navigator.mediaDevices.enumerateDevices();
                stream.getTracks().forEach((track) => {
                    track.stop();
                });
            }
        }
        if (kind) {
            devices = devices.filter((device) => device.kind === kind);
        }

        return devices;
    }

    /**
     * 规范化设备ID
     * @param kind 媒体设置类型
     * @param deviceId 设置Id
     * @param groupId 组id
     */
    async normalizeDeviceId(
        kind: MediaDeviceKind,
        deviceId?: string,
        groupId?: string,
    ): Promise<string | undefined> {
        if (deviceId !== defaultId) {
            return deviceId;
        }

        // 如果它是“默认”，则解析实际设备 ID：如果不是，则 Chrome 返回它
        // 设备已被选择
        const devices = await this.getDevices(kind);

        // `default` 设备将与具有实际设备 ID 的条目具有相同的 groupId，因此我们存储每个组 ID 的计数
        const groupIdCounts = new Map(devices.map((d) => [d.groupId, 0]));

        devices.forEach((d) => groupIdCounts.set(d.groupId, (groupIdCounts.get(d.groupId) ?? 0) + 1));

        const device = devices.find(
            (d) =>
                (groupId === d.groupId || (groupIdCounts.get(d.groupId) ?? 0) > 1) &&
                d.deviceId !== defaultId,
        );

        return device?.deviceId;
    }

    /**
     * 判断是否存在kind类型的设置
     * @param kind 媒体设置类型
     */
    private hasDeviceInUse(kind?: MediaDeviceKind): boolean {
        return kind
            ? DeviceManager.userMediaPromiseMap.has(kind)
            : DeviceManager.userMediaPromiseMap.size > 0;
    }

}