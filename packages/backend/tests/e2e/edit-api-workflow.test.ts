import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { createChangelogService, withChangelog } from '../../src/shared/changelog/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';

const prisma = new PrismaClient();
const app = createApp(prisma, { rawPrisma: prisma });
const TEACHER = 'edit-api-workflow-teacher';
const BASE_TOKEN = new Date('2000-01-01T00:00:00.000Z');
// P8 phase-3 批1：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);

interface ApiResponse {
  status: number;
  body: any;
}

function requestApp(method: string, url: string, body: unknown, targetApp = app): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = new Readable({
      read() {
        this.push(payload);
        this.push(null);
      },
    }) as any;
    req.method = method;
    req.url = url;
    req.headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload).toString(),
      'x-teacher-id': TEACHER,
    };

    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    }) as any;
    res.statusCode = 200;
    res.headers = {};
    res.setHeader = (key: string, value: string) => { res.headers[key.toLowerCase()] = value; };
    res.getHeader = (key: string) => res.headers[key.toLowerCase()];
    res.removeHeader = (key: string) => { delete res.headers[key.toLowerCase()]; };
    res.end = (chunk?: unknown) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      return res;
    };
    targetApp.handle(req, res, (error?: unknown) => {
      if (error) reject(error);
      else resolve({ status: 404, body: null });
    });
  });
}

async function cleanup() {
  await prisma.changeLog.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.lesson.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.schedule.deleteMany({ where: { teacherId: TEACHER, parentId: { not: null } } });
  await prisma.schedule.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.payment.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.memo.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER } });
}

async function fixtures() {
  const student = await prisma.student.create({
    data: { teacherId: TEACHER, name: '原学生', grade: '高一', updatedAtTs: BASE_TOKEN },
  });
  const schedule = await prisma.schedule.create({
    data: {
      teacherId: TEACHER,
      studentId: student.id,
      type: 'lesson',
      title: '原课程',
      scheduledStartTs: new Date('2030-08-20T01:00:00.000Z'),
      scheduledEndTs: new Date('2030-08-20T02:00:00.000Z'),
      updatedAtTs: BASE_TOKEN,
    },
  });
  const lesson = await prisma.lesson.create({
    data: {
      teacherId: TEACHER,
      studentId: student.id,
      scheduleId: schedule.id,
      dateTs: new Date('2030-08-20T01:00:00.000Z'),
      progress: '原进度',
      updatedAtTs: BASE_TOKEN,
    },
  });
  const payment = await prisma.payment.create({
    data: {
      teacherId: TEACHER,
      studentId: student.id,
      amount: 1000,
      lessonCount: 8,
      paidAtTs: new Date('2030-08-01T00:00:00.000Z'),
      updatedAtTs: BASE_TOKEN,
    },
  });
  const memo = await prisma.memo.create({
    data: { teacherId: TEACHER, title: '原备忘', content: '原内容', updatedAtTs: BASE_TOKEN },
  });
  const feedback = await prisma.parentFeedback.create({
    data: {
      teacherId: TEACHER,
      studentId: student.id,
      lessonId: lesson.id,
      title: '原反馈',
      content: '原反馈内容',
      updatedAtTs: BASE_TOKEN,
    },
  });
  return { student, schedule, lesson, payment, memo, feedback };
}

beforeEach(cleanup);
afterEach(cleanup);

