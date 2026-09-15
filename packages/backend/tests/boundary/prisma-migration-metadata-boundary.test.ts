import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRISMA_SCHEMA_DIRECTORY, readPrismaSchema } from '../helpers/prisma-schema.js';

function migration(name: string) {
  return readFileSync(resolve(PRISMA_SCHEMA_DIRECTORY, 'migrations', name, 'migration.sql'), 'utf8');
}

describe('Prisma declarations preserve the existing migration storage', () => {
  it('CaptureTask lifecycle instants retain the timezone-aware SQL type', () => {
    const sql = migration('20260914000000_add_t015_capture_lifecycle');
    const model = readPrismaSchema().match(/model CaptureTask \{([\s\S]*?)\n\}/)?.[1] ?? '';
    for (const field of ['startedAtTs', 'completedAtTs']) {
      expect(sql).toContain(`"${field}" TIMESTAMPTZ(3)`);
      expect(model).toMatch(new RegExp(`${field}\\s+DateTime\\?\\s+@db\\.Timestamptz\\(3\\)`));
    }
  });

  it('long legacy index names map to the names PostgreSQL actually stores', () => {
    const schema = readPrismaSchema();
    const sql = [
      migration('20260905000004_add_p7_wechat_channel_conversation'),
      migration('20260916000000_add_t017_lesson_ledger'),
    ].join('\n');
    const longNames = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX "([^"]+)"/g)]
      .map((match) => match[1]).filter((name) => Buffer.byteLength(name) > 63);
    expect(longNames).toHaveLength(3);
    for (const name of longNames) {
      const storedName = Buffer.from(name).subarray(0, 63).toString();
      expect(schema).toContain(`map: "${storedName}"`);
    }
  });
});
