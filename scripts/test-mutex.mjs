#!/usr/bin/env node
/**
 * test-mutex —— 全量回归互斥锁（P14 t1）
 *
 * 背景（P13 多次并发互踩事件）：隔离库误删 / R6 误报 / DLL 锁 EPERM / flaky
 * （P13 t6 报告 §4b：两套全量回归并发时 child-server 类测试子进程连开发库共享行
 * 互相干扰 → 断言偶发失败）。本模块为「全量回归 / gate」提供文件锁互斥：
 * 同一时间只允许一个全量回归运行，定向测试（带文件路径）不锁、放行。
 *
 * 用法（编程接口）：
 *   import { acquire, release, shouldLockForArgs, lockStatus } from './test-mutex.mjs';
 *   const handle = acquire({ force: false, reason: 'backend full regression' });
 *   try { ... } finally { handle.release(); }
 *   // 冲突时抛 TestMutexError（code: 'BUSY' | 'STALE'），消息含「另一全量回归运行中…」
 *
 * 用法（CLI，手动运维/测试）：
 *   node scripts/test-mutex.mjs check [--lock <path>]             # 0=空闲 1=被持有（含持有者信息）
 *   node scripts/test-mutex.mjs acquire [--force] [--reason X] [--hold-ms N] [--lock <path>]
 *   node scripts/test-mutex.mjs release [--lock <path>]
 *
 * 语义：
 *   - 锁文件默认 <projectRoot>/.data/.test-mutex（.data/ 已 gitignore）；
 *     环境变量 TEST_MUTEX_LOCK_PATH 可覆盖（测试隔离用）。
 *   - 锁内容：JSON { pid, startedAtMs, reason }。
 *   - 判定（按优先序）：
 *       · 持有者 PID 已退出          → 视为失效锁，**自动接管**（进程已死不可能并发，
 *                                     防止崩溃残留阻塞后续回归——P13 崩溃场景的直接缓解）
 *       · 持有者存活且 <30 分钟      → BUSY：报「另一全量回归运行中（PID x，起始时间 t），
 *                                     请错峰或强占」，退出非零
 *       · 持有者存活但 ≥30 分钟(stale) → STALE：报过期，可用 --force 强占
 *       · 锁文件损坏/不可读           → STALE：可用 --force 强占
 *       · force=true 任意情况直接强占（unlink 后重取，wx 原子写防 TOCTOU）
 *   - 释放仅限持有者自身（pid 匹配才 unlink，防止误删他人强占后的锁）。
 *
 * 时间纪律（R1 登记说明）：
 *   - 锁的 startedAtMs 用 Date.now()——**跨进程 stale 判定需要墙钟**；
 *     performance.now() 是进程内单调时钟，跨进程不可比较，无法用于锁过期判定。
 *   - R1 current-time 边界扫描范围为 packages/backend/src 下的 ts 文件，不覆盖 scripts/；
 *     与 gate.mjs 的 Date.now() 计时用法同领地（ops 工具墙钟，非业务时间，
 *     业务时间纪律 TrustedClock 不受影响）。本文件头部注释即本新用途的登记。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 锁过期阈值：30 分钟（超过且持有者存活 → 需 --force 强占）。 */
export const DEFAULT_STALE_MS = 30 * 60 * 1000;

const scriptDir = dirname(fileURLToPath(import.meta.url));
/** 项目根 = scripts/ 的上一级。 */
export const PROJECT_ROOT = resolve(scriptDir, '..');

export const DEFAULT_LOCK_REL = '.data/.test-mutex';

/** 解析锁文件路径：显式参数 > TEST_MUTEX_LOCK_PATH > 默认 .data/.test-mutex。 */
export function resolveLockPath(lockPath) {
  if (lockPath) return lockPath;
  if (process.env.TEST_MUTEX_LOCK_PATH) return process.env.TEST_MUTEX_LOCK_PATH;
  return resolve(PROJECT_ROOT, DEFAULT_LOCK_REL);
}

