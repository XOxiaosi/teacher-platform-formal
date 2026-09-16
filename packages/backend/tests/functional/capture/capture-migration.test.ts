import { PrismaClient, type Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
const prisma = new PrismaClient();
afterAll(() => prisma.$disconnect());
const sql = (name: string) => readFileSync(new URL(`../../../../contracts/prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8');
async function executeSql(tx: Prisma.TransactionClient, source: string) {
  for (const statement of source.split(';').filter(item => item.trim() && !/^(BEGIN|COMMIT)$/i.test(item.trim()))) await tx.$executeRawUnsafe(statement);
}
async function inOldSchema(run: (tx: Prisma.TransactionClient) => Promise<void>) {
  const schema = `a04_migration_${randomUUID().replaceAll('-', '')}`;
  // The root harness supplies an isolated synthetic DB. All DDL is further scoped
  // to a temporary schema and rolled back after assertions; no real data reset.
  if (process.env.TEACHER_PLATFORM_TEST_DATABASE !== '1') throw new Error('Requires isolated test harness');
  const rollback = new Error('rollback verified synthetic schema');
  try {
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await executeSql(tx, sql('20260914000000_add_t015_capture_lifecycle'));
      await tx.$executeRawUnsafe('ALTER TABLE "CaptureCandidate" ADD COLUMN "confirmationRequestId" TEXT, ADD COLUMN "confirmedRecordId" TEXT, ADD COLUMN "confirmedAtTs" TIMESTAMPTZ(3)');
      await tx.$executeRawUnsafe('CREATE UNIQUE INDEX "CaptureCandidate_teacherId_confirmationRequestId_key" ON "CaptureCandidate"("teacherId", "confirmationRequestId")');
      await run(tx);
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
}
async function seed(tx: Prisma.TransactionClient) {
  await tx.$executeRawUnsafe(`INSERT INTO "CaptureEvent" ("id","teacherId","clientRequestId","sourceType","rawText","occurredAtTs","createdAtTs") VALUES ('old-event','synthetic-teacher','synthetic-request','text','synthetic raw',now(),now())`);
  await tx.$executeRawUnsafe(`INSERT INTO "CaptureTask" ("id","teacherId","eventId","createdAtTs","updatedAtTs") VALUES ('old-task','synthetic-teacher','old-event',now(),now())`);
  await tx.$executeRawUnsafe(`INSERT INTO "CaptureCandidate" ("id","teacherId","eventId","taskId","payload","reviewStatus","confirmationRequestId","confirmedRecordId","confirmedAtTs","createdAtTs","updatedAtTs") VALUES ('old-candidate','synthetic-teacher','old-event','old-task','{"text":"synthetic encrypted payload"}','confirmed','old-confirmation','old-record',now(),now(),now())`);
}
describe('A04 additive multi-candidate migration', () => {
  it('upgrades an empty legacy schema and permits multiple candidates per event and task', async () => {
    await inOldSchema(async tx => {
      await executeSql(tx, sql('20260923000000_a04_multiple_capture_candidates'));
      await seed(tx);
      await tx.$executeRawUnsafe(`INSERT INTO "CaptureCandidate" ("id","teacherId","eventId","taskId","position","createdAtTs","updatedAtTs") VALUES ('second-candidate','synthetic-teacher','old-event','old-task',1,now(),now())`);
      expect(await tx.$queryRawUnsafe('SELECT "id", "position", "revision" FROM "CaptureCandidate" ORDER BY "position"')).toEqual([{ id: 'old-candidate', position: 0, revision: 1 }, { id: 'second-candidate', position: 1, revision: 1 }]);
    });
  });
  it('preserves existing IDs, timestamps, payloads and confirmation idempotency without recreating rows', async () => {
    await inOldSchema(async tx => {
      await seed(tx);
      const before = await tx.$queryRawUnsafe<Record<string, unknown>[]>('SELECT * FROM "CaptureCandidate"');
      await executeSql(tx, sql('20260923000000_a04_multiple_capture_candidates'));
      const after = await tx.$queryRawUnsafe<Record<string, unknown>[]>('SELECT migrated.* FROM "CaptureCandidate" AS migrated');
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ ...before[0], position: 0, revision: 1, originalPayload: before[0].payload });
      const indexes = await tx.$queryRawUnsafe<{ indexname: string }[]>('SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = \'CaptureCandidate\'');
      expect(indexes.map(item => item.indexname)).toContain('CaptureCandidate_teacherId_confirmationRequestId_key');
      expect(indexes.map(item => item.indexname)).not.toContain('CaptureCandidate_eventId_key');
    });
  });
});
