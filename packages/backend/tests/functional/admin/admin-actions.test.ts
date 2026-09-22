import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  createAdminAuthService,
  hashAdminPassword,
  createAdminRouter,
  isSafeRestoreTarget,
} from '../../../src/features/admin/index.js';
import { createAuthRouter } from '../../../src/app/routes/auth.routes.js';
import { createAuthService } from '../../../src/features/auth/index.js';
import { createDatabaseTrustedClock } from '../../../src/shared/trusted-clock/index.js';
import { createSlidingWindowLimiter } from '../../../src/app/middleware/rate-limit.js';
import { createDatabaseClientPool } from '../../../src/shared/database-pool/index.js';
import { assertSafeRestoreDatabaseName } from '../../../../ops/lib/db-safety.mjs';
import {
  databaseNameFromUrl,
  loadDatabaseUrl,
  psqlMaintenance,
  quoteIdentifier,
  runMigrateDeploy,
  withDatabase,
} from '../../../../ops/lib/pg-utils.mjs';
import type { DatabaseClientPool } from '../../../src/shared/database-pool/index.js';
import type { Logger } from '../../../src/shared/logger/index.js';
import { seedInvitation } from '../../helpers/invitations.js';

/**
 * 后台管理动作（P7 渠道线 A5）单测：
 * - 教师创建（重复 email 409 / 弱密码 400）+ 状态翻转 + disabled 登录 401（真实 auth 链路）
 * - 审计结构化日志断言（actor/action/objectType/objectId；失败 action=*.failed）
 * - backup 后台任务真实 db-backup 子进程 + jobId 轮询全流程（MANIFEST 产物断言）
 * - restore：无 confirm 400 / 目标校验跨通道一致性（ops assertSafeRestoreDatabaseName 反例集）
 *   / 真实演练恢复全流程（dump → 恢复库）
 * - provision ?provision=1 后台建库
 * - QA5 契约：jobId 不存在 → 404；轮询终态 {status,result?,error?}
 *
 * 库名命名空间约定（QA 验收库豁免）：
 * - 测试域：本文件（及全部 backend 测试）建库前缀 = teacher_db_<testdomain>_*（act/rst/prov 等），
 *   归属「测试残留域」——purgeLeftoverTeacherDbs() 与 gate R4 会全量清理。
 * - QA 真实验收域：持久演练库统一使用保留前缀 teacher_db_qa_*（含 restore 演练
 *   teacher_db_qa_*_restore_*，仍过 ops RESTORE_DB_PATTERN 白名单），purge 与 gate R4 一律豁免；
 *   QA 验收结束必须自行 drop 演练库（R4 不兜底 qa 前缀）。
 */

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-secret-123';
const ADMIN_HASH = hashAdminPassword(ADMIN_PASSWORD);

const prisma = new PrismaClient();
const baseUrl = new URL(loadDatabaseUrl());
const sourceDatabaseName = databaseNameFromUrl(baseUrl);
const maintenanceUrl = withDatabase(baseUrl, 'postgres');

const suffix = randomBytes(4).toString('hex');
const seedEmails: string[] = [];

async function loginAgent(app: ReturnType<typeof express>) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/admin/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

function createAdminApp(overrides: {
  logger?: Logger;
  backupRoot?: string;
  pool?: DatabaseClientPool;
} = {}) {
  const authService = createAdminAuthService({ email: ADMIN_EMAIL, passwordHash: ADMIN_HASH });
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin',
    createAdminRouter({
      authService,
      loginLimiter: createSlidingWindowLimiter(),
      registryPrisma: prisma,
      pool: overrides.pool ?? createRealPool(),
      logger: overrides.logger,
      backupRoot: overrides.backupRoot,
      // 旧备份/恢复专项：T-014 默认封闭，这里显式只为专项测试开启。
      legacyOperationsEnabled: true,
    }),
  );
  // 教师认证路由：验证「停用后登录 401」真实链路
  app.use('/api/v1', createAuthRouter(createAuthService({ prisma, clock: createDatabaseTrustedClock(prisma) })));
  return app;
}

function createRealPool(): DatabaseClientPool {
  return createDatabaseClientPool({
    baseUrl: `postgres://${baseUrl.username}:${baseUrl.password}@${baseUrl.hostname}:${baseUrl.port || '5432'}`,
    registerProcessHooks: false,
  });
}

