/**
 * 可以使用特定于平台的实现覆盖定时器，以确保它们被触发。
 * 当定时器按时触发至关重要时应该使用这些。
 */
export default class CriticalTimers {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    static setTimeout = (...args: Parameters<typeof setTimeout>) => setTimeout(...args);

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    static setInterval = (...args: Parameters<typeof setInterval>) => setInterval(...args);

    static clearTimeout = (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args);

    static clearInterval = (...args: Parameters<typeof clearInterval>) => clearInterval(...args);
}
