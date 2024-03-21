/**
 * 模拟选项
 */
export type SimulationOptions = {
    publish?: {
        audio?: boolean;
        video?: boolean;
        useRealTracks?: boolean;
    };
    participants?: {
        count?: number;
        /**
         * 长宽比
         */
        aspectRatios?: Array<number>;
        audio?: boolean;
        video?: boolean;
    };
};

/**
 * 数据发送选项
 */
export type DataPublishOptions = {
    /**
     * 是否将其作为可靠的或有损的发送。
     * 对于需要传递保证的数据（例如聊天消息），请使用 Reliable。
     * 对于应该尽快到达的数据，但你可以接受丢弃
     * 数据包，使用有损。
     */
    reliable?: boolean;
    /**
     * 接收消息的参与者身份，如果为空，将发送给每一位参与者
     */
    destinationIdentities?: string[];
    /** 发布消息的主题 */
    topic?: string;
};

/**
 * ReactNative信息
 */
export type TCReactNativeInfo = {
    // Corresponds to RN's PlatformOSType
    platform: 'ios' | 'android' | 'windows' | 'macos' | 'web' | 'native';
    /**
     * 设备像素比
     */
    devicePixelRatio: number;
};

/**
 * 模拟场景
 */
export type SimulationScenario =
    | 'signal-reconnect'
    | 'speaker'
    | 'node-failure'
    | 'server-leave'
    | 'migration'
    | 'resume-reconnect'
    | 'force-tcp'
    | 'force-tls'
    | 'full-reconnect'
    // overrides server-side bandwidth estimator with set bandwidth
    // this can be used to test application behavior when congested or
    // to disable congestion control entirely (by setting bandwidth to 100Mbps)
    | 'subscriber-bandwidth'
    | 'disconnect-signal-on-resume'
    | 'disconnect-signal-on-resume-no-messages';

/**
 * 日志选项
 */
export type LoggerOptions = {
    loggerName?: string;
    loggerContextCb?: () => Record<string, unknown>;
};