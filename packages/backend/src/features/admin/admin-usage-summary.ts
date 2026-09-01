import type { PrismaClient } from '@prisma/client';
import { err, internalError, ok, validationError, type CommonError, type Result } from '@teacher-platform/contracts';
import { dbNotReadyError, type OverviewError } from './teacher-overview.js';

/**
 * 平台级用量总览（P8 第六批 t28，设计 p7-admin-panel-design.md §6 / 远期「用量费用看板」）。
 *
 * - ProviderUsage 是**共享库表**（schema 注释：用量汇总按教师查询；providerConfigId 无 FK 保留历史），
 *   admin 直接跨教师聚合，不触达教师独立库（无 N+1，单次 findMany）；
 * - 聚合维度：totals（prompt/completion/total/requests）+ byProvider（providerName|model 分组，
 *   totalTokens 降序）——形状与教师侧 UsageSummary 一致（frontend2 可复用类型）；
 * - 过滤：from/to 必填（ISO，from < to）+ 可选 teacherId（管理动作详情钻取，owner 隔离由 admin 权限覆盖）；
 * - 只读不记审计（管理动作审计纪律：读端点不写 AdminAuditLog）；
 * - 库未就绪 → 503 DATABASE_NOT_READY（与 admin 其余端点语义一致）。
 */

export interface AdminUsageSummaryInput {
  /** 原始 query 值（服务内解析校验：ISO 时间，from < to） */
  from?: unknown;
  to?: unknown;
  /** 可选：单教师钻取（缺省全平台） */
  teacherId?: string;
}

export interface AdminUsageSummaryRow {
  providerName: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
}

export interface AdminUsageSummary {
  from: string;
  to: string;
  /** 可选单教师过滤的回显（缺省 undefined = 全平台） */
  teacherId?: string;
  totals: { promptTokens: number; completionTokens: number; totalTokens: number; requests: number };
  byProvider: AdminUsageSummaryRow[];
}

export type AdminUsageSummaryResult = Result<AdminUsageSummary, OverviewError>;

function parseIsoRange(from: unknown, to: unknown): Result<{ from: Date; to: Date }, CommonError> {
  if (typeof from !== 'string' || from.trim() === '' || typeof to !== 'string' || to.trim() === '') {
    return err(validationError('from/to 查询参数必填（ISO 时间）', 'query'));
  }
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate >= toDate) {
    return err(validationError('from/to 必须是合法 ISO 时间且 from < to', 'query'));
  }
  return ok({ from: fromDate, to: toDate });
}

export async function getAdminUsageSummary(
  prisma: Pick<PrismaClient, 'providerUsage'>,
  input: AdminUsageSummaryInput,
): Promise<AdminUsageSummaryResult> {
  const range = parseIsoRange(input.from, input.to);
  if (!range.ok) return range;

  try {
    const rows = await prisma.providerUsage.findMany({
      where: {
        ...(input.teacherId !== undefined && input.teacherId !== '' ? { teacherId: input.teacherId } : {}),
        requestAt: { gte: range.value.from, lte: range.value.to },
      },
      orderBy: { requestAt: 'asc' },
    });

    const byProviderMap = new Map<string, AdminUsageSummaryRow>();
    let totalPrompt = 0;
    let totalCompletion = 0;

    for (const row of rows) {
      totalPrompt += row.promptTokens;
      totalCompletion += row.completionTokens;
      const key = `${row.providerName}|${row.model}`;
      const entry = byProviderMap.get(key) ?? {
        providerName: row.providerName,
        model: row.model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        requests: 0,
      };
      entry.promptTokens += row.promptTokens;
      entry.completionTokens += row.completionTokens;
      entry.totalTokens += row.promptTokens + row.completionTokens;
      entry.requests += 1;
      byProviderMap.set(key, entry);
    }

    return ok({
      from: range.value.from.toISOString(),
      to: range.value.to.toISOString(),
      ...(input.teacherId !== undefined && input.teacherId !== '' ? { teacherId: input.teacherId } : {}),
      totals: {
        promptTokens: totalPrompt,
        completionTokens: totalCompletion,
        totalTokens: totalPrompt + totalCompletion,
        requests: rows.length,
      },
      byProvider: [...byProviderMap.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    });
  } catch (error) {
    if (error instanceof Error && /database|connection|ECONNREFUSED|does not exist/i.test(error.message)) {
      return err(dbNotReadyError());
    }
    const message = error instanceof Error ? error.message : String(error);
    return err(internalError(`平台用量查询失败：${message}`));
  }
}
