import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { createIsolatedPostgres, type IsolatedPostgres } from '../../helpers/isolated-postgres.js';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';
import { createTeachingTaskService } from '../../../src/features/teaching-tasks/index.js';
import { createTeachingTaskRuntimeRunner } from '../../../src/app/teaching-runtime/task-runtime-runner.js';
import type { TeachingRuntimeDriver } from '../../../src/app/teaching-runtime/runtime-driver.js';
import { createActionTokenSigner, createPendingActionService } from '../../../src/features/pending-action/index.js';
import { createConfirmationTransactionPort } from '../../../src/app/confirmation/confirmation-transaction-port.js';
import { createConfirmPendingActionUseCase } from '../../../src/app/use-cases/confirm-pending-action/index.js';
import { createCancelPendingActionUseCase } from '../../../src/app/use-cases/cancel-pending-action/index.js';
import { createConversationService } from '../../../src/features/conversation/index.js';
import { extractToolCallIds, toAgentTurnDtos } from '../../../src/app/routes/conversation-response.js';
import { createTeachingRegistry } from '../../../src/app/teaching-runtime/create-teaching-registry.js';
import { parseCreateCandidate } from '../../../src/app/confirmation/teaching-create-actions.js';

let database: IsolatedPostgres;
let prisma: PrismaClient;
const cipher = createFieldCipher(loadEncryptionKey().key);
const signer = createActionTokenSigner({ secret: 'synthetic-proposal-secret-at-least-32-characters' });
beforeAll(async () => { database = await createIsolatedPostgres(); prisma = database.prisma; });
afterAll(async () => { await database?.cleanup(); });

async function setup() {
  const teacherId = `proposal-${randomUUID()}`;
  const tasks = createTeachingTaskService({ prisma, cipher, runtimeAvailability: 'test_only' });
  const conversation = await tasks.createConversation({ teacherId }); if (!conversation.ok) throw new Error('conversation');
  const conversationId = conversation.value.id;
  const students = await Promise.all(['合成甲', '合成乙'].map(name => prisma.student.create({ data: { teacherId, name, grade: '高一' } })));
  const conversations = createConversationService({ prisma, cipher });
  const pending = createPendingActionService({ prisma, cipher, actionTokenSigner: signer,
    conversationOwner: { getOwnedConversation: input => conversations.getConversation(input) } });
  const transaction = createConfirmationTransactionPort({ rawPrisma: prisma });
  const confirm = createConfirmPendingActionUseCase({ actionTokenSigner: signer, transaction });
  async function prepare(name = 'scheduling.prepare', args: unknown = { day: '2090-09-23', start: '10:00', end: '12:00',
    participants: [students[0].id], format: '一对一', location: '合成教室', recurrence: 'once' }) {
    const received = await tasks.receiveMessage({ teacherId, conversationId, clientRequestId: randomUUID(), message: '准备已明确日期的课程与备忘' });
    if (!received.ok) throw new Error('receipt');
    const driver: TeachingRuntimeDriver = { availability: 'test', runtimeVersion: 'dsh-v1', async run(input) {
      const prepared = await input.tools.execute(name, args);
      if (!prepared.ok) return { ok: false, error: { ...prepared.error, retryable: false } };
      return { ok: true, value: { reply: '请逐项核对确认卡，尚未保存。', sessionRef: `synthetic:${input.taskId}`,
        status: 'waiting_input', checkpoint: null,
        cost: { modelCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 1, synthetic: true } } };
    } };
    const runner = createTeachingTaskRuntimeRunner({ prisma, cipher, tasks, driver, actionTokenSigner: signer });
    const result = await runner.run({ teacherId, taskId: received.value.task.id });
    return { result, taskId: received.value.task.id };
  }
  async function card() {
    const rows = await conversations.listConversationTurnsPage({ teacherId, conversationId }); if (!rows.ok) throw new Error('turns');
    const actions = await pending.listForConversationToolCalls({ teacherId, conversationId, toolCallIds: extractToolCallIds(rows.value.items) });
    if (!actions.ok) throw new Error('pending');
    const latestToolCallId = extractToolCallIds(rows.value.items).at(-1);
    const action = actions.value.find(item => item.pendingAction.toolCallId === latestToolCallId);
    if (!action) throw new Error('no confirmation card');
    const dtos = toAgentTurnDtos(rows.value.items, actions.value);
    expect(dtos.some(turn => turn.kind === 'confirmation')).toBe(true);
    return { action, input: { teacherId, pendingActionId: action.pendingAction.id, actionToken: action.actionToken } };
  }
  return { teacherId, students, prepare, card, confirm, transaction, pending, conversationId, conversations };
}

