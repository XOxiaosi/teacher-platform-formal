import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRISMA_SCHEMA_DIRECTORY, readPrismaSchema } from '../helpers/prisma-schema.js';

describe('multi-file Prisma schema layout', () => {
  it('schema inspection includes nested model files and ignores migration artifacts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'teacher-platform-schema-reader-'));
    try {
      mkdirSync(join(directory, 'models'));
      mkdirSync(join(directory, 'migrations'));
      writeFileSync(join(directory, 'schema.prisma'), 'datasource db { provider = "postgresql" }');
      writeFileSync(join(directory, 'models', 'student.prisma'), 'model Student { id String @id }');
      writeFileSync(join(directory, 'models', 'notes.txt'), 'IGNORED');
      writeFileSync(join(directory, 'migrations', 'old.prisma'), 'RETIRED_MODEL');
      const schema = readPrismaSchema(directory);
      expect(schema).toContain('datasource db');
      expect(schema).toContain('model Student');
      expect(schema).not.toMatch(/IGNORED|RETIRED_MODEL/);
      expect(readPrismaSchema(directory)).toBe(schema);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('CLI defaults point at the full directory while the entry keeps one datasource and generator', () => {
    const packageJson = JSON.parse(readFileSync(resolve(PRISMA_SCHEMA_DIRECTORY, '../package.json'), 'utf8'));
    expect(packageJson.prisma.schema).toBe('prisma');
    const entry = readFileSync(join(PRISMA_SCHEMA_DIRECTORY, 'schema.prisma'), 'utf8');
    expect(entry.match(/^generator /gm)).toHaveLength(1);
    expect(entry.match(/^datasource /gm)).toHaveLength(1);
    expect(entry).not.toMatch(/^model /m);
    const schema = readPrismaSchema();
    expect(schema.match(/^generator /gm)).toHaveLength(1);
    expect(schema.match(/^datasource /gm)).toHaveLength(1);
    const models = [...schema.matchAll(/^model (\w+) /gm)].map((match) => match[1]);
    expect(new Set(models).size).toBe(models.length);
    for (const model of ['Student', 'Schedule', 'CaptureCandidate', 'Conversation', 'Payment', 'ParentFeedback', 'TeacherRegistry', 'MediaAsset']) {
      expect(models).toContain(model);
    }
  });
});
