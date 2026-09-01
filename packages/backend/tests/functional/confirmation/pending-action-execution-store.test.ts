import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createPendingActionExecutionStore } from '../../../src/features/pending-action/pending-action-execution-store.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../../helpers/isolated-postgres.js';

const TEACHER_A = 'test-execution-store-teacher-a';
const TEACHER_B = 'test-execution-store-teacher-b';

let database: IsolatedPostgres;
let prisma: PrismaClient;
let toolSequence = 0;

async function now() {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  return rows[0].now;
}

async function createPending(input: { status?: string; expired?: boolean } = {}) {
  const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER_A } });
  const databaseNow = await now();
  return prisma.pendingAction.create({
    data: {
      teacherId: TEACHER_A,
      conversationId: conversation.id,
      toolCallId: `tool-${toolSequence += 1}`,
      actionName: 'students.updateStatus',
      targetType: 'Student',
      targetId: 'student-1',
      parameters: { studentId: 'student-1', status: 'paused' },
      afterSummary: '更新学生状态',
      status: input.status ?? 'pending',
      expiresAtTs: new Date(databaseNow.getTime() + (input.expired ? -1_000 : 600_000)),
    },
  });
}

beforeAll(async () => {
  database = await createIsolatedPostgres();
  prisma = database.prisma;
}, 60_000);

afterAll(async () => {
  await database.cleanup();
}, 30_000);

beforeEach(async () => {
  await prisma.pendingAction.deleteMany();
  await prisma.conversation.deleteMany();
});

