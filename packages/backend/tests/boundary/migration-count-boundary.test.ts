import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { countMigrationFiles } from '../../../contracts/scripts/migration-count.mjs';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'migration-count-'));
  roots.push(root);
  return root;
}
function migration(root: string, name: string) {
  const directory = resolve(root, name);
  mkdirSync(directory);
  writeFileSync(resolve(directory, 'migration.sql'), 'SELECT 1;');
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('migration directory count', () => {
  it('tracks added migrations and ignores non-directory metadata', () => {
    const root = fixture();
    writeFileSync(resolve(root, 'migration_lock.toml'), 'provider = "postgresql"');
    migration(root, 'baseline');
    expect(countMigrationFiles(root)).toBe(1);
    migration(root, 'next');
    expect(countMigrationFiles(root)).toBe(2);
  });

  it('rejects missing and empty roots', () => {
    const root = fixture();
    expect(() => countMigrationFiles(root)).toThrow('No migration directories');
    expect(() => countMigrationFiles(resolve(root, 'missing'))).toThrow();
  });

  it('rejects incomplete migrations instead of silently lowering the expected count', () => {
    const root = fixture();
    migration(root, 'valid');
    mkdirSync(resolve(root, 'incomplete'));
    expect(() => countMigrationFiles(root)).toThrow();
    mkdirSync(resolve(root, 'incomplete/migration.sql'));
    expect(() => countMigrationFiles(root)).toThrow('not a regular file');
  });
});
