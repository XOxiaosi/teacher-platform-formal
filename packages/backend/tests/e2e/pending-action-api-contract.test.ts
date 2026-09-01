import { Readable, Writable } from 'node:stream';
import type { Application, Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { createActionTokenSigner } from '../../src/features/pending-action/index.js';
import { createChangelogService, withChangelog } from '../../src/shared/changelog/index.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../helpers/isolated-postgres.js';

const TEACHER_A = 'test-pending-api-teacher-a';
const SECRET = 'test-pending-api-secret-with-at-least-32-bytes';

interface ApiResponse {
  status: number;
  body: unknown;
}

type MockResponse = Writable & {
  statusCode: number;
  headers: Record<string, string>;
  setHeader(key: string, value: string): void;
  getHeader(key: string): string | undefined;
  removeHeader(key: string): void;
  end(chunk?: unknown): MockResponse;
};

function requestApp(
  app: Application,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = new Readable({
      read() {
        this.push(payload);
        this.push(null);
      },
    });
    Object.assign(req, {
      method,
      url,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload).toString(),
        ...headers,
      },
    });

    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    }) as MockResponse;
    res.statusCode = 200;
    res.headers = {};
    res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
    res.getHeader = (key) => res.headers[key.toLowerCase()];
    res.removeHeader = (key) => { delete res.headers[key.toLowerCase()]; };
    res.end = (chunk?: unknown) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      return res;
    };

    app.handle(req as unknown as Request, res as unknown as Response, (error?: unknown) => {
      if (error) return reject(error);
      resolve({ status: res.statusCode === 200 ? 404 : res.statusCode, body: null });
    });
  });
}

let database: IsolatedPostgres;
let prisma: PrismaClient;
let app: Application;
let extendedBusinessApp: Application;
let sequence = 0;
const signer = createActionTokenSigner({ secret: SECRET });

async function databaseNow() {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  return rows[0].now;
}

async function seedPending() {
  const student = await prisma.student.create({
    data: { teacherId: TEACHER_A, name: 'API 测试学生', grade: '高一' },
  });
  const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER_A } });
  const now = await databaseNow();
  const pending = await prisma.pendingAction.create({
    data: {
      teacherId: TEACHER_A,
      conversationId: conversation.id,
      toolCallId: `pending-api-tool-${sequence += 1}`,
      actionName: 'students.updateStatus',
      targetType: 'Student',
      targetId: student.id,
      parameters: { studentId: student.id, status: 'paused', nested: { hidden: true } },
      beforeSummary: 'active',
      afterSummary: 'paused',
      expiresAtTs: new Date(now.getTime() + 600_000),
    },
  });
  const token = signer.sign(pending.id);
  if (!token.ok) throw new Error(token.error.message);
  return { student, conversation, pending, actionToken: token.value };
}

beforeAll(async () => {
  database = await createIsolatedPostgres();
  prisma = database.prisma;
  app = createApp(prisma, { rawPrisma: prisma, actionTokenSigner: signer });
  const extended = withChangelog(prisma, createChangelogService(prisma)) as unknown as PrismaClient;
  extendedBusinessApp = createApp(extended, { rawPrisma: prisma, actionTokenSigner: signer });
}, 60_000);

afterAll(async () => {
  await database.cleanup();
}, 30_000);

beforeEach(async () => {
  await prisma.changeLog.deleteMany();
  await prisma.pendingAction.deleteMany();
  await prisma.conversationTurn.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.student.deleteMany();
});

const endpoints = [
  ['GET', '/api/v1/pending-actions/pending-1'],
  ['POST', '/api/v1/pending-actions/pending-1/confirm'],
  ['POST', '/api/v1/pending-actions/pending-1/cancel'],
] as const;