describe('CHAT-003 proposal to teacher confirmation', () => {
  it('prepares a persisted card without writing, then saves once without deducting lessons', async () => {
    const s = await setup(); expect((await s.prepare()).result.ok).toBe(true);
    expect(await prisma.schedule.count({ where: { teacherId: s.teacherId } })).toBe(0);
    const { input } = await s.card();
    expect((await s.confirm.confirm(input)).ok).toBe(true);
    expect((await s.confirm.confirm(input)).ok).toBe(false);
    expect(await prisma.schedule.count({ where: { teacherId: s.teacherId } })).toBe(1);
    expect(await prisma.lesson.count({ where: { teacherId: s.teacherId } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: s.teacherId, source: 'agent-confirmed' } })).toBe(1);
    // Repeating the candidate in a later chat turn reuses its durable proposal.
    expect((await s.prepare()).result.ok).toBe(true);
    expect(await prisma.pendingAction.count({ where: { teacherId: s.teacherId } })).toBe(1);
    const repeated = await s.conversations.listConversationTurnsPage({ teacherId: s.teacherId, conversationId: s.conversationId });
    if (!repeated.ok) throw new Error('turns');
    const pending = await s.pending.listForConversationToolCalls({ teacherId: s.teacherId, conversationId: s.conversationId,
      toolCallIds: extractToolCallIds(repeated.value.items) });
    if (!pending.ok) throw new Error('actions');
    const cards = toAgentTurnDtos(repeated.value.items, pending.value).filter(turn => turn.kind === 'confirmation');
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map(card => card.id)).size).toBe(2);
    expect(cards.every(card => card.kind === 'confirmation' && card.status === 'consumed')).toBe(true);
    expect(await prisma.schedule.count({ where: { teacherId: s.teacherId } })).toBe(1);
  });

  it('prepares and confirms a memo with no invented reminder time', async () => {
    const s = await setup();
    expect((await s.prepare('memos.prepare', { title: '联系家长', content: '周一下午联系合成甲的家长，具体时间待定' })).result.ok).toBe(true);
    expect(await prisma.memo.count({ where: { teacherId: s.teacherId } })).toBe(0);
    const { input } = await s.card(); expect((await s.confirm.confirm(input)).ok).toBe(true);
    expect(await prisma.memo.findFirst({ where: { teacherId: s.teacherId } })).toMatchObject({ dueAtTs: null });
    expect((await s.confirm.confirm(input)).ok).toBe(false);
    expect(await prisma.memo.count({ where: { teacherId: s.teacherId } })).toBe(1);
  });

  it('rejects empty group membership, ambiguous recurrence and foreign students', async () => {
    const s = await setup(); const fields = { day: '2090-09-23', start: '10:00', end: '12:00', location: '教室', recurrence: 'once' };
    expect((await s.prepare('scheduling.prepare', { ...fields, participants: [], format: '小班' })).result.ok).toBe(false);
    expect((await s.prepare('scheduling.prepare', { ...fields, participants: [s.students[0].id], format: '一对一', recurrence: 'weekly' })).result.ok).toBe(false);
    const other = await setup();
    expect((await s.prepare('scheduling.prepare', { ...fields, participants: [other.students[0].id], format: '一对一' })).result.ok).toBe(false);
    expect(await prisma.pendingAction.count({ where: { teacherId: s.teacherId } })).toBe(0);
    expect(await prisma.schedule.count({ where: { teacherId: s.teacherId } })).toBe(0);
  });

  it('rejects token, identity, cancelled and expired actions with no business writes', async () => {
    const s = await setup(); await s.prepare(); const { input } = await s.card();
    expect((await s.confirm.confirm({ ...input, actionToken: 'bad-token' })).ok).toBe(false);
    expect((await s.confirm.confirm({ ...input, teacherId: 'other-teacher' })).ok).toBe(false);
    await createCancelPendingActionUseCase({ transaction: s.transaction }).cancel(input);
    expect((await s.confirm.confirm(input)).ok).toBe(false);
    const e = await setup(); await e.prepare(); const ec = await e.card();
    await prisma.pendingAction.update({ where: { id: ec.input.pendingActionId }, data: { expiresAtTs: new Date('2000-01-01') } });
    expect((await e.confirm.confirm(ec.input)).ok).toBe(false);
    expect(await prisma.schedule.count({ where: { teacherId: { in: [s.teacherId, e.teacherId] } } })).toBe(0);
  });

  it('rechecks student versions and schedule conflicts at confirmation', async () => {
    const s = await setup(); await s.prepare(); const { input } = await s.card();
    await prisma.student.update({ where: { id: s.students[0].id }, data: { updatedAtTs: new Date('2090-01-01') } });
    expect((await s.confirm.confirm(input)).ok).toBe(false);
    expect(await prisma.schedule.count({ where: { teacherId: s.teacherId } })).toBe(0);
    const c = await setup(); await c.prepare(); const cc = await c.card();
    await prisma.schedule.create({ data: { teacherId: c.teacherId, type: 'lesson', title: '冲突课程',
      scheduledStartTs: new Date('2090-09-23T10:00:00+08:00'), scheduledEndTs: new Date('2090-09-23T12:00:00+08:00') } });
    expect((await c.confirm.confirm(cc.input)).ok).toBe(false);
    expect(await prisma.schedule.count({ where: { teacherId: c.teacherId } })).toBe(1);
    expect((await c.pending.getPendingAction(cc.input)).ok).toBe(true);
    expect(await prisma.pendingAction.findUnique({ where: { id: cc.input.pendingActionId } })).toMatchObject({ status: 'pending' });
  });

  it('allows a fresh proposal after cancellation, expiry, or a student version change', async () => {
    for (const state of ['cancelled', 'expired', 'changed'] as const) {
      const s = await setup(); await s.prepare(); const old = await s.card();
      if (state === 'changed') await prisma.student.update({ where: { id: s.students[0].id }, data: { updatedAtTs: new Date('2091-01-01') } });
      else await prisma.pendingAction.update({ where: { id: old.input.pendingActionId }, data: state === 'expired'
        ? { expiresAtTs: new Date('2000-01-01') } : { status: 'cancelled' } });
      expect((await s.confirm.confirm(old.input)).ok).toBe(false);
      expect((await s.prepare()).result.ok).toBe(true);
      const fresh = await s.card(); expect(fresh.input.pendingActionId).not.toBe(old.input.pendingActionId);
      expect((await s.confirm.confirm(fresh.input)).ok).toBe(true);
      expect(await prisma.schedule.count({ where: { teacherId: s.teacherId } })).toBe(1);
    }
  });

  it('projects only a persisted student write as saved with a view link', async () => {
    const s = await setup();
    expect((await s.prepare('students.create', { name: '合成新生', grade: '初二' })).result.ok).toBe(true);
    expect((await s.prepare('students.create', { name: '合成新生', grade: '初二' })).result.ok).toBe(false);
    expect(await prisma.student.count({ where: { teacherId: s.teacherId, name: '合成新生' } })).toBe(1);
    const page = await s.conversations.listConversationTurnsPage({ teacherId: s.teacherId, conversationId: s.conversationId });
    if (!page.ok) throw new Error('turns');
    const student = await prisma.student.findFirstOrThrow({ where: { teacherId: s.teacherId, name: '合成新生' } });
    expect(toAgentTurnDtos(page.value.items)).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'tool', toolName: 'students.create', status: 'success', resultSummary: '学生 合成新生 已保存',
      references: [{ type: 'Student', id: student.id, label: '查看学生 合成新生', route: `students/${student.id}` }],
    })]));
  });

  it('keeps concurrent duplicate student creation tenant-scoped and at most once', async () => {
    const s = await setup();
    const registry = createTeachingRegistry(async () => prisma);
    const results = await Promise.all([0, 1].map(() => registry.execute('students.create',
      { name: ' 合成并发学生 ', grade: ' 初一 ' }, { teacherId: s.teacherId })));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(await prisma.student.count({ where: { teacherId: s.teacherId, name: '合成并发学生', grade: '初一' } })).toBe(1);
    const other = await setup();
    expect((await registry.execute('students.create', { name: '合成并发学生', grade: '初一' }, { teacherId: other.teacherId })).ok).toBe(true);
  });

  it('does not admit model-supplied identity or malformed dates', () => {
    expect(parseCreateCandidate('memos.create', { title: '合成', content: '合成', teacherId: 'other' }).ok).toBe(false);
    expect(parseCreateCandidate('scheduling.create', { day: '2090-02-30' }).ok).toBe(false);
    expect(parseCreateCandidate('memos.create', { title: '合成', content: '合成', dueAt: '2090-02-30T10:00:00+08:00' }).ok).toBe(false);
  });
});
