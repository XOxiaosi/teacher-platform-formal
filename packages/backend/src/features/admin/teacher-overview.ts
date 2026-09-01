import type { PrismaClient } from '@prisma/client';
import { err, internalError, notFound, ok, validationError, type CommonError, type Result } from '@teacher-platform/contracts';
import { isDatabaseMissingError } from '../../shared/prisma-errors/index.js';
import type { DatabaseClientPool } from '../../shared/database-pool/index.js';

/**
 * 教师总览服务（P7 渠道线 A3，设计 §2.1）。
 *
 * - 列表：只读共享库 TeacherRegistry（分页 + status 过滤），**绝不触达教师独立库**（N×M 性能红线）；
 *   返回字段不含 passwordHash。
 * - 详情：registry 信息 + 对目标教师独立库**懒加载聚合**（Student/Schedule/Lesson/Payment/Feedback/
 *   AgentExecution count + AgentExecution 最近 20 条）；单库聚合 5s 超时 → 返回部分指标 + degraded:
 *   true（单教师库故障不影响面板）。
 * - 枚举/安全：databaseName 逐项安全校验（镜像 ops assertSafeTeacherDatabaseName 规则；额外允许
 *   默认共享库 teacher_platform——dev/共享兼容，生产教师库应为 teacher_db_*）；库缺失（P1003）
 *   → 503 DATABASE_NOT_READY（与 db-routing 语义一致）。
 */

const TEACHER_DB_PREFIX = 'teacher_db_';
const SHARED_DB_NAME = 'teacher_platform';
const SAFE_NAME_PATTERN = /^[a-z0-9_]+$/;

/**
 * 管理面板侧库名校验（镜像 ops lib/db-safety.mjs 规则 + 允许共享默认库）。
 * 返回 true 表示可安全用于 pool.acquire。
 */
export function isSafeAdminDatabaseName(databaseName: string): boolean {
  if (!SAFE_NAME_PATTERN.test(databaseName)) return false;
  if (databaseName === SHARED_DB_NAME) return true; // 默认共享库（dev/共享兼容）
  if (!databaseName.startsWith(TEACHER_DB_PREFIX)) return false;
  return true;
}

export interface TeacherListItem {
  id: string;
  email: string;
  displayName: string;
  status: string;
  databaseName: string;
  createdAtTs: Date;
  updatedAtTs: Date;
}

export interface ListTeachersInput {
  /** 原始 query 值（服务内 parsePagination 校验；页面传 string） */
  page?: unknown;
  pageSize?: unknown;
  status?: string;
}

export interface ListTeachersResult {
  items: TeacherListItem[];
  total: number;
}

export interface TeacherMetricsCounts {
  student: number;
  schedule: number;
  lesson: number;
  payment: number;
  feedback: number;
  agentExecution: number;
}

/** 详情聚合错误：库未就绪（503 语义，与 db-routing 一致）；其余为通用 CommonError。 */
export type OverviewError = CommonError | { code: 'DATABASE_NOT_READY'; message: string };

/** 库未就绪错误（t64/t67 共享）。 */
export function dbNotReadyError(): OverviewError {
  return { code: 'DATABASE_NOT_READY', message: '教师数据库未就绪' };
}

/** 按 id 查教师（findFirst：非 cuid 字符串不抛 P2023，一律 404 语义）。t64/t67 共享。 */
export async function findTeacherListItem(
  registryPrisma: Pick<PrismaClient, 'teacherRegistry'>,
  teacherId: string,
): Promise<Result<TeacherListItem, OverviewError>> {
  try {
    const teacher = await registryPrisma.teacherRegistry.findFirst({
      where: { id: teacherId },
      select: {
        id: true,
        email: true,
        displayName: true,
        status: true,
        databaseName: true,
        createdAtTs: true,
        updatedAtTs: true,
      },
    });
    if (!teacher) return err(notFound('教师不存在'));
    return ok(teacher);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(internalError(`教师查询失败：${message}`));
  }
}

export interface TeacherOverview {
  teacher: TeacherListItem;
  metrics: {
    counts: Partial<TeacherMetricsCounts>;
    recentExecutions: Array<{
      id: string;
      status: string;
      stage: string;
      startedAtTs: Date | null;
      finishedAtTs: Date | null;
    }>;
    /** 超时/部分失败时为 true（单教师库故障不影响面板） */
    degraded: boolean;
    reason?: 'timeout';
  };
}

