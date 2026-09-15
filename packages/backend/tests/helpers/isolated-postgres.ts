import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const TEST_PREFIX = 'teacher_platform_pending_action_test_';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function loadDatabaseUrl(): URL {
  if (process.env.DATABASE_URL) return new URL(process.env.DATABASE_URL);
  const envText = readFileSync(resolve(__dirname, '../../../contracts/.env'), 'utf8');
  const line = envText.split(/\r?\n/).find((item) => item.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL key missing from packages/contracts/.env');
  let value = line.slice('DATABASE_URL='.length).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return new URL(value);
}

function commandEnvironment(url: URL, databaseName: string) {
  return withPostgresBinPath({
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: databaseName,
  });
}

function postgresBinCandidates(): string[] {
  if (process.platform !== 'win32') return [];
  const roots = [
    process.env.ProgramFiles ? resolve(process.env.ProgramFiles, 'PostgreSQL') : undefined,
    process.env['ProgramFiles(x86)'] ? resolve(process.env['ProgramFiles(x86)'], 'PostgreSQL') : undefined,
  ].filter((value): value is string => Boolean(value));
  const dirs: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && /^\d+(\.\d+)?$/.test(entry.name)) {
        dirs.push(resolve(root, entry.name, 'bin'));
      }
    }
  }
  dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return dirs.filter((dir) => existsSync(dir));
}

function withPostgresBinPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bins = postgresBinCandidates();
  if (bins.length === 0) return env;
  const existingPath = env.PATH ?? process.env.PATH ?? '';
  return {
    ...env,
    PATH: [existingPath, ...bins].filter(Boolean).join(delimiter),
  };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, { env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
  }
}

export interface IsolatedPostgres {
  prisma: PrismaClient;
  cleanup(): Promise<void>;
}

export async function createIsolatedPostgres(): Promise<IsolatedPostgres> {
  const baseUrl = loadDatabaseUrl();
  if (!LOCAL_HOSTS.has(baseUrl.hostname)) throw new Error('SAFETY_BLOCK: isolated test requires local PostgreSQL');

  const sourceDatabase = decodeURIComponent(baseUrl.pathname.replace(/^\//, ''));
  const databaseName = `${TEST_PREFIX}${randomBytes(6).toString('hex')}`;
  if (!databaseName.startsWith(TEST_PREFIX)) throw new Error('SAFETY_BLOCK: invalid isolated database name');

  const maintenanceEnv = commandEnvironment(baseUrl, 'postgres');
  run('createdb', [databaseName], maintenanceEnv);

  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  const prismaBin = resolve(__dirname, '../../../../node_modules/prisma/build/index.js');
  const schemaPath = resolve(__dirname, '../../../contracts/prisma');

  try {
    run(process.execPath, [prismaBin, 'migrate', 'deploy', '--schema', schemaPath], {
      ...process.env,
      DATABASE_URL: testUrl.toString(),
    });
  } catch (error) {
    run('dropdb', ['--if-exists', databaseName], maintenanceEnv);
    throw error;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: testUrl.toString() } } });
  return {
    prisma,
    async cleanup() {
      await prisma.$disconnect();
      if (!databaseName.startsWith(TEST_PREFIX) || databaseName === sourceDatabase) {
        throw new Error('SAFETY_BLOCK: refusing isolated database cleanup');
      }
      run('dropdb', ['--if-exists', '--force', databaseName], maintenanceEnv);
    },
  };
}