describe('PendingActionExecutionStore', () => {
  it('数据库时间不读取本机时钟，跨 teacher 查询统一 NOT_FOUND', async () => {
    const record = await createPending();
    const store = createPendingActionExecutionStore(prisma);
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('不得读取本机时间'); });

    const trustedNow = await store.getDatabaseNow();
    const crossTeacher = await store.getOwned({ pendingActionId: record.id, teacherId: TEACHER_B });

    dateNow.mockRestore();
    expect(trustedNow.ok).toBe(true);
    expect(crossTeacher).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: '待确认操作不存在' },
    });
  });

  it('有效 pending 可原子 claim，重复 claim 返回 ALREADY_CONSUMED', async () => {
    const record = await createPending();
    const store = createPendingActionExecutionStore(prisma);
    const databaseNow = await now();

    const first = await store.claim({ pendingActionId: record.id, teacherId: TEACHER_A, databaseNow });
    const second = await store.claim({ pendingActionId: record.id, teacherId: TEACHER_A, databaseNow });

    expect(first).toMatchObject({
      ok: true,
      value: { kind: 'claimed', pendingAction: { id: record.id, status: 'executing' } },
    });
    expect(second).toEqual({
      ok: false,
      error: { code: 'ALREADY_CONSUMED', message: '待确认操作已被占用或消费' },
    });
  });

  it('并发 claim 只有一个成功', async () => {
    const record = await createPending();
    const store = createPendingActionExecutionStore(prisma);
    const databaseNow = await now();

    const results = await Promise.all(Array.from({ length: 6 }, () => store.claim({
      pendingActionId: record.id,
      teacherId: TEACHER_A,
      databaseNow,
    })));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error.code === 'ALREADY_CONSUMED')).toHaveLength(5);
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: record.id } })).status).toBe('executing');
  });

  it('过期 pending 在 claim 时落为 expired，且不进入 executing', async () => {
    const record = await createPending({ expired: true });
    const store = createPendingActionExecutionStore(prisma);

    const result = await store.claim({
      pendingActionId: record.id,
      teacherId: TEACHER_A,
      databaseNow: await now(),
    });

    expect(result).toMatchObject({
      ok: true,
      value: { kind: 'expired', pendingAction: { id: record.id, status: 'expired' } },
    });
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: record.id } })).status).toBe('expired');
  });

  it('executing 可按数据库时间消费，重复消费保持 ALREADY_CONSUMED', async () => {
    const record = await createPending({ status: 'executing' });
    const store = createPendingActionExecutionStore(prisma);
    const databaseNow = await now();

    const consumed = await store.markConsumed({ pendingActionId: record.id, teacherId: TEACHER_A, databaseNow });
    const repeated = await store.markConsumed({ pendingActionId: record.id, teacherId: TEACHER_A, databaseNow });

    expect(consumed).toMatchObject({
      ok: true,
      value: { status: 'consumed', consumedAt: databaseNow },
    });
    expect(repeated).toEqual({
      ok: false,
      error: { code: 'ALREADY_CONSUMED', message: '待确认操作已被占用或消费' },
    });
  });

  it('pending 可取消且重复取消幂等返回同一记录', async () => {
    const record = await createPending();
    const store = createPendingActionExecutionStore(prisma);
    const databaseNow = await now();

    const cancelled = await store.cancel({ pendingActionId: record.id, teacherId: TEACHER_A, databaseNow });
    const repeated = await store.cancel({ pendingActionId: record.id, teacherId: TEACHER_A, databaseNow });

    expect(cancelled).toMatchObject({ ok: true, value: { status: 'cancelled', cancelledAt: databaseNow } });
    expect(repeated).toEqual(cancelled);
  });

  it.each([
    ['executing', '待确认操作正在执行'],
    ['consumed', '待确认操作已消费'],
    ['expired', '待确认操作已过期'],
  ])('%s 状态不可取消', async (status, message) => {
    const record = await createPending({ status });
    const store = createPendingActionExecutionStore(prisma);

    const result = await store.cancel({
      pendingActionId: record.id,
      teacherId: TEACHER_A,
      databaseNow: await now(),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message, field: 'pendingActionId' },
    });
  });

  it('claim 状态变更将 updatedAt 写为同一 databaseNow', async () => {
    const record = await createPending();
    const store = createPendingActionExecutionStore(prisma);
    const databaseNow = await now();

    await store.claim({ pendingActionId: record.id, teacherId: TEACHER_A, databaseNow });
    const persisted = await prisma.pendingAction.findUniqueOrThrow({ where: { id: record.id } });

    expect(persisted.updatedAtTs).toEqual(databaseNow);
  });

  it('过期 claim 状态变更将 updatedAt 写为同一 databaseNow', async () => {
    const record = await createPending({ expired: true });
    const store = createPendingActionExecutionStore(prisma);
    const databaseNow = await now();

    await store.claim({ pendingActionId: record.id, teacherId: TEACHER_A, databaseNow });
    const persisted = await prisma.pendingAction.findUniqueOrThrow({ where: { id: record.id } });

    expect(persisted.status).toBe('expired');
    expect(persisted.updatedAtTs).toEqual(databaseNow);
  });

  it('markConsumed 使 updatedAt 与 consumedAt 同源为同一 databaseNow', async () => {
    const record = await createPending({ status: 'executing' });
    const store = createPendingActionExecutionStore(prisma);
    const databaseNow = await now();

    await store.markConsumed({ pendingActionId: record.id, teacherId: TEACHER_A, databaseNow });
    const persisted = await prisma.pendingAction.findUniqueOrThrow({ where: { id: record.id } });

    expect(persisted.consumedAtTs).toEqual(databaseNow);
    expect(persisted.updatedAtTs).toEqual(databaseNow);
    expect(persisted.updatedAtTs).toEqual(persisted.consumedAtTs);
  });

  it('cancel 使 updatedAt 与 cancelledAt 同源为同一 databaseNow', async () => {
    const record = await createPending();
    const store = createPendingActionExecutionStore(prisma);
    const databaseNow = await now();

    await store.cancel({ pendingActionId: record.id, teacherId: TEACHER_A, databaseNow });
    const persisted = await prisma.pendingAction.findUniqueOrThrow({ where: { id: record.id } });

    expect(persisted.cancelledAtTs).toEqual(databaseNow);
    expect(persisted.updatedAtTs).toEqual(databaseNow);
    expect(persisted.updatedAtTs).toEqual(persisted.cancelledAtTs);
  });

  it.each(['UTC', 'America/Los_Angeles'])('不同 session 时区 %s 下 updatedAt 仍与 databaseNow 同源', async (timeZone) => {
    const record = await createPending({ status: 'executing' });

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${timeZone}'`);
      const store = createPendingActionExecutionStore(tx);
      const dbNow = await store.getDatabaseNow();
      expect(dbNow.ok).toBe(true);
      if (!dbNow.ok) return;

      const consumed = await store.markConsumed({
        pendingActionId: record.id,
        teacherId: TEACHER_A,
        databaseNow: dbNow.value,
      });
      expect(consumed).toMatchObject({
        ok: true,
        value: { consumedAt: dbNow.value, updatedAt: dbNow.value },
      });
    });
  });
});
