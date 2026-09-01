import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { healthHandler, createHealthRouter } from '../../src/app/routes/health.routes.js';
import type { PrismaClient } from '@prisma/client';
import type { DatabaseClientPool } from '../../src/shared/database-pool/index.js';
import type { Logger } from '../../src/shared/logger/index.js';

/**
 * 直接测试路由处理函数，不依赖网络端口绑定。
 * 构造最小 mock req/res，验证实际处理逻辑。
 */

function createMockRes() {
  const state = { statusCode: 200, body: null as unknown };
  return {
    json(data: unknown) {
      state.body = data;
    },
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    _getState: () => state,
  } as any;
}

describe('healthHandler', () => {
  it('返回 ok:true 和 data.status:"ok" 和 data.timestamp', () => {
    const req = {} as any;
    const res = createMockRes();

    healthHandler(req, res);

    const state = res._getState();
    expect(state.statusCode).toBe(200);

    const body = state.body;
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('ok');
    expect(body.data.timestamp).toBeDefined();

    // timestamp 是合法 ISO 时间
    const parsed = new Date(body.data.timestamp);
    expect(parsed.getTime()).not.toBeNaN();
  });
});

/** 健康路由工厂：真实 express 装配 + supertest（与 e2e 同风格，验证路由注册与响应）。 */
function createHealthApp(options: Parameters<typeof createHealthRouter>[0] = {}) {
  const app = express();
  app.use('/api/v1', createHealthRouter(options));
  return app;
}

function healthyRegistryPrisma(): PrismaClient {
  return { $queryRaw: vi.fn(async () => [{ '?column?': 1 }]) } as unknown as PrismaClient;
}

function downRegistryPrisma(): PrismaClient {
  return { $queryRaw: vi.fn(async () => { throw new Error('connection refused'); }) } as unknown as PrismaClient;
}

function mockPool(size: number): DatabaseClientPool {
  return { size: vi.fn(() => size) } as unknown as DatabaseClientPool;
}

describe('createHealthRouter', () => {
  it('GET /health 保持原形状（200 ok:true status:ok timestamp）', async () => {
    const res = await request(createHealthApp({ registryPrisma: healthyRegistryPrisma() }))
      .get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(new Date(res.body.data.timestamp).getTime()).not.toBeNaN();
  });

  it('GET /health/live 进程存活：200 同 /health 形状', async () => {
    const res = await request(createHealthApp({ registryPrisma: healthyRegistryPrisma() }))
      .get('/api/v1/health/live');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(new Date(res.body.data.timestamp).getTime()).not.toBeNaN();
  });

  it('GET /health/ready 正常：共享库 SELECT 1 通过 → 200 ready', async () => {
    const registryPrisma = healthyRegistryPrisma();
    const res = await request(createHealthApp({ registryPrisma }))
      .get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('ready');
    expect(new Date(res.body.data.timestamp).getTime()).not.toBeNaN();
    expect(registryPrisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('GET /health/ready 共享库断连：SELECT 1 抛错 → 503 + JSON 错误体', async () => {
    const registryPrisma = downRegistryPrisma();
    const res = await request(createHealthApp({ registryPrisma }))
      .get('/api/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: expect.stringContaining('共享数据库不可达') },
    });
  });

  it('GET /health/ready 未注入依赖（registryPrisma/pool 均缺省）→ 503 安全侧', async () => {
    const res = await request(createHealthApp()).get('/api/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });

  it('GET /health/ready 注入连接池：仅验证池状态（size()），仍 200', async () => {
    const pool = mockPool(3);
    const info = vi.fn();
    const logger = { info } as unknown as Logger;
    const res = await request(createHealthApp({ registryPrisma: healthyRegistryPrisma(), pool, logger }))
      .get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ready');
    expect(pool.size).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][1]).toEqual({ path: '/api/v1/health/ready', hotDbCount: 3 });
  });

  it('GET /health/ready 连接池无热库（size 0）：状态验证通过，仍 200', async () => {
    const pool = mockPool(0);
    const res = await request(createHealthApp({ registryPrisma: healthyRegistryPrisma(), pool }))
      .get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ready');
    expect(pool.size).toHaveBeenCalledTimes(1);
  });
});