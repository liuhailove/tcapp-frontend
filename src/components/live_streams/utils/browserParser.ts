// tiny, simplified version of https://github.com/lancedikson/bowser/blob/master/src/parser-browsers.js
// reduced to only differentiate Chrome(ium) based browsers / Firefox / Safari

/**
 * 常规版本标识
 */
const commonVersionIdentifier = /version\/(\d+(\.?_?\d+)+)/i;

/**
 * 检查的浏览器类型
 */
export type DetectableBrowser = 'Chrome' | 'Firefox' | 'Safari';

/**
 * 可以检测的操作系统
 */
export type DetectableOS = 'iOS' | 'macOS';

/**
 * 浏览器明细
 */
export type BrowserDetails = {
    /**
     * 浏览器名称
     */
    name: DetectableBrowser;
    /**
     * 版本
     */
    version: string;
    /**
     * os
     */
    os?: DetectableOS;
};

/**
 * 浏览器明细
 */
let browserDetails: BrowserDetails | undefined;

/**
 * 获取浏览器
 * @internal
 */
export function getBrowser(userAgent?: string, force = true) {
    if (typeof userAgent === 'undefined' && typeof navigator === 'undefined') {
        return;
    }
    const ua = (userAgent ?? navigator.userAgent).toLowerCase();
    if (browserDetails === undefined || force) {
        const browser = browsersList.find(({test}) => test.test(ua));
        browserDetails = browser?.describe(ua);
    }
    return browserDetails;
}

/**
 * 浏览器数组
 */
const browsersList = [
    {
        test: /firefox|iceweasel|fxios/i,
        describe(ua: string) {
            const browser: BrowserDetails = {
                name: 'Firefox',
                version: getMatch(/(?:firefox|iceweasel|fxios)[\s/](\d+(\.?_?\d+)+)/i, ua),
                os: ua.toLowerCase().includes('fxios') ? 'iOS' : undefined,
            };
            return browser;
        },
    },
    {
        test: /chrom|crios|crmo/i,
        describe(ua: string) {
            const browser: BrowserDetails = {
                name: 'Chrome',
                version: getMatch(/(?:chrome|chromium|crios|crmo)\/(\d+(\.?_?\d+)+)/i, ua),
                os: ua.toLowerCase().includes('crios') ? 'iOS' : undefined,
            };

            return browser;
        },
    },
    /* Safari */
    {
        test: /safari|applewebkit/i,
        describe(ua: string) {
            const browser: BrowserDetails = {
                name: 'Safari',
                version: getMatch(commonVersionIdentifier, ua),
                os: ua.includes('mobile/') ? 'iOS' : 'macOS',
            };

            return browser;
        },
    },
];

function getMatch(exp: RegExp, ua: string, id = 1) {
    const match = ua.match(exp);
    return (match && match.length >= id && match[id]) || '';
}