describe('P5.2 PendingAction API 契约', () => {
  it('查询、确认和取消缺少 teacher 身份时返回 401（P0 IDOR 修复：身份唯一来源 = requireAuth 注入）', async () => {
    for (const [method, url] of endpoints) {
      const response = await requestApp(app, method, url, method === 'POST' ? {} : undefined);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: '未登录或会话已过期' },
      });
    }
  });

  it('confirm 缺少 actionToken 时返回字段级 VALIDATION_ERROR', async () => {
    const response = await requestApp(
      app,
      'POST',
      '/api/v1/pending-actions/pending-1/confirm',
      undefined,
      { 'x-teacher-id': TEACHER_A },
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: '缺少 actionToken', field: 'actionToken' },
    });
  });

  it('查询返回 pending token 和白名单 DTO', async () => {
    const fixture = await seedPending();

    const own = await requestApp(app, 'GET', `/api/v1/pending-actions/${fixture.pending.id}`, undefined, {
      'x-teacher-id': TEACHER_A,
    });

    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({
      ok: true,
      data: {
        pendingAction: {
          id: fixture.pending.id,
          status: 'pending',
          actionToken: fixture.actionToken,
          parameterSummary: { studentId: fixture.student.id, status: 'paused' },
        },
      },
    });
  });

  it('confirm 忽略客户端重提参数，只执行数据库参数；重复确认返回 409', async () => {
    const fixture = await seedPending();
    const url = `/api/v1/pending-actions/${fixture.pending.id}/confirm`;

    const confirmed = await requestApp(app, 'POST', url, {
      actionToken: fixture.actionToken,
      actionName: 'students.updateStatus',
      parameters: { studentId: fixture.student.id, status: 'finished' },
    }, { 'x-teacher-id': TEACHER_A });
    const repeated = await requestApp(app, 'POST', url, {
      actionToken: fixture.actionToken,
    }, { 'x-teacher-id': TEACHER_A });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      ok: true,
      data: { pendingAction: { status: 'consumed', actionToken: null } },
    });
    expect((await prisma.student.findUniqueOrThrow({ where: { id: fixture.student.id } })).currentStatus).toBe('paused');
    expect(await prisma.changeLog.count({ where: { targetId: fixture.student.id } })).toBe(1);
    expect(repeated).toEqual({
      status: 409,
      body: {
        ok: false,
        error: { code: 'ALREADY_CONSUMED', message: '待确认操作已被占用或消费' },
      },
    });
  });

  it('业务 client 带全局 changelog extension 时，confirmation 仍走 raw Prisma 且只写一条日志', async () => {
    const fixture = await seedPending();

    const response = await requestApp(
      extendedBusinessApp,
      'POST',
      `/api/v1/pending-actions/${fixture.pending.id}/confirm`,
      { actionToken: fixture.actionToken },
      { 'x-teacher-id': TEACHER_A },
    );

    expect(response.status).toBe(200);
    expect(await prisma.changeLog.count({ where: { targetId: fixture.student.id } })).toBe(1);
  });

  it.each(['tampered', 'path-mismatch'] as const)('%s token 返回 actionToken 字段错误', async (scenario) => {
    const fixture = await seedPending();
    const [payload, signature] = fixture.actionToken.split('.');
    const actionToken = scenario === 'tampered'
      ? `${payload}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`
      : (() => {
        const other = signer.sign('other-pending-id');
        if (!other.ok) throw new Error(other.error.message);
        return other.value;
      })();

    const response = await requestApp(
      app,
      'POST',
      `/api/v1/pending-actions/${fixture.pending.id}/confirm`,
      { actionToken },
      { 'x-teacher-id': TEACHER_A },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'actionToken' },
    });
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: fixture.pending.id } })).status).toBe('pending');
  });

  it('cancel 忽略客户端重提参数且重复取消幂等', async () => {
    const fixture = await seedPending();
    const url = `/api/v1/pending-actions/${fixture.pending.id}/cancel`;

    const first = await requestApp(app, 'POST', url, {
      actionName: 'students.updateStatus', parameters: { status: 'finished' },
    }, { 'x-teacher-id': TEACHER_A });
    const repeated = await requestApp(app, 'POST', url, {}, { 'x-teacher-id': TEACHER_A });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      ok: true,
      data: { pendingAction: { status: 'cancelled', actionToken: null } },
    });
    expect(repeated).toEqual(first);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: fixture.student.id } })).currentStatus).toBe('active');
  });

  it('consumed PendingAction 不可取消', async () => {
    const fixture = await seedPending();
    await requestApp(
      app,
      'POST',
      `/api/v1/pending-actions/${fixture.pending.id}/confirm`,
      { actionToken: fixture.actionToken },
      { 'x-teacher-id': TEACHER_A },
    );

    const response = await requestApp(
      app,
      'POST',
      `/api/v1/pending-actions/${fixture.pending.id}/cancel`,
      {},
      { 'x-teacher-id': TEACHER_A },
    );

    expect(response).toEqual({
      status: 400,
      body: {
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: '待确认操作已消费', field: 'pendingActionId' },
      },
    });
  });

  it('未知 pending action 取消返回 NOT_FOUND', async () => {
    const response = await requestApp(
      app,
      'POST',
      '/api/v1/pending-actions/nonexistent/cancel',
      { actionName: 'students.updateStatus', parameters: { status: 'finished' } },
      { 'x-teacher-id': TEACHER_A },
    );

    expect(response).toEqual({
      status: 404,
      body: { ok: false, error: { code: 'NOT_FOUND', message: '待确认操作不存在' } },
    });
  });
});
