import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createAgentExecutionService } from '../../../src/features/agent-execution/index.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../../helpers/isolated-postgres.js';

const TEACHER = 'shadow-double-write-teacher';
let database: IsolatedPostgres;
let prisma: PrismaClient;

beforeAll(async () => {
  database = await createIsolatedPostgres('agent_shadow');
  prisma = database.prisma;
});

afterAll(async () => database.cleanup());

beforeEach(async () => {
  await prisma.conversationTurn.deleteMany();
  await prisma.agentExecution.deleteMany();
  await prisma.conversation.deleteMany();
});

async function createConversation() {
  return prisma.conversation.create({ data: { teacherId: TEACHER, status: 'active' } });
}

describe('AgentExecution 只写 *Ts 列（I9 删旧列后）', () => {
  it('claim 时只写 startedAtTs/createdAtTs/updatedAtTs，无旧列', async () => {
    const conv = await createConversation();
    const service = createAgentExecutionService({ prisma });
    const result = await service.claim({
      teacherId: TEACHER,
      conversationId: conv.id,
      message: 'test shadow double-write',
      clientRequestId: 'req-shadow-1',
      requestFingerprint: 'fp-shadow-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const record = await prisma.agentExecution.findUnique({
      where: { id: result.value.execution.id },
    });

    expect(record).not.toBeNull();
    expect(record!.startedAtTs).toBeInstanceOf(Date);
    expect(record!.createdAtTs).toBeInstanceOf(Date);
    expect(record!.updatedAtTs).toBeInstanceOf(Date);

    // 旧列已删除，不再双写
    expect(record).not.toHaveProperty('startedAt');
    expect(record).not.toHaveProperty('createdAt');
    expect(record).not.toHaveProperty('updatedAt');

    // 三个时刻来自同一次 TrustedClock
    expect(record!.startedAtTs.getTime()).toBe(record!.createdAtTs.getTime());
    expect(record!.createdAtTs.getTime()).toBe(record!.updatedAtTs.getTime());
  });

  it('complete 时只写 finishedAtTs/updatedAtTs，无旧列', async () => {
    const conv = await createConversation();
    const service = createAgentExecutionService({ prisma });

    const claimResult = await service.claim({
      teacherId: TEACHER,
      conversationId: conv.id,
      message: 'test complete shadow',
      clientRequestId: 'req-shadow-2',
      requestFingerprint: 'fp-shadow-2',
    });
    expect(claimResult.ok).toBe(true);
    if (!claimResult.ok) return;

    const completeResult = await service.complete({
      teacherId: TEACHER,
      executionId: claimResult.value.execution.id,
      status: 'succeeded',
      stage: 'persistence',
      reply: 'done',
      completedToolCallIds: [],
    });
    expect(completeResult.ok).toBe(true);
    if (!completeResult.ok) return;

    const record = await prisma.agentExecution.findUnique({
      where: { id: claimResult.value.execution.id },
    });

    expect(record).not.toBeNull();
    expect(record!.finishedAtTs).toBeInstanceOf(Date);
    expect(record!.updatedAtTs).toBeInstanceOf(Date);

    // 旧列已删除，不再双写
    expect(record).not.toHaveProperty('finishedAt');
    expect(record).not.toHaveProperty('updatedAt');

    // finishedAtTs 与 updatedAtTs 来自同一次 TrustedClock
    expect(record!.finishedAtTs!.getTime()).toBe(record!.updatedAtTs.getTime());

    // Invariant: finishedAtTs >= startedAtTs
    expect(record!.finishedAtTs!.getTime()).toBeGreaterThanOrEqual(record!.startedAtTs.getTime());
  });

  it('fail 时只写 finishedAtTs/updatedAtTs，无旧列', async () => {
    const conv = await createConversation();
    const service = createAgentExecutionService({ prisma });

    const claimResult = await service.claim({
      teacherId: TEACHER,
      conversationId: conv.id,
      message: 'test fail shadow',
      clientRequestId: 'req-shadow-3',
      requestFingerprint: 'fp-shadow-3',
    });
    expect(claimResult.ok).toBe(true);
    if (!claimResult.ok) return;

    const failResult = await service.fail({
      teacherId: TEACHER,
      executionId: claimResult.value.execution.id,
      status: 'failed',
      stage: 'model',
      error: { message: 'test error', code: 'TEST', retryable: false, retryAction: null },
      completedToolCallIds: [],
    });
    expect(failResult.ok).toBe(true);
    if (!failResult.ok) return;

    const record = await prisma.agentExecution.findUnique({
      where: { id: claimResult.value.execution.id },
    });

    expect(record).not.toBeNull();
    expect(record!.finishedAtTs).toBeInstanceOf(Date);
    expect(record!.updatedAtTs).toBeInstanceOf(Date);

    // 旧列已删除，不再双写
    expect(record).not.toHaveProperty('finishedAt');
    expect(record).not.toHaveProperty('updatedAt');

    // finishedAtTs 与 updatedAtTs 来自同一次 TrustedClock
    expect(record!.finishedAtTs!.getTime()).toBe(record!.updatedAtTs.getTime());
  });
});
