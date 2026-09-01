#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  assertLocalDatabaseUrl,
  assertSafeTestDatabaseName,
  buildTestDatabaseName,
  databaseNameFromUrl,
} from './test-database-safety.mjs';
import { acquire as acquireTestMutex, shouldLockForArgs } from '../../../scripts/test-mutex.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '../../..');
const backendRoot = resolve(projectRoot, 'packages/backend');
const contractsEnvPath = resolve(projectRoot, 'packages/contracts/.env');
const prismaBin = resolve(projectRoot, 'node_modules/prisma/build/index.js');
const vitestBin = resolve(projectRoot, 'node_modules/vitest/vitest.mjs');
const schemaPath = resolve(projectRoot, 'packages/contracts/prisma/schema.prisma');

function readEnvValue(filePath, key) {
  if (!existsSync(filePath)) return undefined;
  const line = readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .find((item) => item.trim().startsWith(`${key}=`));
  if (!line) return undefined;
  let value = line.trim().slice(`${key}=`.length).trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value || undefined;
}

function loadBaseDatabaseUrl() {
  const value = process.env.DATABASE_URL
    ?? readEnvValue(contractsEnvPath, 'DATABASE_URL');
  if (!value) throw new Error('SAFETY_BLOCK: DATABASE_URL 未配置');
  const url = new URL(value);
  assertLocalDatabaseUrl(url);
  return url;
}

function postgresEnvironment(url, databaseName) {
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: databaseName,
  };
}

function postgresBinCandidates() {
  if (process.platform !== 'win32') return [];
  const roots = [
    process.env.ProgramFiles && resolve(process.env.ProgramFiles, 'PostgreSQL'),
    process.env['ProgramFiles(x86)'] && resolve(process.env['ProgramFiles(x86)'], 'PostgreSQL'),
  ].filter(Boolean);
  const dirs = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries;
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

function withPostgresBinPath(environment) {
  const bins = postgresBinCandidates();
  if (bins.length === 0) return environment;
  const existingPath = environment.PATH ?? process.env.PATH ?? '';
  return {
    ...environment,
    PATH: [existingPath, ...bins].filter(Boolean).join(delimiter),
  };
}

function run(command, args, environment, label, cwd = projectRoot) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.status ?? 1;
}

function runRequired(command, args, environment, label) {
  const status = run(command, args, environment, label);
  if (status !== 0) throw new Error(`SETUP_FAILED: ${label} 返回 ${status}`);
}

function main() {
  const vitestArgs = process.argv.slice(2);
  // P14 t1：全量回归互斥——无文件路径（全量）时 acquire；定向测试（带文件路径）不锁。
  // TEST_MUTEX_SKIP=1 由 gate.mjs 传入（gate 已持锁，子进程不重复 acquire，防自锁）。
  const isFullRun = shouldLockForArgs(vitestArgs);
  const mutexSkipped = process.env.TEST_MUTEX_SKIP === '1';
  let testMutex = null;
  if (isFullRun && !mutexSkipped) {
    try {
      testMutex = acquireTestMutex({ reason: 'backend full regression (run-tests-isolated)' });
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const baseUrl = loadBaseDatabaseUrl();
  const sourceDatabase = databaseNameFromUrl(baseUrl);
  const testDatabase = buildTestDatabaseName(randomBytes(6).toString('hex'));
  assertSafeTestDatabaseName(testDatabase, sourceDatabase);

  const maintenanceEnvironment = withPostgresBinPath(postgresEnvironment(baseUrl, 'postgres'));
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${testDatabase}`;
  const testEnvironment = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: testUrl.toString(),
    TEACHER_PLATFORM_TEST_DATABASE: '1',
  };

  let databaseCreated = false;
  let exitCode = 1;
  let cleanupFailed = false;

  try {
    try {
      runRequired('createdb', [testDatabase], maintenanceEnvironment, 'createdb');
      databaseCreated = true;
      runRequired(
        process.execPath,
        [prismaBin, 'migrate', 'deploy', '--schema', schemaPath],
        testEnvironment,
        'prisma migrate deploy',
      );
      exitCode = run(
        process.execPath,
        [vitestBin, 'run', ...vitestArgs],
        testEnvironment,
        'vitest',
        backendRoot,
      );
      if (exitCode !== 0) {
        process.stderr.write(`TEST_FAILED: vitest 返回 ${exitCode}\n`);
      }
    } finally {
      if (databaseCreated) {
        const cleanupStatus = run(
          'dropdb',
          ['--if-exists', '--force', testDatabase],
          maintenanceEnvironment,
          'dropdb',
        );
        cleanupFailed = cleanupStatus !== 0;
        if (cleanupFailed) process.stderr.write('CLEANUP_FAILED: 临时测试数据库删除失败\n');
      }
    }
  } finally {
    if (testMutex) {
      testMutex.release();
      testMutex = null;
    }
  }

  process.exitCode = cleanupFailed ? 1 : exitCode;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
