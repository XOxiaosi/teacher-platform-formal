import { describe, expect, it, vi, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createShutdownCoordinator,
  closeServer,
  parseShutdownTimeoutMs,
  registerGracefulShutdown,
} from '../../../src/shared/shutdown/index.js';
import type { DatabaseClientPool } from '../../../src/shared/database-pool/index.js';
import type { Logger } from '../../../src/shared/logger/index.js';

function mockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function mockPool(closeAll?: () => Promise<void>): DatabaseClientPool {
  return {
    closeAll: vi.fn(closeAll ?? (async () => undefined)),
  } as unknown as DatabaseClientPool;
}

function listenServer(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, port });
    });
  });
}

describe('parseShutdownTimeoutMs', () => {
  it('缺省/非法值回退 10_000，合法值原样返回', () => {
    expect(parseShutdownTimeoutMs(undefined)).toBe(10_000);
    expect(parseShutdownTimeoutMs('abc')).toBe(10_000);
    expect(parseShutdownTimeoutMs('0')).toBe(10_000);
    expect(parseShutdownTimeoutMs('-5')).toBe(10_000);
    expect(parseShutdownTimeoutMs('800')).toBe(800);
  });
});

describe('closeServer', () => {
  it('关闭已 listen 的 server 后 resolve', async () => {
    const { server, port } = await listenServer();
    expect(port).toBeGreaterThan(0);
    await expect(closeServer(server)).resolves.toBeUndefined();
  });
});

describe('createShutdownCoordinator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('成功路径：钩子按注册顺序执行 → exit 0 + shutdown 日志', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const logger = mockLogger();
    const coordinator = createShutdownCoordinator({ forceExitMs: 1000, logger, exit });

    coordinator.register(async () => { order.push('server.close'); });
    coordinator.register(async () => { order.push('pool.closeAll'); });

    await coordinator.shutdown('SIGTERM');

    expect(order).toEqual(['server.close', 'pool.closeAll']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.info).toHaveBeenCalledWith('shutdown started', { reason: 'SIGTERM' });
    expect(logger.info).toHaveBeenCalledWith('shutdown complete', { reason: 'SIGTERM' });
  });

  it('钩子抛错 → 停止后续钩子 → exit 1', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const logger = mockLogger();
    const coordinator = createShutdownCoordinator({ forceExitMs: 1000, logger, exit });

    coordinator.register(async () => { order.push('first'); });
    coordinator.register(async () => { throw new Error('closeAll boom'); });
    coordinator.register(async () => { order.push('never'); });

    await coordinator.shutdown('SIGTERM');

    expect(order).toEqual(['first']);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      'shutdown hook failed, force exit',
      expect.objectContaining({ reason: 'SIGTERM' }),
    );
  });

  it('超时兜底：钩子挂起 → forceExitMs 后 exit 1', async () => {
    const exit = vi.fn();
    const logger = mockLogger();
    const coordinator = createShutdownCoordinator({ forceExitMs: 60, logger, exit });

    coordinator.register(() => new Promise<void>(() => undefined)); // 永不 resolve

    void coordinator.shutdown('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      'shutdown timed out, force exit',
      expect.objectContaining({ reason: 'SIGINT', forceExitMs: 60 }),
    );
  });

  it('幂等：shutdown 进行中再次触发不重复执行钩子/exit', async () => {
    const exit = vi.fn();
    const coordinator = createShutdownCoordinator({ forceExitMs: 1000, exit });
    let runs = 0;
    coordinator.register(async () => { runs += 1; });

    await Promise.all([
      coordinator.shutdown('SIGTERM'),
      coordinator.shutdown('SIGINT'),
      coordinator.shutdown('SIGTERM'),
    ]);

    expect(runs).toBe(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('registerGracefulShutdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('注册 SIGTERM/SIGINT 监听；dispose 后移除', async () => {
    const before = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT');
    const { server } = await listenServer();
    const graceful = registerGracefulShutdown({ server, pool: mockPool(), timeoutMs: 1000 });
    expect(process.listenerCount('SIGTERM') + process.listenerCount('SIGINT')).toBe(before + 2);
    graceful.dispose();
    expect(process.listenerCount('SIGTERM') + process.listenerCount('SIGINT')).toBe(before);
    await closeServer(server);
  });

  it('shutdown() 程序化触发：server.close → pool.closeAll → 附加钩子 → exit 0', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const { server } = await listenServer();
    const pool = mockPool(async () => { order.push('pool.closeAll'); });
    const graceful = registerGracefulShutdown({
      server,
      pool,
      timeoutMs: 1000,
      exit,
      additionalHooks: [async () => { order.push('prisma.$disconnect'); }],
    });

    await graceful.shutdown('probe');
    graceful.dispose();

    expect(order).toEqual(['pool.closeAll', 'prisma.$disconnect']);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
