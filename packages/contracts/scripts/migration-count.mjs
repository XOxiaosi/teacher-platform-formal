import { lstatSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Count complete migration directories; fail closed on an incomplete migration. */
export function countMigrationFiles(migrationsRoot) {
  const directories = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  if (directories.length === 0) throw new Error('No migration directories found');
  for (const entry of directories) {
    const sql = resolve(migrationsRoot, entry.name, 'migration.sql');
    if (!lstatSync(sql).isFile()) throw new Error(`Migration SQL is not a regular file: ${sql}`);
  }
  return directories.length;
}
