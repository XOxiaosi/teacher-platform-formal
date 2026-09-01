import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../../contracts');
const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(resolve(root, 'prisma/migrations/20260912000000_add_communication_moderation/migration.sql'), 'utf8');

describe('communication moderation additive schema boundary', () => {
  it('仅新增 nullable moderation 字段且无 default/backfill', () => {
    const model = schema.match(/model CommunicationDetail \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(model).toMatch(/moderationFlagged\s+Boolean\?/);
    expect(model).toMatch(/moderationReasons\s+Json\?/);
    expect(model).not.toMatch(/moderation(?:Flagged|Reasons)[^\n]*@default/);
    expect(migration).toMatch(/ADD COLUMN "moderationFlagged" BOOLEAN/);
    expect(migration).toMatch(/ADD COLUMN "moderationReasons" JSONB/);
    expect(migration.match(/ADD COLUMN/gi)).toHaveLength(2);
    expect(migration).not.toMatch(/NOT NULL|DEFAULT|UPDATE|INSERT|DELETE|DROP|TRUNCATE|RENAME/i);
  });
});
