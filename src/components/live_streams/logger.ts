import * as log from 'loglevel';

/**
 * 日志级别
 */
export enum LogLevel {
    trace = 0,
    debug = 1,
    info = 2,
    warn = 3,
    error = 4,
    silent = 5,
}

/**
 * 日志名称
 */
export enum LoggerNames {
    Default = 'tc',
    Room = 'tc-room',
    Participant = 'tc-participant',
    Track = 'tc-track',
    Publication = 'tc-track-publication',
    Engine = 'tc-engine',
    Signal = 'tc-signal',
    PCManager = 'tc-pc-manager',
    PCTransport = 'tc-pc-transport',
    E2EE = 'tc-e2ee',
}

/**
 * 日志级别String，获取一个类型的所有属性名称
 */
type LogLevelString = keyof typeof LogLevel;

/**
 * 创建一个新类型 StructureLogger，这个类型包含log.Logger及
 * 其扩展的方法trace、debug、info、warn、error、setDefaultLevel、
 * setLevel、getLevel
 */
export type StructuredLogger = log.Logger & {
    trace: (msg: string, context?: object) => void;
    debug: (msg: string, context?: object) => void;
    info: (msg: string, context?: object) => void;
    warn: (msg: string, context?: object) => void;
    error: (msg: string, context?: object) => void;
    setDefaultLevel: (level: log.LogLevelDesc) => void;
    setLevel: (level: log.LogLevelDesc) => void;
    getLevel: () => number;
};

/**
 * 获取一个tcLogger对象
 */
let tcLogger = log.getLogger('tc');

/**
 * 根据LoggerNames创建Logger对象数组
 */
const tcLoggers = Object.values(LoggerNames).map((name) => log.getLogger(name));

/**
 * 设置tcLogger对象的默认日志级别
 */
tcLogger.setDefaultLevel(LogLevel.info);

/**
 * 把tcLogger断言为StructureLogger类型，并作为默认导出
 */
export default tcLogger as StructuredLogger;

/**
 * 根据名称构建logger对象
 * @internal
 */
export function getLogger(name: string) {
    const logger = log.getLogger(name);
    logger.setDefaultLevel(tcLogger.getLevel());
    return logger as StructuredLogger;
}

/**
 * 设置对应日志对应的日志级别
 * @param level 日志级别
 * @param loggerName 日志名称
 */
export function setLogLevel(level: LogLevel | LogLevelString, loggerName?: LoggerNames) {
    if (loggerName) {
        log.getLogger(loggerName).setLevel(level);
    }
    for (const logger of tcLoggers) {
        logger.setLevel(level);
    }
}

/**
 * 声明一个LogExtension函数类型
 */
export type LogExtension = (level: LogLevel, msg: string, context?: object) => void;

/**
 * 使用它来连接日志记录功能，以允许将内部 TcApp 日志发送到第三方服务
 * 如果设置，浏览器日志将丢失其堆栈跟踪信息（请参阅 https://github.com/pimterry/loglevel#writing-plugins）
 */
export function setLogExtension(extension: LogExtension, logger?: StructuredLogger) {
    const loggers = logger ? [logger] : tcLoggers;

    loggers.forEach((logR) => {
        const originalFactory = logR.methodFactory;

        logR.methodFactory = (methodName, configLevel, loggerName) => {
            const rawMethod = originalFactory(methodName, configLevel, loggerName);

            const logLevel = LogLevel[methodName as LogLevelString];
            const needLog = logLevel >= configLevel && logLevel < LogLevel.silent;

            return (msg, context?: [msg: string, context: object]) => {
                if (context) {
                    rawMethod(msg, context);
                } else {
                    rawMethod(msg);
                }
                if (needLog) {
                    extension(logLevel, msg, context);
                }
            }
        };
        logR.setLevel(logR.getLevel());
    });
}

/**
 * 定义workerLogger常量
 */
export const workerLogger = log.getLogger('tc-e2ee') as StructuredLogger;