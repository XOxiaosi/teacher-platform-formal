#!/usr/bin/env node
/**
 * ops 测试入口（P15 t1）：node --test 前先取 test-mutex 互斥锁。
 *
 * 背景：ops 测试（db-backup/db-restore/deactivate/export/db-tools 等）全部连共享库
 * teacher_platform 并创建/删除 teacher_db_* 演练库——与 backend 全量回归并发时互相踩：
 *   · backend 套件 admin-actions 的 purgeLeftoverTeacherDbs() 会把 ops 侧存活演练库
 *     直接 DROP（实测：ops 套件并发时 db-restore/deactivate/export 全挂「库不存在」）；
 *   · ops 套件写入的 TeacherRegistry 行会污染 backend teacher-overview 的分页计数
 *     （实测：全量回归并发时 teacher-overview 分页断言偶发红）。
 * 同一时间只允许一个 DB 重度套件运行（与 run-tests-isolated.mjs 全量回归同锁）。
 *
 * 用法：node scripts/run-tests.mjs [-- node --test 参数]
 *   TEST_MUTEX_SKIP=1 跳过取锁（gate 等已持锁的调用方传入，防自锁）。
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquire } from '../../../scripts/test-mutex.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const opsRoot = resolve(scriptDir, '..');

const mutexSkipped = process.env.TEST_MUTEX_SKIP === '1';
let testMutex = null;
if (!mutexSkipped) {
  try {
    testMutex = acquire({ reason: 'ops full suite (node --test，连共享库)' });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const child = spawn(
  process.execPath,
  ['--test', 'tests/**/*.test.mjs', ...args],
  {
    cwd: opsRoot,
    stdio: 'inherit',
    windowsHide: true,
  },
);

child.on('error', (error) => {
  process.stderr.write(`[ops-tests] 启动失败: ${error.message}\n`);
  if (testMutex) testMutex.release();
  process.exit(1);
});

child.on('close', (code) => {
  if (testMutex) testMutex.release();
  process.exit(code ?? 1);
});
