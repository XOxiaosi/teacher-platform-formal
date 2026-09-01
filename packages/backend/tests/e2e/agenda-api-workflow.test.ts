import { Readable, Writable } from 'node:stream';
import express, { type Request } from 'express';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, internalError, ok, type CommonError, type Result } from '@teacher-platform/contracts';
import { createCoreRouter } from '../../src/app/routes/core.routes.js';

const prisma = new PrismaClient();
const TEACHER_A = 'agenda-api-teacher-a';
const NOW = new Date('2030-07-24T01:00:00.000Z');

interface ApiResponse {
  status: number;
  body: Record<string, unknown> | null;
}

function requestApp(
  app: express.Express,
  url: string,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const req = new Readable({
      read() {
        this.push(null);
      },
    }) as Readable & {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    req.method = 'GET';
    req.url = url;
    req.headers = headers;

    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    }) as Writable & {
      statusCode: number;
      headers: Record<string, string>;
      setHeader(key: string, value: string): void;
      getHeader(key: string): string | undefined;
      removeHeader(key: string): void;
      end(chunk?: unknown): Writable;
    };
    res.statusCode = 200;
    res.headers = {};
    res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
    res.getHeader = (key) => res.headers[key.toLowerCase()];
    res.removeHeader = (key) => { delete res.headers[key.toLowerCase()]; };
    res.end = (chunk?: unknown) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status: res.statusCode, body: text ? JSON.parse(text) as Record<string, unknown> : null });
      return res;
    };

    app.handle(
      req as unknown as Parameters<typeof app.handle>[0],
      res as unknown as Parameters<typeof app.handle>[1],
      (error?: unknown) => {
        if (error) reject(error);
        else resolve({ status: 404, body: null });
      },
    );
  });
}

function testApp(clockResult: Result<Date, CommonError> = ok(NOW)) {
  const now = vi.fn(async () => clockResult);
  const app = express();
  app.use(express.json());
  // P0 IDOR 修复：路由层身份只来自 requireAuth 注入的 req.teacherId（不再读 x-teacher-id header）。
  // 直挂 createCoreRouter（不经 requireAuth）用轻量中间件模拟认证层 dev fallback 的注入语义。
  app.use((req, _res, next) => {
    const header = req.header('x-teacher-id');
    if (header) (req as Request & { teacherId?: string }).teacherId = header;
    next();
  });
  app.use('/api/v1', createCoreRouter(prisma, { trustedClock: { now } }));
  return { app, now };
}

async function cleanup() {
  const teacherIds = [TEACHER_A];
  await prisma.agentExecution.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.pendingAction.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.conversationTurn.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.conversation.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.memo.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teacherIds } } });
}

async function seedAgendaFacts() {
  const studentA = await prisma.student.create({
    data: { teacherId: TEACHER_A, name: '小明', grade: '高一' },
  });
  const crossDay = await prisma.schedule.create({
    data: {
      teacherId: TEACHER_A,
      studentId: studentA.id,
      type: 'lesson',
      title: '跨日物理课',
      scheduledStartTs: new Date('2030-07-23T15:30:00.000Z'),
      scheduledEndTs: new Date('2030-07-23T17:00:00.000Z'),
    },
  });
  const meeting = await prisma.schedule.create({
    data: {
      teacherId: TEACHER_A,
      type: 'meeting',
      title: '窗口内教研会',
      scheduledStartTs: new Date('2030-07-24T02:00:00.000Z'),
      scheduledEndTs: new Date('2030-07-24T03:00:00.000Z'),
    },
  });
  const overdueMemo = await prisma.memo.create({
    data: {
      teacherId: TEACHER_A,
      title: '历史逾期备忘',
      content: 'private-overdue-content',
      status: 'active',
      dueAtTs: new Date('2030-07-20T04:00:00.000Z'),
    },
  });
  const todayMemo = await prisma.memo.create({
    data: {
      teacherId: TEACHER_A,
      title: '今日备忘',
      content: 'private-today-content',
      status: 'active',
      dueAtTs: new Date('2030-07-24T04:00:00.000Z'),
    },
  });
  await prisma.memo.create({
    data: {
      teacherId: TEACHER_A,
      title: '已完成备忘',
      content: 'done-private-content',
      status: 'done',
      dueAtTs: new Date('2030-07-24T05:00:00.000Z'),
    },
  });
  const conversationA = await prisma.conversation.create({ data: { teacherId: TEACHER_A } });
  const activePending = await prisma.pendingAction.create({
    data: {
      teacherId: TEACHER_A,
      conversationId: conversationA.id,
      toolCallId: 'agenda-active-a',
      actionName: 'students.updateStatus',
      targetType: 'Student',
      targetId: studentA.id,
      parameters: { status: 'paused', url: 'https://private.example' },
      beforeSummary: '敏感前态',
      afterSummary: '暂停学生',
      expiresAtTs: new Date('2030-07-24T06:00:00.000Z'),
    },
  });
  const expiredPending = await prisma.pendingAction.create({
    data: {
      teacherId: TEACHER_A,
      conversationId: conversationA.id,
      toolCallId: 'agenda-expired-a',
      actionName: 'students.updateStatus',
      targetType: 'Student',
      targetId: studentA.id,
      parameters: { status: 'finished' },
      beforeSummary: '敏感过期前态',
      afterSummary: '完成学生',
      expiresAtTs: new Date('2030-07-24T00:00:00.000Z'),
    },
  });
  return {
    studentA,
    crossDay,
    meeting,
    overdueMemo,
    todayMemo,
    activePending,
    expiredPending,
  };
}

