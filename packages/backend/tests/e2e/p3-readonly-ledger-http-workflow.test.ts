import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { acceptInvitation } from '../helpers/invitations.js';

/**
 * P3-READONLY-LEDGER-HTTP-01：余额与正式课时流水的认证只读验收。
 *
 * 数据准备直接写入合成测试库，HTTP 只覆盖认证读取路径；测试不会调用支付、调整确认
 * 或任何外部服务。第二个 PrismaClient + createApp 用同一个持久 session 回读，验证
 * 读取结果不依赖旧的服务上下文。
 */
const prisma = new PrismaClient();
const app = createApp(prisma, { rawPrisma: prisma, localSafeMode: true });
const createdTeacherIds: string[] = [];

async function cleanup() {
  if (createdTeacherIds.length === 0) return;
  const teachers = { in: createdTeacherIds };
  await prisma.changeLog.deleteMany({ where: { teacherId: teachers } });
  await prisma.lessonLedgerEntry.deleteMany({ where: { teacherId: teachers } });
  await prisma.lessonLedgerAdjustmentConfirmation.deleteMany({ where: { teacherId: teachers } });
  await prisma.payment.deleteMany({ where: { teacherId: teachers } });
  await prisma.lesson.deleteMany({ where: { teacherId: teachers } });
  await prisma.schedule.deleteMany({ where: { teacherId: teachers } });
  await prisma.student.deleteMany({ where: { teacherId: teachers } });
  await prisma.sessionStore.deleteMany({ where: { teacherId: teachers } });
  await prisma.teacherRegistry.deleteMany({ where: { id: teachers } });
  await prisma.teacherInvitation.deleteMany({ where: { email: { startsWith: 'p3-ledger-http-' } } });
}