/** 互斥锁业务错误：code = 'BUSY' | 'STALE'；holder 为锁内记录（可能为 null）。 */
export class TestMutexError extends Error {
  constructor(code, message, holder = null) {
    super(message);
    this.name = 'TestMutexError';
    this.code = code;
    this.holder = holder;
  }
}

/**
 * 全量回归判定（接入点共用，纯函数便于测试）：
 * 任意非 `-` 开头的参数视为 vitest 文件过滤器（定向测试）→ 不锁；
 * 仅 flag（如 --no-file-parallelism）或无参数 → 全量 → 锁。
 */
export function shouldLockForArgs(args) {
  return !args.some((arg) => !arg.startsWith('-'));
}

/** Windows 下禁止 process.kill(pid, 0) 探测存活（会真杀进程）；用 tasklist。 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    return r.status === 0 && r.stdout.includes(String(pid));
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** 读取锁文件；不存在返回 null；损坏返回 { corrupt: true }。 */
function readLock(lockPath) {
  const p = resolveLockPath(lockPath);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { corrupt: true, pid: null, startedAtMs: null };
  }
}

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '未知';
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}

/**
 * 锁状态（供 check/诊断与 acquire 内部复用）：
 * 返回 { held, stale, reason, holder }，holder = { pid, startedAtMs, reason } | null。
 * reason: 'free' | 'active' | 'over-age' | 'pid-dead' | 'corrupt'
 */
export function lockStatus(lockPath, staleMs = DEFAULT_STALE_MS) {
  const p = resolveLockPath(lockPath);
  const raw = readLock(p);
  if (!raw) return { held: false, stale: false, reason: 'free', holder: null };
  const holder = {
    pid: raw.pid ?? null,
    startedAtMs: raw.startedAtMs ?? null,
    reason: raw.reason ?? '',
  };
  if (raw.corrupt || !Number.isInteger(holder.pid)) {
    return { held: true, stale: true, reason: 'corrupt', holder };
  }
  const alive = isPidAlive(holder.pid);
  if (!alive) return { held: true, stale: true, reason: 'pid-dead', holder };
  const age = Date.now() - Number(holder.startedAtMs || 0);
  if (!Number.isFinite(age) || age < 0) {
    return { held: true, stale: true, reason: 'corrupt', holder };
  }
  if (age >= staleMs) return { held: true, stale: true, reason: 'over-age', holder };
  return { held: true, stale: false, reason: 'active', holder };
}

/**
 * 获取互斥锁。
 * @param {object} [options]
 * @param {string} [options.lockPath]      锁文件路径（默认 .data/.test-mutex）
 * @param {number} [options.staleMs]       过期阈值 ms（默认 30 分钟）
 * @param {boolean} [options.force]        强占（任意状态直接接管）
 * @param {string} [options.reason]        持有原因（写入锁文件，便于诊断）
 * @returns {{ pid:number, startedAtMs:number, reason:string, lockPath:string, release:()=>boolean }}
 * @throws {TestMutexError} code='BUSY'（他方持有）| 'STALE'（过期需强占）
 */
export function acquire({ lockPath, staleMs = DEFAULT_STALE_MS, force = false, reason = '全量回归' } = {}) {
  const p = resolveLockPath(lockPath);
  mkdirSync(dirname(p), { recursive: true });
  const me = { pid: process.pid, startedAtMs: Date.now(), reason };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(p, JSON.stringify(me, null, 2), { flag: 'wx' });
      return {
        pid: me.pid,
        startedAtMs: me.startedAtMs,
        reason: me.reason,
        lockPath: p,
        release: () => release({ lockPath: p, pid: process.pid }),
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // 已被占用：判定可否接管
      const st = lockStatus(p, staleMs);
      if (st.held) {
        if (st.reason === 'pid-dead') {
          // 持有者已退出：自动接管（进程已死，无并发可能；防崩溃残留阻塞）
          process.stderr.write(
            `[test-mutex] 接管失效锁：持有者 PID ${st.holder.pid}（起始 ${formatTime(st.holder.startedAtMs)}）已退出\n`,
          );
        } else if (st.reason === 'over-age') {
          if (!force) {
            throw new TestMutexError(
              'STALE',
              `互斥锁已过期（PID ${st.holder.pid}，起始时间 ${formatTime(st.holder.startedAtMs)}，超过 ${Math.round(staleMs / 60000)} 分钟），可用 --force 强占`,
              st.holder,
            );
          }
        } else if (st.reason === 'corrupt') {
          if (!force) {
            throw new TestMutexError('STALE', `互斥锁文件异常（${p}），可用 --force 强占`, st.holder);
          }
        } else if (st.reason === 'active') {
          if (!force) {
            throw new TestMutexError(
              'BUSY',
              `另一全量回归运行中（PID ${st.holder.pid}，起始时间 ${formatTime(st.holder.startedAtMs)}），请错峰或强占`,
              st.holder,
            );
          }
        }
      }
      // force / 自动接管 / 竞态落空 → 移除后重试（wx 原子写防并发双写）
      rmSync(p, { force: true });
    }
  }
  throw new TestMutexError('BUSY', `互斥锁获取失败（${p} 持续冲突）`);
}

