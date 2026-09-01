import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { err, internalError, ok, type CommonError, type Result } from '@teacher-platform/contracts';
import { createAgentExecutionService } from '../../src/features/agent-execution/index.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../helpers/isolated-postgres.js';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';

// P8 phase-3 批3：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);

const TEACHER_A = 'agent-execution-teacher-a';
const TEACHER_B = 'agent-execution-teacher-b';
let database: IsolatedPostgres;
let prisma: PrismaClient;

beforeAll(async () => {
  database = await createIsolatedPostgres('agent_execution');
  prisma = database.prisma;
});
afterAll(async () => database.cleanup());
beforeEach(async () => {
  await prisma.conversationTurn.deleteMany();
  await prisma.agentExecution.deleteMany();
  await prisma.conversation.deleteMany();
});

async function conversation(status = 'active') {
  return prisma.conversation.create({ data: { teacherId: TEACHER_A, status } });
}

function claimInput(conversationId: string, overrides: Partial<{
  teacherId: string; clientRequestId: string; message: string;
}> = {}) {
  return {
    teacherId: overrides.teacherId ?? TEACHER_A,
    conversationId,
    clientRequestId: overrides.clientRequestId ?? 'request-00000001',
    message: overrides.message ?? '查一下今天的课程',
  };
}

function trustedClock(...results: Array<Result<Date, CommonError>>) {
  let index = 0;
  return {
    now: vi.fn(async () => results[Math.min(index++, results.length - 1)]!),
  };
}

