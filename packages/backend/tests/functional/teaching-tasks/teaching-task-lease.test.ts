import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { createTeachingTaskLeaseMethods } from '../../../src/features/teaching-tasks/teaching-task-lease.js';
import { createFieldCipherFromEnv, decryptFieldValue } from '../../../src/shared/field-encryption/index.js';

const prisma = new PrismaClient();
const teacherId = `a01-lease-${randomUUID()}`;
const cipher = createFieldCipherFromEnv();
const methods = createTeachingTaskLeaseMethods({ getClient: async () => prisma, cipher, availability: 'test_only', leaseMs: 60_000 });
const failure = { code: 'SYNTHETIC_FAILURE', message: 'synthetic interruption', retryable: true };
async function queued() {
  const conversation = await prisma.conversation.create({ data: { teacherId, runtimeOwner: 'dsh-v1' } });
  const task = await prisma.taskRuntime.create({ data: { teacherId, conversationId: conversation.id } });
  const execution = await prisma.agentExecution.create({ data: {
    teacherId, conversationId: conversation.id, taskId: task.id, clientRequestId: randomUUID(),
    requestFingerprint: 'synthetic', status: 'queued',
  } });
  await prisma.taskRuntime.update({ where: { id: task.id }, data: { currentExecutionId: execution.id, originExecutionId: execution.id } });
  return { teacherId, taskId: task.id, executionId: execution.id, conversationId: conversation.id };
}
async function running() {
  const fixture = await queued();
  const claim = await methods.claim(fixture);
  if (!claim.ok || 'unavailable' in claim.value) throw new Error('Expected synthetic lease');
  return { ...fixture, ...claim.value.lease };
}
afterAll(async () => {
  await prisma.stepReceipt.deleteMany({ where: { teacherId } });
  await prisma.agentExecution.deleteMany({ where: { teacherId } });
  await prisma.taskRuntime.deleteMany({ where: { teacherId } });
  await prisma.conversationTurn.deleteMany({ where: { teacherId } });
  await prisma.conversation.deleteMany({ where: { teacherId } });
  await prisma.$disconnect();
});