describe('A5-I8 edit API workflow', () => {
  it('makes all six raw-Prisma typed commands reachable through the frozen HTTP contract', async () => {
    const records = await fixtures();
    const token = BASE_TOKEN.toISOString();
    const calls = [
      ['PATCH', `/api/v1/students/${records.student.id}/profile`, { expectedUpdatedAt: token, changes: { name: '新学生' } }],
      ['POST', `/api/v1/schedules/${records.schedule.id}/reschedule`, {
        expectedUpdatedAt: token,
        replacement: {
          scheduledStart: '2030-08-21T01:00:00.000Z',
          scheduledEnd: '2030-08-21T02:00:00.000Z',
        },
      }],
      ['PATCH', `/api/v1/lessons/${records.lesson.id}/record`, { expectedUpdatedAt: token, changes: { progress: '新进度' } }],
      ['PATCH', `/api/v1/payments/${records.payment.id}`, { expectedUpdatedAt: token, changes: { note: '已核对' } }],
      ['PATCH', `/api/v1/memos/${records.memo.id}`, { expectedUpdatedAt: token, changes: { title: '新备忘' } }],
      ['PATCH', `/api/v1/feedback/${records.feedback.id}/content`, { expectedUpdatedAt: token, changes: { content: '新反馈内容' } }],
    ] as const;

    for (const [method, path, body] of calls) {
      const response = await requestApp(method, path, body);
      expect(response.status, path).toBe(200);
      expect(response.body.ok, path).toBe(true);
    }

    expect((await prisma.student.findUniqueOrThrow({ where: { id: records.student.id } })).name).toBe('新学生');
    expect((await prisma.schedule.findUniqueOrThrow({ where: { id: records.schedule.id } })).status).toBe('rescheduled');
    // P8 phase-3 批4：lesson.progress 落库为密文，解密后为新进度
    const storedLesson = await prisma.lesson.findUniqueOrThrow({ where: { id: records.lesson.id } });
    expect(storedLesson.progress).not.toBe('新进度');
    expect(cipher.decrypt(storedLesson.progress!)).toBe('新进度');
    // P8 phase-3 批6：payment.note 落库为密文，解密后为已核对
    const storedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: records.payment.id } });
    expect(storedPayment.note).not.toBe('已核对');
    expect(cipher.decrypt(storedPayment.note!)).toBe('已核对');
    expect((await prisma.memo.findUniqueOrThrow({ where: { id: records.memo.id } })).title).toBe('新备忘');
    // P8 phase-3 批1：ParentFeedback content 落库为密文，解密后为新内容
    const storedFeedback = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: records.feedback.id } });
    expect(storedFeedback.content).not.toBe('新反馈内容');
    expect(cipher.decrypt(storedFeedback.content)).toBe('新反馈内容');
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER } })).toBe(7);
  });

  it('returns unified 400 and 404 JSON through the real Express app chain', async () => {
    const invalid = await requestApp('PATCH', '/api/v1/payments/missing', {
      expectedUpdatedAt: BASE_TOKEN.toISOString(),
      changes: { note: 'x' },
      source: 'system',
    });
    expect(invalid).toEqual({
      status: 400,
      body: { ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR' }) },
    });

    const missing = await requestApp('PATCH', '/api/v1/payments/missing', {
      expectedUpdatedAt: BASE_TOKEN.toISOString(),
      changes: { note: 'x' },
    });
    expect(missing).toEqual({
      status: 404,
      body: { ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) },
    });
  });

  it('keeps edit routes unreachable when a custom public client omits an explicit raw client', async () => {
    const extended = withChangelog(prisma, createChangelogService(prisma)) as unknown as PrismaClient;
    const failClosedApp = createApp(extended);
    const response = await requestApp('PATCH', '/api/v1/payments/missing', {
      expectedUpdatedAt: BASE_TOKEN.toISOString(),
      changes: { note: 'must not dispatch' },
    }, failClosedApp);
    expect(response.status).toBe(404);
  });

  it('uses the explicit raw client when the public client has automatic ChangeLog extension', async () => {
    const { payment } = await fixtures();
    const extended = withChangelog(prisma, createChangelogService(prisma)) as unknown as PrismaClient;
    const extendedApp = createApp(extended, { rawPrisma: prisma });
    const response = await requestApp('PATCH', `/api/v1/payments/${payment.id}`, {
      expectedUpdatedAt: BASE_TOKEN.toISOString(),
      changes: { note: 'single audit' },
    }, extendedApp);

    expect(response.status).toBe(200);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER, targetId: payment.id } })).toBe(1);
  });

  it('returns the unified 409 protocol for a stale HTTP edit and writes nothing', async () => {
    const { payment } = await fixtures();
    const response = await requestApp('PATCH', `/api/v1/payments/${payment.id}`, {
      expectedUpdatedAt: '1999-01-01T00:00:00.000Z',
      changes: { note: 'stale' },
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'VERSION_CONFLICT',
        message: '记录已被其他操作更新，请刷新后重试',
        field: 'expectedUpdatedAt',
      },
    });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).note).toBeNull();
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER } })).toBe(0);
  });
});
