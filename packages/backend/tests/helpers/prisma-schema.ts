import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const PRISMA_SCHEMA_DIRECTORY = resolve(__dirname, '../../../contracts/prisma');

/** Read the full schema, including model folders, without treating migrations as models. */
export function readPrismaSchema(directory = PRISMA_SCHEMA_DIRECTORY): string {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory() && entry.name !== 'migrations') return [readPrismaSchema(path)];
      return entry.isFile() && entry.name.endsWith('.prisma') ? [readFileSync(path, 'utf8')] : [];
    })
    .join('\n');
}
