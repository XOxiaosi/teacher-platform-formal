import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../../src/index.js';
import { createLessonStatusFixUseCase } from '../../../src/app/use-cases/lesson-status-fix/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';
import { acceptInvitation } from '../../helpers/invitations.js';

const prisma = new PrismaClient();
const app = createApp(prisma, { rawPrisma: prisma });
const TEST_RUN_ID = randomUUID();
const TEACHER_A_EMAIL = `lesson-status-correction-a-${TEST_RUN_ID}@example.test`;
const TEACHER_B_EMAIL = `lesson-status-correction-b-${TEST_RUN_ID}@example.test`;
const cipher = createFieldCipher(loadEncryptionKey().key);
let cookieA = '';
let cookieB = '';
let teacherA = '';
let teacherB = '';

async function clean(teacherId: string) {
  await prisma.changeLog.deleteMany({ where: { teacherId } });
  await prisma.lessonLedgerEntry.deleteMany({ where: { teacherId } });
  await prisma.lessonStatusCorrectionConfirmation.deleteMany({ where: { teacherId } });
  await prisma.lessonLedgerAdjustmentConfirmation.deleteMany({ where: { teacherId } });
  await prisma.payment.deleteMany({ where: { teacherId } });
  await prisma.lesson.deleteMany({ where: { teacherId } });
  await prisma.scheduleParticipant.deleteMany({ where: { teacherId } });
  await prisma.schedule.deleteMany({ where: { teacherId } });
  await prisma.student.deleteMany({ where: { teacherId } });
}

async function createStudent(teacherId = teacherA, name = '出勤学生') {
  return prisma.student.create({ data: { teacherId, name, grade: '高一', source: 'test' } });
}

async function createLesson(
  studentId: string,
  status: 'attended' | 'absent',
  scheduleStatus = 'completed',
  teacherId = teacherA,
) {
  const date = new Date('2026-10-08T01:00:00.000Z');
  const schedule = await prisma.schedule.create({
    data: {
      teacherId,
      studentId,
      type: 'lesson',
      title: '',
      classFormat: 'one_to_one',
      scheduledStartTs: date,
      scheduledEndTs: new Date(date.getTime() + 60 * 60 * 1000),
      status: scheduleStatus,
      participants: { create: { teacherId, studentId } },
    },
  });
  const lesson = await prisma.lesson.create({
    data: { teacherId, studentId, scheduleId: schedule.id, dateTs: date, status },
  });
  return { lesson, schedule };
}

async function addLegacyPurchase(studentId: string, lessonCount = 4) {
  return prisma.payment.create({
    data: {
      teacherId: teacherA,
      studentId,
      amount: lessonCount * 200,
      lessonCount,
      paidAtTs: new Date('2026-10-01T00:00:00.000Z'),
    },
  });
}

function prepare(cookie: string, payload: Record<string, unknown>) {
  return request(app).post('/api/v1/lesson-status-corrections').set('Cookie', cookie).send(payload);
}

function confirm(cookie: string, confirmationId: string) {
  return request(app).post(`/api/v1/lesson-status-corrections/${confirmationId}/confirm`).set('Cookie', cookie).send({});
}

beforeAll(async () => {
  const a = await acceptInvitation(app, prisma, { email: TEACHER_A_EMAIL });
  const b = await acceptInvitation(app, prisma, { email: TEACHER_B_EMAIL });
  expect(a.response.status).toBe(201);
  expect(b.response.status).toBe(201);
  cookieA = a.response.headers['set-cookie'][0];
  cookieB = b.response.headers['set-cookie'][0];
  teacherA = a.response.body.data.teacher.id;
  teacherB = b.response.body.data.teacher.id;
});

beforeEach(async () => {
  await clean(teacherA);
  await clean(teacherB);
});

afterAll(async () => {
  await clean(teacherA);
  await clean(teacherB);
  await prisma.$disconnect();
});

