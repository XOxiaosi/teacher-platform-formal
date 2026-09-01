import type { NextFunction, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabaseClientPool,
  DatabasePoolLimitError,
  withDatabaseUrl,
  parseDatabasePoolEnv,
  type DatabaseClientPool,
} from '../../../src/shared/database-pool/index.js';
import {
  createDatabaseRouter,
  DatabaseRouterError,
  toDatabaseRouterError,
  type RoutedRequest,
} from '../../../src/app/middleware/database-router.js';
import type { AuthenticatedRequest } from '../../../src/app/middleware/require-auth.js';

const BASE_URL = 'postgres://user:pass@127.0.0.1:5432/postgres';

function fakeClient() {
  return { $disconnect: vi.fn(async () => undefined) } as unknown as PrismaClient;
}

function createPool(overrides: Parameters<typeof createDatabaseClientPool>[0] = {}): DatabaseClientPool {
  return createDatabaseClientPool({
    baseUrl: BASE_URL,
    registerProcessHooks: false,
    ...overrides,
  });
}

function invokeRouter(options: {
  teacherId?: string;
  registryFindUnique?: () => { databaseName: string } | null;
  pool?: DatabaseClientPool;
}) {
  const registryPrisma = {
    teacherRegistry: { findUnique: options.registryFindUnique ?? (() => ({ databaseName: 'teacher_db_a' })) },
  } as unknown as PrismaClient;
  const router = createDatabaseRouter({
    registryPrisma,
    pool: options.pool ?? createPool({ createClient: () => fakeClient() }),
  });
  const req = {} as AuthenticatedRequest;
  if (options.teacherId !== undefined) req.teacherId = options.teacherId;
  const res = {} as Response;
  const next = vi.fn() as NextFunction;
  return { router, req, res, next };
}

describe('createDatabaseClientPool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('同 dbName 两次 acquire 返回同一实例（复用）', async () => {
    const pool = createPool({ createClient: () => fakeClient() });
    const first = await pool.acquire('teacher_db_a');
    const second = await pool.acquire('teacher_db_a');
    expect(first).toBe(second);
    expect(pool.size()).toBe(1);
    await pool.closeAll();
  });

  it('懒创建：未 acquire 不建 client', async () => {
    const createClient = vi.fn(() => fakeClient());
    const pool = createPool({ createClient });
    expect(createClient).not.toHaveBeenCalled();
    expect(pool.size()).toBe(0);
    await pool.acquire('teacher_db_b');
    expect(createClient).toHaveBeenCalledTimes(1);
    await pool.closeAll();
  });

  it('不同 dbName 各自独立实例，size 计数正确', async () => {
    const pool = createPool({ createClient: () => fakeClient() });
    await pool.acquire('teacher_db_a');
    await pool.acquire('teacher_db_b');
    expect(pool.size()).toBe(2);
    await pool.closeAll();
  });

  it('闲置回收：超过 idleTtlMs 且无活跃引用后 $disconnect 并被移除', async () => {
    const client = fakeClient();
    const pool = createPool({
      createClient: () => client,
      idleTtlMs: 20,
      sweepIntervalMs: 10,
    });
    await pool.acquire('teacher_db_a');
    pool.release('teacher_db_a');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(client.$disconnect).toHaveBeenCalled();
    expect(pool.size()).toBe(0);
    await pool.closeAll();
  });

  it('有活跃引用（未 release）时不回收', async () => {
    const client = fakeClient();
    const pool = createPool({
      createClient: () => client,
      idleTtlMs: 20,
      sweepIntervalMs: 10,
    });
    await pool.acquire('teacher_db_a');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(client.$disconnect).not.toHaveBeenCalled();
    expect(pool.size()).toBe(1);
    await pool.closeAll();
  });

  it('closeAll 清理全部连接且幂等', async () => {
    const clientA = fakeClient();
    const clientB = fakeClient();
    let index = 0;
    const pool = createPool({
      createClient: () => (index++ === 0 ? clientA : clientB),
    });
    await pool.acquire('teacher_db_a');
    await pool.acquire('teacher_db_b');
    await pool.closeAll();
    await pool.closeAll();
    expect(clientA.$disconnect).toHaveBeenCalledTimes(1);
    expect(clientB.$disconnect).toHaveBeenCalledTimes(1);
    expect(pool.size()).toBe(0);
  });

  it('closeAll 后 acquire 拒绝', async () => {
    const pool = createPool({ createClient: () => fakeClient() });
    await pool.acquire('teacher_db_a');
    await pool.closeAll();
    await expect(pool.acquire('teacher_db_a')).rejects.toThrow('database pool is closed');
  });

  it('超过 maxClients 抛 DatabasePoolLimitError', async () => {
    const pool = createPool({ createClient: () => fakeClient(), maxClients: 1 });
    await pool.acquire('teacher_db_a');
    await expect(pool.acquire('teacher_db_b')).rejects.toBeInstanceOf(DatabasePoolLimitError);
    await pool.closeAll();
  });

  it('进程退出钩子注册并可随 closeAll 移除', async () => {
    const before = process.listenerCount('SIGTERM');
    const pool = createDatabaseClientPool({
      baseUrl: BASE_URL,
      createClient: () => fakeClient(),
      // 默认 registerProcessHooks=true
    });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    expect(process.listenerCount('exit')).toBe(before + 1);
    await pool.closeAll();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('withDatabaseUrl 拼接库名到连接串', () => {
    expect(withDatabaseUrl(BASE_URL, 'teacher_db_a'))
      .toBe('postgres://user:pass@127.0.0.1:5432/teacher_db_a');
  });
});

