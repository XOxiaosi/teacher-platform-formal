import { describe, it, expect } from 'vitest';
import {
  createRequestIdMiddleware,
  createRequestLogMiddleware,
  generateRequestId,
} from '../../../src/app/middleware/request-id.js';
import { createLogger } from '../../../src/shared/logger/index.js';
import type { Request, Response } from 'express';

/**
 * 构造最小 mock req/res（与 health.test.ts 同风格），验证中间件逻辑。
 * requestLogMiddleware 依赖 res.on('finish') 触发日志——mock 里手动触发。
 */

function createMockReq(headerValue?: string): Request {
  return {
    header(name: string) {
      return name.toLowerCase() === 'x-request-id' ? headerValue : undefined;
    },
    method: 'GET',
    url: '/api/v1/health',
    originalUrl: '/api/v1/health',
  } as unknown as Request;
}

function createMockRes() {
  const headers: Record<string, string> = {};
  const listeners: Record<string, () => void> = {};
  return {
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    on(event: string, cb: () => void) {
      listeners[event] = cb;
      return this;
    },
    statusCode: 200,
    _headers: headers,
    _emit(event: string) {
      listeners[event]?.();
    },
  } as unknown as Response & { _headers: Record<string, string>; _emit: (e: string) => void };
}

function next() {}

describe('generateRequestId', () => {
  it('生成 req_ 前缀 id，长度合理', () => {
    const id = generateRequestId();
    expect(id.startsWith('req_')).toBe(true);
    expect(id.length).toBeGreaterThan(8);
  });
});

describe('createRequestIdMiddleware', () => {
  it('无入站头时生成新 id 并回写响应头与 req.requestId', () => {
    const middleware = createRequestIdMiddleware();
    const req = createMockReq(undefined);
    const res = createMockRes();
    middleware(req, res, next);
    expect(res._headers['x-request-id']).toBeDefined();
    expect(res._headers['x-request-id'].startsWith('req_')).toBe(true);
    expect((req as unknown as { requestId?: string }).requestId).toBe(res._headers['x-request-id']);
  });

  it('入站头合法时复用（链路透传）', () => {
    const middleware = createRequestIdMiddleware();
    const req = createMockReq('trace-123_abc:def');
    const res = createMockRes();
    middleware(req, res, next);
    expect(res._headers['x-request-id']).toBe('trace-123_abc:def');
  });

  it('入站头含危险字符时拒绝复用，重新生成', () => {
    const middleware = createRequestIdMiddleware();
    const req = createMockReq('bad\r\nX-Evil: 1');
    const res = createMockRes();
    middleware(req, res, next);
    expect(res._headers['x-request-id']).not.toBe('bad\r\nX-Evil: 1');
    expect(res._headers['x-request-id'].startsWith('req_')).toBe(true);
  });
});

describe('createRequestLogMiddleware', () => {
  it('finish 时输出单行 JSON 请求日志（含 requestId/durationMs/status）', () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    const idMiddleware = createRequestIdMiddleware();
    const middleware = createRequestLogMiddleware(logger);
    const req = createMockReq(undefined);
    const res = createMockRes();
    idMiddleware(req, res, next);
    middleware(req, res, next);
    res._emit('finish');

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.msg).toBe('request completed');
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/api/v1/health');
    expect(entry.status).toBe(200);
    expect(typeof entry.durationMs).toBe('number');
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry.requestId).toBe(res._headers['x-request-id']);
  });

  it('认证请求附带 teacherId', () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    const middleware = createRequestLogMiddleware(logger);
    const req = createMockReq(undefined) as Request & { teacherId?: string };
    req.teacherId = 'clx_teacher_9';
    const res = createMockRes();
    middleware(req, res, next);
    res._emit('finish');

    expect(JSON.parse(lines[0]).teacherId).toBe('clx_teacher_9');
  });
});
