/**
 * 后台任务共享模块（P10 t1 runSpawnJob shell 硬化）单测：
 *
 * - resolveSpawnCommand 双形态：win32（npm/npx → node <npm-cli.js> 显式可执行路径）/
 *   非 win32（原样直传，npm 可直接 spawn）；非 npm/npx 命令原样直传；找不到 npm-cli.js 时兜底 npm.cmd；
 * - resolveNpmCliJs 真实定位：当前环境（Windows npm 标准安装布局）能解析出 npm-cli.js；
 * - runSpawnJob 真实子进程（shell:false）：成功路径 stdout 尾行 JSON 解析 / 非零退出 failed + stderr 尾 /
 *   超时强杀 failed；真实 npm 后台任务形态（npm → node npm-cli.js）全流程。
 *
 * 注：真实 db-backup/restore/provision/privacy 全流程见 admin-actions.test.ts / privacy-api.test.ts
 * （真实子进程 + HTTP 轮询），本文件锁定 spawn 形态本身。
 */

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  createJobStore,
  resolveSpawnCommand,
  resolveNpmCliJs,
  runSpawnJob,
} from '../../../src/shared/background-jobs/index.js';

describe('resolveSpawnCommand: shell:false 双形态解析', () => {
  it('win32 + npm → node <npm-cli.js>（显式可执行路径，argv 直传，不经 shell）', () => {
    const resolved = resolveSpawnCommand('npm', ['--version'], 'win32', process.env, process.execPath);
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args[0]).toMatch(/npm-cli\.(js|cjs|mjs)$/i);
    expect(resolved.args.slice(1)).toEqual(['--version']);
  });

  it('win32 + npx → node <npm-cli.js>', () => {
    const resolved = resolveSpawnCommand('npx', ['eslint'], 'win32', process.env, process.execPath);
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args[0]).toMatch(/npm-cli\.(js|cjs|mjs)$/i);
    expect(resolved.args.slice(1)).toEqual(['eslint']);
  });

  it('win32 + 找不到 npm-cli.js → 兜底 npm.cmd（极端环境，由 spawn error 兜底标记 failed）', () => {
    const resolved = resolveSpawnCommand('npm', ['--version'], 'win32', { PATH: '' }, 'C:\\no-such\\node.exe');
    expect(resolved).toEqual({ command: 'npm.cmd', args: ['--version'] });
  });

  it('非 win32（linux）→ 原样直传（npm 本身可直接 spawn，无需解析）', () => {
    const resolved = resolveSpawnCommand('npm', ['--version'], 'linux', {}, '/usr/bin/node');
    expect(resolved).toEqual({ command: 'npm', args: ['--version'] });
  });

  it('win32 + 非 npm/npx 命令 → 原样直传', () => {
    const resolved = resolveSpawnCommand('psql', ['-V'], 'win32', {}, process.execPath);
    expect(resolved).toEqual({ command: 'psql', args: ['-V'] });
  });
});

describe('resolveNpmCliJs: 真实环境定位', () => {
  it('当前环境（Windows npm 标准安装布局）能定位 npm-cli.js', () => {
    const cli = resolveNpmCliJs(process.env, process.execPath);
    expect(cli).toBeTruthy();
    expect(cli!).toMatch(/npm-cli\.(js|cjs|mjs)$/i);
  });
});

describe('runSpawnJob: 真实子进程（shell:false）', () => {
  it('成功路径：退出码 0 + stdout 尾行 JSON 解析为 result', async () => {
    const store = createJobStore();
    const jobId = store.create('smoke');
    await runSpawnJob(store, jobId, {
      command: process.execPath,
      args: ['-e', 'console.log("progress"); console.log(JSON.stringify({ tool: "smoke", ok: true }))'],
      cwd: process.cwd(),
    });
    const job = store.get(jobId);
    expect(job?.status).toBe('succeeded');
    expect((job?.result as { tool?: string }).tool).toBe('smoke');
  });

  it('失败路径：非零退出 → failed + stderr 尾', async () => {
    const store = createJobStore();
    const jobId = store.create('smoke-fail');
    await runSpawnJob(store, jobId, {
      command: process.execPath,
      args: ['-e', 'console.error("boom-marker"); process.exit(3)'],
      cwd: process.cwd(),
    });
    const job = store.get(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('退出码 3');
    expect(job?.error).toContain('boom-marker');
  });

  it('超时路径：超时强杀 → failed', async () => {
    const store = createJobStore();
    const jobId = store.create('smoke-timeout');
    await runSpawnJob(store, jobId, {
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60_000)'],
      cwd: process.cwd(),
      timeoutMs: 300,
    });
    const job = store.get(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('超时');
  });

  it('真实 npm 后台任务形态：npm → node <npm-cli.js>（本机 Windows 实测 shell:false 全流程）', async () => {
    const store = createJobStore();
    const jobId = store.create('smoke-npm');
    await runSpawnJob(store, jobId, {
      command: 'npm',
      args: ['--version'],
      cwd: resolve(process.cwd(), '..', '..'), // monorepo 根（spawnCwd 同形态；npm 可运行）
    });
    const job = store.get(jobId);
    expect(job?.status).toBe('succeeded');
    expect((job?.result as { stdoutTail?: string[] }).stdoutTail?.join(' ')).toMatch(/^\d+\.\d+\.\d+/);
  });
});