async function countReadModelWrites(teacherIds: string[]) {
  const where = { in: teacherIds };
  return {
    students: await prisma.student.count({ where: { teacherId: where } }),
    lessons: await prisma.lesson.count({ where: { teacherId: where } }),
    payments: await prisma.payment.count({ where: { teacherId: where } }),
    ledgerEntries: await prisma.lessonLedgerEntry.count({ where: { teacherId: where } }),
    adjustmentConfirmations: await prisma.lessonLedgerAdjustmentConfirmation.count({ where: { teacherId: where } }),
    completionSnapshots: await prisma.scheduleCompletionSnapshot.count({ where: { teacherId: where } }),
    changeLogs: await prisma.changeLog.count({ where: { teacherId: where } }),
  };
}

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('P3 余额与课时流水认证只读 HTTP 合成闭环', () => {
  it('认证读取、跨新服务上下文回读、跨教师隔离且重复 GET 零写入', async () => {
    const suffix = randomBytes(6).toString('hex');
    const teacherA = (await acceptInvitation(app, prisma, {
      email: `p3-ledger-http-a-${suffix}@example.com`,
      password: 'password123',
      displayName: 'P3 教师 A',
    })).response;
    const teacherB = (await acceptInvitation(app, prisma, {
      email: `p3-ledger-http-b-${suffix}@example.com`,
      password: 'password123',
      displayName: 'P3 教师 B',
    })).response;
    expect(teacherA.status).toBe(201);
    expect(teacherB.status).toBe(201);

    const teacherAId = teacherA.body.data.teacher.id as string;
    const teacherBId = teacherB.body.data.teacher.id as string;
    createdTeacherIds.push(teacherAId, teacherBId);
    const cookieA = teacherA.headers['set-cookie'][0].split(';')[0];
    const cookieB = teacherB.headers['set-cookie'][0].split(';')[0];

    const studentA = await prisma.student.create({
      data: { teacherId: teacherAId, name: 'P3 合成学生 A', grade: '高一', source: 'synthetic' },
    });
    const paidAt = new Date('2026-09-18T10:00:00.000Z');
    const payment = await prisma.payment.create({
      data: {
        teacherId: teacherAId,
        studentId: studentA.id,
        amount: 800,
        lessonCount: 8,
        clientRequestId: `p3-payment-${suffix}`,
        paidAtTs: paidAt,
      },
    });
    await prisma.lessonLedgerEntry.create({
      data: {
        teacherId: teacherAId,
        studentId: studentA.id,
        entryType: 'purchase',
        lessonDelta: 8,
        amount: 800,
        paymentId: payment.id,
        createdAtTs: paidAt,
      },
    });
    await prisma.lessonLedgerEntry.create({
      data: {
        teacherId: teacherAId,
        studentId: studentA.id,
        entryType: 'attendance_deduction',
        lessonDelta: -1,
        clientRequestId: `p3-attendance-${suffix}`,
        createdAtTs: new Date('2026-09-19T10:00:00.000Z'),
      },
    });
    await prisma.lessonLedgerEntry.create({
      data: {
        teacherId: teacherAId,
        studentId: studentA.id,
        entryType: 'gift',
        lessonDelta: 2,
        clientRequestId: `p3-gift-${suffix}`,
        createdAtTs: new Date('2026-09-20T10:00:00.000Z'),
      },
    });

    const beforeReads = await countReadModelWrites(createdTeacherIds);
    const unauthenticated = await request(app)
      .get(`/api/v1/students/${studentA.id}/balance`);
    expect(unauthenticated.status).toBe(401);

    const balance = await request(app)
      .get(`/api/v1/students/${studentA.id}/balance`)
      .set('Cookie', cookieA);
    const entries = await request(app)
      .get(`/api/v1/lesson-ledger/entries?studentId=${studentA.id}`)
      .set('Cookie', cookieA);
    expect(balance.status).toBe(200);
    expect(balance.body).toEqual({
      ok: true,
      data: { purchased: 8, attended: 1, adjustments: 2, remaining: 9 },
    });
    expect(entries.status).toBe(200);
    expect(entries.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ studentId: studentA.id, entryType: 'purchase', lessonDelta: 8, paymentId: payment.id }),
      expect.objectContaining({ studentId: studentA.id, entryType: 'attendance_deduction', lessonDelta: -1 }),
      expect.objectContaining({ studentId: studentA.id, entryType: 'gift', lessonDelta: 2 }),
    ]));
    expect(entries.body.data).toHaveLength(3);

    const freshPrisma = new PrismaClient();
    const freshApp = createApp(freshPrisma, { rawPrisma: freshPrisma, localSafeMode: true });
    try {
      const freshBalance = await request(freshApp)
        .get(`/api/v1/students/${studentA.id}/balance`)
        .set('Cookie', cookieA);
      const freshEntries = await request(freshApp)
        .get(`/api/v1/lesson-ledger/entries?studentId=${studentA.id}`)
        .set('Cookie', cookieA);
      expect(freshBalance.status).toBe(200);
      expect(freshBalance.body).toEqual(balance.body);
      expect(freshEntries.status).toBe(200);
      expect(freshEntries.body).toEqual(entries.body);
    } finally {
      await freshPrisma.$disconnect();
    }

    const crossBalance = await request(app)
      .get(`/api/v1/students/${studentA.id}/balance`)
      .set('Cookie', cookieB);
    const crossEntries = await request(app)
      .get(`/api/v1/lesson-ledger/entries?studentId=${studentA.id}`)
      .set('Cookie', cookieB);
    expect(crossBalance.status).toBe(404);
    expect(crossBalance.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '学生不存在' } });
    expect(crossEntries.status).toBe(404);
    expect(crossEntries.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '学生不存在' } });

    const repeatedReads = await Promise.all(Array.from({ length: 3 }, () => Promise.all([
      request(app).get(`/api/v1/students/${studentA.id}/balance`).set('Cookie', cookieA),
      request(app).get(`/api/v1/lesson-ledger/entries?studentId=${studentA.id}`).set('Cookie', cookieA),
    ])));
    for (const [repeatedBalance, repeatedEntries] of repeatedReads) {
      expect(repeatedBalance.status).toBe(200);
      expect(repeatedBalance.body).toEqual(balance.body);
      expect(repeatedEntries.status).toBe(200);
      expect(repeatedEntries.body).toEqual(entries.body);
    }
    const afterReads = await countReadModelWrites(createdTeacherIds);
    expect(afterReads).toEqual(beforeReads);
  });
});
