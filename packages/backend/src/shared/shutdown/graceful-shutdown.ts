import type { Server } from 'node:http';
import type { DatabaseClientPool } from '../database-pool/index.js';
import type { Logger } from '../logger/index.js';
import {
  createShutdownCoordinator,
  closeServer,
  type ShutdownCoordinator,
} from './shutdown.js';

/**
 * 优雅退出接线函数（P7 G3，T8b 设计 §4.1）。
 *
 * 一次调用完成：SIGTERM/SIGINT → server.close()（停新请求、在途排空）→
 * pool.closeAll()（S1 池幂等 closeAll）→ exit 0；钩子抛错或超时（timeoutMs）
 * → exit 1（让守护进程按异常重启）。
 *
 * - 防重复注册：协调器幂等（shutdown 进行中再次触发直接返回），信号监听可
 *   dispose() 移除（测试清理）；
 * - 池内部自注册的 exit/SIGINT/SIGTERM 钩子（S1 产物）作二级兜底，与本函数
 *   显式调用 closeAll 幂等共存（设计 §4.1 第 3 点：统一入口 + 池钩子兜底）；
 * - additionalHooks 在 server.close 与 pool.closeAll 之后执行（如共享库
 *   $disconnect）；FIXTURE/测试注入用 additionalHooks 模拟挂起钩子。
 */
export interface GracefulShutdownOptions {
  /** 已 listen 的 HTTP server（先停流量） */
  server: Server;
  /** 数据库连接池（S1 产物，closeAll 幂等） */
  pool: DatabaseClientPool;
  /** 优雅退出兜底超时（毫秒），默认 10_000 */
  timeoutMs?: number;
  /** 结构化日志（可选；缺省静默） */
  logger?: Logger;
  /** 附加清理钩子（server.close + pool.closeAll 之后按序执行） */
  additionalHooks?: Array<() => Promise<void>>;
  /** 退出函数（测试注入 mock；缺省 process.exit） */
  exit?: (code: number) => void;
}

export interface GracefulShutdown {
  /** 底层协调器（单测/探测用） */
  coordinator: ShutdownCoordinator;
  /** 程序化触发优雅退出（测试探测/运维脚本用） */
  shutdown(reason: string): Promise<void>;
  /** 移除 SIGTERM/SIGINT 监听（测试清理用，防跨测试串扰） */
  dispose(): void;
}

export function registerGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  const coordinator = createShutdownCoordinator({
    forceExitMs: options.timeoutMs ?? 10_000,
    logger: options.logger,
    exit: options.exit,
  });

  coordinator.register(() => closeServer(options.server));
  coordinator.register(() => options.pool.closeAll());
  for (const hook of options.additionalHooks ?? []) {
    coordinator.register(hook);
  }

  const onSigTerm = (): void => {
    void coordinator.shutdown('SIGTERM');
  };
  const onSigInt = (): void => {
    void coordinator.shutdown('SIGINT');
  };
  process.on('SIGTERM', onSigTerm);
  process.on('SIGINT', onSigInt);

  return {
    coordinator,
    shutdown: (reason: string) => coordinator.shutdown(reason),
    dispose() {
      process.removeListener('SIGTERM', onSigTerm);
      process.removeListener('SIGINT', onSigInt);
    },
  };
}
