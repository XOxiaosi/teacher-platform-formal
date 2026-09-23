import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../../src/index.js';
import { COMPLETION_ENTRYPOINT_UNAVAILABLE_MESSAGE } from '../../../src/app/policies/completion-entrypoint-gate.js';
import { acceptInvitation } from '../../helpers/invitations.js';

const prisma = new PrismaClient();
const app = createApp(prisma, { rawPrisma: prisma });
const A = 'scheduling-web-a@example.test';
const B = 'scheduling-web-b@example.test';
let cookieA = ''; let cookieB = ''; let teacherA = ''; let teacherB = '';

async function clean(teacherId: string) {
  await prisma.schedulingWebMutationReceipt.deleteMany({ where: { teacherId } });
  await prisma.scheduleCompletionSnapshot.deleteMany({ where: { teacherId } });
  await prisma.scheduleRevision.deleteMany({ where: { teacherId } });
  await prisma.lessonLedgerEntry.deleteMany({ where: { teacherId } });
  await prisma.lesson.deleteMany({ where: { teacherId } });
  await prisma.payment.deleteMany({ where: { teacherId } });
  await prisma.scheduleParticipant.deleteMany({ where: { teacherId } });
  await prisma.schedule.deleteMany({ where: { teacherId } });
  await prisma.recurrenceRuleParticipant.deleteMany({ where: { teacherId } });
  await prisma.recurrenceRule.deleteMany({ where: { teacherId } });
  await prisma.student.deleteMany({ where: { teacherId } });
}
async function command(cookie: string, body: Record<string, unknown>) { return request(app).post('/api/v1/scheduling-web/commands').set('Cookie', cookie).send(body); }
function schedule(studentId: string, overrides: Record<string, unknown> = {}) { return { day: '2026-10-05', start: '09:00', end: '10:00', location: '工作室 A', participants: [studentId], format: '一对一', note: '确认到场', ...overrides }; }
function rule(studentId: string, overrides: Record<string, unknown> = {}) { return { startDate: '2026-10-05', weekdays: [1], start: '09:00', end: '10:00', location: '工作室 A', participants: [studentId], format: '一对一', note: '确认到场', ...overrides }; }
function projected(ruleState: any, day = '2026-10-05') {
  return {
    id: `${ruleState.id}@${day}`, day, start: ruleState.start, end: ruleState.end, location: ruleState.location,
    participants: ruleState.participants, format: ruleState.format, note: ruleState.note, status: '已排期',
    recurrenceRuleId: ruleState.id, recurrenceDay: day, updatedAt: ruleState.updatedAt, version: ruleState.version,
  };
}

beforeAll(async () => {
  const a = await acceptInvitation(app, prisma, { email: A }); const b = await acceptInvitation(app, prisma, { email: B });
  expect(a.response.status).toBe(201); expect(b.response.status).toBe(201);
  cookieA = a.response.headers['set-cookie'][0]; cookieB = b.response.headers['set-cookie'][0];
  teacherA = a.response.body.data.teacher.id; teacherB = b.response.body.data.teacher.id;
});
beforeEach(async () => { await clean(teacherA); await clean(teacherB); });
afterEach(async () => { await clean(teacherA); await clean(teacherB); });