describe('AgentExecutionService', () => {
  it('claim 原子创建 running execution 与唯一 user turn', async () => {
    const conv = await conversation();
    const service = createAgentExecutionService({ prisma });
    const result = await service.claim(claimInput(conv.id));

    expect(result).toMatchObject({ ok: true, value: { kind: 'claimed', execution: { status: 'running' } } });
    expect(await prisma.agentExecution.count()).toBe(1);
    expect(await prisma.conversationTurn.count({ where: { role: 'user' } })).toBe(1);
  });

  it('claim 使用同一个 PostgreSQL 可信时刻创建 execution 与 user turn', async () => {
    const conv = await conversation();
    const startedAt = new Date('2030-01-02T03:04:05.006Z');
    const clock = trustedClock(ok(startedAt));
    const service = createAgentExecutionService({ prisma, trustedClock: clock });

    const result = await service.claim(claimInput(conv.id));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.execution.startedAt).toEqual(startedAt);
    expect(result.value.execution.createdAt).toEqual(startedAt);
    expect(result.value.execution.updatedAt).toEqual(startedAt);
    expect((await prisma.conversationTurn.findFirstOrThrow({ where: { role: 'user' } })).createdAtTs).toEqual(startedAt);
    expect(clock.now).toHaveBeenCalledTimes(1);
  });

  it('并发相同请求只创建一条 execution 与 user turn', async () => {
    const conv = await conversation();
    const service = createAgentExecutionService({ prisma });
    const results = await Promise.all(Array.from({ length: 6 }, () => service.claim(claimInput(conv.id))));

    expect(results.filter((result) => result.ok && result.value.kind === 'claimed')).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.value.kind === 'existing')).toHaveLength(5);
    expect(await prisma.agentExecution.count()).toBe(1);
    expect(await prisma.conversationTurn.count({ where: { role: 'user' } })).toBe(1);
  });

  it('同 key 不同 message 拒绝，跨 teacher 与归档会话 fail-closed', async () => {
    const conv = await conversation();
    const archived = await conversation('archived');
    const service = createAgentExecutionService({ prisma });
    await service.claim(claimInput(conv.id));

    expect(await service.claim(claimInput(conv.id, { message: '另一条消息' }))).toMatchObject({
      ok: false, error: { code: 'VALIDATION_ERROR', field: 'clientRequestId' },
    });
    expect(await service.claim(claimInput(conv.id, { teacherId: TEACHER_B, clientRequestId: 'request-00000002' }))).toMatchObject({
      ok: false, error: { code: 'NOT_FOUND' },
    });
    expect(await service.claim(claimInput(archived.id, { clientRequestId: 'request-00000003' }))).toMatchObject({
      ok: false, error: { code: 'VALIDATION_ERROR', field: 'status' },
    });
  });

  it('fail 在同一事务写 error turn 与 failed execution', async () => {
    const conv = await conversation();
    const service = createAgentExecutionService({ prisma });
    const claimed = await service.claim(claimInput(conv.id));
    if (!claimed.ok) throw new Error(claimed.error.message);

    const result = await service.fail({
      teacherId: TEACHER_A,
      executionId: claimed.value.execution.id,
      stage: 'model',
      status: 'failed',
      error: { code: 'INTERNAL_ERROR', message: '模型响应超时' },
      retryable: true,
      retryAction: 'retry-model',
      completedToolCallIds: [],
    });

    expect(result).toMatchObject({ ok: true, value: { status: 'failed', stage: 'model' } });
    const errorTurn = await prisma.conversationTurn.findFirstOrThrow({ where: { role: 'error' } });
    // P8 phase-3 批3：toolResults 落库为密文，解密后断言
    expect(errorTurn.toolResults).not.toMatchObject({ executionId: claimed.value.execution.id });
    expect(cipher.decryptJson<unknown>(errorTurn.toolResults as unknown as string)).toMatchObject({
      executionId: claimed.value.execution.id,
      stage: 'model',
    });
    expect(await service.prepareReplay({
      teacherId: TEACHER_A,
      executionId: claimed.value.execution.id,
      clientRequestId: 'request-replay-0001',
    })).toEqual({
      ok: true,
      value: {
        conversationId: conv.id,
        message: '查一下今天的课程',
        clientRequestId: 'request-replay-0001',
      },
    });
  });

  it('complete 使用第二个 PostgreSQL 可信时刻且不会产生负耗时', async () => {
    const conv = await conversation();
    const startedAt = new Date('2030-01-02T03:04:05.000Z');
    const finishedAt = new Date('2030-01-02T03:04:06.250Z');
    const clock = trustedClock(ok(startedAt), ok(finishedAt));
    const service = createAgentExecutionService({ prisma, trustedClock: clock });
    const claimed = await service.claim(claimInput(conv.id));
    if (!claimed.ok) throw new Error(claimed.error.message);

    const result = await service.complete({
      teacherId: TEACHER_A,
      executionId: claimed.value.execution.id,
      status: 'succeeded',
      stage: 'model',
      reply: '完成',
      completedToolCallIds: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.finishedAt).toEqual(finishedAt);
    expect(result.value.updatedAt).toEqual(finishedAt);
    expect(result.value.finishedAt!.getTime() - result.value.startedAt.getTime()).toBe(1_250);
    expect(clock.now).toHaveBeenCalledTimes(2);
  });

  it('fail 的 execution 与 error turn 使用同一个 PostgreSQL 可信结束时刻', async () => {
    const conv = await conversation();
    const startedAt = new Date('2030-01-02T03:04:05.000Z');
    const finishedAt = new Date('2030-01-02T03:04:07.500Z');
    const clock = trustedClock(ok(startedAt), ok(finishedAt));
    const service = createAgentExecutionService({ prisma, trustedClock: clock });
    const claimed = await service.claim(claimInput(conv.id));
    if (!claimed.ok) throw new Error(claimed.error.message);

    const result = await service.fail({
      teacherId: TEACHER_A,
      executionId: claimed.value.execution.id,
      stage: 'model',
      status: 'failed',
      error: { code: 'INTERNAL_ERROR', message: '模型响应超时' },
      retryable: true,
      retryAction: 'retry-model',
      completedToolCallIds: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.finishedAt).toEqual(finishedAt);
    expect(result.value.updatedAt).toEqual(finishedAt);
    expect((await prisma.conversationTurn.findFirstOrThrow({ where: { role: 'error' } })).createdAtTs).toEqual(finishedAt);
    expect(clock.now).toHaveBeenCalledTimes(2);
  });

  it('claim 在 TrustedClock 失败时零写入', async () => {
    const conv = await conversation();
    const clock = trustedClock(err(internalError('数据库可信时间不可用')));
    const service = createAgentExecutionService({ prisma, trustedClock: clock });

    expect(await service.claim(claimInput(conv.id))).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '数据库可信时间不可用' },
    });
    expect(await prisma.agentExecution.count()).toBe(0);
    expect(await prisma.conversationTurn.count()).toBe(0);
  });

  it('complete 在 TrustedClock 失败时保持 running', async () => {
    const conv = await conversation();
    const clock = trustedClock(
      ok(new Date('2030-01-02T03:04:05.000Z')),
      err(internalError('数据库可信时间不可用')),
    );
    const service = createAgentExecutionService({ prisma, trustedClock: clock });
    const claimed = await service.claim(claimInput(conv.id));
    if (!claimed.ok) throw new Error(claimed.error.message);

    expect(await service.complete({
      teacherId: TEACHER_A,
      executionId: claimed.value.execution.id,
      status: 'succeeded',
      stage: 'model',
      reply: '完成',
      completedToolCallIds: [],
    })).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '数据库可信时间不可用' },
    });
    expect(await prisma.agentExecution.findUniqueOrThrow({ where: { id: claimed.value.execution.id } })).toMatchObject({
      status: 'running',
      finishedAtTs: null,
    });
  });

  it('fail 在 TrustedClock 失败时保持 running 且不创建 error turn', async () => {
    const conv = await conversation();
    const clock = trustedClock(
      ok(new Date('2030-01-02T03:04:05.000Z')),
      err(internalError('数据库可信时间不可用')),
    );
    const service = createAgentExecutionService({ prisma, trustedClock: clock });
    const claimed = await service.claim(claimInput(conv.id));
    if (!claimed.ok) throw new Error(claimed.error.message);

    expect(await service.fail({
      teacherId: TEACHER_A,
      executionId: claimed.value.execution.id,
      stage: 'model',
      status: 'failed',
      error: { code: 'INTERNAL_ERROR', message: '模型响应超时' },
      retryable: true,
      retryAction: 'retry-model',
      completedToolCallIds: [],
    })).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '数据库可信时间不可用' },
    });
    expect(await prisma.agentExecution.findUniqueOrThrow({ where: { id: claimed.value.execution.id } })).toMatchObject({
      status: 'running',
      finishedAtTs: null,
    });
    expect(await prisma.conversationTurn.count({ where: { role: 'error' } })).toBe(0);
  });

  it('complete 只更新当前 teacher 的 running execution', async () => {
    const conv = await conversation();
    const service = createAgentExecutionService({ prisma });
    const claimed = await service.claim(claimInput(conv.id));
    if (!claimed.ok) throw new Error(claimed.error.message);

    expect(await service.complete({
      teacherId: TEACHER_A,
      executionId: claimed.value.execution.id,
      status: 'succeeded',
      stage: 'model',
      reply: '完成',
      completedToolCallIds: [],
    })).toMatchObject({ ok: true, value: { status: 'succeeded', reply: '完成' } });
    expect(await service.get({ teacherId: TEACHER_B, executionId: claimed.value.execution.id })).toMatchObject({
      ok: false, error: { code: 'NOT_FOUND' },
    });
  });
});
