/**
 * 进程级测试 fixture（P7 G3）：独立子进程入口，端到端验证 registerGracefulShutdown。
 *
 * 不依赖 src/index.ts（S3 装配期间由 backend3 占用），直接装配生产模块：
 * - LISTEN_HOST/PORT 来自 env（默认 127.0.0.1/0）；
 * - FIXTURE_PROBE_MS>0 → 定时触发 graceful.shutdown('probe')（跨平台优雅路径）；
 * - FIXTURE_HANG=1 → additionalHooks 注入永不 resolve 的钩子（超时兜底路径）；
 * - SHUTDOWN_TIMEOUT_MS → 兜底超时窗口（默认 10_000）。
 *
 * 运行：node --import tsx tests/fixtures/graceful-shutdown-child.ts（cwd=packages/backend）
 */

import express from 'express';
import { createDatabaseClientPool } from '../../src/shared/database-pool/index.js';
import { createLogger } from '../../src/shared/logger/index.js';
import { registerGracefulShutdown } from '../../src/shared/shutdown/index.js';

const PORT = Number(process.env.PORT ?? 0);
const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1';
const TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);
const PROBE_MS = Number(process.env.FIXTURE_PROBE_MS ?? 0);
const HANG = process.env.FIXTURE_HANG === '1';

const pool = createDatabaseClientPool({
  baseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/teacher_platform',
  registerProcessHooks: false,
});

const app = express();
app.get('/api/v1/health/live', (_req, res) => {
  res.json({ ok: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
});

const server = app.listen(PORT, LISTEN_HOST, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : PORT;
  process.stdout.write(JSON.stringify({ msg: 'fixture listening', port }) + '\n');
});

const graceful = registerGracefulShutdown({
  server,
  pool,
  timeoutMs: TIMEOUT_MS,
  logger: createLogger(),
  additionalHooks: HANG ? [() => new Promise<void>(() => undefined)] : [],
});

if (Number.isFinite(PROBE_MS) && PROBE_MS > 0) {
  const probeTimer = setTimeout(() => {
    void graceful.shutdown('probe');
  }, PROBE_MS);
  probeTimer.unref?.();
}
