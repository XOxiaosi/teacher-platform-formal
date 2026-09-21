import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { PrismaClient } from '@prisma/client';
import express, { type Request } from 'express';
import { internalError } from '@teacher-platform/contracts';
import { createApp } from '../../src/index.js';
import { createCoreRouter } from '../../src/app/routes/core.routes.js';
import { createChangelogService, withChangelog } from '../../src/shared/changelog/index.js';

/**
 * P0 IDOR 修复：路由层身份只来自 requireAuth 注入的 req.teacherId（不再读 x-teacher-id header）。
 * 直挂 createCoreRouter（不经 requireAuth）的测试用轻量中间件模拟认证层 dev fallback 的注入语义。
 */
function injectDevIdentity(app: express.Express): void {
  app.use((req, _res, next) => {
    const header = req.header('x-teacher-id');
    if (header) (req as Request & { teacherId?: string }).teacherId = header;
    next();
  });
}

const prisma = new PrismaClient();
// 单库兼容路径：不传 dbRouter（模块级 app 现启用数据库路由，此测试验证无路由单库基线）；
// 用 withChangelog 包装 client（与生产一致，changelog 拦截生效——测试断言 changelog 写入）
const app = createApp(withChangelog(prisma, createChangelogService(prisma)) as unknown as PrismaClient);
const TEACHER_ID = 'test-teacher-api-core-workflow';
const OTHER_TEACHER_ID = 'test-teacher-api-core-workflow-other';

async function cleanup() {
  const teacherIds = [TEACHER_ID, OTHER_TEACHER_ID];
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.pushRecord.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.dailyReview.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.payment.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teacherIds } } });
}

interface ApiResponse {
  status: number;
  body: any;
}

function requestApp(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
  target: { handle: typeof app.handle } = app,
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
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
      ...headers,
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

    target.handle(req, res, (error?: unknown) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ status: res.statusCode === 200 ? 404 : res.statusCode, body: null });
    });
  });
}

function api(method: string, url: string, body?: unknown) {
  return requestApp(method, url, body, { 'x-teacher-id': TEACHER_ID });
}

