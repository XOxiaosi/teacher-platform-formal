import { ok } from '@teacher-platform/contracts';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';
import { channelMessageRowToInbound } from './agent-loop.js';
import type {
  ChannelIdentityService,
  ChannelMessageService,
  QueuePort,
  WechatUnboundRecoveryScanner,
} from './types.js';

/**
 * S3 未绑定恢复扫描（P8 t16，设计 p7-wechat-ilink-design.md §4.2/S3）。
 *
 * 入站消息在发送时未绑定 → status='new' 挂起；教师随后扫码绑定后，扫描器发现
 * ChannelIdentity 已解析 → markQueued + 重新入队（processMessage 幂等键防重复）；
 * 超过 maxPendingMs（默认 24h）仍未绑定 → 置 failed（防僵尸挂起堆积）。
 */

export interface CreateWechatUnboundRecoveryScannerOptions {
  channelMessageService: ChannelMessageService;
  identityService: ChannelIdentityService;
  queue: QueuePort;
  clock: TrustedClock;
  /** 扫描间隔（ms，默认 5 分钟）。 */
  intervalMs?: number;
  /** 未绑定最长挂起（ms，默认 24h）。 */
  maxPendingMs?: number;
}

export function createWechatUnboundRecoveryScanner(
  options: CreateWechatUnboundRecoveryScannerOptions,
): WechatUnboundRecoveryScanner {
  const intervalMs = options.intervalMs ?? 5 * 60 * 1000;
  const maxPendingMs = options.maxPendingMs ?? 24 * 60 * 60 * 1000;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function scanOnce() {
    const pending = await options.channelMessageService.listPending();
    if (!pending.ok) return pending;

    let recovered = 0;
    let failedStale = 0;
    for (const row of pending.value) {
      const binding = await options.identityService.resolveChannelBinding({
        platform: row.channel,
        externalUserId: row.fromExternalUserId,
      });
      if (!binding.ok) continue;

      if (binding.value) {
        // 绑定已补充 → 重试入队（Agent 闭环幂等键防重复执行）
        const queued = await options.channelMessageService.markQueued(row.id);
        if (!queued.ok) continue;
        const enqueued = await options.queue.enqueue(channelMessageRowToInbound(row));
        if (!enqueued.ok) {
          await options.channelMessageService.markFailed(row.id, { errorMsg: enqueued.error.message });
          failedStale += 1;
          continue;
        }
        recovered += 1;
        continue;
      }

      // 仍未绑定：超时置 failed，否则保持挂起（等下次扫描）
      const now = await options.clock.now();
      if (!now.ok) continue;
      if (row.createdAtTs.getTime() + maxPendingMs <= now.value.getTime()) {
        const failed = await options.channelMessageService.markFailed(row.id, { errorMsg: '未绑定超时' });
        if (failed.ok) failedStale += 1;
      }
    }
    return ok({ recovered, failedStale });
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void scanOnce().catch(() => undefined);
      }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    scanOnce,
  };
}
