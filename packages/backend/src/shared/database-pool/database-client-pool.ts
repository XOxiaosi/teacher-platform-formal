import { PrismaClient } from '@prisma/client';

/**
 * 数据库客户端连接池：Map<dbName, PrismaClient> 懒创建 + 复用。
 *
 * 设计依据：reports/architecture/p7-db-routing-design.md §2
 * - 懒创建：首次 acquire 才 new PrismaClient（不启动时拉起 500 条连接）
 * - 复用：同 dbName 共享同一实例（Prisma 内部自带连接池）
 * - 闲置回收：巡检把超过 idleTtlMs 且无活跃引用的 client $disconnect 并移除
 * - 进程退出：closeAll() 幂等清理全部连接；可选注册 exit/SIGINT/SIGTERM 钩子
 */
export interface DatabaseClientPool {
  acquire(dbName: string): Promise<PrismaClient>;
  release(dbName: string): void;
  closeAll(): Promise<void>;
  size(): number;
}

export interface DatabaseClientPoolOptions {
  /** 源连接串（不含库名，如 postgres://user:pass@host:port）；教师库名拼在其后 */
  baseUrl: URL | string;
  /** 进程内最大热连库数，默认 100 */
  maxClients?: number;
  /** 闲置回收 TTL（毫秒），默认 30 分钟 */
  idleTtlMs?: number;
  /** 回收巡检间隔（毫秒），默认 5 分钟 */
  sweepIntervalMs?: number;
  /** 是否注册进程退出钩子（exit/SIGINT/SIGTERM → closeAll），默认 true；单测可关 */
  registerProcessHooks?: boolean;
  /** 客户端工厂（可注入用于单测；默认按 dbName 构造真实 PrismaClient） */
  createClient?: (dbName: string) => PrismaClient;
}

/** 连接池达 maxClients 上限时 acquire 抛出。 */
export class DatabasePoolLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabasePoolLimitError';
  }
}

/** 在 baseUrl 后拼接库名。 */
export function withDatabaseUrl(baseUrl: URL | string, dbName: string): string {
  const url = new URL(typeof baseUrl === 'string' ? baseUrl : baseUrl.toString());
  url.pathname = `/${dbName}`;
  return url.toString();
}

interface PoolEntry {
  client: PrismaClient;
  lastUsedAt: number;
  activeCount: number;
}

export function createDatabaseClientPool(options: DatabaseClientPoolOptions): DatabaseClientPool {
  const baseUrl = options.baseUrl instanceof URL ? options.baseUrl : new URL(options.baseUrl);
  const maxClients = options.maxClients ?? 100;
  const idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 5 * 60 * 1000;
  const createClient = options.createClient
    ?? ((dbName: string) => new PrismaClient({
      datasources: { db: { url: withDatabaseUrl(baseUrl, dbName) } },
    }));

  const entries = new Map<string, PoolEntry>();
  let closed = false;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;

  function assertOpen(): void {
    if (closed) throw new Error('database pool is closed');
  }

  function sweep(): void {
    const now = performance.now();
    for (const [dbName, entry] of entries) {
      if (entry.activeCount === 0 && now - entry.lastUsedAt > idleTtlMs) {
        entries.delete(dbName);
        void entry.client.$disconnect().catch(() => {
          // 断开失败不致命：连接会被 PostgreSQL 侧超时回收
        });
      }
    }
  }

  function removeProcessHooks(): void {
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  async function closeAll(): Promise<void> {
    if (closed) return;
    closed = true;
    if (sweepTimer !== undefined) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
    removeProcessHooks();
    const clients = [...entries.values()].map((entry) => entry.client);
    entries.clear();
    await Promise.allSettled(clients.map((client) => client.$disconnect()));
  }

  function onSignal(): void {
    void closeAll();
  }

  function onExit(): void {
    // exit 钩子无法 await；closeAll 内部 allSettled 保证不抛未处理拒绝
    void closeAll();
  }

  if (options.registerProcessHooks !== false) {
    process.on('exit', onExit);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  sweepTimer = setInterval(sweep, sweepIntervalMs);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  return {
    async acquire(dbName) {
      assertOpen();
      const existing = entries.get(dbName);
      if (existing) {
        existing.lastUsedAt = performance.now();
        existing.activeCount += 1;
        return existing.client;
      }
      if (entries.size >= maxClients) {
        throw new DatabasePoolLimitError(
          `数据库连接池已达上限（maxClients=${maxClients}），拒绝为 ${dbName} 新建连接`,
        );
      }
      const client = createClient(dbName);
      entries.set(dbName, { client, lastUsedAt: performance.now(), activeCount: 1 });
      return client;
    },

    release(dbName) {
      const entry = entries.get(dbName);
      if (!entry) return;
      entry.activeCount = Math.max(0, entry.activeCount - 1);
      entry.lastUsedAt = performance.now();
    },

    closeAll,

    size() {
      return entries.size;
    },
  };
}
