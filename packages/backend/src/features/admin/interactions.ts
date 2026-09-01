import type { PrismaClient } from '@prisma/client';
import { err, ok, validationError, type Result } from '@teacher-platform/contracts';
import { isDatabaseMissingError } from '../../shared/prisma-errors/index.js';
import type { DatabaseClientPool } from '../../shared/database-pool/index.js';
import {
  dbNotReadyError,
  findTeacherListItem,
  isSafeAdminDatabaseName,
  type OverviewError,
} from './teacher-overview.js';

/**
 * 交互数据（Agent 用量）统计（P7 渠道线 A4，设计 §2.2）。
 *
 * - 单教师库 AgentExecution 统计：按 status 分布（succeeded/failed/partial/waiting_confirmation +
 *   running），平均/最大耗时（finishedAtTs - startedAtTs，仅终态且双时间戳齐全），错误率
 *   （failed / 终态总数），最近交互时间（max startedAtTs）；
 * - token 用量：AgentExecution 无 token 字段 → available:false（阶段二 provider-usage 表接入）；
 * - 单库聚合全局 deadline（默认 5s），超时返回已计算部分 + degraded:true（同 t64 语义）；
 * - 教师不存在 → 404；库未就绪/不安全 → 503 DATABASE_NOT_READY；连接 try/finally release。
 */

export interface InteractionStatsInput {
  teacherId: string;
  /** 起止时间（ISO；可选，按 startedAtTs 过滤） */
  from?: string;
  to?: string;
  timeoutMs?: number;
}

export interface InteractionStats {
  teacherId: string;
  window?: { from?: string; to?: string };
  counts: {
    succeeded: number;
    failed: number;
    partial: number;
    waiting_confirmation: number;
    running: number;
    /** 终态总数（succeeded+failed+partial+waiting_confirmation） */
    totalTerminal: number;
  };
  /** 错误率 = failed / totalTerminal（终态口径） */
  errorRate: number;
  /** 终态且双时间戳齐全的执行耗时统计 */
  durationMs: { avg: number | null; max: number | null };
  /** 最近交互时间（max startedAtTs，ISO；无记录 null） */
  lastInteractionAt: string | null;
  /** 阶段一无 token 字段：显式标注不可用 */
  usage: { available: false; reason: string };
  degraded: boolean;
  reason?: 'timeout';
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

export async function getInteractionStats(
  registryPrisma: Pick<PrismaClient, 'teacherRegistry'>,
  pool: DatabaseClientPool,
  input: InteractionStatsInput,
): Promise<Result<InteractionStats, OverviewError>> {
  const timeoutMs = input.timeoutMs ?? 5000;
  const teacherResult = await findTeacherListItem(registryPrisma, input.teacherId);
  if (!teacherResult.ok) return teacherResult;
  const teacher = teacherResult.value;

  // 时间窗口校验（ISO；from<=to）
  let fromDate: Date | undefined;
  let toDate: Date | undefined;
  if (input.from !== undefined) {
    const parsed = new Date(input.from);
    if (Number.isNaN(parsed.getTime())) return err(validationError('from 必须是合法 ISO 时间', 'from'));
    fromDate = parsed;
  }
  if (input.to !== undefined) {
    const parsed = new Date(input.to);
    if (Number.isNaN(parsed.getTime())) return err(validationError('to 必须是合法 ISO 时间', 'to'));
    toDate = parsed;
  }
  if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
    return err(validationError('from 不能晚于 to', 'from'));
  }

  if (!isSafeAdminDatabaseName(teacher.databaseName)) {
    return err(dbNotReadyError());
  }

  let client: PrismaClient;
  try {
    client = await pool.acquire(teacher.databaseName);
  } catch {
    return err(dbNotReadyError());
  }

  try {
    const deadline = performance.now() + timeoutMs;
    const rows = await withTimeout(
      client.agentExecution.findMany({
        where: {
          startedAtTs: {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          },
        },
        select: { status: true, startedAtTs: true, finishedAtTs: true },
        orderBy: { startedAtTs: 'desc' },
      }),
      deadline - performance.now(),
    ).catch((error) => {
      if (isDatabaseMissingError(error)) {
        throw error; // 上游按 503 处理
      }
      return null; // 超时/其他 → 无数据 + degraded
    });
    if (rows === null) {
      // 超时或查询失败：返回空统计 + degraded（单库故障不影响面板）
      return ok({
        teacherId: teacher.id,
        ...(input.from || input.to
          ? { window: { ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}) } }
          : {}),
        counts: { succeeded: 0, failed: 0, partial: 0, waiting_confirmation: 0, running: 0, totalTerminal: 0 },
        errorRate: 0,
        durationMs: { avg: null, max: null },
        lastInteractionAt: null,
        usage: { available: false, reason: 'AgentExecution 无 token 字段（阶段二 provider-usage 表接入）' },
        degraded: true,
        reason: 'timeout',
      });
    }

    const counts = { succeeded: 0, failed: 0, partial: 0, waiting_confirmation: 0, running: 0, totalTerminal: 0 };
    const durations: number[] = [];
    let lastInteractionAt: Date | null = null;
    for (const row of rows) {
      if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'partial' || row.status === 'waiting_confirmation') {
        counts[row.status] += 1;
        counts.totalTerminal += 1;
        if (row.startedAtTs && row.finishedAtTs) {
          durations.push(row.finishedAtTs.getTime() - row.startedAtTs.getTime());
        }
      } else if (row.status === 'running') {
        counts.running += 1;
      }
      if (row.startedAtTs && (!lastInteractionAt || row.startedAtTs > lastInteractionAt)) {
        lastInteractionAt = row.startedAtTs;
      }
    }
    const avg = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
    const max = durations.length > 0 ? Math.max(...durations) : null;

    return ok({
      teacherId: teacher.id,
      ...(input.from || input.to
        ? { window: { ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}) } }
        : {}),
      counts,
      errorRate: counts.totalTerminal > 0 ? counts.failed / counts.totalTerminal : 0,
      durationMs: { avg, max },
      lastInteractionAt: lastInteractionAt ? lastInteractionAt.toISOString() : null,
      usage: { available: false, reason: 'AgentExecution 无 token 字段（阶段二 provider-usage 表接入）' },
      degraded: false,
    });
  } catch (error) {
    if (isDatabaseMissingError(error)) {
      return err(dbNotReadyError());
    }
    throw error;
  } finally {
    pool.release(teacher.databaseName);
  }
}
