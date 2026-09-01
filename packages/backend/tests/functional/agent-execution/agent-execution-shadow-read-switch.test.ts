import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createAgentExecutionService } from '../../../src/features/agent-execution/index.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../../helpers/isolated-postgres.js';

const TEACHER = 'shadow-read-switch-teacher';
let database: IsolatedPostgres;
let prisma: PrismaClient;

beforeAll(async () => {
  database = await createIsolatedPostgres('agent_shadow_read');
  prisma = database.prisma;
});

afterAll(async () => database.cleanup());

beforeEach(async () => {
  await prisma.conversationTurn.deleteMany();
  await prisma.agentExecution.deleteMany();
  await prisma.conversation.deleteMany();
});

describe('AgentExecution 直接读 *Ts（I9 删旧列后无兜底）', () => {
  it('mapExecution 输出 startedAt/createdAt/updatedAt 来自 *Ts', async () => {
    const conv = await prisma.conversation.create({ data: { teacherId: TEACHER, status: 'active' } });
    const service = createAgentExecutionService({ prisma });
    const claim = await service.claim({
      teacherId: TEACHER,
      conversationId: conv.id,
      message: 'read switch test',
      clientRequestId: 'req-readswitch-1',
      requestFingerprint: 'fp-readswitch-1',
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const executionId = claim.value.execution.id;
    const got = await service.get({ teacherId: TEACHER, executionId });
    expect(got.ok).toBe(true);
    if (!got.ok) return;

    const record = await prisma.agentExecution.findUnique({ where: { id: executionId } });
    expect(record).not.toBeNull();

    // 领域字段直接来自 *Ts
    expect(got.value.startedAt).toEqual(record!.startedAtTs);
    expect(got.value.createdAt).toEqual(record!.createdAtTs);
    expect(got.value.updatedAt).toEqual(record!.updatedAtTs);

    // 旧列已删除，无兜底
    expect(record).not.toHaveProperty('startedAt');
    expect(record).not.toHaveProperty('createdAt');
    expect(record).not.toHaveProperty('updatedAt');
  });

  it('complete 后 mapExecution 输出 finishedAt 来自 finishedAtTs', async () => {
    const conv = await prisma.conversation.create({ data: { teacherId: TEACHER, status: 'active' } });
    const service = createAgentExecutionService({ prisma });
    const claim = await service.claim({
      teacherId: TEACHER,
      conversationId: conv.id,
      message: 'read switch complete test',
      clientRequestId: 'req-readswitch-2',
      requestFingerprint: 'fp-readswitch-2',
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const complete = await service.complete({
      teacherId: TEACHER,
      executionId: claim.value.execution.id,
      status: 'succeeded',
      stage: 'persistence',
      reply: 'done',
      completedToolCallIds: [],
    });
    expect(complete.ok).toBe(true);
    if (!complete.ok) return;

    const executionId = claim.value.execution.id;
    const got = await service.get({ teacherId: TEACHER, executionId });
    expect(got.ok).toBe(true);
    if (!got.ok) return;

    const record = await prisma.agentExecution.findUnique({ where: { id: executionId } });
    expect(record).not.toBeNull();

    // 领域 finishedAt 直接来自 finishedAtTs
    expect(got.value.finishedAt).toEqual(record!.finishedAtTs);
    expect(got.value.updatedAt).toEqual(record!.updatedAtTs);

    // 旧列已删除，无兜底
    expect(record).not.toHaveProperty('finishedAt');
    expect(record).not.toHaveProperty('updatedAt');
  });
});
