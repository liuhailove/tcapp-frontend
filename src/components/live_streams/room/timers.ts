/**
 * 可以使用特定于平台的实现覆盖定时器，以确保它们被触发。
 * 当定时器按时触发至关重要时应该使用这些。
 */
export default class CriticalTimers {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    static setTimeout = (...args: Parameters<typeof setTimeout>) => {
        if (args.length < 2) {
            return;
        }
        setTimeout(args[0], args[1]);
    };

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    static setInterval = (...args: Parameters<typeof setInterval>) => {
        if (args.length < 2) {
            return;
        }
        setInterval(args[0], args[1]);
    };

    static clearTimeout = (...args: Parameters<typeof clearTimeout>) => {
        if (args.length < 1) {
            return;
        }
        clearTimeout(args[0]);
    };

    static clearInterval = (...args: Parameters<typeof clearInterval>) => {
        if (args.length < 1) {
            return;
        }
        clearInterval(args[0]);
    };
}