describe('createDatabaseRouter', () => {
  it('teacherId → databaseName → req.db 注入（client + dbName）', async () => {
    const pool = createPool({ createClient: () => fakeClient() });
    const { router, req, res, next } = invokeRouter({ teacherId: 'teacher-1', pool });
    await router(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
    const routed = req as RoutedRequest;
    expect(routed.db).toBeDefined();
    expect(routed.db!.dbName).toBe('teacher_db_a');
    expect(routed.db!.client).toBeDefined();
    await pool.closeAll();
  });

  it('registry 缓存：同 teacherId 第二次请求不重复查 TeacherRegistry', async () => {
    const findUnique = vi.fn(() => ({ databaseName: 'teacher_db_a' }));
    const registryPrisma = {
      teacherRegistry: { findUnique },
    } as unknown as PrismaClient;
    const pool = createPool({ createClient: () => fakeClient() });
    const router = createDatabaseRouter({ registryPrisma, pool, registryCacheTtlMs: 60_000 });
    const req = { teacherId: 'teacher-1' } as AuthenticatedRequest;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;
    await router(req, res, next);
    await router(req, res, next);
    expect(findUnique).toHaveBeenCalledTimes(1);
    await pool.closeAll();
  });

  it('registry 缓存过期后重新查询', async () => {
    const findUnique = vi.fn(() => ({ databaseName: 'teacher_db_a' }));
    const registryPrisma = {
      teacherRegistry: { findUnique },
    } as unknown as PrismaClient;
    const pool = createPool({ createClient: () => fakeClient() });
    const router = createDatabaseRouter({ registryPrisma, pool, registryCacheTtlMs: 0 });
    const req = { teacherId: 'teacher-1' } as AuthenticatedRequest;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;
    await router(req, res, next);
    await router(req, res, next);
    expect(findUnique).toHaveBeenCalledTimes(2);
    await pool.closeAll();
  });

  it('teacherId 缺失 → next(DatabaseRouterError TEACHER_NOT_FOUND)', async () => {
    const { router, req, res, next } = invokeRouter({});
    await router(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    const error = next.mock.calls[0][0] as DatabaseRouterError;
    expect(error).toBeInstanceOf(DatabaseRouterError);
    expect(error.code).toBe('TEACHER_NOT_FOUND');
  });

  it('TeacherRegistry 查无此教师 → TEACHER_NOT_FOUND', async () => {
    const { router, req, res, next } = invokeRouter({ teacherId: 'unknown', registryFindUnique: () => null });
    await router(req, res, next);
    const error = next.mock.calls[0][0] as DatabaseRouterError;
    expect(error.code).toBe('TEACHER_NOT_FOUND');
  });

  it('acquire 抛 DatabasePoolLimitError → next 收到 POOL_LIMIT_EXCEEDED', async () => {
    const pool = createPool({ createClient: () => fakeClient(), maxClients: 0 });
    const { router, req, res, next } = invokeRouter({ teacherId: 'teacher-1', pool });
    await router(req, res, next);
    const error = next.mock.calls[0][0] as DatabaseRouterError;
    expect(error).toBeInstanceOf(DatabaseRouterError);
    expect(error.code).toBe('POOL_LIMIT_EXCEEDED');
  });
});

describe('toDatabaseRouterError / isDatabaseMissingError', () => {
  it('P1003 数据库不存在 → DATABASE_NOT_READY', () => {
    const error = toDatabaseRouterError({ code: 'P1003', message: 'database "teacher_db_a" does not exist' });
    expect(error.code).toBe('DATABASE_NOT_READY');
    expect(error.message).toContain('未就绪');
  });

  it('DatabaseRouterError 原样透传', () => {
    const original = new DatabaseRouterError('TEACHER_NOT_FOUND', '教师记录不存在');
    expect(toDatabaseRouterError(original)).toBe(original);
  });

  it('未知错误 → POOL_LIMIT_EXCEEDED（保守归类，message 保留）', () => {
    const error = toDatabaseRouterError(new Error('connection refused'));
    expect(error.code).toBe('POOL_LIMIT_EXCEEDED');
    expect(error.message).toContain('connection refused');
  });
});

describe('parseDatabasePoolEnv', () => {
  it('合法 env 映射到选项（SCREAMING_SNAKE ↔ camelCase）', () => {
    const options = parseDatabasePoolEnv({
      MAX_DB_CLIENTS: '50',
      DB_IDLE_TTL_MS: '60000',
      DB_SWEEP_INTERVAL_MS: '30000',
      DB_REGISTRY_CACHE_TTL_MS: '5000',
    } as NodeJS.ProcessEnv);
    expect(options.maxClients).toBe(50);
    expect(options.idleTtlMs).toBe(60000);
    expect(options.sweepIntervalMs).toBe(30000);
    expect(options.registryCacheTtlMs).toBe(5000);
  });

  it('缺省/非法值回退默认', () => {
    const options = parseDatabasePoolEnv({} as NodeJS.ProcessEnv);
    expect(options.maxClients).toBe(100);
    expect(options.idleTtlMs).toBe(30 * 60 * 1000);
    expect(options.sweepIntervalMs).toBe(5 * 60 * 1000);
    expect(options.registryCacheTtlMs).toBe(60 * 1000);

    const bad = parseDatabasePoolEnv({
      MAX_DB_CLIENTS: 'abc',
      DB_IDLE_TTL_MS: '0',
    } as NodeJS.ProcessEnv);
    expect(bad.maxClients).toBe(100);
    expect(bad.idleTtlMs).toBe(30 * 60 * 1000);
  });
});
