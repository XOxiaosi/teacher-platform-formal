import type { Server } from 'node:http';
import type { Logger } from '../logger/index.js';

/**
 * 优雅退出协调器（P7 G3，T8b 设计 §4.1）。
 *
 * 流程：SIGTERM/SIGINT → server.close()（停新请求、在途排空）→ 注册的清理钩子
 * （连接池 closeAll → 共享库 $disconnect）→ exit 0；钩子抛错或超时（forceExitMs）
 * → exit 1（让守护进程按异常重启）。
 *
 * - 钩子按注册顺序执行（首个应为 server.close，先停流量再断资源）；
 * - 幂等：shutdown 进行中再次触发直接返回（信号重复/并发安全）；
 * - 池内部自注册的 exit/SIGINT/SIGTERM 钩子（S1 产物）作二级兜底，与本协调器
 *   显式调用 closeAll 幂等共存（设计 §4.1 第 3 点：统一入口 + 池钩子兜底）。
 */

export interface ShutdownOptions {
  /** 优雅退出兜底超时（毫秒），默认 10_000 */
  forceExitMs?: number;
  /** 结构化日志（可选；缺省静默） */
  logger?: Logger;
  /** 退出函数（测试注入 mock；缺省 process.exit） */
  exit?: (code: number) => void;
}

export interface ShutdownCoordinator {
  /** 注册清理钩子（按注册顺序执行；首个应为 server.close） */
  register(hook: () => Promise<void>): void;
  /** 执行优雅退出：按序跑钩子 → exit 0；钩子失败或超时 → exit 1 */
  shutdown(reason: string): Promise<void>;
}

/** 读取 SHUTDOWN_TIMEOUT_MS env（默认 10_000；非法/非正数回退默认）——测试用 env 缩短兜底窗口。 */
export function parseShutdownTimeoutMs(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
}

/** 关闭 HTTP server：停止接收新连接，等待在途请求排空（Node close 回调 Promise 化）。 */
export function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolveClose();
    });
  });
}

export function createShutdownCoordinator(options: ShutdownOptions = {}): ShutdownCoordinator {
  const forceExitMs = options.forceExitMs ?? 10_000;
  const logger = options.logger;
  const exitFn = options.exit ?? ((code: number) => process.exit(code));
  const hooks: Array<() => Promise<void>> = [];
  let shuttingDown = false;

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger?.info('shutdown started', { reason });

    const forceTimer = setTimeout(() => {
      logger?.error('shutdown timed out, force exit', { reason, forceExitMs });
      exitFn(1);
    }, forceExitMs);
    // 注意：forceTimer 不能 unref —— 若钩子挂起且不持有事件循环句柄
    // （如永不 settle 的 Promise），unref 会让进程自然退出（code 0）而绕过兜底。
    // 保持引用：钩子挂起时定时器必然触发 exit(1)；成功路径 clearTimeout 移除。

    try {
      for (const hook of hooks) {
        await hook();
      }
    } catch (error) {
      logger?.error('shutdown hook failed, force exit', { reason, error });
      clearTimeout(forceTimer);
      exitFn(1);
      return;
    }

    clearTimeout(forceTimer);
    logger?.info('shutdown complete', { reason });
    exitFn(0);
  }

  return {
    register(hook) {
      hooks.push(hook);
    },
    shutdown,
  };
}