/**
 * 释放互斥锁。仅当锁内 pid === 本进程 pid 才删除（防误删他人强占后的锁）；
 * 例外：持有者 PID 已退出（崩溃残留）→ 允许清理（进程已死，无并发可能）。
 * @param {{ lockPath?: string, pid?: number }} options
 * @returns {boolean} 是否成功释放（true=已释放或本就不存在；false=持有者存活且非本进程/损坏）
 */
export function release({ lockPath, pid = process.pid } = {}) {
  const p = resolveLockPath(lockPath);
  if (!existsSync(p)) return true;
  const raw = readLock(p);
  if (raw && !raw.corrupt && Number(raw.pid) !== Number(pid)) {
    if (!isPidAlive(Number(raw.pid))) {
      process.stderr.write(`[test-mutex] 清理失效锁：持有者 PID ${raw.pid} 已退出\n`);
    } else {
      process.stderr.write(`[test-mutex] 拒绝释放：锁持有者为 PID ${raw.pid}（存活中，非本进程 ${pid}）\n`);
      return false;
    }
  }
  rmSync(p, { force: true });
  return true;
}

// ── CLI（手动运维/测试）───────────────────────────────────────────────────────
function cli() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name) => rest.includes(name);
  const opt = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : undefined;
  };
  const lockPath = opt('--lock');
  const force = flag('--force');

  if (cmd === 'check') {
    const st = lockStatus(lockPath);
    if (!st.held) {
      console.log(`FREE ${resolveLockPath(lockPath)}`);
      process.exit(0);
    }
    console.log(
      `HELD ${resolveLockPath(lockPath)} pid=${st.holder.pid} startedAt=${formatTime(st.holder.startedAtMs)} reason=${st.reason || ''} stale=${st.stale} (${st.reason})`,
    );
    process.exit(st.stale ? 2 : 1);
  }

  if (cmd === 'acquire') {
    const holdMs = Number(opt('--hold-ms') || '0');
    const reason = opt('--reason') || 'cli';
    try {
      const handle = acquire({ lockPath, force, reason });
      console.log(`ACQUIRED ${handle.lockPath} pid=${handle.pid} startedAt=${formatTime(handle.startedAtMs)}`);
      if (holdMs > 0) {
        setTimeout(() => {
          handle.release();
          console.log(`RELEASED ${handle.lockPath}`);
          process.exit(0);
        }, holdMs);
      }
      // holdMs<=0：保持持有直到进程结束（锁文件保留 → 下次按 pid-dead/stale 处理）
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'release') {
    const ok = release({ lockPath });
    console.log(ok ? `RELEASED ${resolveLockPath(lockPath)}` : `RELEASE_REFUSED ${resolveLockPath(lockPath)}`);
    process.exit(ok ? 0 : 1);
  }

  console.log(
    `usage: node scripts/test-mutex.mjs check|acquire|release [--force] [--reason X] [--hold-ms N] [--lock <path>]`,
  );
  process.exit(cmd ? 2 : 0);
}

// 直接执行（node scripts/test-mutex.mjs）时走 CLI；被 import 时不执行。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli();
}
