/**
 * 自定义Error类型
 */
export class TcError extends Error {
    /**
     * 错误码
     */
    code: number;

    constructor(code: number, message?: string) {
        super(message || 'an error has occurred');
        this.code = code;
    }
}

export const enum ConnectionErrorReason {
    NotAllowed,
    ServerUnreachable,
    InternalError,
    Cancelled,
    LeaveRequest,
}

export class ConnectionError extends TcError {
    /**
     * 状态
     */
    status?: number;

    /**
     * 连接失败原因
     */
    reason?: ConnectionErrorReason;

    constructor(message?: string, reason?: ConnectionErrorReason, status?: number) {
        super(1, message);
        this.status = status;
        this.reason = reason;
    }
}

/**
 * 设置不支持错误
 */
export class DeviceUnsupportedError extends TcError {
    constructor(message?: string) {
        super(21, message ?? 'device is unsupported');
    }
}

/**
 * 轨道无效错误
 */
export class TrackInvalidError extends TcError {
    constructor(message?: string) {
        super(20, message ?? 'track is invalid');
    }
}

/**
 * 不支持的server
 */
export class UnsupportedServer extends TcError {
    constructor(message?: string) {
        super(10, message ?? 'unsupported server');
    }
}

/**
 * 非预期连接状态
 */
export class UnexpectedConnectionState extends TcError {
    constructor(message?: string) {
        super(12, message ?? 'unexpected connection state');
    }
}


export class NegotiationError extends TcError {
    constructor(message?: string) {
        super(13, message ?? 'unable to negotiate');
    }
}

export class PublishDataError extends TcError {
    constructor(message?: string) {
        super(13, message ?? 'unable to publish data');
    }
}

export enum MediaDeviceFailure {
    // user rejected permissions
    PermissionDenied = 'PermissionDenied',
    // device is not available
    NotFound = 'NotFound',
    // device is in use. On Windows, only a single tab may get access to a device at a time.
    DeviceInUse = 'DeviceInUse',
    Other = 'Other',
}

export namespace MediaDeviceFailure {
    export function getFailure(error: any): MediaDeviceFailure | undefined {
        if (error && 'name' in error) {
            if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                return MediaDeviceFailure.NotFound;
            }
            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                return MediaDeviceFailure.PermissionDenied;
            }
            if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
                return MediaDeviceFailure.DeviceInUse;
            }
            return MediaDeviceFailure.Other;
        }
    }
}
