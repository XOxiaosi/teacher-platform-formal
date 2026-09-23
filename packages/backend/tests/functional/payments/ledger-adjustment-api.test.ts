import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../../src/index.js';
import { createLessonLedgerService } from '../../../src/features/payments/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';
import { acceptInvitation } from '../../helpers/invitations.js';

const prisma = new PrismaClient();
const app = createApp(prisma, { rawPrisma: prisma });
const TEST_RUN_ID = randomUUID();
const TEACHER_A_EMAIL = `ledger-adjustment-a-${TEST_RUN_ID}@example.test`;
const TEACHER_B_EMAIL = `ledger-adjustment-b-${TEST_RUN_ID}@example.test`;
let cookieA = '';
let cookieB = '';
let teacherA = '';
let teacherB = '';
const cipher = createFieldCipher(loadEncryptionKey().key);

async function clean(teacherId: string) {
  await prisma.changeLog.deleteMany({ where: { teacherId } });
  await prisma.lessonLedgerEntry.deleteMany({ where: { teacherId } });
  await prisma.lessonLedgerAdjustmentConfirmation.deleteMany({ where: { teacherId } });
  await prisma.payment.deleteMany({ where: { teacherId } });
  await prisma.lesson.deleteMany({ where: { teacherId } });
  await prisma.schedule.deleteMany({ where: { teacherId } });
  await prisma.student.deleteMany({ where: { teacherId } });
}

async function student(teacherId = teacherA, name = '账本学生') {
  return prisma.student.create({ data: { teacherId, name, grade: '高一', source: 'test' } });
}

function prepare(cookie: string, payload: Record<string, unknown>) {
  return request(app).post('/api/v1/lesson-ledger/adjustments').set('Cookie', cookie).send(payload);
}

function confirm(cookie: string, confirmationId: string) {
  return request(app).post(`/api/v1/lesson-ledger/adjustments/${confirmationId}/confirm`).set('Cookie', cookie).send({});
}

beforeAll(async () => {
  const a = await acceptInvitation(app, prisma, { email: TEACHER_A_EMAIL });
  const b = await acceptInvitation(app, prisma, { email: TEACHER_B_EMAIL });
  expect(a.response.status).toBe(201); expect(b.response.status).toBe(201);
  cookieA = a.response.headers['set-cookie'][0]; cookieB = b.response.headers['set-cookie'][0];
  teacherA = a.response.body.data.teacher.id; teacherB = b.response.body.data.teacher.id;
});

beforeEach(async () => { await clean(teacherA); await clean(teacherB); });
afterAll(async () => { await clean(teacherA); await clean(teacherB); await prisma.$disconnect(); });

