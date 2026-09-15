import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { createTeachingTaskReader } from '../../../src/features/teaching-tasks/teaching-task-reader.js';
import { createFieldCipherFromEnv, encryptFieldValue } from '../../../src/shared/field-encryption/index.js';

const prisma = new PrismaClient();
const teacherId = `a01-reader-${randomUUID()}`;
const cipher = createFieldCipherFromEnv();
const reader = createTeachingTaskReader({ getClient: async () => prisma, cipher, availability: 'test_only' });
afterAll(async () => {
  await prisma.stepReceipt.deleteMany({ where: { teacherId } });
  await prisma.agentExecution.deleteMany({ where: { teacherId } });
  await prisma.taskRuntime.deleteMany({ where: { teacherId } });
  await prisma.conversationTurn.deleteMany({ where: { teacherId } });
  await prisma.conversation.deleteMany({ where: { teacherId } });
  await prisma.$disconnect();
});

describe('A01 durable task reader', () => {
  it('paginates all tasks across timestamp ties without truncation or repetition', async () => {
    const conversation = await prisma.conversation.create({ data: { teacherId, runtimeOwner: 'dsh-v1' } });
    const at = new Date('2026-09-01T00:00:00.000Z');
    const created: string[] = [];
    for (let index = 0; index < 7; index++) {
      const task = await prisma.taskRuntime.create({ data: { teacherId, conversationId: conversation.id, updatedAtTs: at } });
      created.push(task.id);
    }
    const found: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await reader.listTasks({ teacherId, conversationId: conversation.id, limit: 2, cursor });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected task page');
      found.push(...result.value.items.map((task) => task.id));
      if (!result.value.nextCursor) break;
      cursor = result.value.nextCursor;
    }
    expect(found).toEqual([...created].sort().reverse());
    expect(new Set(found).size).toBe(7);
    const invalid = Buffer.from(JSON.stringify(['invalid-date', created[0]])).toString('base64url');
    expect(await reader.listTasks({ teacherId, cursor: invalid })).toMatchObject({ ok: false, error: { field: 'cursor' } });
    expect(await reader.getTask({ teacherId: 'another-synthetic-teacher', taskId: created[0]! })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('recovers visible events across global sequence gaps while excluding erased and invalidated text', async () => {
    const conversation = await prisma.conversation.create({ data: { teacherId, runtimeOwner: 'dsh-v1' } });
    const task = await prisma.taskRuntime.create({ data: { teacherId, conversationId: conversation.id } });
    for (const seq of [1, 3, 5, 8]) {
      await prisma.conversationTurn.create({ data: {
        conversationId: conversation.id, teacherId, taskId: task.id, seq,
        eventKey: `reader-${seq}`, eventKind: 'message_received', role: 'user',
        content: encryptFieldValue(cipher, `  original ${seq}  `),
        redactedAtTs: seq === 3 ? new Date() : null,
        invalidatedAtTs: seq === 5 ? new Date() : null,
      } });
    }
    const first = await reader.listTaskEvents({ teacherId, taskId: task.id, limit: 1 });
    expect(first).toMatchObject({ ok: true, value: { items: [{ seq: 1, content: '  original 1  ' }], nextSeq: 1 } });
    const next = await reader.listTaskEvents({ teacherId, taskId: task.id, limit: 1, afterSeq: 1 });
    expect(next).toMatchObject({ ok: true, value: { items: [{ seq: 8, content: '  original 8  ' }], nextSeq: null } });
    expect(JSON.stringify(next)).not.toContain('original 3');
    expect(JSON.stringify(next)).not.toContain('original 5');
    expect(await reader.listTaskEvents({ teacherId: 'another-synthetic-teacher', taskId: task.id })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
