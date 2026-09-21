import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { acceptInvitation } from '../helpers/invitations.js';

/**
 * P3-STUDENT-PROFILE-LEDGER-READBACK-02：学生画像读取课时余额的认证闭环。
 *
 * 合成账本数据直接写入隔离测试库；业务 HTTP 请求全部是 GET，避免把 B02 的
 * 数量写入行为带入本验收。新的 PrismaClient + createApp 复用持久 session，验证
 * profile 读取不依赖旧服务上下文，且重复读取不会产生任何读模型写入。
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
  await prisma.teacherInvitation.deleteMany({ where: { email: { startsWith: 'p3-profile-ledger-' } } });
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

describe('P3 学生画像课时账本认证只读 HTTP 合成闭环', () => {
  it('认证读取、跨新服务上下文回读、跨教师隔离且重复 GET 零写入', async () => {
    const suffix = randomBytes(6).toString('hex');
    const teacherA = (await acceptInvitation(app, prisma, {
      email: `p3-profile-ledger-a-${suffix}@example.com`,
      password: 'password123',
      displayName: 'P3 画像教师 A',
    })).response;
    const teacherB = (await acceptInvitation(app, prisma, {
      email: `p3-profile-ledger-b-${suffix}@example.com`,
      password: 'password123',
      displayName: 'P3 画像教师 B',
    })).response;
    expect(teacherA.status).toBe(201);
    expect(teacherB.status).toBe(201);

    const teacherAId = teacherA.body.data.teacher.id as string;
    const teacherBId = teacherB.body.data.teacher.id as string;
    createdTeacherIds.push(teacherAId, teacherBId);
    const cookieA = teacherA.headers['set-cookie'][0].split(';')[0];
    const cookieB = teacherB.headers['set-cookie'][0].split(';')[0];

    const studentA = await prisma.student.create({
      data: { teacherId: teacherAId, name: 'P3 画像合成学生 A', grade: '高一', source: 'synthetic' },
    });
    const paidAt = new Date('2026-09-18T10:00:00.000Z');
    const payment = await prisma.payment.create({
      data: {
        teacherId: teacherAId,
        studentId: studentA.id,
        amount: 800,
        lessonCount: 8,
        clientRequestId: `p3-profile-payment-${suffix}`,
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
        clientRequestId: `p3-profile-attendance-${suffix}`,
        createdAtTs: new Date('2026-09-19T10:00:00.000Z'),
      },
    });
    await prisma.lessonLedgerEntry.create({
      data: {
        teacherId: teacherAId,
        studentId: studentA.id,
        entryType: 'gift',
        lessonDelta: 2,
        clientRequestId: `p3-profile-gift-${suffix}`,
        createdAtTs: new Date('2026-09-20T10:00:00.000Z'),
      },
    });

    const beforeReads = await countReadModelWrites(createdTeacherIds);
    const unauthenticated = await request(app)
      .get(`/api/v1/students/${studentA.id}/profile`);
    expect(unauthenticated.status).toBe(401);

    const profile = await request(app)
      .get(`/api/v1/students/${studentA.id}/profile`)
      .set('Cookie', cookieA);
    const balance = await request(app)
      .get(`/api/v1/students/${studentA.id}/balance`)
      .set('Cookie', cookieA);
    expect(profile.status).toBe(200);
    expect(balance.status).toBe(200);
    expect(profile.body.ok).toBe(true);
    expect(profile.body.data.student.id).toBe(studentA.id);
    expect(profile.body.data.lessonBalance).toEqual({
      purchased: 8,
      attended: 1,
      adjustments: 2,
      remaining: 9,
    });
    expect(profile.body.data.lessonBalance).toEqual(balance.body.data);

    const freshPrisma = new PrismaClient();
    const freshApp = createApp(freshPrisma, { rawPrisma: freshPrisma, localSafeMode: true });
    try {
      const freshProfile = await request(freshApp)
        .get(`/api/v1/students/${studentA.id}/profile`)
        .set('Cookie', cookieA);
      expect(freshProfile.status).toBe(200);
      expect(freshProfile.body).toEqual(profile.body);
    } finally {
      await freshPrisma.$disconnect();
    }

    const crossTeacher = await request(app)
      .get(`/api/v1/students/${studentA.id}/profile`)
      .set('Cookie', cookieB);
    expect(crossTeacher.status).toBe(404);
    expect(crossTeacher.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '学生不存在' } });

    const repeatedReads = await Promise.all(Array.from({ length: 3 }, () => request(app)
      .get(`/api/v1/students/${studentA.id}/profile`)
      .set('Cookie', cookieA)));
    for (const repeatedProfile of repeatedReads) {
      expect(repeatedProfile.status).toBe(200);
      expect(repeatedProfile.body).toEqual(profile.body);
    }
    const afterReads = await countReadModelWrites(createdTeacherIds);
    expect(afterReads).toEqual(beforeReads);
  });
});
