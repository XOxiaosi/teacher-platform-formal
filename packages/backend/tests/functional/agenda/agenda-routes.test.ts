import { Readable, Writable } from 'node:stream';
import express, { type Request, type Router } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  err,
  internalError,
  ok,
  validationError,
  type AgendaTodayDocument,
  type AgendaWeekDocument,
  type CommonError,
  type Result,
} from '@teacher-platform/contracts';

interface AgendaQueryLike {
  getToday(input: {
    teacherId: string;
    timeZone: 'Asia/Shanghai';
  }): Promise<Result<AgendaTodayDocument, CommonError>>;
  getWeek(input: {
    teacherId: string;
    weekStart?: string;
    timeZone: 'Asia/Shanghai';
  }): Promise<Result<AgendaWeekDocument, CommonError>>;
}

interface AgendaRouteModule {
  createAgendaRouter?: (dependencies: { agenda: AgendaQueryLike }) => Router;
}

interface ApiResponse {
  status: number;
  body: Record<string, unknown> | null;
}

const TODAY: AgendaTodayDocument = {
  schemaVersion: 1,
  timeZone: 'Asia/Shanghai',
  businessDate: '2030-07-24',
  generatedAt: '2030-07-24T01:00:00.000Z',
  items: [],
};

const WEEK: AgendaWeekDocument = {
  schemaVersion: 1,
  timeZone: 'Asia/Shanghai',
  weekStart: '2030-07-22',
  weekEndExclusive: '2030-07-29',
  generatedAt: '2030-07-24T01:00:00.000Z',
  days: [
    '2030-07-22',
    '2030-07-23',
    '2030-07-24',
    '2030-07-25',
    '2030-07-26',
    '2030-07-27',
    '2030-07-28',
  ].map((date) => ({ date, items: [] })),
};

async function loadRoute(): Promise<AgendaRouteModule> {
  try {
    return await import('../../../src/app/routes/agenda.routes.js') as unknown as AgendaRouteModule;
  } catch {
    return {};
  }
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

async function createFixture(input?: {
  today?: Result<AgendaTodayDocument, CommonError>;
  week?: Result<AgendaWeekDocument, CommonError>;
}) {
  const module = await loadRoute();
  expect(module.createAgendaRouter).toBeTypeOf('function');
  const getToday = vi.fn(async (_input: unknown) => input?.today ?? ok(TODAY));
  const getWeek = vi.fn(async (_input: unknown) => input?.week ?? ok(WEEK));
  const app = express();
  if (module.createAgendaRouter) {
    // P0 IDOR 修复：路由层身份只来自 requireAuth 注入的 req.teacherId（不再读 x-teacher-id header）。
    // 本测试直挂路由工厂（不经 requireAuth），用轻量中间件模拟认证层 dev fallback 的注入语义。
    app.use('/api/v1', (req, _res, next) => {
      const header = req.header('x-teacher-id');
      if (header) (req as Request & { teacherId?: string }).teacherId = header;
      next();
    });
    app.use('/api/v1', module.createAgendaRouter({ agenda: { getToday, getWeek } }));
  }
  return { app, getToday, getWeek };
}

describe('Agenda HTTP routes', () => {
  it('GET /agenda/today只从header取teacher并固定Asia/Shanghai，忽略query覆盖', async () => {
    const fixture = await createFixture();
    const response = await requestApp(
      fixture.app,
      '/api/v1/agenda/today?teacherId=evil&timeZone=UTC&date=1999-01-01',
      { 'x-teacher-id': 'teacher-a' },
    );

    expect(response).toEqual({ status: 200, body: { ok: true, data: TODAY } });
    expect(fixture.getToday).toHaveBeenCalledWith({
      teacherId: 'teacher-a',
      timeZone: 'Asia/Shanghai',
    });
  });

  it('GET /agenda/week只转发单个weekStart，缺失时不伪造参数', async () => {
    const fixture = await createFixture();
    const explicit = await requestApp(
      fixture.app,
      '/api/v1/agenda/week?weekStart=2030-07-22',
      { 'x-teacher-id': 'teacher-a' },
    );
    const current = await requestApp(
      fixture.app,
      '/api/v1/agenda/week',
      { 'x-teacher-id': 'teacher-a' },
    );

    expect(explicit.status).toBe(200);
    expect(current.status).toBe(200);
    expect(fixture.getWeek).toHaveBeenNthCalledWith(1, {
      teacherId: 'teacher-a',
      weekStart: '2030-07-22',
      timeZone: 'Asia/Shanghai',
    });
    expect(fixture.getWeek).toHaveBeenNthCalledWith(2, {
      teacherId: 'teacher-a',
      timeZone: 'Asia/Shanghai',
    });
  });

  it('缺teacher header返回400且不调用Agenda Query', async () => {
    const fixture = await createFixture();
    const response = await requestApp(fixture.app, '/api/v1/agenda/today');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: '缺少 teacherId', field: 'teacherId' },
    });
    expect(fixture.getToday).not.toHaveBeenCalled();
  });

  it('重复weekStart query返回400且不调用Agenda Query', async () => {
    const fixture = await createFixture();
    const response = await requestApp(
      fixture.app,
      '/api/v1/agenda/week?weekStart=2030-07-22&weekStart=2030-07-29',
      { 'x-teacher-id': 'teacher-a' },
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'weekStart 必须是单个日期', field: 'weekStart' },
    });
    expect(fixture.getWeek).not.toHaveBeenCalled();
  });

  it.each([
    [err(validationError('weekStart非法', 'weekStart')), 400],
    [err(internalError('可信时钟失败')), 500],
  ] as const)('按CommonError映射HTTP状态且不以空数组掩盖失败', async (failure, status) => {
    const fixture = await createFixture({ week: failure });
    const response = await requestApp(
      fixture.app,
      '/api/v1/agenda/week?weekStart=bad',
      { 'x-teacher-id': 'teacher-a' },
    );

    expect(response.status).toBe(status);
    expect(response.body).toEqual({ ok: false, error: failure.error });
  });
});
