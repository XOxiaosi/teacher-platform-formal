import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStudentService } from '../../../src/features/students/student-service.js';
import {
  bindParameterValue,
  classifyFieldSource,
  createQueryEventPrismaClient,
  isStudentInsert,
  isStudentUpdate,
  parseInsertRegion,
  parseUpdateSetRegion,
  type AuditFieldSqlSource,
} from '../../helpers/prisma-query-event.js';

const TEST_DATABASE_PREFIX = 'teacher_platform_test_';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const TIME_ZONES = ['UTC', 'America/Los_Angeles'] as const;
const TEACHER_ID = 'p6-b04-i1-query-event';

interface SourceObservation {
  createdAtTsOnCreate: AuditFieldSqlSource;
  updatedAtTsOnCreate: AuditFieldSqlSource;
  updatedAtTsOnUpdate: AuditFieldSqlSource;
}

const EXPECTED_SOURCE_OBSERVATION = {
  createdAtTsOnCreate: 'PRISMA_BIND_PARAMETER',
  updatedAtTsOnCreate: 'PRISMA_BIND_PARAMETER',
  updatedAtTsOnUpdate: 'PRISMA_BIND_PARAMETER',
} as const satisfies SourceObservation;

const { client, events } = createQueryEventPrismaClient();
const createdIds: string[] = [];
const observations = new Map<(typeof TIME_ZONES)[number], SourceObservation>();

function assertIsolatedTestDatabase(): void {
  expect(process.env.NODE_ENV).toBe('test');
  expect(process.env.TEACHER_PLATFORM_TEST_DATABASE).toBe('1');
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ''));
  expect(LOCAL_HOSTS.has(databaseUrl.hostname)).toBe(true);
  expect(databaseName.startsWith(TEST_DATABASE_PREFIX)).toBe(true);
}

function isoFromBind(value: unknown): string {
  expect(typeof value).toBe('string');
  return new Date(value as string).toISOString();
}

beforeAll(async () => {
  assertIsolatedTestDatabase();
  await client.$connect();
});

afterAll(async () => {
  try {
    if (createdIds.length > 0) await client.student.deleteMany({ where: { id: { in: createdIds } } });
  } finally {
    await client.$disconnect();
  }
});

describe('Student Prisma query-event audit-time source', () => {
  for (const timeZone of TIME_ZONES) {
    it(`${timeZone} session真实执行create/update并冻结审计时间来源`, async () => {
      events.length = 0;
      let shownTimeZone = '';
      let createdDto: { id: string; createdAt: Date; updatedAt: Date } | undefined;
      let updatedDto: { updatedAt: Date } | undefined;

      await client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${timeZone}'`);
        const shownRows = await tx.$queryRawUnsafe<Array<Record<string, string>>>('SHOW TIME ZONE');
        shownTimeZone = Object.values(shownRows[0])[0];

        const service = createStudentService(tx);
        const created = await service.createStudent({
          teacherId: TEACHER_ID,
          name: `SQL探针-${timeZone}`,
          grade: '高三',
        });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error('Student create探针失败');
        createdDto = created.value;
        createdIds.push(created.value.id);

        const updated = await service.updateStudent({
          studentId: created.value.id,
          name: `SQL探针已更新-${timeZone}`,
        });
        expect(updated.ok).toBe(true);
        if (!updated.ok) throw new Error('Student update探针失败');
        updatedDto = updated.value;
      });

      expect(shownTimeZone).toBe(timeZone);
      const insertEvents = events.filter((event) => isStudentInsert(event.query));
      const updateEvents = events.filter((event) => isStudentUpdate(event.query));
      expect(insertEvents).toHaveLength(1);
      expect(updateEvents).toHaveLength(1);

      const insertEvent = insertEvents[0];
      const updateEvent = updateEvents[0];
      const insertRegion = parseInsertRegion(insertEvent.query);
      const updateRegion = parseUpdateSetRegion(updateEvent.query);
      const observation: SourceObservation = {
        createdAtTsOnCreate: classifyFieldSource(insertRegion, 'createdAtTs'),
        updatedAtTsOnCreate: classifyFieldSource(insertRegion, 'updatedAtTs'),
        updatedAtTsOnUpdate: classifyFieldSource(updateRegion, 'updatedAtTs'),
      };
      observations.set(timeZone, observation);

      expect(observation).toEqual(EXPECTED_SOURCE_OBSERVATION);
      expect([...updateRegion.fields].sort()).toEqual(['name', 'updatedAtTs']);
      expect(updateEvent.query).not.toMatch(/\bCURRENT_TIMESTAMP\b/i);
      expect(updateEvent.query).not.toMatch(/\bclock_timestamp\s*\(/i);

      const insertCreatedAtExpression = insertRegion.expressions.get('createdAtTs');
      const insertUpdatedAtExpression = insertRegion.expressions.get('updatedAtTs');
      const updateUpdatedAtExpression = updateRegion.expressions.get('updatedAtTs');
      expect(insertCreatedAtExpression).toBeDefined();
      expect(insertUpdatedAtExpression).toBeDefined();
      expect(updateUpdatedAtExpression).toBeDefined();
      expect(createdDto).toBeDefined();
      expect(updatedDto).toBeDefined();
      expect(isoFromBind(bindParameterValue(insertEvent, insertCreatedAtExpression!)))
        .toBe(createdDto!.createdAt.toISOString());
      expect(isoFromBind(bindParameterValue(insertEvent, insertUpdatedAtExpression!)))
        .toBe(createdDto!.updatedAt.toISOString());
      expect(isoFromBind(bindParameterValue(updateEvent, updateUpdatedAtExpression!)))
        .toBe(updatedDto!.updatedAt.toISOString());
    });
  }

  it('来源分类跨两个session时区保持一致', () => {
    expect(observations.get('UTC')).toEqual(observations.get('America/Los_Angeles'));
  });
});