beforeEach(cleanup);
afterEach(cleanup);
afterAll(async () => { await prisma.$disconnect(); });

describe('Agenda API real Prisma workflow', () => {
  it('Today组合可信业务日、lesson、逾期Memo和有效PendingAction，并保持白名单响应', async () => {
    const facts = await seedAgendaFacts();
    const beforeChangeLogs = await prisma.changeLog.count({ where: { teacherId: TEACHER_A } });
    const fixture = testApp();

    const response = await requestApp(
      fixture.app,
      '/api/v1/agenda/today',
      { 'x-teacher-id': TEACHER_A },
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 1,
        timeZone: 'Asia/Shanghai',
        businessDate: '2030-07-24',
        generatedAt: NOW.toISOString(),
      },
    });
    const data = response.body?.data as { items: Array<Record<string, unknown>> };
    expect(data.items.map((item) => item.id)).toEqual([
      `schedule:${facts.crossDay.id}`,
      `pending-action:${facts.activePending.id}`,
      `memo:${facts.overdueMemo.id}`,
      `memo:${facts.todayMemo.id}`,
    ]);
    expect(data.items[0]?.studentRef).toMatchObject({
      type: 'Student',
      objectId: facts.studentA.id,
      label: '小明',
    });
    const serialized = JSON.stringify(response.body);
    for (const forbidden of [
      TEACHER_A,
      facts.meeting.id,
      'private-overdue-content',
      'private-today-content',
      'https://private.example',
      '敏感前态',
      'parameters',
      'actionToken',
      'route',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(fixture.now).toHaveBeenCalledTimes(1);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A } })).toBe(beforeChangeLogs);
    expect((await prisma.pendingAction.findUniqueOrThrow({
      where: { id: facts.expiredPending.id },
    })).status).toBe('pending');
  });

  it('Week返回固定7天，跨日lesson重复分桶且不把历史逾期Memo平移到本周', async () => {
    const facts = await seedAgendaFacts();
    const fixture = testApp();

    const response = await requestApp(
      fixture.app,
      '/api/v1/agenda/week?weekStart=2030-07-22',
      { 'x-teacher-id': TEACHER_A },
    );

    expect(response.status).toBe(200);
    const data = response.body?.data as {
      weekStart: string;
      weekEndExclusive: string;
      days: Array<{ date: string; items: Array<{ id: string }> }>;
    };
    expect(data.weekStart).toBe('2030-07-22');
    expect(data.weekEndExclusive).toBe('2030-07-29');
    expect(data.days).toHaveLength(7);
    expect(data.days.map((day) => day.date)).toEqual([
      '2030-07-22',
      '2030-07-23',
      '2030-07-24',
      '2030-07-25',
      '2030-07-26',
      '2030-07-27',
      '2030-07-28',
    ]);
    expect(data.days[1]?.items.map((item) => item.id)).toEqual([`schedule:${facts.crossDay.id}`]);
    expect(data.days[2]?.items.map((item) => item.id)).toEqual([
      `schedule:${facts.crossDay.id}`,
      `pending-action:${facts.activePending.id}`,
      `memo:${facts.todayMemo.id}`,
    ]);
    expect(JSON.stringify(response.body)).not.toContain(facts.overdueMemo.id);
    expect(fixture.now).toHaveBeenCalledTimes(1);
  });

  it('缺teacher或非法weekStart在可信时钟前返回400；clock失败返回500', async () => {
    const fixture = testApp();
    const missingTeacher = await requestApp(fixture.app, '/api/v1/agenda/today');
    const invalidWeek = await requestApp(
      fixture.app,
      '/api/v1/agenda/week?weekStart=2030-07-23',
      { 'x-teacher-id': TEACHER_A },
    );

    expect(missingTeacher.status).toBe(400);
    expect(missingTeacher.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'teacherId' },
    });
    expect(invalidWeek.status).toBe(400);
    expect(invalidWeek.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'weekStart' },
    });
    expect(fixture.now).not.toHaveBeenCalled();

    const failedClock = testApp(err(internalError('database clock unavailable')));
    const unavailable = await requestApp(
      failedClock.app,
      '/api/v1/agenda/today',
      { 'x-teacher-id': TEACHER_A },
    );
    expect(unavailable).toEqual({
      status: 500,
      body: { ok: false, error: { code: 'INTERNAL_ERROR', message: 'database clock unavailable' } },
    });
    expect(failedClock.now).toHaveBeenCalledTimes(1);
  });
});
