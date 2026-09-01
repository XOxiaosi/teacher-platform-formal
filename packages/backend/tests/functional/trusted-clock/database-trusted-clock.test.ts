import { afterAll, describe, expect, it, vi } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { createDatabaseTrustedClock } from '../../../src/shared/trusted-clock/database-trusted-clock.js';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

describe('DatabaseTrustedClock', () => {
  it('返回 PostgreSQL CURRENT_TIMESTAMP 对应的可信 instant', async () => {
    const beforeRows = await prisma.$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT CURRENT_TIMESTAMP AS "now"`,
    );
    const result = await createDatabaseTrustedClock(prisma).now();
    const afterRows = await prisma.$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT CURRENT_TIMESTAMP AS "now"`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.getTime()).toBeGreaterThanOrEqual(beforeRows[0].now.getTime());
    expect(result.value.getTime()).toBeLessThanOrEqual(afterRows[0].now.getTime());
  });

  it('数据库时钟查询失败时返回 INTERNAL_ERROR，不回退本机时间', async () => {
    const failingPrisma = {
      $queryRaw: vi.fn().mockRejectedValue(new Error('database unavailable')),
    };

    const result = await createDatabaseTrustedClock(failingPrisma as never).now();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.message).toContain('数据库可信时间不可用');
  });
});
