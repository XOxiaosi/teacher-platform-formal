import { err, internalError, ok } from '@teacher-platform/contracts';
import type { NormalizedInboundMessage, QueuePort } from './types.js';

/**
 * 进程内内存消息队列（P8 t13，设计 p7-wechat-ilink-design.md §4.2）。
 *
 * - 阶段一单进程零依赖实现（与 logger/rate-limit/shutdown 同风格）；
 * - 有界队列：满则拒绝入队（返回错误，webhook 侧 5s 内 200 由调用方保证）；
 * - 单消费者串行（每用户并发 1 的 S2 基础）；stop() 排空在途任务；
 * - QueuePort 接口预留 Redis Streams / RabbitMQ 迁移（业务零改动）；
 * - 持久兜底：ChannelMessage 表（pending/processing 状态 + 启动恢复扫描，S3 实现）。
 */

export interface CreateInMemoryQueueOptions {
  maxSize?: number;
}

export function createInMemoryMessageQueue(options: CreateInMemoryQueueOptions = {}): QueuePort {
  const maxSize = options.maxSize ?? 1000;
  const pending: NormalizedInboundMessage[] = [];
  let worker: ((msg: NormalizedInboundMessage) => Promise<void>) | null = null;
  let running = false;
  let stopped = false;
  let draining: Promise<void> | null = null;

  async function drain(): Promise<void> {
    while (pending.length > 0 && !stopped) {
      const msg = pending.shift();
      if (!msg) break;
      if (worker) {
        try {
          await worker(msg);
        } catch {
          // worker 失败不阻塞队列：消息状态已由 worker 内落库（failed），此处仅防队列卡死
        }
      }
    }
  }

  function scheduleDrain(): void {
    if (draining || stopped || !running || !worker) return;
    draining = drain().finally(() => {
      draining = null;
      if (pending.length > 0) scheduleDrain();
    });
  }

  return {
    async enqueue(msg) {
      if (stopped) return err(internalError('消息队列已停止'));
      if (pending.length >= maxSize) {
        return err(internalError('消息队列已满，请稍后重试'));
      }
      pending.push(msg);
      scheduleDrain(); // 非阻塞启动单一消费者（webhook 5s 硬约束）
      return ok({ queued: true });
    },

    async start(handler) {
      if (running) return;
      worker = handler;
      running = true;
      scheduleDrain();
    },

    async stop() {
      stopped = true;
      running = false;
      await draining;
    },

    size() {
      return pending.length;
    },
  };
}
