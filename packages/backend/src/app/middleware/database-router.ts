import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedRequest } from './require-auth.js';
import { isDatabaseMissingError } from '../../shared/prisma-errors/index.js';
export { isDatabaseMissingError } from '../../shared/prisma-errors/index.js';
import {
  DatabasePoolLimitError,
  runWithRequestDb,
  type DatabaseClientPool,
} from '../../shared/database-pool/index.js';

/**
 * 数据库路由中间件：teacherId → TeacherRegistry.databaseName → 独立库 Prisma 实例。
 *
 * 设计依据：reports/architecture/p7-db-routing-design.md §1/§2.3
 * - 在 requireAuth 之后运行（req.teacherId 已可信）
 * - 解析 databaseName（TeacherRegistry 查询 + TTL 缓存）→ pool.acquire → req.db
 * - req.db 用 RoutedRequest 类型扩展注入（与 AuthenticatedRequest 同风格，禁 any、不用 res.locals）
 * - 失败统一 next(error)，由统一错误处理映射（S3 装配）
 */

/** 请求级数据库上下文：路由层从这里取独立库 client。 */
export interface RoutedDatabaseContext {
  client: PrismaClient;
  dbName: string;
}

/** 带数据库上下文的请求（类型扩展，禁止 any）。 */
export interface RoutedRequest extends Request {
  db?: RoutedDatabaseContext;
}

export type DatabaseRouterErrorCode =
  | 'TEACHER_NOT_FOUND'
  | 'DATABASE_NOT_READY'
  | 'POOL_LIMIT_EXCEEDED';

/** 数据库路由错误：携带语义码，供装配层映射 HTTP 状态。 */
export class DatabaseRouterError extends Error {
  readonly code: DatabaseRouterErrorCode;

  constructor(code: DatabaseRouterErrorCode, message: string) {
    super(message);
    this.name = 'DatabaseRouterError';
    this.code = code;
  }
}

export interface DatabaseRouterOptions {
  /** 共享库 client：用于读 TeacherRegistry 拿 databaseName */
  registryPrisma: PrismaClient;
  /** 连接池：管理 dbName → PrismaClient */
  pool: DatabaseClientPool;
  /** databaseName 解析结果缓存 TTL（毫秒，默认 60_000） */
  registryCacheTtlMs?: number;
}

interface RegistryCacheEntry {
  dbName: string;
  expiresAt: number;
}

/** 把任意失败归一为 DatabaseRouterError（供装配层统一映射）。 */
export function toDatabaseRouterError(error: unknown): DatabaseRouterError {
  if (error instanceof DatabaseRouterError) return error;
  if (error instanceof DatabasePoolLimitError) {
    return new DatabaseRouterError('POOL_LIMIT_EXCEEDED', error.message);
  }
  if (isDatabaseMissingError(error)) {
    return new DatabaseRouterError('DATABASE_NOT_READY', '教师数据库未就绪');
  }
  const message = error instanceof Error ? error.message : String(error);
  return new DatabaseRouterError('POOL_LIMIT_EXCEEDED', message);
}

export function createDatabaseRouter(options: DatabaseRouterOptions) {
  const registryCacheTtlMs = options.registryCacheTtlMs ?? 60_000;
  const cache = new Map<string, RegistryCacheEntry>();

  async function resolveDatabaseName(teacherId: string): Promise<string> {
    const now = performance.now();
    const cached = cache.get(teacherId);
    if (cached && cached.expiresAt > now) {
      return cached.dbName;
    }
    const teacher = await options.registryPrisma.teacherRegistry.findUnique({
      where: { id: teacherId },
      select: { databaseName: true },
    });
    if (!teacher) {
      throw new DatabaseRouterError('TEACHER_NOT_FOUND', '教师记录不存在');
    }
    cache.set(teacherId, { dbName: teacher.databaseName, expiresAt: now + registryCacheTtlMs });
    return teacher.databaseName;
  }

  return async function databaseRouter(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const teacherId = (req as AuthenticatedRequest).teacherId;
    if (!teacherId) {
      // requireAuth 在链路前面已保证 teacherId 存在；此处兜底防御
      next(new DatabaseRouterError('TEACHER_NOT_FOUND', '缺少 teacherId'));
      return;
    }
    try {
      const dbName = await resolveDatabaseName(teacherId);
      const client = await options.pool.acquire(dbName);
      (req as RoutedRequest).db = { client, dbName };
      // 把请求级 client 传播给装配期创建的服务（getClient 请求期解析，S2 平移）
      runWithRequestDb({ client, dbName }, () => next());
    } catch (error) {
      next(toDatabaseRouterError(error));
    }
  };
}