describe('Scheduling Web persistent bridge', () => {
  it('rejects overlapping weekly rules atomically and state refresh only returns the owner data', async () => {
    const student = await prisma.student.create({ data: { teacherId: teacherA, name: '排课学生', grade: '初三' } });
    const first = await command(cookieA, { clientRequestId: 'rule-create-0001', kind: 'save-rule', rule: rule(student.id) });
    expect(first.status).toBe(200); expect(first.body.data.recurrenceRules).toHaveLength(1);
    const rejected = await command(cookieA, { clientRequestId: 'rule-create-0002', kind: 'save-rule', rule: rule(student.id, { start: '09:30', end: '10:30' }) });
    expect(rejected.status).toBe(400); expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.recurrenceRule.count({ where: { teacherId: teacherA } })).toBe(1);
    const refreshed = await request(app).get('/api/v1/scheduling-web/state').set('Cookie', cookieA);
    expect(refreshed.status).toBe(200); expect(refreshed.body.data.recurrenceRules[0]).toMatchObject({ participants: [student.id], format: '一对一', enabled: true });
    expect(refreshed.body.data.recurrenceRules[0].version).toBe(refreshed.body.data.recurrenceRules[0].updatedAt);
    const other = await request(app).get('/api/v1/scheduling-web/state').set('Cookie', cookieB);
    expect(other.status).toBe(200); expect(other.body.data.recurrenceRules).toEqual([]);
    const activeRule = refreshed.body.data.recurrenceRules[0]; const ruleId = activeRule.id;
    const cancelled = await command(cookieA, { clientRequestId: 'cancel-rule-0001', kind: 'cancel', before: projected(activeRule) });
    expect(cancelled.status).toBe(200); expect(cancelled.body.data.schedules[0].status).toBe('已取消');
    const cancelledRow = await prisma.schedule.findFirst({ where: { teacherId: teacherA, recurrenceRuleId: ruleId, recurrenceDay: new Date('2026-10-05T00:00:00.000Z') } });
    expect(cancelledRow).toMatchObject({ id: cancelled.body.data.schedules[0].id, recurrenceRuleId: ruleId, status: 'cancelled' });
    expect(cancelledRow?.recurrenceDay?.toISOString().slice(0, 10)).toBe('2026-10-05');
    const paused = await command(cookieA, { clientRequestId: 'pause-rule-0001', kind: 'set-rule-enabled', ruleId, enabled: false, expectedUpdatedAt: activeRule.updatedAt });
    expect(paused.status).toBe(200); expect(paused.body.data.recurrenceRules[0].enabled).toBe(false);
    expect(paused.body.data.schedules[0].status).toBe('已取消');
    const enabled = await command(cookieA, { clientRequestId: 'enable-rule-0001', kind: 'set-rule-enabled', ruleId, enabled: true, expectedUpdatedAt: paused.body.data.recurrenceRules[0].updatedAt });
    expect(enabled.status).toBe(200); expect(enabled.body.data.recurrenceRules[0].enabled).toBe(true);
  });

  it('complete 命令与其他入口使用同一安全错误，且不生成完课写入', async () => {
    const student = await prisma.student.create({ data: { teacherId: teacherA, name: '完课学生', grade: '高一' } });
    await prisma.payment.create({ data: {
      teacherId: teacherA, studentId: student.id, amount: 4500, lessonCount: 15,
      paidAtTs: new Date('2026-10-01T00:00:00.000Z'), note: '快照回归测试',
    } });
    const balanceBefore = await request(app)
      .get(`/api/v1/students/${student.id}/balance`)
      .set('Cookie', cookieA);
    expect(balanceBefore.status).toBe(200);
    const created = await command(cookieA, { clientRequestId: 'rule-complete-0001', kind: 'save-rule', rule: rule(student.id) });
    const synthetic = projected(created.body.data.recurrenceRules[0]);
    const complete = await command(cookieA, { clientRequestId: 'complete-0001', kind: 'complete', before: synthetic });
    expect(complete.status).toBe(400);
    expect(complete.body.error).toEqual({
      code: 'VALIDATION_ERROR', message: COMPLETION_ENTRYPOINT_UNAVAILABLE_MESSAGE, field: 'completion',
    });
    expect(await prisma.schedule.count({ where: { teacherId: teacherA } })).toBe(0);
    expect(await prisma.lesson.count({ where: { teacherId: teacherA } })).toBe(0);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: teacherA } })).toBe(0);
    expect(await prisma.scheduleCompletionSnapshot.count({ where: { teacherId: teacherA } })).toBe(0);
    expect(await prisma.schedulingWebMutationReceipt.count({ where: { teacherId: teacherA, clientRequestId: 'complete-0001' } })).toBe(0);
    expect(await prisma.payment.count({ where: { teacherId: teacherA, studentId: student.id } })).toBe(1);
    const balanceAfter = await request(app)
      .get(`/api/v1/students/${student.id}/balance`)
      .set('Cookie', cookieA);
    expect(balanceAfter.body).toEqual(balanceBefore.body);
  });

  it('rejects impossible strict calendar dates for one-off schedules and weekly rules', async () => {
    const student = await prisma.student.create({ data: { teacherId: teacherA, name: '日期学生', grade: '初一' } });
    const once = await command(cookieA, { clientRequestId: 'invalid-date-once', kind: 'save-schedule', schedule: schedule(student.id, { day: '2026-02-30' }) });
    expect(once.status).toBe(400); expect(once.body.error.code).toBe('VALIDATION_ERROR');
    const weekly = await command(cookieA, { clientRequestId: 'invalid-date-rule', kind: 'save-rule', rule: rule(student.id, { startDate: '2026-02-30' }) });
    expect(weekly.status).toBe(400); expect(weekly.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.schedule.count({ where: { teacherId: teacherA } })).toBe(0);
    expect(await prisma.recurrenceRule.count({ where: { teacherId: teacherA } })).toBe(0);
  });

  it('returns not found for a cross-teacher mutation and never changes the owner row', async () => {
    const ownerStudent = await prisma.student.create({ data: { teacherId: teacherA, name: '隔离学生', grade: '初二' } });
    const ownerCreate = await command(cookieA, { clientRequestId: 'once-create-0001', kind: 'save-schedule', schedule: schedule(ownerStudent.id) });
    expect(ownerCreate.status).toBe(200); const ownerSchedule = ownerCreate.body.data.schedules[0];
    expect(ownerSchedule.createdAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(ownerSchedule.createdAt))).toBe(false);
    const attack = await command(cookieB, { clientRequestId: 'attack-cancel-0001', kind: 'cancel', before: ownerSchedule });
    expect(attack.status).toBe(404); expect(attack.body.error.code).toBe('NOT_FOUND');
    const otherState = await request(app).get('/api/v1/scheduling-web/state').set('Cookie', cookieB);
    expect(otherState.status).toBe(200); expect(otherState.body.data.schedules).toEqual([]);
    const stillOwner = await request(app).get('/api/v1/scheduling-web/state').set('Cookie', cookieA);
    expect(stillOwner.body.data.schedules[0]).toMatchObject({ id: ownerSchedule.id, status: '已排期', createdAt: ownerSchedule.createdAt });
  });

  it('is retry-safe, rejects stale versions, and never reopens an earlier rule cutoff', async () => {
    const student = await prisma.student.create({ data: { teacherId: teacherA, name: '版本学生', grade: '初一' } });
    const createPayload = { clientRequestId: 'once-retry-0001', kind: 'save-schedule', schedule: schedule(student.id, { start: '13:00', end: '14:00' }) };
    const first = await command(cookieA, createPayload); const replay = await command(cookieA, createPayload);
    expect(first.status).toBe(200); expect(replay.status).toBe(200); expect(replay.body.data.schedules).toHaveLength(1);
    const before = first.body.data.schedules[0];
    const changed = await command(cookieA, { clientRequestId: 'once-edit-0001', kind: 'save-schedule', before, schedule: { ...before, start: '14:00', end: '15:00' } });
    expect(changed.status).toBe(200);
    const stale = await command(cookieA, { clientRequestId: 'once-edit-0002', kind: 'save-schedule', before, schedule: { ...before, start: '15:00', end: '16:00' } });
    expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const createdRule = await command(cookieA, { clientRequestId: 'finite-rule-0001', kind: 'save-rule', rule: rule(student.id, { start: '16:00', end: '17:00', endDate: '2026-10-12' }) });
    expect(createdRule.status).toBe(200); const finite = createdRule.body.data.recurrenceRules[0];
    const ended = await command(cookieA, { clientRequestId: 'finite-end-0001', kind: 'end-rule', ruleId: finite.id, from: '2026-10-26', expectedUpdatedAt: finite.updatedAt });
    expect(ended.status).toBe(200); expect(ended.body.data.recurrenceRules[0].endDate).toBe('2026-10-12');
  });

  it('checks weekly rules against one-off rows and only excludes the exact edited occurrence', async () => {
    const student = await prisma.student.create({ data: { teacherId: teacherA, name: '冲突学生', grade: '初二' } });
    const once = await command(cookieA, { clientRequestId: 'one-off-0900', kind: 'save-schedule', schedule: schedule(student.id) });
    expect(once.status).toBe(200);
    const blockedRule = await command(cookieA, { clientRequestId: 'rule-vs-once-01', kind: 'save-rule', rule: rule(student.id) });
    expect(blockedRule.status).toBe(400); expect(await prisma.recurrenceRule.count({ where: { teacherId: teacherA } })).toBe(0);

    const created = await command(cookieA, { clientRequestId: 'rule-exact-0001', kind: 'save-rule', rule: rule(student.id, { start: '11:00', end: '12:00' }) });
    expect(created.status).toBe(200); const recurring = created.body.data.recurrenceRules[0];
    const firstOccurrence = projected(recurring, '2026-10-05');
    const materialized = await command(cookieA, { clientRequestId: 'materialize-0001', kind: 'save-schedule', before: firstOccurrence, schedule: firstOccurrence });
    expect(materialized.status).toBe(200);
    // Moving 10/05 onto 10/12 must still collide with the source rule's 10/12
    // projection; excluding the entire rule would incorrectly accept this.
    const moved = await command(cookieA, { clientRequestId: 'move-onto-rule', kind: 'save-schedule', before: materialized.body.data.schedules.find((item: any) => item.recurrenceRuleId === recurring.id), schedule: schedule(student.id, { day: '2026-10-12', start: '11:00', end: '12:00' }) });
    expect(moved.status).toBe(400); expect(moved.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('replaces only future materialized exceptions and preserves prior rule history', async () => {
    const student = await prisma.student.create({ data: { teacherId: teacherA, name: '替换学生', grade: '高二' } });
    const created = await command(cookieA, { clientRequestId: 'replace-source', kind: 'save-rule', rule: rule(student.id, { start: '13:00', end: '14:00' }) });
    expect(created.status).toBe(200); const source = created.body.data.recurrenceRules[0];
    const historical = await command(cookieA, { clientRequestId: 'replace-history', kind: 'save-schedule', before: projected(source, '2026-10-05'), schedule: projected(source, '2026-10-05') });
    expect(historical.status).toBe(200);
    const future = await command(cookieA, { clientRequestId: 'replace-future', kind: 'save-schedule', before: projected(source, '2026-10-12'), schedule: projected(source, '2026-10-12') });
    expect(future.status).toBe(200);
    const movedBackward = await command(cookieA, { clientRequestId: 'replace-moved-backward', kind: 'replace-rule', ruleId: source.id, from: '2026-10-12', expectedUpdatedAt: source.updatedAt, rule: rule(student.id, { startDate: '2026-10-05', start: '13:00', end: '14:00' }) });
    expect(movedBackward.status).toBe(400); expect(movedBackward.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.schedulingWebMutationReceipt.count({ where: { teacherId: teacherA, clientRequestId: 'replace-moved-backward' } })).toBe(0);
    expect(await prisma.schedule.count({ where: { teacherId: teacherA } })).toBe(2);
    expect((await prisma.recurrenceRule.findUniqueOrThrow({ where: { id: source.id } })).endDate).toBeNull();
    const backdated = await command(cookieA, { clientRequestId: 'replace-backdated', kind: 'replace-rule', ruleId: source.id, from: '2026-10-04', expectedUpdatedAt: source.updatedAt, rule: rule(student.id, { startDate: '2026-10-04', start: '13:00', end: '14:00' }) });
    expect(backdated.status).toBe(400); expect(backdated.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.recurrenceRule.count({ where: { teacherId: teacherA } })).toBe(1);
    const replaced = await command(cookieA, { clientRequestId: 'replace-command', kind: 'replace-rule', ruleId: source.id, from: '2026-10-12', expectedUpdatedAt: source.updatedAt, rule: rule(student.id, { startDate: '2026-10-12', start: '13:00', end: '14:00' }) });
    expect(replaced.status).toBe(200);
    const old = replaced.body.data.recurrenceRules.find((item: any) => item.id === source.id);
    const replacement = replaced.body.data.recurrenceRules.find((item: any) => item.id !== source.id);
    expect(old.endDate).toBe('2026-10-11');
    const rows = replaced.body.data.schedules;
    expect(rows.find((item: any) => item.recurrenceDay === '2026-10-05').recurrenceRuleId).toBe(source.id);
    expect(rows.find((item: any) => item.recurrenceDay === '2026-10-12').recurrenceRuleId).toBe(replacement.id);
    const replay = await command(cookieA, { clientRequestId: 'replace-command', kind: 'replace-rule', ruleId: source.id, from: '2026-10-12', expectedUpdatedAt: source.updatedAt, rule: rule(student.id, { startDate: '2026-10-12', start: '13:00', end: '14:00' }) });
    expect(replay.status).toBe(200);
    expect(replay.body.data.recurrenceRules).toHaveLength(2);
    expect(await prisma.schedulingWebMutationReceipt.count({ where: { teacherId: teacherA, clientRequestId: 'replace-command' } })).toBe(1);
  });

  it('allows a synthetic occurrence to move forward and leaves the intentional O-to-T projection gap', async () => {
    const student = await prisma.student.create({ data: { teacherId: teacherA, name: '前移学生', grade: '高一' } });
    const created = await command(cookieA, { clientRequestId: 'forward-synthetic-source', kind: 'save-rule', rule: rule(student.id, { start: '13:00', end: '14:00' }) });
    expect(created.status).toBe(200);
    const source = created.body.data.recurrenceRules[0];
    const replaced = await command(cookieA, { clientRequestId: 'forward-synthetic-replace', kind: 'replace-rule', ruleId: source.id, from: '2026-10-05', expectedUpdatedAt: source.updatedAt, rule: rule(student.id, { startDate: '2026-10-12', start: '15:00', end: '16:00', location: '新教室' }) });
    expect(replaced.status).toBe(200);
    const old = replaced.body.data.recurrenceRules.find((item: any) => item.id === source.id);
    const replacement = replaced.body.data.recurrenceRules.find((item: any) => item.id !== source.id);
    expect(old.endDate).toBe('2026-10-04');
    expect(replacement).toMatchObject({ startDate: '2026-10-12', start: '15:00', end: '16:00', location: '新教室' });
    expect(replaced.body.data.schedules).toEqual([]);
  });

  it('moves one materialized anchor exactly once and updates its fields and participants at T', async () => {
    const first = await prisma.student.create({ data: { teacherId: teacherA, name: '改期甲', grade: '初二' } });
    const second = await prisma.student.create({ data: { teacherId: teacherA, name: '改期乙', grade: '初二' } });
    const created = await command(cookieA, { clientRequestId: 'anchor-source', kind: 'save-rule', rule: rule(first.id, { start: '13:00', end: '14:00' }) });
    const source = created.body.data.recurrenceRules[0];
    const materialized = await command(cookieA, { clientRequestId: 'anchor-materialize', kind: 'save-schedule', before: projected(source, '2026-10-05'), schedule: projected(source, '2026-10-05') });
    expect(materialized.status).toBe(200);
    const anchor = materialized.body.data.schedules[0];
    const replacementRule = rule(first.id, { startDate: '2026-10-12', start: '15:00', end: '16:30', location: '二楼 B', participants: [first.id, second.id], format: '小班', note: '仅改这一期后续规则' });
    const replaced = await command(cookieA, { clientRequestId: 'anchor-forward', kind: 'replace-rule', ruleId: source.id, from: '2026-10-05', expectedUpdatedAt: source.updatedAt, rule: replacementRule });
    expect(replaced.status).toBe(200);
    const newRule = replaced.body.data.recurrenceRules.find((item: any) => item.id !== source.id);
    const moved = replaced.body.data.schedules.find((item: any) => item.id === anchor.id);
    expect(moved).toMatchObject({ id: anchor.id, day: '2026-10-12', start: '15:00', end: '16:30', location: '二楼 B', participants: [first.id, second.id], format: '小班', note: '仅改这一期后续规则', status: '已排期', recurrenceRuleId: newRule.id, recurrenceDay: '2026-10-12' });
    expect(replaced.body.data.schedules.filter((item: any) => item.recurrenceRuleId === newRule.id && item.recurrenceDay === '2026-10-12')).toHaveLength(1);
    expect(await prisma.scheduleParticipant.count({ where: { scheduleId: anchor.id } })).toBe(2);
  });

  it('reattaches later active, completed and cancelled instances without changing their concrete history or ledger', async () => {
    const student = await prisma.student.create({ data: { teacherId: teacherA, name: '历史实例学生', grade: '高二' } });
    const created = await command(cookieA, { clientRequestId: 'history-source', kind: 'save-rule', rule: rule(student.id, { start: '13:00', end: '14:00' }) });
    const source = created.body.data.recurrenceRules[0];
    const materialize = async (day: string, id: string) => command(cookieA, { clientRequestId: id, kind: 'save-schedule', before: projected(source, day), schedule: projected(source, day) });
    const anchor = await materialize('2026-10-05', 'history-anchor');
    const active = await materialize('2026-10-12', 'history-active');
    const activeRow = active.body.data.schedules.find((item: any) => item.recurrenceDay === '2026-10-12');
    const movedActive = await command(cookieA, { clientRequestId: 'history-active-move', kind: 'save-schedule', before: activeRow, schedule: { ...activeRow, day: '2026-10-13', start: '17:00', end: '18:00', location: '例外教室' } });
    expect(movedActive.status).toBe(200);
    const completed = await materialize('2026-10-19', 'history-completed');
    const cancelled = await materialize('2026-10-26', 'history-cancelled');
    const completedId = completed.body.data.schedules.find((item: any) => item.recurrenceDay === '2026-10-19').id;
    const cancelledId = cancelled.body.data.schedules.find((item: any) => item.recurrenceDay === '2026-10-26').id;
    await prisma.schedule.update({ where: { id: completedId }, data: { status: 'completed' } });
    await prisma.schedule.update({ where: { id: cancelledId }, data: { status: 'cancelled' } });
    const ledger = await prisma.lessonLedgerEntry.create({ data: { teacherId: teacherA, studentId: student.id, entryType: 'manual_adjustment', lessonDelta: 2, clientRequestId: 'history-ledger' } });

    const replaced = await command(cookieA, { clientRequestId: 'history-replace', kind: 'replace-rule', ruleId: source.id, from: '2026-10-05', expectedUpdatedAt: source.updatedAt, rule: rule(student.id, { startDate: '2026-10-05', start: '15:00', end: '16:00', location: '新规则教室' }) });
    expect(replaced.status).toBe(200);
    const newRule = replaced.body.data.recurrenceRules.find((item: any) => item.id !== source.id);
    const rows = await prisma.schedule.findMany({ where: { id: { in: [anchor.body.data.schedules[0].id, activeRow.id, completedId, cancelledId] } }, include: { participants: true } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(activeRow.id)).toMatchObject({ recurrenceRuleId: newRule.id, status: 'planned' });
    expect(byId.get(activeRow.id)?.scheduledStartTs.toISOString()).toBe('2026-10-13T09:00:00.000Z');
    expect(byId.get(completedId)).toMatchObject({ recurrenceRuleId: newRule.id, status: 'completed' });
    expect(byId.get(cancelledId)).toMatchObject({ recurrenceRuleId: newRule.id, status: 'cancelled' });
    expect(byId.get(completedId)?.scheduledStartTs.toISOString()).toBe('2026-10-19T05:00:00.000Z');
    expect(byId.get(cancelledId)?.scheduledStartTs.toISOString()).toBe('2026-10-26T05:00:00.000Z');
    expect(await prisma.lessonLedgerEntry.findUnique({ where: { id: ledger.id } })).toMatchObject({ id: ledger.id, lessonDelta: 2, clientRequestId: 'history-ledger' });
    expect(await prisma.scheduleRevision.count({ where: { teacherId: teacherA } })).toBe(0);
    expect(await prisma.scheduleCompletionSnapshot.count({ where: { teacherId: teacherA } })).toBe(0);
  });

  it('rejects replacement target conflicts from direct lessons and other rules with no receipt or partial cutoff', async () => {
    const student = await prisma.student.create({ data: { teacherId: teacherA, name: '替换冲突学生', grade: '初三' } });
    const directSource = await command(cookieA, { clientRequestId: 'direct-conflict-source', kind: 'save-rule', rule: rule(student.id, { start: '13:00', end: '14:00' }) });
    const direct = await command(cookieA, { clientRequestId: 'direct-conflict-row', kind: 'save-schedule', schedule: schedule(student.id, { day: '2026-10-12', start: '15:00', end: '16:00' }) });
    expect(direct.status).toBe(200);
    const directRejected = await command(cookieA, { clientRequestId: 'direct-conflict-replace', kind: 'replace-rule', ruleId: directSource.body.data.recurrenceRules[0].id, from: '2026-10-05', expectedUpdatedAt: directSource.body.data.recurrenceRules[0].updatedAt, rule: rule(student.id, { startDate: '2026-10-12', start: '15:00', end: '16:00' }) });
    expect(directRejected.status).toBe(400);
    expect(await prisma.recurrenceRule.count({ where: { teacherId: teacherA } })).toBe(1);
    expect(await prisma.schedulingWebMutationReceipt.count({ where: { teacherId: teacherA, clientRequestId: 'direct-conflict-replace' } })).toBe(0);

    const ruleSource = await command(cookieA, { clientRequestId: 'rule-conflict-source', kind: 'save-rule', rule: rule(student.id, { startDate: '2026-10-07', weekdays: [3], start: '13:00', end: '14:00' }) });
    const blocker = await command(cookieA, { clientRequestId: 'rule-conflict-blocker', kind: 'save-rule', rule: rule(student.id, { startDate: '2026-10-07', weekdays: [3], start: '15:00', end: '16:00' }) });
    expect(blocker.status).toBe(200);
    const ruleRejected = await command(cookieA, { clientRequestId: 'rule-conflict-replace', kind: 'replace-rule', ruleId: ruleSource.body.data.recurrenceRules.find((item: any) => item.startDate === '2026-10-07' && item.start === '13:00').id, from: '2026-10-07', expectedUpdatedAt: ruleSource.body.data.recurrenceRules.find((item: any) => item.startDate === '2026-10-07' && item.start === '13:00').updatedAt, rule: rule(student.id, { startDate: '2026-10-14', weekdays: [3], start: '15:00', end: '16:00' }) });
    expect(ruleRejected.status).toBe(400);
    expect(await prisma.schedulingWebMutationReceipt.count({ where: { teacherId: teacherA, clientRequestId: 'rule-conflict-replace' } })).toBe(0);
  });

  it('rejects a forward move when T already has any materialized source instance without partial writes', async () => {
    const student = await prisma.student.create({ data: { teacherId: teacherA, name: '唯一实例学生', grade: '初一' } });
    const created = await command(cookieA, { clientRequestId: 'unique-source', kind: 'save-rule', rule: rule(student.id, { start: '13:00', end: '14:00' }) });
    const source = created.body.data.recurrenceRules[0];
    const anchor = await command(cookieA, { clientRequestId: 'unique-anchor', kind: 'save-schedule', before: projected(source, '2026-10-05'), schedule: projected(source, '2026-10-05') });
    const target = await command(cookieA, { clientRequestId: 'unique-target', kind: 'save-schedule', before: projected(source, '2026-10-12'), schedule: projected(source, '2026-10-12') });
    const targetRow = target.body.data.schedules.find((item: any) => item.recurrenceDay === '2026-10-12');
    const movedAway = await command(cookieA, { clientRequestId: 'unique-target-move', kind: 'save-schedule', before: targetRow, schedule: { ...targetRow, day: '2026-10-13', start: '17:00', end: '18:00' } });
    expect(movedAway.status).toBe(200);
    const rejected = await command(cookieA, { clientRequestId: 'unique-forward-reject', kind: 'replace-rule', ruleId: source.id, from: '2026-10-05', expectedUpdatedAt: source.updatedAt, rule: rule(student.id, { startDate: '2026-10-12', start: '15:00', end: '16:00' }) });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.recurrenceRule.count({ where: { teacherId: teacherA } })).toBe(1);
    expect(await prisma.schedulingWebMutationReceipt.count({ where: { teacherId: teacherA, clientRequestId: 'unique-forward-reject' } })).toBe(0);
    const unchangedAnchor = await prisma.schedule.findUniqueOrThrow({ where: { id: anchor.body.data.schedules[0].id } });
    expect(unchangedAnchor.recurrenceRuleId).toBe(source.id);
    expect(unchangedAnchor.recurrenceDay?.toISOString().slice(0, 10)).toBe('2026-10-05');
  });

  it.each(['completed', 'cancelled'] as const)('rejects a dragged gap from a %s source occurrence without partial writes', async (status) => {
    const student = await prisma.student.create({ data: { teacherId: teacherA, name: `${status} 拖动边界学生`, grade: '初一' } });
    const created = await command(cookieA, { clientRequestId: `${status}-drag-state-source`, kind: 'save-rule', rule: rule(student.id, { start: '13:00', end: '14:00' }) });
    const source = created.body.data.recurrenceRules[0];
    const materialized = await command(cookieA, { clientRequestId: `${status}-drag-state-slot`, kind: 'save-schedule', before: projected(source, '2026-10-05'), schedule: projected(source, '2026-10-05') });
    const occurrence = materialized.body.data.schedules[0];
    await prisma.schedule.update({ where: { id: occurrence.id }, data: { status } });

    const rejected = await command(cookieA, { clientRequestId: `${status}-drag-state-replace`, kind: 'replace-rule', ruleId: source.id, from: '2026-10-05', expectedUpdatedAt: source.updatedAt, rule: rule(student.id, { startDate: '2026-10-12', start: '15:00', end: '16:00' }) });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'fromDate' });
    expect(await prisma.recurrenceRule.count({ where: { teacherId: teacherA } })).toBe(1);
    expect(await prisma.schedulingWebMutationReceipt.count({ where: { teacherId: teacherA, clientRequestId: `${status}-drag-state-replace` } })).toBe(0);
    expect(await prisma.recurrenceRule.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ id: source.id, endDate: null });
    expect(await prisma.schedule.findUniqueOrThrow({ where: { id: occurrence.id } })).toMatchObject({ id: occurrence.id, recurrenceRuleId: source.id, status });
  });

  it('allows a replacement through a cancelled target slot of another finite rule', async () => {
    const student = await prisma.student.create({ data: { teacherId: teacherA, name: '取消例外学生', grade: '初二' } });
    const sourceResult = await command(cookieA, { clientRequestId: 'cancel-slot-source', kind: 'save-rule', rule: rule(student.id, { start: '13:00', end: '14:00' }) });
    const source = sourceResult.body.data.recurrenceRules[0];
    const blockerResult = await command(cookieA, { clientRequestId: 'cancel-slot-blocker', kind: 'save-rule', rule: rule(student.id, { startDate: '2026-10-12', endDate: '2026-10-12', weekdays: [1], start: '15:00', end: '16:00' }) });
    const blocker = blockerResult.body.data.recurrenceRules.find((item: any) => item.id !== source.id);
    const cancelled = await command(cookieA, { clientRequestId: 'cancel-slot-instance', kind: 'cancel', before: projected(blocker, '2026-10-12') });
    expect(cancelled.status).toBe(200);
    const replaced = await command(cookieA, { clientRequestId: 'cancel-slot-replace', kind: 'replace-rule', ruleId: source.id, from: '2026-10-05', expectedUpdatedAt: source.updatedAt, rule: rule(student.id, { startDate: '2026-10-12', weekdays: [1], start: '15:00', end: '16:00' }) });
    expect(replaced.status).toBe(200);
    expect(replaced.body.data.recurrenceRules).toHaveLength(3);
  });

  it('allows another-rule moved exception to suppress its virtual T slot but rejects its conflicting actual day', async () => {
    const student = await prisma.student.create({ data: { teacherId: teacherA, name: '移动例外学生', grade: '初二' } });
    const sourceResult = await command(cookieA, { clientRequestId: 'moved-slot-source', kind: 'save-rule', rule: rule(student.id, { start: '13:00', end: '14:00' }) });
    const source = sourceResult.body.data.recurrenceRules[0];
    const blockerResult = await command(cookieA, { clientRequestId: 'moved-slot-blocker', kind: 'save-rule', rule: rule(student.id, { startDate: '2026-10-12', endDate: '2026-10-12', weekdays: [1], start: '15:00', end: '16:00' }) });
    const blocker = blockerResult.body.data.recurrenceRules.find((item: any) => item.id !== source.id);
    const materialized = await command(cookieA, { clientRequestId: 'moved-slot-instance', kind: 'save-schedule', before: projected(blocker, '2026-10-12'), schedule: projected(blocker, '2026-10-12') });
    const moved = materialized.body.data.schedules.find((item: any) => item.recurrenceRuleId === blocker.id);
    const movedAway = await command(cookieA, { clientRequestId: 'moved-slot-away', kind: 'save-schedule', before: moved, schedule: { ...moved, day: '2026-10-19', start: '15:00', end: '16:00' } });
    expect(movedAway.status).toBe(200);
    const rejected = await command(cookieA, { clientRequestId: 'moved-slot-replace', kind: 'replace-rule', ruleId: source.id, from: '2026-10-05', expectedUpdatedAt: source.updatedAt, rule: rule(student.id, { startDate: '2026-10-12', weekdays: [1], start: '15:00', end: '16:00' }) });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.schedulingWebMutationReceipt.count({ where: { teacherId: teacherA, clientRequestId: 'moved-slot-replace' } })).toBe(0);
  });

  it('keeps generic same-day RuleEditor replacements while guarding dragged gaps and missing target weekdays', async () => {
    const student = await prisma.student.create({ data: { teacherId: teacherA, name: '规则编辑学生', grade: '初三' } });
    const genericSource = await command(cookieA, { clientRequestId: 'generic-source', kind: 'save-rule', rule: rule(student.id, { start: '13:00', end: '14:00' }) });
    const source = genericSource.body.data.recurrenceRules[0];
    const generic = await command(cookieA, { clientRequestId: 'generic-effective-tuesday', kind: 'replace-rule', ruleId: source.id, from: '2026-10-06', expectedUpdatedAt: source.updatedAt, rule: rule(student.id, { startDate: '2026-10-06', weekdays: [1], start: '15:00', end: '16:00' }) });
    expect(generic.status).toBe(200);
    expect(generic.body.data.recurrenceRules.find((item: any) => item.id === source.id).endDate).toBe('2026-10-05');

    const draggedSource = await command(cookieA, { clientRequestId: 'dragged-invalid-source', kind: 'save-rule', rule: rule(student.id, { startDate: '2026-10-12', weekdays: [1], start: '13:00', end: '14:00' }) });
    const second = draggedSource.body.data.recurrenceRules.find((item: any) => item.id !== source.id && item.start === '13:00');
    const nonOccurrenceGap = await command(cookieA, { clientRequestId: 'dragged-non-occurrence-gap', kind: 'replace-rule', ruleId: second.id, from: '2026-10-13', expectedUpdatedAt: second.updatedAt, rule: rule(student.id, { startDate: '2026-10-20', weekdays: [2], start: '17:00', end: '18:00' }) });
    expect(nonOccurrenceGap.status).toBe(400);
    expect(await prisma.schedulingWebMutationReceipt.count({ where: { teacherId: teacherA, clientRequestId: 'dragged-non-occurrence-gap' } })).toBe(0);
    const missingTargetWeekday = await command(cookieA, { clientRequestId: 'dragged-missing-target-weekday', kind: 'replace-rule', ruleId: second.id, from: '2026-10-12', expectedUpdatedAt: second.updatedAt, rule: rule(student.id, { startDate: '2026-10-19', weekdays: [2], start: '17:00', end: '18:00' }) });
    expect(missingTargetWeekday.status).toBe(400);
    expect(missingTargetWeekday.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.recurrenceRule.count({ where: { teacherId: teacherA } })).toBe(3);
  });

  it('rolls back a command and its receipt if fresh state cannot safely decode an unsupported stored status', async () => {
    const student = await prisma.student.create({ data: { teacherId: teacherA, name: '回滚学生', grade: '初三' } });
    // Legacy/unrecognised statuses are neither projected as a valid UI status
    // nor allowed to commit a partial command when the response state fails.
    await prisma.schedule.create({ data: {
      teacherId: teacherA, studentId: student.id, type: 'lesson', title: '', classFormat: 'one_to_one', status: 'missed',
      scheduledStartTs: new Date('2026-10-20T09:00:00+08:00'), scheduledEndTs: new Date('2026-10-20T10:00:00+08:00'),
    } });
    const failed = await command(cookieA, { clientRequestId: 'rollback-state-01', kind: 'save-schedule', schedule: schedule(student.id, { day: '2026-10-21' }) });
    expect(failed.status).toBe(500); expect(failed.body.error.code).toBe('INTERNAL_ERROR');
    expect(await prisma.schedule.count({ where: { teacherId: teacherA } })).toBe(1);
    expect(await prisma.schedulingWebMutationReceipt.count({ where: { teacherId: teacherA, clientRequestId: 'rollback-state-01' } })).toBe(0);
  });

  it('edits completed schedules only when the new window is free and rolls back every side effect on conflict', async () => {
    const student = await prisma.student.create({ data: { teacherId: teacherA, name: '已完成修订学生', grade: '初三' } });
    const created = await command(cookieA, { clientRequestId: 'completed-create-01', kind: 'save-schedule', schedule: schedule(student.id, { start: '09:00', end: '10:00' }) });
    expect(created.status).toBe(200);
    const createdSchedule = created.body.data.schedules[0];
    await prisma.schedule.update({ where: { id: createdSchedule.id }, data: { status: 'completed' } });

    const completedState = await request(app).get('/api/v1/scheduling-web/state').set('Cookie', cookieA);
    expect(completedState.status).toBe(200);
    const completed = completedState.body.data.schedules.find((item: any) => item.id === createdSchedule.id);
    const edited = await command(cookieA, {
      clientRequestId: 'completed-edit-01', kind: 'edit-completed', before: completed,
      schedule: schedule(student.id, { day: completed.day, start: '09:30', end: '10:30', location: '工作室 B', note: '已修订' }),
    });
    expect(edited.status).toBe(200);
    const editedSchedule = edited.body.data.schedules.find((item: any) => item.id === createdSchedule.id);
    expect(editedSchedule).toMatchObject({ status: '已完成', start: '09:30', end: '10:30', location: '工作室 B', note: '已修订' });
    expect(edited.body.data.scheduleRevisions).toHaveLength(1);

    const blocker = await command(cookieA, { clientRequestId: 'completed-blocker-01', kind: 'save-schedule', schedule: schedule(student.id, { start: '11:00', end: '12:00' }) });
    expect(blocker.status).toBe(200);
    const rejected = await command(cookieA, {
      clientRequestId: 'completed-edit-02', kind: 'edit-completed', before: editedSchedule,
      schedule: schedule(student.id, { day: editedSchedule.day, start: '10:30', end: '11:30', location: '工作室 C', note: '不应写入' }),
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.schedulingWebMutationReceipt.count({ where: { teacherId: teacherA, clientRequestId: 'completed-edit-02' } })).toBe(0);
    expect(await prisma.scheduleRevision.count({ where: { teacherId: teacherA, scheduleId: createdSchedule.id } })).toBe(1);
    expect(await prisma.scheduleCompletionSnapshot.count({ where: { teacherId: teacherA } })).toBe(0);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: teacherA } })).toBe(0);
    expect(await prisma.payment.count({ where: { teacherId: teacherA } })).toBe(0);
    const unchanged = await prisma.schedule.findUniqueOrThrow({ where: { id: createdSchedule.id } });
    expect(unchanged.status).toBe('completed');
    expect(unchanged.scheduledStartTs.toISOString()).toBe('2026-10-05T01:30:00.000Z');
    expect(unchanged.scheduledEndTs.toISOString()).toBe('2026-10-05T02:30:00.000Z');
  });
});
