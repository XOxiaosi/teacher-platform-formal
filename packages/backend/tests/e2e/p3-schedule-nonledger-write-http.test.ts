import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { acceptInvitation } from '../helpers/invitations.js';

const prisma = new PrismaClient();
const app = createApp(prisma, { rawPrisma: prisma, localSafeMode: true });
const createdTeacherIds: string[] = [];

async function createTeacher(label: string) {
  const suffix = randomBytes(6).toString('hex');
  const response = (await acceptInvitation(app, prisma, {
    email: `p3-schedule-${label}-${suffix}@example.com`,
    password: 'password123',
    displayName: `P3 排课 ${label}`,
  })).response;
  expect(response.status).toBe(201);
  const teacherId = response.body.data.teacher.id as string;
  createdTeacherIds.push(teacherId);
  return {
    teacherId,
    cookie: response.headers['set-cookie'][0].split(';')[0],
  };
}

async function createStudent(teacherId: string, name: string) {
  return prisma.student.create({
    data: { teacherId, name, grade: 'G1', source: 'synthetic' },
  });
}

function lessonPayload(studentIds: string[], clientRequestId: string, overrides: Record<string, unknown> = {}) {
  return {
    clientRequestId,
    type: 'lesson',
    participantIds: studentIds,
    location: '工作室 A',
    classFormat: studentIds.length === 1 ? 'one_to_one' : 'small_group',
    operationalNote: '课前准备小测纸',
    scheduledStart: '2035-07-24T19:00:00+08:00',
    scheduledEnd: '2035-07-24T20:30:00+08:00',
    ...overrides,
  };
}

async function countEffects(teacherId: string) {
  return {
    schedules: await prisma.schedule.count({ where: { teacherId } }),
    scheduleParticipants: await prisma.scheduleParticipant.count({ where: { teacherId } }),
    payments: await prisma.payment.count({ where: { teacherId } }),
    ledgerEntries: await prisma.lessonLedgerEntry.count({ where: { teacherId } }),
    completionSnapshots: await prisma.scheduleCompletionSnapshot.count({ where: { teacherId } }),
    lessons: await prisma.lesson.count({ where: { teacherId } }),
  };
}