/** 解析分页参数（默认 page=1/pageSize=20，上限 100；非法 → 400）。 */
export function parsePagination(
  page: unknown,
  pageSize: unknown,
): Result<{ page: number; pageSize: number }, CommonError> {
  const parsedPage = page === undefined ? 1 : Number(page);
  const parsedSize = pageSize === undefined ? 20 : Number(pageSize);
  if (!Number.isInteger(parsedPage) || parsedPage < 1) {
    return err(validationError('page 必须是正整数', 'page'));
  }
  if (!Number.isInteger(parsedSize) || parsedSize < 1 || parsedSize > 100) {
    return err(validationError('pageSize 必须是 1-100 的整数', 'pageSize'));
  }
  return ok({ page: parsedPage, pageSize: parsedSize });
}

/** 列表：只读共享库，分页 + status 过滤；不触达教师独立库（N×M 红线）。 */
export async function listTeachers(
  registryPrisma: Pick<PrismaClient, 'teacherRegistry'>,
  input: ListTeachersInput,
): Promise<Result<ListTeachersResult, CommonError>> {
  if (input.status !== undefined && input.status !== 'active' && input.status !== 'disabled') {
    return err(validationError('status 只能是 active|disabled', 'status'));
  }
  const pagination = parsePagination(input.page, input.pageSize);
  if (!pagination.ok) return pagination;

  const where = input.status ? { status: input.status } : {};
  try {
    const [items, total] = await Promise.all([
      registryPrisma.teacherRegistry.findMany({
        where,
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          databaseName: true,
          createdAtTs: true,
          updatedAtTs: true,
        },
        orderBy: { createdAtTs: 'desc' },
        skip: (pagination.value.page - 1) * pagination.value.pageSize,
        take: pagination.value.pageSize,
      }),
      registryPrisma.teacherRegistry.count({ where }),
    ]);
    return ok({ items, total });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(internalError(`教师列表查询失败：${message}`));
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('aggregation timeout')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 详情：registry 信息 + 目标独立库懒加载聚合。
 * - 教师不存在 → NOT_FOUND 404；
 * - 库名不安全 / 库缺失（P1003）/ 连接失败 → DATABASE_NOT_READY 503；
 * - 聚合超时（timeoutMs，默认 5s）→ 200 + 部分指标 + degraded:true。
 * - 池连接 try/finally release（不做死连接）。
 */
export async function getTeacherOverview(
  registryPrisma: Pick<PrismaClient, 'teacherRegistry'>,
  pool: DatabaseClientPool,
  input: { teacherId: string; timeoutMs?: number },
): Promise<Result<TeacherOverview, OverviewError>> {
  const timeoutMs = input.timeoutMs ?? 5000;
  const teacherResult = await findTeacherListItem(registryPrisma, input.teacherId);
  if (!teacherResult.ok) return teacherResult;
  const teacher = teacherResult.value;
  if (!isSafeAdminDatabaseName(teacher.databaseName)) {
    return err(dbNotReadyError());
  }

  const dbName = teacher.databaseName;
  let client: PrismaClient;
  try {
    client = await pool.acquire(dbName);
  } catch {
    return err(dbNotReadyError());
  }

  try {
    const counts: Partial<TeacherMetricsCounts> = {};
    const recentExecutions: TeacherOverview['metrics']['recentExecutions'] = [];
    let degraded = false;
    const deadline = performance.now() + timeoutMs;

    // 顺序聚合 + 全局期限：每步用剩余预算包裹超时；超时 → 停止并保留已完成部分
    const countSteps: Array<[keyof TeacherMetricsCounts, () => Promise<number>]> = [
      ['student', () => client.student.count()],
      ['schedule', () => client.schedule.count()],
      ['lesson', () => client.lesson.count()],
      ['payment', () => client.payment.count()],
      ['feedback', () => client.parentFeedback.count()],
      ['agentExecution', () => client.agentExecution.count()],
    ];
    for (const [key, run] of countSteps) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        degraded = true;
        break;
      }
      try {
        counts[key] = await withTimeout(run(), remaining);
      } catch (error) {
        if (isDatabaseMissingError(error)) {
          return err(dbNotReadyError());
        }
        degraded = true;
        break;
      }
    }

    if (!degraded) {
      const remaining = deadline - performance.now();
      if (remaining > 0) {
        try {
          const executions = await withTimeout(
            client.agentExecution.findMany({
              orderBy: { startedAtTs: 'desc' },
              take: 20,
              select: { id: true, status: true, stage: true, startedAtTs: true, finishedAtTs: true },
            }),
            remaining,
          );
          recentExecutions.push(...executions);
        } catch (error) {
          if (isDatabaseMissingError(error)) {
            return err(dbNotReadyError());
          }
          degraded = true;
        }
      } else {
        degraded = true;
      }
    }

    return ok({
      teacher,
      metrics: {
        counts,
        recentExecutions,
        degraded,
        ...(degraded ? { reason: 'timeout' as const } : {}),
      },
    });
  } finally {
    pool.release(dbName);
  }
}
