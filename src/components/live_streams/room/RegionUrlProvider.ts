/**
 * 区域URL提供者
 */
import {RegionInfo, RegionSettings} from "../protocol/tc_rtc_pb";
import {isCloud} from "./utils";
import log from '../logger';
import {ConnectionError, ConnectionErrorReason} from "./errors";

export class RegionUrlProvider {
    /**
     * server url
     */
    private serverUrl: URL;

    /**
     * token
     */
    private token: string;

    /**
     * 区域设置
     */
    private regionSettings: RegionSettings | undefined;

    /**
     * 最后更新时间
     */
    private lastUpdateAt: number = 0;

    /**
     * 设置的缓存时间
     */
    private settingsCacheTime = 3_000;

    /**
     * 尝试地区
     */
    private attemptedRegions: RegionInfo[] = [];

    constructor(url: string, token: string) {
        this.serverUrl = new URL(url);
        this.token = token;
    }

    /**
     * 更新Token
     * @param token token值
     */
    updateToken(token: string) {
        this.token = token;
    }

    /**
     * 判断是否为云服务
     */
    isCloud() {
        return isCloud(this.serverUrl);
    }

    /**
     * 获取服务端地址
     */
    getServerUrl() {
        return this.serverUrl;
    }

    /**
     * 获取下一个最好的区域Url
     * @param abortSignal 中断信号
     */
    async getNextBestRegionUrl(abortSignal?: AbortSignal) {
        if (!this.isCloud()) {
            throw Error('region availability is only supported for TCApp Cloud domains');
        }
        if (!this.regionSettings || Date.now() - this.lastUpdateAt > this.settingsCacheTime) {
            this.regionSettings = await this.fetchRegionSettings(abortSignal);
        }
        const regionsLeft = this.regionSettings?.regions.filter(
            (region) => !this.attemptedRegions.find((attempted) => attempted.url === region.url),
        );
        if (regionsLeft.length > 0) {
            const nextRegion = regionsLeft[0];
            this.attemptedRegions.push(nextRegion);
            log.debug(`next region: ${nextRegion.region}`);
            return nextRegion.url;
        }
        return null;
    }

    /**
     * 重置尝试区域
     */
    resetAttempts() {
        this.attemptedRegions = [];
    }

    /* @internal */
    async fetchRegionSettings(signal?: AbortSignal | null) {
        const regionSettingsResponse = await fetch(`${getCloudConfigUrl(this.serverUrl)}/regions`, {
            headers: {authorization: `Bearer ${this.token}`},
            signal: signal,
        });
        if (regionSettingsResponse.ok) {
            const regionSettings = (await regionSettingsResponse.json()) as RegionSettings;
            this.lastUpdateAt = Date.now();
            return regionSettings;
        } else {
            throw new ConnectionError(
                `Could not fetch region settings: ${regionSettingsResponse.statusText}`,
                regionSettingsResponse.status === 401 ? ConnectionErrorReason.NotAllowed : undefined,
                regionSettingsResponse.status,
            );
        }
    }
}

function getCloudConfigUrl(serverUrl: URL) {
    return `${serverUrl.protocol.replace('ws', 'http')}//${serverUrl.host}/settings`;
}