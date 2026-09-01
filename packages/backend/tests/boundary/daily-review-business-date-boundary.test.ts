import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { D47_AUDIT_TIME_FIELD_MATRIX } from '../fixtures/d47-audit-time-field-matrix.js';

const source = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('DailyReview BusinessDate static boundary', () => {
  it('route 只转发 date 原值并防御非对象 body', () => {
    const route = source('src/app/routes/daily-review.routes.ts');

    expect(route).toContain('date: req.body.date');
    expect(route).toContain('请求体必须是对象');
    expect(route).toContain("typeof req.body.date !== 'string'");
    expect(route).not.toMatch(/req\.body\.date\s+as\s+string/);
    expect(route).not.toMatch(/\bparseDate\b/);
    expect(route).not.toMatch(/new\s+Date\s*\(/);
  });

  it('assemble 契约要求 TrustedClock，date 仅为可选 string', () => {
    const types = source('src/app/use-cases/daily-review-assemble/types.ts');
    const composition = source('src/app/composition/core-route-dependencies.ts');

    expect(types).toMatch(/trustedClock:\s*TrustedClock/);
    expect(types).toMatch(/date\?:\s*string/);
    expect(types).not.toMatch(/date\??:\s*Date/);
    expect(composition).toContain('createDailyReviewAssembleUseCase({');
    expect(composition).toContain('getClient: clientProvider.getClient');
    expect(composition).toContain('cipher: fieldCipher');
  });

  it('owner 使用半开查询、确定顺序和 take 501 容量探测', () => {
    const schedules = source('src/features/scheduling/schedule-service.ts');
    const lessons = source('src/features/lessons/lesson-service.ts');

    for (const owner of [schedules, lessons]) {
      expect(owner).toContain('const DAILY_REVIEW_SOURCE_LIMIT = 500');
      expect(owner).toContain('take: DAILY_REVIEW_SOURCE_LIMIT + 1');
      expect(owner).toContain('lt: input.windowEndExclusive');
    }
    expect(schedules).toContain("{ scheduledStartTs: 'asc' }");
    expect(schedules).toContain("{ scheduledEndTs: 'asc' }");
    expect(lessons).toContain("orderBy: [{ dateTs: 'asc' }, { id: 'asc' }]");
  });

  it('机器矩阵保持 MIXED/HIGH，并将 DailyReview.date newWriteRisk 降为 LOW', () => {
    const entry = D47_AUDIT_TIME_FIELD_MATRIX.find((item) => item.key === 'DailyReview.dateTs');

    expect(entry).toEqual({
      key: 'DailyReview.dateTs',
      semantics: 'BUSINESS_DATE',
      currentSource: 'MIXED',
      newWriteRisk: 'LOW',
      migrationRisk: 'HIGH',
    });
  });
});
