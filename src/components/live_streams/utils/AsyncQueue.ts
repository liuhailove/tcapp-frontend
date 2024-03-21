// 定义任务队列
import {Mutex} from "../room/utils";

type QueueTask<T> = () => PromiseLike<T>;

// 队列任务状态
enum QueueTaskStatus {
    'WAITING',
    'RUNNING',
    'COMPLETED',
}

// 任务信息
type QueueTaskInfo = {
    /**
     * id
     */
    id: number;
    /**
     * 入队时间
     */
    enqueuedAt: number;
    /**
     * 执行时间
     */
    executedAt?: number;
    /**
     * 任务状态
     */
    status: QueueTaskStatus;
};

// 异步队列
export class AsyncQueue {
    // 待处理任务
    private pendingTasks: Map<number, QueueTaskInfo>;
    // 锁
    private taskMutex: Mutex;
    // 下一个任务的索引
    private nextTaskIndex: number;

    constructor() {
        this.pendingTasks = new Map();
        this.taskMutex = new Mutex();
        this.nextTaskIndex = 0;
    }

    /**
     * 运行任务
     * @param task 任务信息
     */
    async run<T>(task: QueueTask<T>) {
        const taskInfo: QueueTaskInfo = {
            id: this.nextTaskIndex++,
            enqueuedAt: Date.now(),
            status: QueueTaskStatus.WAITING,
        };
        this.pendingTasks.set(taskInfo.id, taskInfo);
        const unlock = await this.taskMutex.lock();
        try {
            taskInfo.executedAt = Date.now();
            taskInfo.status = QueueTaskStatus.RUNNING;
            return await task();
        } finally {
            taskInfo.status = QueueTaskStatus.COMPLETED;
            this.pendingTasks.delete(taskInfo.id);
            unlock();
        }
    }

    async flush() {
        return this.run(async () => {
        });
    }

    /**
     * 等待执行任务备份
     */
    snapshot() {
        return Array.from(this.pendingTasks.values());
    }

}