describe('API 核心教师工作流端到端', () => {
  beforeEach(async () => { await cleanup(); });
  afterEach(async () => { await cleanup(); });

  it('缺少 teacherId header 时返回 401（P0 IDOR 修复：身份唯一来源 = requireAuth 注入）', async () => {
    const response = await requestApp('POST', '/api/v1/students', { name: '无老师', grade: '高三' });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: '未登录或会话已过期' },
    });
  });

  it('拒绝跨 teacher 查询学生余额', async () => {
    const otherStudent = await prisma.student.create({ data: { teacherId: OTHER_TEACHER_ID, name: '其他老师学生', grade: '高一' } });
    await prisma.payment.create({
      data: { teacherId: OTHER_TEACHER_ID, studentId: otherStudent.id, amount: 1200, lessonCount: 8, paidAtTs: new Date('2025-05-01') },
    });

    const response = await api('GET', `/api/v1/students/${otherStudent.id}/balance`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '学生不存在' } });
  });

  it('日程列表拒绝非法 type 查询参数', async () => {
    const response = await api('GET', '/api/v1/schedules?type=invalid');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: '日程类型不合法', field: 'type' },
    });
  });

  it('POST /schedules 拒绝缺少时区 offset 的计划时间且零写入', async () => {
    const response = await api('POST', '/api/v1/schedules', {
      type: 'lesson',
      title: '缺少时区的 API 课程',
      scheduledStart: '2030-07-20T16:00:00',
      scheduledEnd: '2030-07-20T18:00:00',
    });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toEqual(expect.objectContaining({
      code: 'VALIDATION_ERROR',
      field: 'scheduledStart',
    }));
    expect(await prisma.schedule.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('POST /schedules 与 /payments 拒绝关联其他 teacher 的学生且零写入', async () => {
    const otherStudent = await prisma.student.create({
      data: { teacherId: OTHER_TEACHER_ID, name: '其他老师学生', grade: '高一' },
    });

    const scheduleResponse = await api('POST', '/api/v1/schedules', {
      studentId: otherStudent.id,
      type: 'lesson',
      title: '跨老师 API 课程',
      scheduledStart: '2030-07-20T16:00:00+08:00',
      scheduledEnd: '2030-07-20T18:00:00+08:00',
    });
    const paymentResponse = await api('POST', '/api/v1/payments', {
      studentId: otherStudent.id,
      amount: 1200,
      lessonCount: 8,
      paidAt: '2030-07-20T10:00:00+08:00',
    });

    expect(scheduleResponse.status).toBe(404);
    expect(scheduleResponse.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '学生不存在' } });
    expect(paymentResponse.status).toBe(404);
    expect(paymentResponse.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '学生不存在' } });
    expect(await prisma.schedule.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.payment.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('POST /schedules 拒绝过去的 planned 日程且零写入', async () => {
    const response = await api('POST', '/api/v1/schedules', {
      type: 'lesson',
      title: '过去的 API 课程',
      scheduledStart: '2026-07-20T16:00:00+08:00',
      scheduledEnd: '2026-07-20T18:00:00+08:00',
    });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toEqual(expect.objectContaining({
      code: 'VALIDATION_ERROR',
      field: 'scheduledStart',
    }));
    expect(await prisma.schedule.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('POST /schedules 在 TrustedClock 失败时返回 500 且零写入', async () => {
    const isolatedApp = express();
    isolatedApp.use(express.json());
    injectDevIdentity(isolatedApp);
    isolatedApp.use('/api/v1', createCoreRouter(prisma, {
      trustedClock: {
        now: async () => ({ ok: false, error: internalError('数据库可信时间不可用') }),
      },
    }));

    const response = await requestApp(
      'POST',
      '/api/v1/schedules',
      {
        type: 'lesson',
        title: '时钟失败的 API 课程',
        scheduledStart: '2030-07-20T16:00:00+08:00',
        scheduledEnd: '2030-07-20T18:00:00+08:00',
      },
      { 'x-teacher-id': TEACHER_ID },
      isolatedApp,
    );

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '数据库可信时间不可用' },
    });
    expect(await prisma.schedule.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('POST /daily-review/assemble 接受严格 BusinessDate', async () => {
    const response = await api('POST', '/api/v1/daily-review/assemble', { date: '2030-05-02' });

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.review.date).toBe('2030-05-02T00:00:00.000Z');
  });

  it.each([null, 42, true, [], {}, '2030-05-02T00:00:00.000Z', '2030-02-30']) (
    'POST /daily-review/assemble 拒绝非法 date %# 且零写入',
    async (date) => {
      const response = await api('POST', '/api/v1/daily-review/assemble', { date });

      expect(response.status).toBe(400);
      expect(response.body.error).toEqual(expect.objectContaining({
        code: 'VALIDATION_ERROR',
        field: 'date',
      }));
      expect(await prisma.dailyReview.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    },
  );

  it.each([null, [], 'not-an-object']) (
    'POST /daily-review/assemble 拒绝非对象 body %#',
    async (body) => {
      const isolatedApp = express();
      isolatedApp.use(express.json({ strict: false }));
      injectDevIdentity(isolatedApp);
      isolatedApp.use('/api/v1', createCoreRouter(prisma, {
        trustedClock: { now: async () => ({ ok: true, value: new Date('2030-05-01T16:00:00.000Z') }) },
      }));

      const response = await requestApp(
        'POST',
        '/api/v1/daily-review/assemble',
        body,
        { 'x-teacher-id': TEACHER_ID },
        isolatedApp,
      );

      expect(response.status).toBe(400);
      expect(response.body.error).toEqual({
        code: 'VALIDATION_ERROR',
        message: '请求体必须是对象',
        field: 'body',
      });
      expect(await prisma.dailyReview.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    },
  );

  it('POST /daily-review/assemble 的空对象使用注入 TrustedClock', async () => {
    const now = vi.fn(async () => ({ ok: true as const, value: new Date('2030-05-01T16:00:00.000Z') }));
    const isolatedApp = express();
    isolatedApp.use(express.json());
    injectDevIdentity(isolatedApp);
    isolatedApp.use('/api/v1', createCoreRouter(prisma, { trustedClock: { now } }));

    const response = await requestApp(
      'POST',
      '/api/v1/daily-review/assemble',
      {},
      { 'x-teacher-id': TEACHER_ID },
      isolatedApp,
    );

    expect(response.status).toBe(201);
    expect(response.body.data.review.date).toBe('2030-05-02T00:00:00.000Z');
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('POST /daily-review/assemble 在 TrustedClock 失败时返回 500 且零写入', async () => {
    const now = vi.fn(async () => ({ ok: false as const, error: internalError('每日回顾可信时间不可用') }));
    const isolatedApp = express();
    isolatedApp.use(express.json());
    injectDevIdentity(isolatedApp);
    isolatedApp.use('/api/v1', createCoreRouter(prisma, { trustedClock: { now } }));

    const response = await requestApp(
      'POST',
      '/api/v1/daily-review/assemble',
      {},
      { 'x-teacher-id': TEACHER_ID },
      isolatedApp,
    );

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '每日回顾可信时间不可用' },
    });
    expect(now).toHaveBeenCalledTimes(1);
    expect(await prisma.dailyReview.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('拒绝其他 teacher 通过 API 完成日程', async () => {
    const student = await prisma.student.create({
      data: { teacherId: TEACHER_ID, name: '受保护学生', grade: '高二' },
    });
    const schedule = await prisma.schedule.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: student.id,
        type: 'lesson',
        title: '受保护课程',
        scheduledStartTs: new Date('2025-05-03T19:00:00+08:00'),
        scheduledEndTs: new Date('2025-05-03T20:30:00+08:00'),
      },
    });

    const response = await requestApp(
      'POST',
      `/api/v1/schedules/${schedule.id}/complete`,
      {},
      { 'x-teacher-id': OTHER_TEACHER_ID },
    );

    expect(response.status).toBe(404);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('NOT_FOUND');
    const persisted = await prisma.schedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(persisted.status).toBe('planned');
    expect(await prisma.lesson.count({ where: { scheduleId: schedule.id } })).toBe(0);
  });

  it('通过 HTTP API 完成学生、缴费、排课、完成课程、余额、档案、每日回顾，并写入 changelog', async () => {
    const studentResponse = await api('POST', '/api/v1/students', {
      name: 'API学生',
      grade: '高三',
      source: '转介绍',
      stageGoal: '二轮复习',
    });

    expect(studentResponse.status).toBe(201);
    expect(studentResponse.body.ok).toBe(true);
    const studentId = studentResponse.body.data.id as string;
    expect(studentResponse.body.data.teacherId).toBe(TEACHER_ID);

    const paymentResponse = await api('POST', '/api/v1/payments', {
      studentId,
      amount: 3000,
      lessonCount: 10,
      paidAt: '2030-05-01T10:00:00+08:00',
      note: 'API预付课时',
    });

    expect(paymentResponse.status).toBe(201);
    expect(paymentResponse.body.ok).toBe(true);
    expect(paymentResponse.body.data.studentId).toBe(studentId);

    const scheduleResponse = await api('POST', '/api/v1/schedules', {
      studentId,
      type: 'lesson',
      title: 'API学生物理课',
      scheduledStart: '2030-05-02T19:00:00+08:00',
      scheduledEnd: '2030-05-02T20:30:00+08:00',
      confidence: 'high',
    });

    expect(scheduleResponse.status).toBe(201);
    expect(scheduleResponse.body.ok).toBe(true);
    const scheduleId = scheduleResponse.body.data.schedule.id as string;
    expect(scheduleResponse.body.data.conflicts).toEqual([]);

    const completeResponse = await api('POST', `/api/v1/schedules/${scheduleId}/complete`, {});

    expect(completeResponse.status).toBe(200);
    expect(completeResponse.body.ok).toBe(true);
    expect(completeResponse.body.data.schedule.status).toBe('completed');
    expect(completeResponse.body.data.lesson.status).toBe('attended');

    const balanceResponse = await api('GET', `/api/v1/students/${studentId}/balance`);

    expect(balanceResponse.status).toBe(200);
    expect(balanceResponse.body).toEqual({ ok: true, data: { purchased: 10, attended: 1, adjustments: 0, remaining: 9 } });

    const profileResponse = await api('GET', `/api/v1/students/${studentId}/profile`);

    expect(profileResponse.status).toBe(200);
    expect(profileResponse.body.ok).toBe(true);
    expect(profileResponse.body.data.student.id).toBe(studentId);
    expect(profileResponse.body.data.lessonBalance).toEqual({ purchased: 10, attended: 1, adjustments: 0, remaining: 9 });

    const reviewResponse = await api('POST', '/api/v1/daily-review/assemble', {
      date: '2030-05-02',
    });

    expect(reviewResponse.status).toBe(201);
    expect(reviewResponse.body.ok).toBe(true);
    expect(reviewResponse.body.data.review.plannedCount).toBe(1);
    expect(reviewResponse.body.data.review.actualCount).toBe(1);

    const changelogModules = await prisma.changeLog.findMany({
      where: { teacherId: TEACHER_ID },
      select: { module: true, action: true },
      orderBy: { createdAtTs: 'asc' },
    });

    expect(changelogModules).toEqual(
      expect.arrayContaining([
        { module: 'students', action: 'create' },
        { module: 'payments', action: 'create' },
        { module: 'scheduling', action: 'create' },
        { module: 'scheduling', action: 'update' },
        { module: 'lessons', action: 'create' },
        { module: 'daily-review', action: 'create' },
      ]),
    );
  });
});
