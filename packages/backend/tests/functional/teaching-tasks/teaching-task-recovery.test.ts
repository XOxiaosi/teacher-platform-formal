import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { createTeachingTaskService } from '../../../src/features/teaching-tasks/index.js';
import type { TeachingTaskService } from '../../../src/features/teaching-tasks/types.js';
import type { CommonError, Result } from '@teacher-platform/contracts';

const prisma = new PrismaClient();
const teacherId = `a01-recovery-${randomUUID()}`;
const tasks = createTeachingTaskService({ prisma, runtimeAvailability: 'test_only' });
function value<T>(result: Result<T, CommonError>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
async function running() {
  const conversation = value(await tasks.createConversation({ teacherId }));
  const received = value(await tasks.receiveMessage({ teacherId, conversationId: conversation.id, clientRequestId: randomUUID(), message: 'synthetic query task' }));
  const owner = value(await tasks.claim({ teacherId, taskId: received.task.id }));
  if ('unavailable' in owner) throw new Error('Expected synthetic owner');
  return { ...owner.lease, executionId: received.receipt.executionId, conversationId: conversation.id };
}
afterAll(async () => {
  await prisma.student.deleteMany({ where: { teacherId } });
  await prisma.stepReceipt.deleteMany({ where: { teacherId } });
  await prisma.agentExecution.deleteMany({ where: { teacherId } });
  await prisma.taskRuntime.deleteMany({ where: { teacherId } });
  await prisma.conversationTurn.deleteMany({ where: { teacherId } });
  await prisma.conversation.deleteMany({ where: { teacherId } });
  await prisma.$disconnect();
});

describe('A01 partial query recovery through the composed service', () => {
  it('keeps the successful result and retries only the unfinished query after reconstruction', async () => {
    const owner = await running();
    const key = (stepKey: string) => ({ ...owner, stepKey, kind: 'query' as const, inputFingerprint: stepKey.repeat(8) });
    const first = value(await tasks.prepareStep(key('one')));
    value(await tasks.completeStep({ ...key('one'), result: { resultId: 'saved-query-result' } }));
    const second = value(await tasks.prepareStep(key('two')));
    const failure = { ...key('two'), error: { code: 'SYNTHETIC', message: 'retry unfinished query', retryable: true } };
    value(await tasks.failStep(failure));
    expect(value(await tasks.failStep(failure)).id).toBe(second.id);
    const partial = value(await tasks.finish({ ...owner, status: 'partial', reply: 'first query saved' }));
    const rebuilt = createTeachingTaskService({ prisma, runtimeAvailability: 'test_only' });
    value(await rebuilt.resume({ ...owner, expectedVersion: partial.version }));
    const next = value(await rebuilt.claim(owner));
    if ('unavailable' in next) throw new Error('Expected resumed owner');
    const recoveredFirst = value(await rebuilt.prepareStep({ ...key('one'), ...next.lease }));
    expect(recoveredFirst).toMatchObject({ id: first.id, status: 'succeeded', result: { resultId: 'saved-query-result' } });
    expect(value(await rebuilt.prepareStep({ ...key('two'), ...next.lease })).id).toBe(second.id);
    value(await rebuilt.completeStep({ ...key('two'), ...next.lease, result: { resultId: 'second-query-result' } }));
    expect(value(await rebuilt.finish({ ...owner, ...next.lease, status: 'succeeded', reply: 'both saved' })).status).toBe('succeeded');
    const rows = await prisma.stepReceipt.findMany({ where: { taskId: owner.taskId }, orderBy: { stepKey: 'asc' } });
    expect(rows.map((row) => [row.stepKey, row.status, row.attemptCount])).toEqual([['one', 'succeeded', 1], ['two', 'succeeded', 2]]);
    expect(await prisma.agentExecution.count({ where: { taskId: owner.taskId } })).toBe(1);
    expect(await prisma.conversationTurn.count({ where: { taskId: owner.taskId, role: 'user' } })).toBe(1);
  });

  it('blocks unsupported tools, invalidated/uncertain query replay and writes after archival', async () => {
    const owner = await running();
    const step = { ...owner, stepKey: 'guarded', inputFingerprint: 'synthetic-query', kind: 'query' as const };
    for (const kind of ['capture', 'draft', 'confirmed_write']) {
      expect(await tasks.prepareStep({ ...step, kind } as Parameters<TeachingTaskService['prepareStep']>[0])).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    }
    expect(await tasks.prepareStep({ ...step, sourceRefs: [{ type: 'lesson', id: 'external', version: '1' }] })).toMatchObject({ ok: false });
    const prepared = value(await tasks.prepareStep(step));
    for (const status of ['invalidated', 'uncertain']) {
      await prisma.stepReceipt.update({ where: { id: prepared.id }, data: { status } });
      expect(await tasks.prepareStep(step)).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
      expect((await prisma.stepReceipt.findUniqueOrThrow({ where: { id: prepared.id } })).status).toBe(status);
    }
    await prisma.stepReceipt.update({ where: { id: prepared.id }, data: { status: 'running' } });
    await prisma.conversation.update({ where: { id: owner.conversationId }, data: { status: 'archived' } });
    const before = await prisma.conversationTurn.count({ where: { taskId: owner.taskId } });
    expect(await tasks.completeStep({ ...step, result: { forbidden: true } })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(await tasks.failStep({ ...step, error: { code: 'ARCHIVED', message: 'no writes', retryable: false } })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(await prisma.conversationTurn.count({ where: { taskId: owner.taskId } })).toBe(before);
    expect((await prisma.stepReceipt.findUniqueOrThrow({ where: { id: prepared.id } })).status).toBe('running');
  });

  it('stores source refs and invalidates a cached query after the source version changes', async () => {
    const owner = await running();
    const student = await prisma.student.create({ data: {
      teacherId, name: '来源校验学生', grade: 'grade-1', currentStatus: 'active',
    } });
    const ref = { type: 'Student', id: student.id, version: student.updatedAtTs.toISOString() };
    const step = { ...owner, stepKey: 'source-version', inputFingerprint: 'source-version-fingerprint', kind: 'query' as const };
    const prepared = value(await tasks.prepareStep({ ...step, sourceRefs: [ref] }));
    const completed = value(await tasks.completeStep({ ...step, result: {
      id: student.id, updatedAt: student.updatedAtTs, name: student.name,
    }, sourceRefs: [ref] }));
    expect(completed.sourceRefs).toEqual([ref]);
    await prisma.student.update({ where: { id: student.id }, data: { name: '来源已更新' } });
    expect(await tasks.prepareStep({ ...step, sourceRefs: [] })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(await prisma.stepReceipt.findUniqueOrThrow({ where: { id: prepared.id } })).toMatchObject({ status: 'invalidated' });
  });
});
