import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createProviderUsageService } from '../../../src/features/provider-usage/index.js';

const prisma = new PrismaClient();
const service = createProviderUsageService({ prisma });

const createdTeacherIds: string[] = [];
const createdUsageIds: string[] = [];

function uniqueId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

async function createTeacher(displayName: string): Promise<string> {
  const id = uniqueId('teacher');
  await prisma.teacherRegistry.create({
    data: {
      id,
      email: `${id}@example.com`,
      passwordHash: 'scrypt:test',
      displayName,
      status: 'active',
    },
  });
  createdTeacherIds.push(id);
  return id;
}

afterAll(async () => {
  await prisma.providerUsage.deleteMany({ where: { id: { in: createdUsageIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
});

describe('provider-usage 服务：采集落库', () => {
  it('厂商返回 usage → 直接落库（不估算）', async () => {
    const teacherId = await createTeacher('usage-t1');
    await service.record({
      teacherId,
      providerConfigId: 'cfg-deleted-later',
      providerName: 'deepseek',
      model: 'deepseek-chat',
      promptTokens: 100,
      completionTokens: 50,
      requestAt: new Date('2026-08-30T01:00:00.000Z'),
    });
    const rows = await prisma.providerUsage.findMany({
      where: { teacherId, providerName: 'deepseek' },
    });
    const row = rows[rows.length - 1];
    createdUsageIds.push(row.id);
    expect(row.promptTokens).toBe(100);
    expect(row.completionTokens).toBe(50);
    expect(row.providerConfigId).toBe('cfg-deleted-later');
    expect(row.estimatedCostUsd).toBeNull(); // 阶段一不估费
  });

  it('无厂商 usage → estimateTokens 兜底（请求消息 + 响应 content）', async () => {
    const teacherId = await createTeacher('usage-t2');
    await service.record({
      teacherId,
      providerName: 'qwen',
      model: 'qwen-plus',
      requestMessages: [
        { role: 'system', content: '你好' },      // 2 tokens
        { role: 'user', content: '今天天气很好' },  // 6 tokens
      ],
      responseContent: '晴转多云',                  // 4 tokens
      requestAt: new Date('2026-08-30T02:00:00.000Z'),
    });
    const rows = await prisma.providerUsage.findMany({ where: { teacherId, providerName: 'qwen' } });
    const row = rows[rows.length - 1];
    createdUsageIds.push(row.id);
    // join('\n') 分隔符按 other 字符计 ceil(1/4)=1 → 2+1+6=9
    expect(row.promptTokens).toBe(9);
    expect(row.completionTokens).toBe(4);
  });

  it('providerConfigId 删除后置 null 保留用量（无 FK 不阻塞）', async () => {
    const teacherId = await createTeacher('usage-t3');
    await service.record({
      teacherId,
      providerConfigId: 'cfg-nonexistent-fk-free',
      providerName: 'ark',
      model: 'doubao',
      promptTokens: 10,
      completionTokens: 5,
    });
    const rows = await prisma.providerUsage.findMany({ where: { teacherId, providerName: 'ark' } });
    const row = rows[rows.length - 1];
    createdUsageIds.push(row.id);
    // 无 FK：即使 config 不存在也能落库（历史保留语义）
    expect(row.providerConfigId).toBe('cfg-nonexistent-fk-free');
  });

  it('教学运行用量按 eventKey 幂等落库并保留执行身份', async () => {
    const teacherId = await createTeacher('usage-runtime');
    const input = {
      teacherId,
      providerName: 'deepseek',
      model: 'deepseek-flash',
      promptTokens: 12,
      completionTokens: 8,
      taskId: 'task-runtime-1',
      executionId: 'execution-runtime-1',
      sessionId: 'session-runtime-1',
      eventKey: 'session-runtime-1:execution:execution-runtime-1:event:3',
      outcome: 'completed',
      usageStatus: 'reported' as const,
      synthetic: false,
      requestAt: new Date('2026-09-16T03:00:00.000Z'),
    };
    await service.record(input);
    await service.record(input);
    const rows = await prisma.providerUsage.findMany({ where: { teacherId, eventKey: input.eventKey } });
    createdUsageIds.push(...rows.map((row) => row.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId: input.taskId,
      executionId: input.executionId,
      sessionId: input.sessionId,
      eventKey: input.eventKey,
      outcome: 'completed',
      usageStatus: 'reported',
      synthetic: false,
    });
  });
});

describe('provider-usage 服务：summary 聚合', () => {
  it('按时间段聚合 prompt/completion/总请求 + 按 provider/model 分组', async () => {
    const teacherId = await createTeacher('usage-sum');
    const base = new Date('2026-08-30T03:00:00.000Z');
    for (const [i, providerName] of ['deepseek', 'deepseek', 'qwen'].entries()) {
      await service.record({
        teacherId,
        providerName,
        model: providerName === 'deepseek' ? 'deepseek-chat' : 'qwen-plus',
        promptTokens: 10 * (i + 1),
        completionTokens: 5 * (i + 1),
        requestAt: new Date(base.getTime() + i * 60_000),
      });
    }
    const rows = await prisma.providerUsage.findMany({ where: { teacherId, providerName: { in: ['deepseek', 'qwen'] } } });
    createdUsageIds.push(...rows.map((r) => r.id));

    const summary = await service.summary(
      teacherId,
      new Date('2026-08-30T00:00:00.000Z'),
      new Date('2026-08-31T00:00:00.000Z'),
    );
    // deepseek ×2: prompt 10+20=30, completion 5+10=15；qwen ×1: prompt 30, completion 15
    expect(summary.totals.promptTokens).toBe(60);
    expect(summary.totals.completionTokens).toBe(30);
    expect(summary.totals.totalTokens).toBe(90);
    expect(summary.totals.requests).toBe(3);
    expect(summary.byProvider).toHaveLength(2);
    const deepseek = summary.byProvider.find((p) => p.providerName === 'deepseek');
    expect(deepseek?.requests).toBe(2);
    expect(deepseek?.promptTokens).toBe(30);
  });

  it('owner 隔离：A 的用量不出现在 B 的 summary', async () => {
    const teacherA = await createTeacher('usage-owner-a');
    const teacherB = await createTeacher('usage-owner-b');
    await service.record({
      teacherId: teacherA,
      providerName: 'deepseek',
      model: 'deepseek-chat',
      promptTokens: 99,
      completionTokens: 1,
      requestAt: new Date('2026-08-30T04:00:00.000Z'),
    });
    const aRows = await prisma.providerUsage.findMany({ where: { teacherId: teacherA } });
    createdUsageIds.push(...aRows.map((r) => r.id));

    const bSummary = await service.summary(
      teacherB,
      new Date('2026-08-30T00:00:00.000Z'),
      new Date('2026-08-31T00:00:00.000Z'),
    );
    expect(bSummary.totals.requests).toBe(0);
    expect(bSummary.totals.promptTokens).toBe(0);
  });

  it('时间段过滤：窗口外的用量不计', async () => {
    const teacherId = await createTeacher('usage-window');
    await service.record({
      teacherId,
      providerName: 'deepseek',
      model: 'deepseek-chat',
      promptTokens: 50,
      completionTokens: 5,
      requestAt: new Date('2026-07-01T00:00:00.000Z'), // 8 月窗口外
    });
    const rows = await prisma.providerUsage.findMany({ where: { teacherId, providerName: 'deepseek' } });
    createdUsageIds.push(...rows.map((r) => r.id));

    const summary = await service.summary(
      teacherId,
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-08-31T00:00:00.000Z'),
    );
    expect(summary.totals.requests).toBe(0);
  });
});
