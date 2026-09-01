#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildLocalSafeEnvironment } from './start-local-safe.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const loopback = '127.0.0.1';
const startupTimeoutMs = 10_000;

/**
 * Windows 下 npm 是 .cmd 批处理，spawn 直接调会 ENOENT/EINVAL（shell:false 亦不行）——
 * 解析为显式可执行路径 node <npm-cli.js>（与 npm.cmd shim 内部执行等价，零 shell 解释）。
 * 非 win32 原样返回（npm 可直接 spawn）。
 */
function resolveNpmCommand() {
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  const candidates = [];
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && /npm-cli\.(js|cjs|mjs)$/i.test(npmExecPath) && existsSync(npmExecPath)) {
    candidates.push(npmExecPath);
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const npmCmd = join(dir, 'npm.cmd');
    if (!existsSync(npmCmd)) continue;
    const cli = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(cli)) candidates.push(cli);
    break;
  }
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(bundled)) candidates.push(bundled);
  const cli = candidates[0];
  return cli
    ? { command: process.execPath, args: [cli] }
    : { command: 'npm.cmd', args: [] };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function reserveAvailablePort() {
  const server = createServer();
  server.unref();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, loopback, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('无法分配 backend smoke 端口');
  }
  const { port } = address;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return port;
}

async function stopProcessGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Windows 无负 pid 进程组信号：taskkill /T 杀进程树
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await Promise.race([once(child, 'exit'), delay(1_000)]);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return;
  }
  await Promise.race([once(child, 'exit'), delay(1_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
    await Promise.race([once(child, 'exit'), delay(1_000)]);
  }
}

async function waitForHealth(child, url, output) {
  const deadline = performance.now() + startupTimeoutMs;
  while (performance.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`backend smoke 提前退出\n${output()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const body = await response.json();
        if (body?.ok === true && body?.data?.status === 'ok') return;
      }
    } catch {}
    await delay(100);
  }
  throw new Error(`backend smoke 在 ${startupTimeoutMs}ms 内未就绪\n${output()}`);
}

/**
 * The built-backend smoke is part of the local-safe launch graph.  It must
 * never inherit a caller's opt-out or service credentials, even when invoked
 * from an interactive shell with an old project .env already loaded.
 */
export function buildSmokeEnvironment(source = process.env, port) {
  return {
    ...buildLocalSafeEnvironment(source, 'runtime-smoke-only-secret-32-bytes-minimum'),
    PORT: String(port),
    DATABASE_URL: 'postgresql://postgres@127.0.0.1:1/teacher_platform_runtime_smoke',
  };
}

async function main() {
  const port = await reserveAvailablePort();
  const outputChunks = [];
  const npm = resolveNpmCommand();
  const child = spawn(npm.command, [...npm.args, '-w', '@teacher-platform/backend', 'run', 'start'], {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildSmokeEnvironment(process.env, port),
  });
  const capture = (chunk) => {
    outputChunks.push(String(chunk));
    if (outputChunks.length > 40) outputChunks.shift();
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  try {
    await waitForHealth(
      child,
      `http://${loopback}:${port}/api/v1/health`,
      () => outputChunks.join(''),
    );
    process.stdout.write('BUILT_BACKEND_SMOKE_PASS\n');
  } finally {
    await stopProcessGroup(child);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
