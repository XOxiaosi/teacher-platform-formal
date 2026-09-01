/**
 * Provider 用量采集与统计（P7 渠道线 · t69，t57 设计 §4）。
 *
 * 采集：createRoutingAiClient 的 chat/run 成功后落一行 ProviderUsage——
 * 厂商返回 usage 优先（NormalizedResponse.usage），不返回则 t48 estimateTokens 兜底
 * （请求侧消息估算 + 响应 content 估算）。
 * 与 t48 预算衔接：预算在调用前检查（checkAndConsume 管上限），usage 在调用后记录实耗。
 *
 * 统计：GET /api/v1/usage/summary?from&to 按教师聚合（owner 隔离）。
 */

import type { PrismaClient } from '@prisma/client';
import type { ChatMessage } from '../../shared/ai-client/types.js';
import { estimateTokens } from '../../shared/agent-cost/agent-cost.js';

export interface RecordUsageInput {
  teacherId: string;
  providerConfigId?: string | null;
  providerName: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  /** 请求侧消息（无厂商 usage 时兜底估算 prompt 用）。 */
  requestMessages?: ChatMessage[];
  /** 响应 content（无厂商 usage 时兜底估算 completion 用）。 */
  responseContent?: string;
  conversationId?: string | null;
  requestAt?: Date;
}

export interface UsageSummaryRow {
  providerName: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
}

export interface UsageSummary {
  from: string;
  to: string;
  totals: { promptTokens: number; completionTokens: number; totalTokens: number; requests: number };
  byProvider: UsageSummaryRow[];
}

export interface ProviderUsageService {
  /** 记录一次用量（routing client 成功回调调用）。 */
  record(input: RecordUsageInput): Promise<void>;
  /** 按教师聚合（owner 隔离，时间段过滤）。 */
  summary(teacherId: string, from: Date, to: Date): Promise<UsageSummary>;
}

export interface CreateProviderUsageServiceOptions {
  prisma: PrismaClient;
}

export function createProviderUsageService(options: CreateProviderUsageServiceOptions): ProviderUsageService {
  const { prisma } = options;

  async function record(input: RecordUsageInput): Promise<void> {
    let promptTokens = input.promptTokens;
    let completionTokens = input.completionTokens;

    // 厂商未返回 usage → t48 estimateTokens 兜底估算
    if (promptTokens === undefined) {
      const requestText = (input.requestMessages ?? [])
        .map((message) => message.content)
        .join('\n');
      promptTokens = estimateTokens(requestText);
    }
    if (completionTokens === undefined) {
      completionTokens = estimateTokens(input.responseContent ?? '');
    }

    await prisma.providerUsage.create({
      data: {
        teacherId: input.teacherId,
        providerConfigId: input.providerConfigId ?? null,
        providerName: input.providerName,
        model: input.model,
        promptTokens,
        completionTokens,
        conversationId: input.conversationId ?? null,
        requestAt: input.requestAt ?? new Date(),
      },
    });
  }

  async function summary(teacherId: string, from: Date, to: Date): Promise<UsageSummary> {
    const rows = await prisma.providerUsage.findMany({
      where: {
        teacherId,
        requestAt: { gte: from, lte: to },
      },
      orderBy: { requestAt: 'asc' },
    });

    const byProviderMap = new Map<string, UsageSummaryRow>();
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

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        promptTokens: totalPrompt,
        completionTokens: totalCompletion,
        totalTokens: totalPrompt + totalCompletion,
        requests: rows.length,
      },
      byProvider: [...byProviderMap.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    };
  }

  return { record, summary };
}
