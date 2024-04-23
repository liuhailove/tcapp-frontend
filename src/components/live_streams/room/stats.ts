/**
 * 监控频率
 */
export const monitorFrequency = 2000;

// 发送者和接收者的关键统计信息
interface SenderStats {
    /** 发送的数据包数量 */
    packetsSent?: number;

    /** 发送的字节数 */
    bytesSent?: number;

    /** 远程感知的抖动 */
    jitter?: number;

    /** 远程报告丢失的数据包 */
    packetsLost?: number;

    /** 远程报告RTT */
    roundTripTime?: number;

    /** 出站流ID */
    streamId?: string;

    /**
     * 时间戳
     */
    timestamp: number;
}

/**
 * 音频发送统计
 */
export interface AudioSenderStats extends SenderStats {
    type: 'audio';
}

/**
 * 视频发送统计
 */
export interface VideoSenderStats extends SenderStats {
    type: 'video';

    /**
     * 用于计数 FIR（Full Intra Request）消息的变量
     */
    firCount: number;

    /**
     * 用于计数 PLI（Picture Loss Indication）消息的变量
     */
    pliCount: number;

    /**
     * 用于计数 NACK（Negative Acknowledgement）消息的变量
     */
    nackCount: number;

    rid: string;

    frameWidth: number;

    frameHeight: number;

    framesPerSecond: number;

    /**
     * 发送的祯
     */
    framesSent: number;

    // bandwidth, cpu, other, none
    qualityLimitationReason?: string;

    qualityLimitationDurations?: Record<string, number>;

    /**
     * 质量限制分辨率更改
     */
    qualityLimitationResolutionChanges?: number;

    /**
     * 重新发送的数据包
     */
    retransmittedPacketsSent?: number;

    targetBitrate: number;
}

/**
 * 接收统计
 */
interface ReceiverStats {
    jitterBufferDelay?: number;

    /** 远程报告丢失的数据包 */
    packetsLost?: number;

    /** 发送的数据包数量 */
    packetsReceived?: number;

    /**
     * 收到的字节数
     */
    bytesReceived?: number;

    /**
     * 流ID
     */
    streamId?: string;
    /**
     * 抖动数
     */
    jitter?: number;
    /**
     * 时间戳
     */
    timestamp: number;
}

/**
 * 音频接收统计
 */
export interface AudioReceiverStats extends ReceiverStats {
    type: 'audio';
    /**
     * 隐藏样本
     */
    concealedSamples?: number;
    /**
     * 隐藏事件
     */
    concealmentEvents?: number;
    /**
     * 静音隐藏样本
     */
    silentConcealedSamples?: number;
    /**
     * 静音取消事件
     */
    silentConcealmentEvents?: number;

    totalAudioEnergy?: number;
    /**
     * 总样本持续时间
     */
    totalSamplesDuration?: number;
}

/**
 * 视频接收器统计
 */
export interface VideoReceiverStats extends ReceiverStats {
    type: 'video';

    /**
     * 解码帧数量
     */
    framesDecoded: number;

    /**
     * 丢失的祯数量
     */
    framesDropped: number;

    /**
     * 接收的祯数
     */
    framesReceived: number;

    /**
     * 祯宽
     */
    frameWidth?: number;

    /**
     * 祯高
     */
    frameHeight?: number;

    firCount?: number;

    pliCount?: number;

    nackCount?: number;

    /**
     * 解码实现
     */
    decoderImplementation?: string;

    mimeType?: string;
}

/**
 * 计算比特率
 * @param currentStats 当前统计
 * @param prevStats 上一次统计
 */
export function computeBitrate<T extends ReceiverStats | SenderStats>(
    currentStats: T,
    prevStats?: T,
): number {
    if (!prevStats) {
        return 0;
    }
    let bytesNow: number | undefined;
    let bytesPrev: number | undefined;
    if ('bytesReceived' in currentStats) {
        bytesNow = (currentStats as ReceiverStats).bytesReceived;
        bytesPrev = (prevStats as ReceiverStats).bytesReceived;
    } else if ('bytesSent' in currentStats) {
        bytesNow = (currentStats as SenderStats).bytesSent;
        bytesPrev = (prevStats as SenderStats).bytesSent;
    }
    if (
        bytesNow === undefined ||
        bytesPrev === undefined ||
        currentStats.timestamp === undefined ||
        prevStats.timestamp === undefined
    ) {
        return 0;
    }
    return ((bytesNow - bytesPrev) * 8 * 1000) / (currentStats.timestamp - prevStats.timestamp);
}