describe('A01 task lease and recovery transactions', () => {
  it('allows one concurrent owner and rejects stale lease after takeover', async () => {
    const fixture = await queued();
    const claims = await Promise.all([methods.claim(fixture), methods.claim(fixture)]);
    expect(claims.filter((result) => result.ok)).toHaveLength(1);
    const winner = claims.find((result) => result.ok);
    if (!winner?.ok || 'unavailable' in winner.value) throw new Error('Expected winner');
    const stale = { ...fixture, ...winner.value.lease };
    await prisma.taskRuntime.update({ where: { id: fixture.taskId }, data: { leaseExpiresAtTs: new Date(0) } });
    const takeover = await methods.claim(fixture);
    expect(takeover.ok).toBe(true);
    expect(await methods.heartbeat(stale)).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT', field: 'lease' } });
    expect(await methods.finish({ ...stale, status: 'succeeded', reply: 'stale' })).toMatchObject({ ok: false, error: { field: 'lease' } });
    expect(await prisma.conversationTurn.count({ where: { taskId: fixture.taskId, role: 'assistant' } })).toBe(0);
  });

  it('checks expiration after waiting for the conversation lock using wall clock in the DB', async () => {
    const fixture = await running();
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => { acquired = resolve; });
    const unlock = new Promise<void>((resolve) => { release = resolve; });
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "Conversation" WHERE id = ${fixture.conversationId} FOR UPDATE`);
      await tx.$executeRaw(Prisma.sql`UPDATE "TaskRuntime" SET "leaseExpiresAtTs" = clock_timestamp() + interval '250 milliseconds' WHERE id = ${fixture.taskId}`);
      acquired();
      await unlock;
      await tx.$queryRaw`SELECT 1 AS slept FROM pg_sleep(0.35)`;
    });
    await held;
    const heartbeat = methods.heartbeat(fixture);
    try {
      await expect.poll(async () => {
        const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%Conversation%FOR UPDATE%'`;
        return Number(rows[0]?.count ?? 0);
      }, { timeout: 1500, interval: 10 }).toBeGreaterThan(0);
    } finally { release(); }
    await blocker;
    expect(await heartbeat).toMatchObject({ ok: false, error: { field: 'lease' } });
  });

  it('keeps resume on the same execution and old retry cannot requeue a newly failed attempt', async () => {
    const fixture = await running();
    const firstFailure = await methods.finish({ ...fixture, status: 'failed', error: failure, reply: '  partial reply  ' });
    if (!firstFailure.ok) throw new Error('Expected persisted failure');
    const command = { ...fixture, expectedVersion: firstFailure.value.version };
    const resumed = await methods.resume(command);
    expect(resumed).toMatchObject({ ok: true, value: { replayed: false, task: { status: 'queued', currentExecutionId: fixture.executionId } } });
    const next = await methods.claim(fixture);
    if (!next.ok || 'unavailable' in next.value) throw new Error('Expected resumed owner');
    const failedAgain = await methods.finish({ ...fixture, ...next.value.lease, status: 'failed', error: failure });
    if (!failedAgain.ok) throw new Error('Expected second failure');
    const repeated = await methods.resume(command);
    expect(repeated).toMatchObject({ ok: true, value: { replayed: true, task: { status: 'failed', version: failedAgain.value.version } } });
    const fresh = await methods.resume({ ...fixture, expectedVersion: failedAgain.value.version });
    expect(fresh.ok).toBe(true);
    const finalClaim = await methods.claim(fixture);
    if (!finalClaim.ok || 'unavailable' in finalClaim.value) throw new Error('Expected final owner');
    expect(await methods.finish({ ...fixture, ...finalClaim.value.lease, status: 'succeeded', reply: 'final reply' })).toMatchObject({ ok: true, value: { status: 'succeeded' } });
    expect(await prisma.agentExecution.count({ where: { taskId: fixture.taskId } })).toBe(1);
    const replies = await prisma.conversationTurn.findMany({ where: { taskId: fixture.taskId, role: 'assistant' }, orderBy: { seq: 'asc' } });
    expect(replies.map((row) => decryptFieldValue(cipher, row.content))).toEqual(['  partial reply  ', 'final reply']);
    expect(new Set(replies.map((row) => row.eventKey)).size).toBe(2);
    const execution = await prisma.agentExecution.findUniqueOrThrow({ where: { id: fixture.executionId } });
    expect(decryptFieldValue(cipher, execution.reply!)).toBe('final reply');
  });

  it('records an unavailable resume once without pretending to queue a worker', async () => {
    const fixture = await queued();
    await prisma.taskRuntime.update({ where: { id: fixture.taskId }, data: { status: 'failed' } });
    const unavailable = createTeachingTaskLeaseMethods({ getClient: async () => prisma, cipher, availability: 'unavailable', leaseMs: 60_000 });
    const command = { ...fixture, expectedVersion: 0 };
    expect(await unavailable.resume(command)).toMatchObject({ ok: true, value: { replayed: false, task: { status: 'unavailable', canResume: false, version: 1 } } });
    expect(await unavailable.resume(command)).toMatchObject({ ok: true, value: { replayed: true, task: { status: 'unavailable', version: 1 } } });
    expect((await prisma.taskRuntime.findUniqueOrThrow({ where: { id: fixture.taskId } })).attemptCount).toBe(0);
  });

  it('rejects archived writes and uncertain recovery without appending misleading events', async () => {
    const fixture = await running();
    await prisma.conversation.update({ where: { id: fixture.conversationId }, data: { status: 'archived' } });
    const count = await prisma.conversationTurn.count({ where: { taskId: fixture.taskId } });
    expect(await methods.heartbeat(fixture)).toMatchObject({ ok: false, error: { field: 'conversationId' } });
    expect(await methods.finish({ ...fixture, status: 'succeeded' })).toMatchObject({ ok: false, error: { field: 'conversationId' } });
    expect(await prisma.conversationTurn.count({ where: { taskId: fixture.taskId } })).toBe(count);
    const uncertain = await running();
    await prisma.stepReceipt.create({ data: { teacherId, taskId: uncertain.taskId, executionId: uncertain.executionId, stepKey: 'uncertain-query', kind: 'query', inputFingerprint: 'synthetic', status: 'uncertain', leaseEpoch: uncertain.leaseEpoch } });
    const failed = await methods.finish({ ...uncertain, status: 'failed', error: failure });
    if (!failed.ok) throw new Error('Expected uncertain task failure');
    expect(failed.value.canResume).toBe(false);
    expect(await methods.resume({ ...uncertain, expectedVersion: failed.value.version })).toMatchObject({ ok: false, error: { field: 'stepStatus' } });
    const foreign = await methods.claim({ teacherId: 'another-teacher', taskId: uncertain.taskId });
    expect(foreign).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
