import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../../src/index.js';
import { createSlidingWindowLimiter } from '../../../src/app/middleware/rate-limit.js';

/**
 * G3 收口（reports/security/g2-g3-nginx-headers-metrics-fix-contract.md §3.2 改动 A + §5 矩阵）：
 * - GET /api/v1/metrics → 200 且信封 {ok, data} 形状不变（兼容未来 t41 聚合接线，不改变路径/形状）
 * - payload 不含 poolSize / dbConnections（池规模等运维指标走本地 metrics-aggregate 聚合文件，
 *   HTTP 端点不暴露 → 平台规模信息泄露面消除）
 *
 * 纪律：本端点不访问数据库（纯占位聚合），createApp 用注入 limiter 保持测试确定性。
 */

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

function createMetricsApp() {
  return createApp(prisma, { rateLimiter: createSlidingWindowLimiter() });
}

describe('GET /api/v1/metrics（G3 收口）', () => {
  it('200 + {ok:true, data:{totals,latency,errorRate5xx}}，且不含 poolSize/dbConnections', async () => {
    const res = await request(createMetricsApp()).get('/api/v1/metrics');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toBeDefined();
    // 占位聚合保留（t41 扩展点）
    expect(res.body.data.totals).toBeDefined();
    expect(res.body.data.totals.requests).toBe(0);
    expect(res.body.data.latency).toBeDefined();
    expect(res.body.data.errorRate5xx).toBe(0);
    // G3：敏感运维字段已剥离（池规模泄露面消除）
    expect(res.body.data.poolSize).toBeUndefined();
    expect(res.body.data.dbConnections).toBeUndefined();
  });
});