describe('P3-LESSON-STATUS-CORRECTION-CONFIRM-14 HTTP contract', () => {
  it('previews without changing the lesson or balance, then confirms one absent-to-attended deduction', async () => {
    const enrolled = await createStudent();
    await addLegacyPurchase(enrolled.id);
    const { lesson, schedule } = await createLesson(enrolled.id, 'absent');
    const payload = {
      lessonId: lesson.id,
      targetStatus: 'attended',
      reason: '核对签到记录后确认到课',
      clientRequestId: 'lesson-correction-http-0001',
      teacherId: 'forged-teacher',
    };

    const prepared = await prepare(cookieA, payload);
    expect(prepared.status).toBe(201);
    expect(prepared.body.data).toMatchObject({
      confirmation: {
        lessonId: lesson.id,
        studentId: enrolled.id,
        fromStatus: 'absent',
        toStatus: 'attended',
        reason: '核对签到记录后确认到课',
        status: 'pending',
      },
      balanceBefore: { purchased: 4, attended: 0, remaining: 4 },
      balanceAfter: { purchased: 4, attended: 1, remaining: 3 },
      plannedLedgerEntry: { entryType: 'attendance_deduction', lessonDelta: -1 },
    });
    const confirmationId = prepared.body.data.confirmation.id as string;
    expect(await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } })).toMatchObject({ status: 'absent' });
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: teacherA } })).toBe(0);
    const stored = await prisma.lessonStatusCorrectionConfirmation.findUniqueOrThrow({ where: { id: confirmationId } });
    expect(stored.teacherId).toBe(teacherA);
    expect(stored.reasonCiphertext).not.toContain('核对签到记录后确认到课');

    const confirmed = await confirm(cookieA, confirmationId);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data).toMatchObject({
      confirmation: {
        id: confirmationId,
        status: 'confirmed',
        entry: { entryType: 'attendance_deduction', lessonDelta: -1 },
      },
      lesson: { id: lesson.id, status: 'attended' },
      balance: { purchased: 4, attended: 1, remaining: 3 },
    });
    expect(await prisma.lessonLedgerEntry.count({ where: { statusCorrectionConfirmationId: confirmationId } })).toBe(1);
    const state = await request(app).get('/api/v1/scheduling-web/state').set('Cookie', cookieA);
    expect(state.status).toBe(200);
    expect(state.body.data.schedules).toContainEqual(expect.objectContaining({
      id: schedule.id,
      attendance: [expect.objectContaining({ lessonId: lesson.id, studentId: enrolled.id, status: 'attended' })],
    }));

    const replay = await confirm(cookieA, confirmationId);
    const preparedReplay = await prepare(cookieA, payload);
    expect(replay.status).toBe(200);
    expect(preparedReplay.status).toBe(201);
    expect(preparedReplay.body.data).toMatchObject({
      confirmation: { id: confirmationId, status: 'confirmed' },
      balanceBefore: { remaining: 3 },
      balanceAfter: { remaining: 3 },
    });
    expect(await prisma.lessonLedgerEntry.count({ where: { statusCorrectionConfirmationId: confirmationId } })).toBe(1);
  });

  it('does not invent a reversal for a legacy attended lesson, but reverses an existing formal deduction', async () => {
    const legacyStudent = await createStudent(teacherA, '历史学生');
    await addLegacyPurchase(legacyStudent.id);
    const legacy = await createLesson(legacyStudent.id, 'attended');
    const legacyPrepared = await prepare(cookieA, {
      lessonId: legacy.lesson.id,
      targetStatus: 'absent',
      reason: '历史考勤误录',
      clientRequestId: 'lesson-correction-legacy-0001',
    });
    expect(legacyPrepared.status).toBe(201);
    expect(legacyPrepared.body.data).toMatchObject({
      balanceBefore: { attended: 1, remaining: 3 },
      balanceAfter: { attended: 0, remaining: 4 },
      plannedLedgerEntry: null,
    });
    const legacyConfirmed = await confirm(cookieA, legacyPrepared.body.data.confirmation.id);
    expect(legacyConfirmed.status).toBe(200);
    expect(legacyConfirmed.body.data).toMatchObject({
      confirmation: { status: 'confirmed', entry: null },
      lesson: { status: 'absent' },
      balance: { attended: 0, remaining: 4 },
    });
    expect(await prisma.lessonLedgerEntry.count({ where: { lessonId: legacy.lesson.id } })).toBe(0);

    const formalStudent = await createStudent(teacherA, '正式账本学生');
    await addLegacyPurchase(formalStudent.id);
    const formal = await createLesson(formalStudent.id, 'attended');
    await prisma.lessonLedgerEntry.create({
      data: {
        teacherId: teacherA,
        studentId: formalStudent.id,
        lessonId: formal.lesson.id,
        entryType: 'attendance_deduction',
        lessonDelta: -1,
      },
    });
    const formalPrepared = await prepare(cookieA, {
      lessonId: formal.lesson.id,
      targetStatus: 'absent',
      reason: '正式账本考勤误录',
      clientRequestId: 'lesson-correction-formal-0001',
    });
    expect(formalPrepared.status).toBe(201);
    expect(formalPrepared.body.data.plannedLedgerEntry).toEqual({ entryType: 'attendance_reversal', lessonDelta: 1 });
    const formalConfirmed = await confirm(cookieA, formalPrepared.body.data.confirmation.id);
    expect(formalConfirmed.status).toBe(200);
    expect(formalConfirmed.body.data).toMatchObject({
      confirmation: { entry: { entryType: 'attendance_reversal', lessonDelta: 1 } },
      balance: { attended: 0, remaining: 4 },
    });
    expect(await prisma.lessonLedgerEntry.count({
      where: { lessonId: formal.lesson.id, entryType: 'attendance_reversal' },
    })).toBe(1);
  });

  it('serializes same-key retries, rejects changed payloads and stale previews, and keeps tenant ownership', async () => {
    const enrolled = await createStudent();
    await addLegacyPurchase(enrolled.id);
    const { lesson } = await createLesson(enrolled.id, 'absent');
    const payload = {
      lessonId: lesson.id,
      targetStatus: 'attended',
      reason: '并发核对签到',
      clientRequestId: 'lesson-correction-race-0001',
    };
    const preparations = await Promise.all(Array.from({ length: 6 }, () => prepare(cookieA, payload)));
    expect(preparations.every((response) => response.status === 201)).toBe(true);
    const confirmationId = preparations[0].body.data.confirmation.id as string;
    expect(new Set(preparations.map((response) => response.body.data.confirmation.id))).toEqual(new Set([confirmationId]));
    expect(await prisma.lessonStatusCorrectionConfirmation.count({
      where: { teacherId: teacherA, clientRequestId: payload.clientRequestId },
    })).toBe(1);

    const changed = await prepare(cookieA, { ...payload, reason: '篡改后的原因' });
    expect(changed.status).toBe(409);
    const stalePreview = await prepare(cookieA, { ...payload, clientRequestId: 'lesson-correction-race-0002' });
    expect(stalePreview.status).toBe(201);
    const crossPrepare = await prepare(cookieB, { ...payload, clientRequestId: 'lesson-correction-cross-0001' });
    const crossConfirm = await confirm(cookieB, confirmationId);
    expect(crossPrepare.status).toBe(404);
    expect(crossConfirm.status).toBe(404);

    const confirms = await Promise.all(Array.from({ length: 6 }, () => confirm(cookieA, confirmationId)));
    expect(confirms.every((response) => response.status === 200)).toBe(true);
    expect(await prisma.lessonLedgerEntry.count({ where: { statusCorrectionConfirmationId: confirmationId } })).toBe(1);
    const staleConfirm = await confirm(cookieA, stalePreview.body.data.confirmation.id);
    expect(staleConfirm.status).toBe(409);
    expect(await prisma.lessonStatusCorrectionConfirmation.findUniqueOrThrow({
      where: { id: stalePreview.body.data.confirmation.id },
    })).toMatchObject({ status: 'pending', confirmedAtTs: null });
  });

  it('allows neither preparing nor confirming a correction outside a completed schedule', async () => {
    const enrolled = await createStudent();
    const planned = await createLesson(enrolled.id, 'attended', 'planned');
    const rejectedPrepare = await prepare(cookieA, {
      lessonId: planned.lesson.id,
      targetStatus: 'absent',
      reason: '不应允许的更正',
      clientRequestId: 'lesson-correction-planned-0001',
    });
    expect(rejectedPrepare.status).toBe(400);
    expect(rejectedPrepare.body.error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'lessonId' });

    const completed = await createLesson(enrolled.id, 'absent', 'completed');
    const prepared = await prepare(cookieA, {
      lessonId: completed.lesson.id,
      targetStatus: 'attended',
      reason: '待确认后课程状态发生变化',
      clientRequestId: 'lesson-correction-cancelled-0001',
    });
    expect(prepared.status).toBe(201);
    await prisma.schedule.update({ where: { id: completed.schedule.id }, data: { status: 'cancelled' } });
    const rejectedConfirm = await confirm(cookieA, prepared.body.data.confirmation.id);
    expect(rejectedConfirm.status).toBe(400);
    expect(rejectedConfirm.body.error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'confirmationId' });
    expect(await prisma.lesson.findUniqueOrThrow({ where: { id: completed.lesson.id } })).toMatchObject({ status: 'absent' });
    expect(await prisma.lessonLedgerEntry.count({ where: { lessonId: completed.lesson.id } })).toBe(0);
  });

  it('rolls back prepare and confirm when an audit write fails', async () => {
    const enrolled = await createStudent();
    const { lesson } = await createLesson(enrolled.id, 'absent');
    const faulting = prisma.$extends({
      query: {
        changeLog: {
          async create() {
            throw new Error('forced lesson status correction audit failure');
          },
        },
      },
    }) as unknown as PrismaClient;
    const faultingApp = createApp(faulting, { rawPrisma: prisma });
    const payload = {
      lessonId: lesson.id,
      targetStatus: 'attended',
      reason: '审计失败回滚',
      clientRequestId: 'lesson-correction-audit-prepare',
    };
    const failedPrepare = await request(faultingApp)
      .post('/api/v1/lesson-status-corrections')
      .set('Cookie', cookieA)
      .send(payload);
    expect(failedPrepare.status).toBe(500);
    expect(await prisma.lessonStatusCorrectionConfirmation.count({ where: { teacherId: teacherA } })).toBe(0);

    const prepared = await prepare(cookieA, { ...payload, clientRequestId: 'lesson-correction-audit-confirm' });
    expect(prepared.status).toBe(201);
    const failedConfirm = await request(faultingApp)
      .post(`/api/v1/lesson-status-corrections/${prepared.body.data.confirmation.id}/confirm`)
      .set('Cookie', cookieA)
      .send({});
    expect(failedConfirm.status).toBe(500);
    expect(await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } })).toMatchObject({ status: 'absent' });
    expect(await prisma.lessonLedgerEntry.count({ where: { lessonId: lesson.id } })).toBe(0);
    expect(await prisma.lessonStatusCorrectionConfirmation.findUniqueOrThrow({
      where: { id: prepared.body.data.confirmation.id },
    })).toMatchObject({ status: 'pending', confirmedAtTs: null });
  });

  it('forces a failed Result to abort a caller-owned outer transaction', async () => {
    const enrolled = await createStudent();
    const { lesson } = await createLesson(enrolled.id, 'absent');
    const faulting = prisma.$extends({
      query: {
        changeLog: {
          async create() {
            throw new Error('forced outer transaction audit failure');
          },
        },
      },
    }) as unknown as PrismaClient;
    await expect(faulting.$transaction(async (tx) => {
      const corrections = createLessonStatusFixUseCase({ getClient: async () => tx, cipher });
      return corrections.prepareLessonStatusCorrection({
        teacherId: teacherA,
        lessonId: lesson.id,
        targetStatus: 'attended',
        reason: '外层事务审计失败',
        clientRequestId: 'lesson-correction-outer-rollback',
      });
    })).rejects.toThrow('lesson-status-fix rollback');
    expect(await prisma.lessonStatusCorrectionConfirmation.count({ where: { teacherId: teacherA } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: teacherA } })).toBe(0);
  });

  it.each([
    [undefined, 'body'],
    [null, 'body'],
    [[], 'body'],
    [{}, 'lessonId'],
    [{ lessonId: 'lesson', targetStatus: 'pending', reason: '更正', clientRequestId: 'lesson-correction-invalid-01' }, 'targetStatus'],
    [{ lessonId: 'lesson', targetStatus: 'attended', reason: '  ', clientRequestId: 'lesson-correction-invalid-02' }, 'reason'],
    [{ lessonId: 'lesson', targetStatus: 'attended', reason: '更正', clientRequestId: 'short' }, 'clientRequestId'],
  ])('rejects malformed prepare input before any write (%j)', async (payload, field) => {
    const response = await prepare(cookieA, payload as Record<string, unknown>);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', field });
    expect(await prisma.lessonStatusCorrectionConfirmation.count({ where: { teacherId: teacherA } })).toBe(0);
  });
});