describe('P3-LEDGER-ADJUSTMENT-CONFIRM-13 HTTP contract', () => {
  it('prepare returns a non-writing preview; confirm writes exactly one immutable ledger entry and authoritative balance', async () => {
    const enrolled = await student();
    const payload = { studentId: enrolled.id, entryType: 'gift', lessonDelta: 2, reason: '补偿停课', clientRequestId: 'ledger-http-gift-0001' };
    const prepared = await prepare(cookieA, payload);
    expect(prepared.status).toBe(201);
    expect(prepared.body.data).toMatchObject({
      confirmation: { studentId: enrolled.id, entryType: 'gift', lessonDelta: 2, reason: '补偿停课', status: 'pending' },
      balanceBefore: { purchased: 0, attended: 0, adjustments: 0, remaining: 0 },
      balanceAfter: { purchased: 0, attended: 0, adjustments: 2, remaining: 2 },
    });
    const confirmationId = prepared.body.data.confirmation.id;
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: teacherA } })).toBe(0);
    expect(await prisma.lessonLedgerAdjustmentConfirmation.count({ where: { teacherId: teacherA, status: 'pending' } })).toBe(1);
    const storedConfirmation = await prisma.lessonLedgerAdjustmentConfirmation.findUniqueOrThrow({ where: { id: confirmationId } });
    expect(storedConfirmation.reasonCiphertext).not.toContain('补偿停课');

    const confirmed = await confirm(cookieA, confirmationId);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data).toMatchObject({
      confirmation: { id: confirmationId, status: 'confirmed', entry: { entryType: 'gift', lessonDelta: 2 } },
      balance: { purchased: 0, attended: 0, adjustments: 2, remaining: 2 },
    });
    const replay = await confirm(cookieA, confirmationId);
    expect(replay.status).toBe(200);
    expect(replay.body.data.balance).toMatchObject({ adjustments: 2, remaining: 2 });
    const preparedAfterConfirmation = await prepare(cookieA, payload);
    expect(preparedAfterConfirmation.status).toBe(201);
    expect(preparedAfterConfirmation.body.data).toMatchObject({
      confirmation: { id: confirmationId, status: 'confirmed', lessonDelta: 2 },
      balanceBefore: { adjustments: 2, remaining: 2 },
      balanceAfter: { adjustments: 2, remaining: 2 },
    });
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: teacherA, adjustmentConfirmationId: confirmationId } })).toBe(1);
  });

  it('rejects out-of-range integers at the service boundary before any database write', async () => {
    const enrolled = await student();
    const ledger = createLessonLedgerService({ getClient: async () => prisma, cipher });
    await expect(ledger.prepareAdjustment({
      teacherId: teacherA,
      studentId: enrolled.id,
      entryType: 'manual_adjustment',
      lessonDelta: -2_147_483_649,
      reason: '超出整数范围',
      clientRequestId: 'ledger-http-direct-invalid-range',
    })).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'lessonDelta' } });
    expect(await prisma.lessonLedgerAdjustmentConfirmation.count({ where: { teacherId: teacherA } })).toBe(0);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: teacherA } })).toBe(0);
  });

  it('is idempotent under repeated and concurrent confirmation, while a changed prepare payload conflicts', async () => {
    const enrolled = await student();
    const payload = { studentId: enrolled.id, entryType: 'manual_adjustment', lessonDelta: -1, reason: '对账修正', clientRequestId: 'ledger-http-race-0001' };
    const first = await prepare(cookieA, payload);
    const replay = await prepare(cookieA, payload);
    const conflict = await prepare(cookieA, { ...payload, lessonDelta: 1 });
    expect(first.status).toBe(201); expect(replay.status).toBe(201); expect(conflict.status).toBe(409);
    expect(replay.body.data.confirmation.id).toBe(first.body.data.confirmation.id);
    const confirmationId = first.body.data.confirmation.id;
    const confirms = await Promise.all(Array.from({ length: 6 }, () => confirm(cookieA, confirmationId)));
    expect(confirms.every((response) => response.status === 200)).toBe(true);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: teacherA, adjustmentConfirmationId: confirmationId } })).toBe(1);
    expect(await prisma.lessonLedgerAdjustmentConfirmation.count({ where: { teacherId: teacherA, clientRequestId: payload.clientRequestId } })).toBe(1);
  });

  it('rejects cross-teacher student and confirmation access without changing the owner data', async () => {
    const ownerStudent = await student();
    const ownerPrepare = await prepare(cookieA, { studentId: ownerStudent.id, entryType: 'refund', lessonDelta: -1, reason: '退款仅记账', clientRequestId: 'ledger-http-owner-0001' });
    expect(ownerPrepare.status).toBe(201);
    const foreignStudent = await student(teacherB, '他人学生');
    const crossStudent = await prepare(cookieA, { studentId: foreignStudent.id, entryType: 'gift', lessonDelta: 1, reason: '越权', clientRequestId: 'ledger-http-cross-student' });
    const crossConfirmation = await confirm(cookieB, ownerPrepare.body.data.confirmation.id);
    expect(crossStudent.status).toBe(404); expect(crossConfirmation.status).toBe(404);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: teacherA } })).toBe(0);
    expect(await prisma.lessonLedgerAdjustmentConfirmation.findUniqueOrThrow({ where: { id: ownerPrepare.body.data.confirmation.id } })).toMatchObject({ status: 'pending' });
  });

  it('returns failure only after rolling back prepare or confirm audit writes', async () => {
    const enrolled = await student();
    const faulting = prisma.$extends({
      query: {
        changeLog: {
          async create() {
            throw new Error('forced HTTP adjustment audit failure');
          },
        },
      },
    }) as unknown as PrismaClient;
    const faultingApp = createApp(faulting, { rawPrisma: prisma });
    const payload = { studentId: enrolled.id, entryType: 'gift', lessonDelta: 2, reason: '审计失败', clientRequestId: 'ledger-http-audit-prepare' };
    const failedPrepare = await request(faultingApp).post('/api/v1/lesson-ledger/adjustments').set('Cookie', cookieA).send(payload);
    expect(failedPrepare.status).toBe(500);
    expect(await prisma.lessonLedgerAdjustmentConfirmation.count({ where: { teacherId: teacherA } })).toBe(0);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: teacherA } })).toBe(0);

    const prepared = await prepare(cookieA, { ...payload, clientRequestId: 'ledger-http-audit-confirm' });
    expect(prepared.status).toBe(201);
    const failedConfirm = await request(faultingApp)
      .post(`/api/v1/lesson-ledger/adjustments/${prepared.body.data.confirmation.id}/confirm`)
      .set('Cookie', cookieA).send({});
    expect(failedConfirm.status).toBe(500);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: teacherA } })).toBe(0);
    expect(await prisma.lessonLedgerAdjustmentConfirmation.findUniqueOrThrow({ where: { id: prepared.body.data.confirmation.id } }))
      .toMatchObject({ status: 'pending', confirmedAtTs: null });
  });

  it('does not swallow an audit rollback when the caller provides the outer transaction client', async () => {
    const enrolled = await student();
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
      const ledger = createLessonLedgerService({ getClient: async () => tx, cipher });
      return ledger.prepareAdjustment({
        teacherId: teacherA, studentId: enrolled.id, entryType: 'gift', lessonDelta: 2,
        reason: '外层事务审计失败', clientRequestId: 'ledger-http-outer-rollback',
      });
    })).rejects.toThrow('ledger transaction rollback');
    expect(await prisma.lessonLedgerAdjustmentConfirmation.count({ where: { teacherId: teacherA } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: teacherA } })).toBe(0);
  });

  it.each([
    [undefined], [null], [{}],
    [{ studentId: 'missing', entryType: 'gift', lessonDelta: -1, reason: 'x', clientRequestId: 'invalid-2' }],
    [{ studentId: 'missing', entryType: 'refund', lessonDelta: 1, reason: 'x', clientRequestId: 'invalid-3' }],
    [{ studentId: 'missing', entryType: 'manual_adjustment', lessonDelta: 0, reason: 'x', clientRequestId: 'invalid-4' }],
    [{ studentId: 'missing', entryType: 'manual_adjustment', lessonDelta: 1, reason: ' ', clientRequestId: 'invalid-5' }],
    [{ studentId: 'missing', entryType: 'manual_adjustment', lessonDelta: 2_147_483_648, reason: 'x', clientRequestId: 'invalid-6' }],
  ])('rejects malformed adjustment input before any write', async (payload) => {
    const response = await prepare(cookieA, payload as Record<string, unknown>);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.lessonLedgerAdjustmentConfirmation.count({ where: { teacherId: teacherA } })).toBe(0);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: teacherA } })).toBe(0);
  });
});