async function seedTeacher(email: string, databaseName: string) {
  const teacher = await prisma.teacherRegistry.create({
    data: {
      email,
      passwordHash: 'scrypt$dummy$dummy',
      displayName: `动作测试-${email}`,
      databaseName,
    },
  });
  seedEmails.push(email);
  return teacher;
}

async function createIsolatedDb(dbName: string): Promise<void> {
  if (!/^teacher_db_[a-z0-9_]+$/.test(dbName)) throw new Error(`SAFETY_BLOCK: unsafe db name ${dbName}`);
  if (dbName === sourceDatabaseName || dbName === 'teacher_platform') {
    throw new Error('SAFETY_BLOCK: db name collides with source/shared');
  }
  psqlMaintenance(maintenanceUrl, `CREATE DATABASE ${quoteIdentifier(dbName)}`);
  try {
    runMigrateDeploy(withDatabase(baseUrl, dbName));
  } catch (error) {
    psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)}`);
    throw error;
  }
}

async function dropIsolatedDb(dbName: string): Promise<void> {
  psqlMaintenance(
    maintenanceUrl,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
  );
  psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)}`);
}

function databaseExists(dbName: string): boolean {
  const rows = psqlMaintenance(maintenanceUrl, `SELECT 1 FROM pg_database WHERE datname = '${dbName}'`);
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * 清理历史遗留 teacher_db_* 测试库（R4 纪律；跨文件失败运行可能残留，备份枚举会因库不存在而失败）。
 * QA 豁免：保留前缀 teacher_db_qa_* 属 QA 真实验收持久演练库（见文件头命名空间约定），
 * 由 QA 验收方自建自清，本函数与 gate R4 一律不碰——防止并行全量回归误删验收演练库。
 */
function purgeLeftoverTeacherDbs(): void {
  const rows = psqlMaintenance(
    maintenanceUrl,
    "SELECT datname FROM pg_database WHERE datname LIKE 'teacher_db_%' AND datname NOT LIKE 'teacher_db_qa_%'",
  ) as string[];
  for (const name of rows) {
    psqlMaintenance(
      maintenanceUrl,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
    );
    psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
  }
}

/** 轮询 job 直至终态（timeoutMs 内）。 */
async function pollJob(agent: ReturnType<typeof request.agent>, jobId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last: { status: string; result?: unknown; error?: string } = { status: 'pending' };
  while (Date.now() < deadline) {
    const res = await agent.get('/api/v1/admin/backup/status').query({ jobId });
    expect(res.status).toBe(200);
    last = res.body.data;
    if (last.status === 'succeeded' || last.status === 'failed') return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`job 未在 ${timeoutMs}ms 内终态：${JSON.stringify(last)}`);
}

afterAll(async () => {
  await prisma.teacherRegistry.deleteMany({ where: { email: { in: seedEmails } } });
  await prisma.$disconnect();
});

describe('admin actions: 邀请制账号与状态', () => {
  it('旧建号端点不可用，管理员不能代设教师密码', async () => {
    const app = createAdminApp();
    const agent = await loginAgent(app);
    const res = await agent.post('/api/v1/admin/teachers').send({
      email: `create-${suffix}@example.com`,
      password: 'teacher-pass-123',
      displayName: '创建测试教师',
    });
    expect(res.status).toBe(404);
  });

  it('状态翻转：disabled 后教师登录 401（真实 auth 链路），active 恢复', async () => {
    const app = createAdminApp();
    const agent = await loginAgent(app);
    const email = `flip-${suffix}@example.com`;
    const password = 'flip-pass-123';
    const invitation = await seedInvitation(prisma, { email });
    const created = await request(app).post('/api/v1/auth/invitations/accept').send({ token: invitation.token, password, displayName: '翻转测试' });
    expect(created.status).toBe(201);
    const teacherId = created.body.data.teacher.id;
    seedEmails.push(email);

    const loginOk = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(loginOk.status).toBe(200);

    const disable = await agent.patch(`/api/v1/admin/teachers/${teacherId}/status`).send({ status: 'disabled' });
    expect(disable.status).toBe(200);
    expect(disable.body.data.teacher.status).toBe('disabled');

    const loginBlocked = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(loginBlocked.status).toBe(401);
    expect(loginBlocked.body.error.message).toContain('停用');

    const enable = await agent.patch(`/api/v1/admin/teachers/${teacherId}/status`).send({ status: 'active' });
    expect(enable.status).toBe(200);
    const loginRestored = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(loginRestored.status).toBe(200);
  });

  it('非法 status → 400；未知教师 → 404', async () => {
    const app = createAdminApp();
    const agent = await loginAgent(app);
    const bad = await agent.patch('/api/v1/admin/teachers/whatever/status').send({ status: 'banned' });
    expect(bad.status).toBe(400);
    const missing = await agent.patch('/api/v1/admin/teachers/does-not-exist/status').send({ status: 'disabled' });
    expect(missing.status).toBe(404);
  });
});

describe('admin actions: backup 后台任务（真实 db-backup 子进程）', () => {
  const teacherDbName = `teacher_db_act_${suffix}`;
  let backupRoot: string;
  let backupJobId: string;
  let teacherId: string;
  let teacherDb: string;

  beforeAll(async () => {
    backupRoot = await mkdtemp(join(tmpdir(), 'tp-admin-act-'));
    teacherDb = teacherDbName;
    // ops db-backup 对非 teacher_db_ 前缀库名（如默认 teacher_platform）会 SAFETY_BLOCK——
    // 先清理本文件前序测试创建的默认库名教师（SessionStore FK 先行）+ 历史遗留 teacher_db_* 库
    await prisma.sessionStore.deleteMany({});
    await prisma.teacherRegistry.deleteMany({ where: { databaseName: { not: { startsWith: 'teacher_db_' } } } });
    purgeLeftoverTeacherDbs();
    await createIsolatedDb(teacherDb);
    const teacher = await seedTeacher(`act-${suffix}@example.com`, teacherDb);
    teacherId = teacher.id;
  }, 60_000);

  afterAll(async () => {
    // R4 纪律：建库必有对应 drop（含失败路径——afterAll 无条件执行）
    if (teacherDb) await dropIsolatedDb(teacherDb);
    if (backupRoot) await rm(backupRoot, { recursive: true, force: true });
  });

  it('缺 confirm → 400（QA5 备份类二次确认）', async () => {
    const app = createAdminApp({ backupRoot });
    const agent = await loginAgent(app);
    const res = await agent.post('/api/v1/admin/backup').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('confirm');
  });

  it('backup 全流程：202 jobId → 轮询 succeeded → MANIFEST 产物；jobId 不存在 → 404', async () => {
    const app = createAdminApp({ backupRoot });
    const agent = await loginAgent(app);

    const start = await agent.post('/api/v1/admin/backup?confirm=1').send({ teacherId });
    expect(start.status).toBe(202);
    backupJobId = start.body.data.jobId;
    expect(backupJobId).toMatch(/^adminjob_/);

    // 轮询：pending/running → succeeded
    const terminal = await pollJob(agent, backupJobId);
    expect(terminal.status).toBe('succeeded');
    expect((terminal.result as { tool?: string }).tool).toBe('db-backup');

    // MANIFEST 产物断言（真实 db-backup 写入）
    const { readdir } = await import('node:fs/promises');
    const dailyFiles = await readdir(join(backupRoot, 'daily'));
    expect(dailyFiles.some((file) => /^MANIFEST-.*\.json$/.test(file))).toBe(true);

    // QA5 契约：jobId 不存在 → 404
    const missing = await agent.get('/api/v1/admin/backup/status').query({ jobId: 'adminjob_nonexistent' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  }, 180_000);
});

describe('admin actions: restore 演练（真实 db-restore 子进程）', () => {
  let backupRoot: string;
  let teacherId: string;
  let teacherDb: string;
  let restoreTarget: string;

  beforeAll(async () => {
    backupRoot = await mkdtemp(join(tmpdir(), 'tp-admin-rest-'));
    teacherDb = `teacher_db_rst_${suffix}`;
    // 同上：清理默认库名教师 + 历史遗留 teacher_db_* 库，保证备份枚举干净
    await prisma.sessionStore.deleteMany({});
    await prisma.teacherRegistry.deleteMany({ where: { databaseName: { not: { startsWith: 'teacher_db_' } } } });
    purgeLeftoverTeacherDbs();
    await createIsolatedDb(teacherDb);
    const teacher = await seedTeacher(`rst-${suffix}@example.com`, teacherDb);
    teacherId = teacher.id;
    restoreTarget = `teacher_db_rst_${suffix}_restore_${randomBytes(4).toString('hex')}`;

    // 真实 dump 造数：ops db-backup 硬编码共享库名 teacher_platform（隔离测试库名随机不匹配），
    // 这里用真实 pg_dump 对该教师库产 dump + 手工 MANIFEST，restore 演练链路（db-restore 子进程）仍全真
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { spawnSync } = await import('node:child_process');
    await mkdir(join(backupRoot, 'daily'), { recursive: true });
    const runId = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}T${new Date().toISOString().slice(11, 19).replaceAll(':', '')}`;
    const dumpFile = `${teacherDb}_${runId}.dump`;
    const teacherDbUrl = withDatabase(baseUrl, teacherDb).toString().split('?')[0];
    const pgBin = process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\17\\bin' : '';
    const dump = spawnSync('pg_dump', ['-Fc', '-Z', '9', '-f', join(backupRoot, 'daily', dumpFile), '-d', teacherDbUrl], {
      env: { ...process.env, PATH: pgBin ? `${pgBin};${process.env.PATH ?? ''}` : process.env.PATH },
      encoding: 'utf8',
    });
    if (dump.status !== 0) {
      throw new Error(`pg_dump 失败：${dump.stderr ?? 'no stderr'}`);
    }
    const dumpSha256 = createHash('sha256')
      .update(await readFile(join(backupRoot, 'daily', dumpFile)))
      .digest('hex');
    await writeFile(
      join(backupRoot, 'daily', `MANIFEST-${runId}.json`),
      JSON.stringify({
        runId,
        databases: [{ name: teacherDb, file: dumpFile, sha256: dumpSha256, status: 'ok' }],
      }),
    );
  }, 120_000);

  afterAll(async () => {
    if (backupRoot) await rm(backupRoot, { recursive: true, force: true });
    if (restoreTarget) await dropIsolatedDb(restoreTarget);
    if (teacherDb) await dropIsolatedDb(teacherDb);
  }, 60_000);

  it('目标校验跨通道一致性：镜像 isSafeRestoreTarget === ops assertSafeRestoreDatabaseName（反例集）', () => {
    const counterexamples = [
      'teacher_platform',
      'teacher_db_abc',
      'teacher_db_a_restore_x',
      'teacher_platform_restore_x',
      'teacher_db_a_restore_',
      '../../evil',
      'Teacher_DB_A_RESTORE_X',
      'teacher_db_a_restore_x!',
      'teacher_platform_restore',
      'teacher_db_a_restore_x_restore_y',
      'postgres',
      '',
    ];
    for (const name of counterexamples) {
      let opsOk = true;
      try {
        assertSafeRestoreDatabaseName(name);
      } catch {
        opsOk = false;
      }
      expect({ name, opsOk, mirrorOk: isSafeRestoreTarget(name) }).toEqual({ name, opsOk, mirrorOk: opsOk });
    }
  });

  it('无 confirm → 400（message 含确认）；非法目标 → 400', async () => {
    const app = createAdminApp({ backupRoot });
    const agent = await loginAgent(app);
    const noConfirm = await agent.post('/api/v1/admin/restore').send({ teacherId, target: restoreTarget });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error.message).toContain('确认');

    const badTarget = await agent
      .post('/api/v1/admin/restore?confirm=1')
      .send({ teacherId, target: 'teacher_platform' });
    expect(badTarget.status).toBe(400);
    expect(badTarget.body.error.message).toContain('teacher_db_*_restore_*');
  });

  it('真实演练恢复：dump → 恢复库创建 → 轮询 succeeded', async () => {
    const app = createAdminApp({ backupRoot });
    const agent = await loginAgent(app);
    const res = await agent
      .post('/api/v1/admin/restore?confirm=1')
      .send({ teacherId, target: restoreTarget });
    expect(res.status).toBe(202);
    const terminal = await pollJob(agent, res.body.data.jobId, 180_000);
    expect(terminal.status).toBe('succeeded');
    // 演练库存在（db-restore drill 分支保留供检查）
    expect(databaseExists(restoreTarget)).toBe(true);
  }, 240_000);
});

describe('admin actions: provision 后台任务', () => {
  it('T-014 不在 Web 请求中建库，旧 endpoint 不可用', async () => {
    const app = createAdminApp();
    const agent = await loginAgent(app);
    const res = await agent
      .post('/api/v1/admin/teachers?provision=1')
      .send({ email: `prov-${suffix}@example.com`, password: 'prov-pass-123', displayName: '建库测试' });
    expect(res.status).toBe(404);
  });
});