async function cleanup() {
  if (createdTeacherIds.length === 0) return;
  const teacherIds = { in: createdTeacherIds };
  await prisma.changeLog.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.lessonLedgerEntry.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.lessonLedgerAdjustmentConfirmation.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.scheduleCompletionSnapshot.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.lesson.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.scheduleParticipant.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.recurrenceRuleParticipant.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.schedule.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.recurrenceRule.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.payment.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.student.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.sessionStore.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.teacherRegistry.deleteMany({ where: { id: teacherIds } });
  await prisma.teacherInvitation.deleteMany({ where: { email: { startsWith: 'p3-schedule-' } } });
}

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('P3 排课非账本写入认证 HTTP 契约', () => {
  it('创建正式 lesson 后可 GET 回显；同 key 同 payload 重放不重复写入且不写账本', async () => {
    const { teacherId, cookie } = await createTeacher('create');
    const student = await createStudent(teacherId, '合成学生甲');
    const payload = lessonPayload([student.id], 'p3-schedule-create-0001');
    const before = await countEffects(teacherId);

    const first = await request(app)
      .post('/api/v1/schedules')
      .set('Cookie', cookie)
      .send(payload);
    expect(first.status).toBe(201);
    expect(first.body.ok).toBe(true);
    const scheduleId = first.body.data.schedule.id as string;

    const listed = await request(app)
      .get('/api/v1/schedules?type=lesson')
      .set('Cookie', cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: scheduleId,
        participantIds: [student.id],
        location: '工作室 A',
        classFormat: 'one_to_one',
        operationalNote: '课前准备小测纸',
      }),
    ]));

    const replay = await request(app)
      .post('/api/v1/schedules')
      .set('Cookie', cookie)
      .send(payload);
    expect(replay.status).toBe(201);
    expect(replay.body.data.schedule.id).toBe(scheduleId);

    const after = await countEffects(teacherId);
    expect(after).toEqual({
      ...before,
      schedules: before.schedules + 1,
      scheduleParticipants: before.scheduleParticipants + 1,
    });
  });

  it('同 clientRequestId 不同 payload 返回 409 且不新增排期', async () => {
    const { teacherId, cookie } = await createTeacher('idempotency');
    const student = await createStudent(teacherId, '合成学生乙');
    const payload = lessonPayload([student.id], 'p3-schedule-conflict-0001');
    const first = await request(app).post('/api/v1/schedules').set('Cookie', cookie).send(payload);
    expect(first.status).toBe(201);
    const before = await countEffects(teacherId);

    const conflict = await request(app)
      .post('/api/v1/schedules')
      .set('Cookie', cookie)
      .send({ ...payload, location: '工作室 B' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.ok).toBe(false);
    expect(await countEffects(teacherId)).toEqual(before);
  });

  it('同 clientRequestId 同 payload 并发重放全部返回同一排期且只写一次', async () => {
    const { teacherId, cookie } = await createTeacher('same-key-concurrent');
    const student = await createStudent(teacherId, '合成学生同键并发');
    const payload = lessonPayload([student.id], 'p3-schedule-same-key-concurrent-0001');
    const before = await countEffects(teacherId);

    const responses = await Promise.all(Array.from({ length: 8 }, () => (
      request(app).post('/api/v1/schedules').set('Cookie', cookie).send(payload)
    )));

    expect(responses.map((response) => response.status)).toEqual(Array(8).fill(201));
    expect(new Set(responses.map((response) => response.body.data.schedule.id)).size).toBe(1);
    expect(await countEffects(teacherId)).toEqual({
      ...before,
      schedules: before.schedules + 1,
      scheduleParticipants: before.scheduleParticipants + 1,
    });
  });

  it('同 clientRequestId 不同 payload 并发时仅一个版本落库', async () => {
    const { teacherId, cookie } = await createTeacher('different-payload-concurrent');
    const student = await createStudent(teacherId, '合成学生异载荷并发');
    const before = await countEffects(teacherId);
    const base = lessonPayload([student.id], 'p3-schedule-different-payload-0001');

    const responses = await Promise.all([
      request(app).post('/api/v1/schedules').set('Cookie', cookie).send(base),
      request(app).post('/api/v1/schedules').set('Cookie', cookie).send({ ...base, location: '工作室 B' }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await countEffects(teacherId)).toEqual({
      ...before,
      schedules: before.schedules + 1,
      scheduleParticipants: before.scheduleParticipants + 1,
    });
  });

  it('新的重叠排期在写入前返回 400 且零新增', async () => {
    const { teacherId, cookie } = await createTeacher('overlap');
    const student = await createStudent(teacherId, '合成学生丙');
    const first = await request(app)
      .post('/api/v1/schedules')
      .set('Cookie', cookie)
      .send(lessonPayload([student.id], 'p3-schedule-overlap-0001'));
    expect(first.status).toBe(201);
    const before = await countEffects(teacherId);

    const overlap = await request(app)
      .post('/api/v1/schedules')
      .set('Cookie', cookie)
      .send(lessonPayload([student.id], 'p3-schedule-overlap-0002'));
    expect(overlap.status).toBe(400);
    expect(overlap.body.ok).toBe(false);
    expect(await countEffects(teacherId)).toEqual(before);
  });

  it('并发提交同一时段只允许一个排期落库', async () => {
    const { teacherId, cookie } = await createTeacher('concurrent');
    const student = await createStudent(teacherId, '合成学生并发');
    const before = await countEffects(teacherId);

    const responses = await Promise.all([
      request(app)
        .post('/api/v1/schedules')
        .set('Cookie', cookie)
        .send(lessonPayload([student.id], 'p3-schedule-concurrent-0001')),
      request(app)
        .post('/api/v1/schedules')
        .set('Cookie', cookie)
        .send(lessonPayload([student.id], 'p3-schedule-concurrent-0002')),
    ]);

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400 || status === 409)).toHaveLength(1);
    expect(await countEffects(teacherId)).toEqual({
      ...before,
      schedules: before.schedules + 1,
      scheduleParticipants: before.scheduleParticipants + 1,
    });
  });

  it('未物化循环规则占用时段；已取消的指定例外释放原时段', async () => {
    const { teacherId, cookie } = await createTeacher('recurrence-conflict');
    const student = await createStudent(teacherId, '合成学生循环冲突');
    const rule = await prisma.recurrenceRule.create({
      data: {
        teacherId,
        clientRequestId: 'p3-schedule-rule-0001',
        startDate: new Date('2035-07-01T00:00:00.000Z'),
        weekdays: [2],
        enabled: true,
        startTime: '19:00',
        endTime: '20:30',
        locationCiphertext: 'synthetic-conflict-only',
        classFormat: 'one_to_one',
      },
    });
    const beforeConflict = await countEffects(teacherId);

    const conflict = await request(app)
      .post('/api/v1/schedules')
      .set('Cookie', cookie)
      .send(lessonPayload([student.id], 'p3-schedule-rule-conflict-0001'));
    expect(conflict.status).toBe(400);
    expect(conflict.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'scheduledStart' },
    });
    expect(await countEffects(teacherId)).toEqual(beforeConflict);

    await prisma.schedule.create({
      data: {
        teacherId,
        studentId: student.id,
        type: 'lesson',
        title: '',
        locationCiphertext: 'synthetic-exception-only',
        classFormat: 'one_to_one',
        scheduledStartTs: new Date('2035-07-31T19:00:00+08:00'),
        scheduledEndTs: new Date('2035-07-31T20:30:00+08:00'),
        status: 'cancelled',
        recurrenceRuleId: rule.id,
        recurrenceDay: new Date('2035-07-31T00:00:00.000Z'),
      },
    });
    const beforeException = await countEffects(teacherId);
    const saved = await request(app)
      .post('/api/v1/schedules')
      .set('Cookie', cookie)
      .send(lessonPayload([student.id], 'p3-schedule-rule-exception-0001', {
        scheduledStart: '2035-07-31T19:00:00+08:00',
        scheduledEnd: '2035-07-31T20:30:00+08:00',
      }));

    expect(saved.status).toBe(201);
    expect(await countEffects(teacherId)).toEqual({
      ...beforeException,
      schedules: beforeException.schedules + 1,
      scheduleParticipants: beforeException.scheduleParticipants + 1,
    });
  });

  it('participantIds 含非字符串值时在写入前返回 400 且零新增', async () => {
    const { teacherId, cookie } = await createTeacher('mixed');
    const student = await createStudent(teacherId, '合成学生丁');
    const before = await countEffects(teacherId);

    const response = await request(app)
      .post('/api/v1/schedules')
      .set('Cookie', cookie)
      .send(lessonPayload([student.id, 123 as unknown as string], 'p3-schedule-mixed-0001'));
    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(await countEffects(teacherId)).toEqual(before);
  });
});
