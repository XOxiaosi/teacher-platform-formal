import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createChangelogService } from '../../../src/shared/changelog/index.js';
import { bindParameterValue, createQueryEventPrismaClient, type CapturedPrismaQuery } from '../../helpers/prisma-query-event.js';

const TEACHER_ID = 'p6-b04-i4-changelog-probe';

function isChangeLogInsert(query: string): boolean {
  return /^\s*INSERT\s+INTO\s+(?:"[^"]+"\.)?"ChangeLog"\s*\(/i.test(query);
}

function insertExpressions(event: CapturedPrismaQuery): Map<string, string> {
  const match = event.query.match(
    /^\s*INSERT\s+INTO\s+(?:"[^"]+"\.)?"ChangeLog"\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
  );
  if (!match) throw new Error(`无法解析ChangeLog INSERT列区: ${event.query}`);
  const fields = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const values = match[2].split(',').map((part) => part.trim());
  if (fields.length !== values.length) throw new Error('ChangeLog INSERT列与值数量不一致');
  return new Map(fields.map((field, index) => [field, values[index]]));
}

function sourceOf(expression: string | undefined): string {
  if (expression === undefined) return 'DATABASE_DEFAULT_COLUMN_OMITTED';
  if (/^\$\d+$/.test(expression)) return 'PRISMA_BIND_PARAMETER';
  if (/\b(?:CURRENT_TIMESTAMP|clock_timestamp)\s*(?:\(\s*\))?/i.test(expression)) {
    return 'DATABASE_TIME_EXPRESSION';
  }
  return 'OTHER_SQL_EXPRESSION';
}

const { client, events } = createQueryEventPrismaClient();

beforeAll(async () => {
  expect(process.env.TEACHER_PLATFORM_TEST_DATABASE).toBe('1');
  await client.$connect();
});

afterAll(async () => {
  await client.changeLog.deleteMany({ where: { teacherId: TEACHER_ID } });
  await client.$disconnect();
});

describe('ChangeLog 审计时间源 query-event 实证', () => {
  it('冻结 recordChange 的 timestampTs 与 createdAtTs 真实 SQL 来源', async () => {
    events.length = 0;
    const changelog = createChangelogService(client);

    const result = await changelog.recordChange({
      teacherId: TEACHER_ID,
      module: 'probe',
      action: 'create',
      targetType: 'Probe',
      targetId: 'probe-1',
      before: null,
      after: { name: 'x' },
      source: 'system',
    });
    expect(result.ok).toBe(true);

    const inserts = events.filter((event) => isChangeLogInsert(event.query));
    expect(inserts).toHaveLength(1);
    const expressions = insertExpressions(inserts[0]);

    expect(sourceOf(expressions.get('timestampTs'))).toBe('PRISMA_BIND_PARAMETER');
    expect(sourceOf(expressions.get('createdAtTs'))).toBe('PRISMA_BIND_PARAMETER');
  });

  it('事务内 timestampTs 与 createdAtTs 同源且等于数据库 CURRENT_TIMESTAMP', async () => {
    let dbNow: Date;
    let bindTimestamp: unknown;
    let bindCreatedAt: unknown;

    await client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
      dbNow = rows[0].now;

      events.length = 0;
      const changelog = createChangelogService(tx);
      const result = await changelog.recordChange({
        teacherId: TEACHER_ID,
        module: 'probe',
        action: 'create',
        targetType: 'Probe',
        targetId: 'probe-tx',
        before: null,
        after: { name: 'tx' },
        source: 'system',
      });
      expect(result.ok).toBe(true);

      const inserts = events.filter((event) => isChangeLogInsert(event.query));
      expect(inserts).toHaveLength(1);
      const expressions = insertExpressions(inserts[0]);
      bindTimestamp = bindParameterValue(inserts[0], expressions.get('timestampTs')!);
      bindCreatedAt = bindParameterValue(inserts[0], expressions.get('createdAtTs')!);
    });

    expect(new Date(bindTimestamp as string).toISOString()).toBe(dbNow.toISOString());
    expect(new Date(bindCreatedAt as string).toISOString()).toBe(dbNow.toISOString());
    expect(bindTimestamp).toBe(bindCreatedAt);
  });

  it('recordChange 不读取本机时间', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('不得读取本机时间');
    });
    try {
      const changelog = createChangelogService(client);
      const result = await changelog.recordChange({
        teacherId: TEACHER_ID,
        module: 'probe',
        action: 'create',
        targetType: 'Probe',
        targetId: 'probe-nolocal',
        before: null,
        after: { name: 'x' },
        source: 'system',
      });
      expect(result.ok).toBe(true);
    } finally {
      dateNow.mockRestore();
    }
  });
});
