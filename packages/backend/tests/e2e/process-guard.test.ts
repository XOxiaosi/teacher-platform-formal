import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 进程级测试（P7 G3，T8b 设计 §6.1）：spawn 独立子进程运行真实入口 src/index.ts
 * （G3 阶段二接线后的生产启动路径：listen 回环 + registerGracefulShutdown + 测试开关），
 * 验证优雅退出/超时兜底/回环绑定端到端。
 *
 * - Windows 下 SIGTERM 为无条件终止（Node 文档），真实信号路径仅 POSIX 覆盖
 *   （it.runIf）；跨平台用 SHUTDOWN_PROBE_MS 环境开关走同一生产 shutdown 函数。
 * - 子进程生命周期：afterEach 清理，防悬挂。
 */

const BACKEND_ROOT = process.cwd(); // 隔离库 runner 以 packages/backend 为 cwd
const ENTRY = 'src/index.ts';
const TEST_ACTION_TOKEN_SECRET = 'process-guard-test-secret-0123456789abcdef'; // ≥32 bytes
const HEALTH_PATH = '/api/v1/health/live';

interface SpawnedServer {
  child: ChildProcess;
  port: number;
  stdout: string;
  stderr: string;
}

const running: SpawnedServer[] = [];

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as { port: number };
      probe.close(() => resolvePort(address.port));
    });
  });
}

async function spawnServer(extraEnv: Record<string, string>): Promise<SpawnedServer> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
    cwd: BACKEND_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      LISTEN_HOST: '127.0.0.1',
      ACTION_TOKEN_SECRET: TEST_ACTION_TOKEN_SECRET,
      SHUTDOWN_TIMEOUT_MS: '2000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const handle: SpawnedServer = { child, port, stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk: Buffer) => { handle.stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { handle.stderr += chunk.toString(); });
  running.push(handle);
  return handle;
}

function healthUrl(port: number): string {
  return `http://127.0.0.1:${port}${HEALTH_PATH}`;
}

async function waitForHealth(handle: SpawnedServer, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`server exited early (code ${handle.child.exitCode}): ${handle.stderr}`);
    }
    try {
      const response = await fetch(healthUrl(handle.port), { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // 尚未就绪，重试
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`health probe timeout: ${handle.stderr}`);
}

function waitForExit(
  handle: SpawnedServer,
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`child did not exit in time: ${handle.stderr}`)),
      timeoutMs,
    );
    handle.child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

afterEach(() => {
  for (const handle of running) {
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill(); // Windows: 无条件终止兜底
    }
  }
  running.length = 0;
});

describe('process guard: graceful shutdown (G3)', () => {
  it('SHUTDOWN_PROBE_MS 触发优雅退出：exit 0 + shutdown 日志序列', async () => {
    const handle = await spawnServer({ SHUTDOWN_PROBE_MS: '1200' });
    await waitForHealth(handle);
    const { code, signal } = await waitForExit(handle);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(handle.stdout).toContain('"msg":"shutdown started"');
    expect(handle.stdout).toContain('"msg":"shutdown complete"');
  }, 20_000);

  it.runIf(process.platform !== 'win32')('SIGTERM → 优雅退出 exit 0', async () => {
    const handle = await spawnServer({});
    await waitForHealth(handle);
    handle.child.kill('SIGTERM');
    const { code, signal } = await waitForExit(handle);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(handle.stdout).toContain('"msg":"shutdown started"');
    expect(handle.stdout).toContain('"msg":"shutdown complete"');
  }, 20_000);

  it('超时兜底：SHUTDOWN_HANG=1 + 短 SHUTDOWN_TIMEOUT_MS → exit 1', async () => {
    const handle = await spawnServer({
      SHUTDOWN_HANG: '1',
      SHUTDOWN_PROBE_MS: '400',
      SHUTDOWN_TIMEOUT_MS: '700',
    });
    await waitForHealth(handle);
    const { code } = await waitForExit(handle, 10_000);
    expect(code).toBe(1);
    expect(handle.stdout).toContain('"msg":"shutdown timed out, force exit"');
  }, 20_000);

  it('回环绑定：LISTEN_HOST=127.0.0.1 探活 200 + 优雅退出', async () => {
    const handle = await spawnServer({ SHUTDOWN_PROBE_MS: '3000' });
    await waitForHealth(handle);
    const response = await fetch(healthUrl(handle.port), { signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('ok');
    const { code } = await waitForExit(handle);
    expect(code).toBe(0);
  }, 20_000);
});
