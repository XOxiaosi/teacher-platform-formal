import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';import { createAuthRouter } from '../../../src/app/routes/auth.routes.js';
import { createAuthService } from '../../../src/features/auth/index.js';
import { createPrivacyRouter } from '../../../src/app/routes/privacy.routes.js';
import { createDatabaseTrustedClock } from '../../../src/shared/trusted-clock/index.js';
import { acceptInvitation } from '../../helpers/invitations.js';
import { createSlidingWindowLimiter } from '../../../src/app/middleware/rate-limit.js';
import type { Logger } from '../../../src/shared/logger/index.js';
import {
  databaseNameFromUrl,
  loadDatabaseUrl,
  psqlMaintenance,
  psqlQuery,
  quoteIdentifier,
  quoteLiteral,
  runMigrateDeploy,
  withDatabase,
} from '../../../../ops/lib/pg-utils.mjs';

/**
 * P8 隐私自助化 API（t29）单测：
 * - POST /api/v1/privacy/export → 202 jobId → GET /export/status 轮询 succeeded → GET /export/download
 *   （manifest/account/tables JSON 附件，下载后清理导出目录及空父目录 exports/<teacherId>，P12 t4）；jobId 不存在 404；owner 隔离（他人 404）；未认证 401
 * - POST /api/v1/privacy/deactivate：邮箱错/密码错/confirm 错 → 400（不 spawn）；confirm=固定短语通过；
 *   成功后演练库 DROP + 真实共享库注册行删除 + 会话失效（登录 401）；未认证 401
 * - 限流（注销更严）：窗口上限 → 429 RATE_LIMITED + Retry-After；审计：结构化日志 actor=teacher
 *
 * 拓扑（与 admin-actions 备份测试同）：spawn 的 ops 脚本连本地真实 teacher_platform（共享库）与
 * teacher_db_*（隔离教师库）；API 侧 prisma 连隔离测试库（会话/登录断言用）。
 * 关键：会话教师 id（隔离库注册产生）必须与真实共享库 TeacherRegistry 行 id 一致——
 * 每场景注册后按返回 id 建真实演练库 + 真实注册行，afterAll 清理。
 */

const prisma = new PrismaClient();
const baseUrl = new URL(loadDatabaseUrl());
const sourceDatabaseName = databaseNameFromUrl(baseUrl);
const maintenanceUrl = withDatabase(baseUrl, 'postgres');

const PASSWORD = 'privacy-pass-123';
const suffix = randomBytes(4).toString('hex');

let exportRoot: string;
const createdTeacherDb: string[] = [];
const realRegistryIds: string[] = [];

function mockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function buildApp(options: {
  logger?: Logger;
  limiter?: ReturnType<typeof createSlidingWindowLimiter>;
  rateLimitConfig?: Parameters<typeof createPrivacyRouter>[0]['rateLimitConfig'];
  confirmPhrase?: string;
} = {}) {
  const authService = createAuthService({ prisma, clock: createDatabaseTrustedClock(prisma) });
  const privacyRouter = createPrivacyRouter({
    authService,
    registryPrisma: prisma,
    logger: options.logger,
    limiter: options.limiter,
    rateLimitConfig: options.rateLimitConfig,
    confirmPhrase: options.confirmPhrase,
    exportRoot,
    spawnCwd: process.cwd(), // npm -w 自动上溯 monorepo 根（与 admin 同）
  });
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createAuthRouter(authService));
  app.use('/api/v1', privacyRouter);
  return app;
}

/** 注册教师（隔离库会话）→ 返回 {cookie, teacherId}。 */
async function registerAndCookie(app: ReturnType<typeof buildApp>, email: string): Promise<{ cookie: string; teacherId: string }> {
  const { response: res } = await acceptInvitation(app, prisma, {
    email,
    password: PASSWORD,
    displayName: '隐私测试',
  });
  expect(res.status).toBe(201);
  return {
    cookie: res.headers['set-cookie'][0].split(';')[0],
    teacherId: res.body.data.teacher.id,
  };
}

/** 建真实演练教师库（teacher_db_priv_*）+ migrate，并登记真实共享库 TeacherRegistry 行（id 与会话一致）。 */
function createDrillTeacherDb(teacherId: string, email: string, tag: string): string {
  const dbName = `teacher_db_priv_${tag}_${suffix}`;
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
  createdTeacherDb.push(dbName);
  // 真实共享库注册（ops 脚本读取；passwordHash 占位即可，脚本只读公开字段）
  psqlQuery(
    baseUrl,
    'teacher_platform',
    `INSERT INTO "TeacherRegistry" ("id","email","passwordHash","displayName","status","databaseName","createdAtTs","updatedAtTs")
     VALUES (${quoteLiteral(teacherId)}, ${quoteLiteral(email)}, 'scrypt:TEST', ${quoteLiteral(teacherId)}, 'active',
             ${quoteLiteral(dbName)}, now(), now())`,
  );
  realRegistryIds.push(teacherId);
  return dbName;
}

function dropIsolatedDb(dbName: string): void {
  psqlMaintenance(
    maintenanceUrl,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
  );
  psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)}`);
}

function teacherDbExists(dbName: string): boolean {
  const rows = psqlMaintenance(maintenanceUrl, `SELECT 1 FROM pg_database WHERE datname = '${dbName}'`);
  return Array.isArray(rows) && rows.length > 0;
}

function registryRowExists(teacherId: string): boolean {
  const rows = psqlQuery(
    baseUrl,
    'teacher_platform',
    `SELECT "id" FROM "TeacherRegistry" WHERE "id" = ${quoteLiteral(teacherId)}`,
  );
  return rows.length > 0;
}

async function pollJob(app: ReturnType<typeof buildApp>, cookie: string, jobId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last: { status: string; result?: unknown; error?: string } = { status: 'pending' };
  while (Date.now() < deadline) {
    const res = await request(app).get('/api/v1/privacy/export/status').query({ jobId }).set('Cookie', cookie);
    expect(res.status).toBe(200);
    last = res.body.data;
    if (last.status === 'succeeded' || last.status === 'failed') return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`job 未在 ${timeoutMs}ms 内终态：${JSON.stringify(last)}`);
}

beforeAll(async () => {
  exportRoot = await mkdtemp(join(tmpdir(), 'tp-privacy-'));
});

afterAll(async () => {
  for (const dbName of createdTeacherDb) dropIsolatedDb(dbName);
  if (realRegistryIds.length > 0) {
    const ids = realRegistryIds.map((id) => quoteLiteral(id)).join(', ');
    psqlQuery(baseUrl, 'teacher_platform', `DELETE FROM "TeacherRegistry" WHERE "id" IN (${ids})`);
  }
  if (exportRoot) await rm(exportRoot, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe('privacy export：jobId 轮询全流程（演练教师）', () => {
  it('POST /export → 202 jobId → 轮询 succeeded → download 返回 manifest/account/tables，下载后清理', async () => {
    const logger = mockLogger();
    const app = buildApp({ logger });
    const email = `priv-exp-${randomBytes(4).toString('hex')}@example.com`;
    const { cookie, teacherId } = await registerAndCookie(app, email);
    createDrillTeacherDb(teacherId, email, 'exp');
    psqlQuery(
      baseUrl,
      `teacher_db_priv_exp_${suffix}`,
      `INSERT INTO "Student" ("id","teacherId","name","grade","currentStatus","createdAtTs","updatedAtTs")
       VALUES ('priv_s1','${teacherId}','Privacy Export A','grade-1','active',now(),now()),
              ('priv_s2','${teacherId}','Privacy Export B','grade-2','active',now(),now())`,
    );

    // 未认证 → 401
    const unauth = await request(app).post('/api/v1/privacy/export');
    expect(unauth.status).toBe(401);

    const start = await request(app).post('/api/v1/privacy/export').set('Cookie', cookie);
    expect(start.status).toBe(202);
    const jobId = start.body.data.jobId;
    expect(jobId).toMatch(/^job_/);

    const terminal = await pollJob(app, cookie, jobId);
    expect(terminal.status, terminal.error).toBe('succeeded');
    expect((terminal.result as { tool?: string }).tool).toBe('export-teacher-data');

    // download：认证 + owner 匹配 → JSON 附件（manifest/account/tables）
    const download = await request(app).get('/api/v1/privacy/export/download').query({ jobId }).set('Cookie', cookie);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    const data = download.body.data as { manifest: { teacherId: string | null }; account: { email: string }; tables: Record<string, unknown[]> };
    expect(data.manifest.teacherId).toBe(teacherId);
    expect(data.account.email).toBe(email);
    expect(data.tables.student).toHaveLength(2);
    expect((data.tables.student[0] as { name: string }).name).toBe('Privacy Export A');

    // 下载后导出目录已清理（一次性产物）
    const exportDir = resolve(exportRoot, 'exports', teacherId, jobId);
    await expect(stat(exportDir)).rejects.toThrow();
    // P12 t4 修复：下载后空父目录 exports/<teacherId> 一并清理（不残留）
    const teacherExportDir = resolve(exportRoot, 'exports', teacherId);
    await expect(stat(teacherExportDir)).rejects.toThrow();

    // 审计：privacy.export.run + privacy.export.download（actor=teacher）
    const infos = logger.info as ReturnType<typeof vi.fn>;
    const runAudit = infos.mock.calls.find((call: unknown[]) => call[0] === 'privacy action' && call[1]?.action === 'privacy.export.run');
    expect(runAudit).toBeDefined();
    expect(runAudit![1]).toMatchObject({ actor: teacherId, action: 'privacy.export.run' });
    const dlAudit = infos.mock.calls.find((call: unknown[]) => call[0] === 'privacy action' && call[1]?.action === 'privacy.export.download');
    expect(dlAudit).toBeDefined();
  }, 180_000);

  it('format=zip：下载返回 application/zip（Content-Disposition export-<id>.zip），内容含 manifest/tables/media，下载后清理', async () => {
    const app = buildApp();
    const email = `priv-zip-${randomBytes(4).toString('hex')}@example.com`;
    const { cookie, teacherId } = await registerAndCookie(app, email);
    createDrillTeacherDb(teacherId, email, 'zip');
    psqlQuery(
      baseUrl,
      `teacher_db_priv_zip_${suffix}`,
      `INSERT INTO "Student" ("id","teacherId","name","grade","currentStatus","createdAtTs","updatedAtTs")
       VALUES ('zip_s1','${teacherId}','Zip Student A','grade-1','active',now(),now())`,
    );

    // format=zip 发起导出（body.format 走 zip 单包路径）
    const start = await request(app)
      .post('/api/v1/privacy/export')
      .set('Cookie', cookie)
      .send({ format: 'zip' });
    expect(start.status).toBe(202);
    const jobId = start.body.data.jobId;

    const terminal = await pollJob(app, cookie, jobId);
    expect(terminal.status, terminal.error).toBe('succeeded');
    expect((terminal.result as { tool?: string }).tool).toBe('export-teacher-data');
    // 结果含 zip 产物路径（export-teacher-data --zip 输出）
    expect((terminal.result as { zip?: string }).zip).toBeTruthy();

    // download → application/zip + Content-Disposition export-<teacherId>.zip
    const download = await request(app)
      .get('/api/v1/privacy/export/download')
      .query({ jobId })
      .set('Cookie', cookie)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/zip');
    expect(download.headers['content-disposition']).toContain(`export-${teacherId}.zip`);
    expect(download.headers['content-disposition']).toContain('attachment');
    const zipBuffer = download.body as Buffer;
    // PK\x03\x04 ZIP 魔数
    expect(zipBuffer.readUInt32LE(0)).toBe(0x04034b50);
    // EOCD PK\x05\x06
    expect(zipBuffer.readUInt32LE(zipBuffer.length - 22)).toBe(0x06054b50);
    expect(zipBuffer.length).toBeGreaterThan(200);

    // 下载后清理：导出目录 + zip 文件均删除（一次性产物）——清理在响应 flush 后异步执行，
    // 轮询等待（生产 TTL sweep 兜底；此处验证最终清理，非严格同步时序）
    const exportDir = resolve(exportRoot, 'exports', teacherId, jobId);
    const gone = async (p: string) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          await stat(p);
        } catch {
          return true;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
      }
      return false;
    };
    expect(await gone(exportDir)).toBe(true);
    expect(await gone(`${exportDir}.zip`)).toBe(true);
  }, 180_000);

  it('jobId 不存在 → 404；未完成下载 → 400', async () => {    const app = buildApp();
    const email = `priv-exp2-${randomBytes(4).toString('hex')}@example.com`;
    const { cookie } = await registerAndCookie(app, email);

    const missing = await request(app).get('/api/v1/privacy/export/status').query({ jobId: 'job_nonexistent' }).set('Cookie', cookie);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');

    const start = await request(app).post('/api/v1/privacy/export').set('Cookie', cookie);
    expect(start.status).toBe(202);
    const jobId = start.body.data.jobId;
    const early = await request(app).get('/api/v1/privacy/export/download').query({ jobId }).set('Cookie', cookie);
    expect(early.status).toBe(400);
  }, 180_000);

  it('owner 隔离：他人读状态/下载 → 404（不泄露存在性）；未认证 401', async () => {
    const app = buildApp();
    const ownerEmail = `priv-owner-${randomBytes(4).toString('hex')}@example.com`;
    const otherEmail = `priv-other-${randomBytes(4).toString('hex')}@example.com`;
    const owner = await registerAndCookie(app, ownerEmail);
    const other = await registerAndCookie(app, otherEmail);

    const start = await request(app).post('/api/v1/privacy/export').set('Cookie', owner.cookie);
    expect(start.status).toBe(202);
    const jobId = start.body.data.jobId;

    const crossedStatus = await request(app).get('/api/v1/privacy/export/status').query({ jobId }).set('Cookie', other.cookie);
    expect(crossedStatus.status).toBe(404);
    const crossedDownload = await request(app).get('/api/v1/privacy/export/download').query({ jobId }).set('Cookie', other.cookie);
    expect(crossedDownload.status).toBe(404);

    const unauthStatus = await request(app).get('/api/v1/privacy/export/status').query({ jobId });
    expect(unauthStatus.status).toBe(401);
  }, 180_000);
});

describe('privacy deactivate：邮箱/密码/confirm 双验证 + 会话失效', () => {
  it('邮箱错 / 密码错 / confirm 错 / 缺字段 → 400（不 spawn 注销）；失败审计 actor=teacher', async () => {
    const logger = mockLogger();
    const app = buildApp({ logger });
    const email = `priv-deact-bad-${randomBytes(4).toString('hex')}@example.com`;
    const { cookie, teacherId } = await registerAndCookie(app, email);

    const badEmail = await request(app)
      .post('/api/v1/privacy/deactivate')
      .set('Cookie', cookie)
      .send({ email: `wrong-${email}`, password: PASSWORD, confirm: email });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.error.field).toBe('email');

    const badPassword = await request(app)
      .post('/api/v1/privacy/deactivate')
      .set('Cookie', cookie)
      .send({ email, password: 'wrong-password-999', confirm: email });
    expect(badPassword.status).toBe(400);
    expect(badPassword.body.error.field).toBe('password');

    const badConfirm = await request(app)
      .post('/api/v1/privacy/deactivate')
      .set('Cookie', cookie)
      .send({ email, password: PASSWORD, confirm: 'NOT-THE-CONFIRM' });
    expect(badConfirm.status).toBe(400);
    expect(badConfirm.body.error.field).toBe('confirm');

    const missing = await request(app).post('/api/v1/privacy/deactivate').set('Cookie', cookie).send({ email });
    expect(missing.status).toBe(400);

    // 失败审计：privacy.deactivate.failed（actor=teacher）
    const infos = logger.info as ReturnType<typeof vi.fn>;
    const failAudit = infos.mock.calls.find((call: unknown[]) => call[0] === 'privacy action' && call[1]?.action === 'privacy.deactivate.failed');
    expect(failAudit).toBeDefined();
    expect(failAudit![1]).toMatchObject({ actor: teacherId, action: 'privacy.deactivate.failed' });
  });

  it('未认证 → 401（confirm=固定短语仅验证门禁接受，不触达 spawn）', async () => {
    const app = buildApp({ confirmPhrase: 'DELETE-ME' });
    const email = `priv-deact-unauth-${randomBytes(4).toString('hex')}@example.com`;
    const res = await request(app)
      .post('/api/v1/privacy/deactivate')
      .send({ email, password: PASSWORD, confirm: 'DELETE-ME' });
    expect(res.status).toBe(401);
  });

  it('注销成功（confirm=邮箱）：演练库 DROP + 真实共享库注册行删除 + 会话失效（登录 401）', async () => {
    const logger = mockLogger();
    const app = buildApp({ logger });
    const email = `priv-deact-ok-${randomBytes(4).toString('hex')}@example.com`;
    const { cookie, teacherId } = await registerAndCookie(app, email);
    const deactDb = createDrillTeacherDb(teacherId, email, 'deact');
    expect(registryRowExists(teacherId)).toBe(true);

    const result = await request(app)
      .post('/api/v1/privacy/deactivate')
      .set('Cookie', cookie)
      .send({ email, password: PASSWORD, confirm: email });
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ status: 'succeeded' });
    expect((result.body.data.result as { tool?: string }).tool).toBe('deactivate-teacher');

    // 演练库已 DROP（ops 脚本删除）
    expect(teacherDbExists(deactDb)).toBe(false);
    // 真实共享库注册行已删（ops 脚本删除）
    expect(registryRowExists(teacherId)).toBe(false);

    // 会话失效：登录 → 401（TeacherRegistry 已删 → 统一凭据错误）
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(401);

    // 审计：privacy.deactivate（actor=teacher）
    const infos = logger.info as ReturnType<typeof vi.fn>;
    const audit = infos.mock.calls.find((call: unknown[]) => call[0] === 'privacy action' && call[1]?.action === 'privacy.deactivate');
    expect(audit).toBeDefined();
    expect(audit![1]).toMatchObject({ actor: teacherId, action: 'privacy.deactivate' });
  }, 240_000);

  it('注销成功（confirm=固定短语）：门禁接受固定短语', async () => {
    const app = buildApp({ confirmPhrase: 'DELETE-ME' });
    const email = `priv-deact-phrase-${randomBytes(4).toString('hex')}@example.com`;
    const { cookie, teacherId } = await registerAndCookie(app, email);
    const deactDb = createDrillTeacherDb(teacherId, email, 'phrase');

    const result = await request(app)
      .post('/api/v1/privacy/deactivate')
      .set('Cookie', cookie)
      .send({ email, password: PASSWORD, confirm: 'DELETE-ME' });
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ status: 'succeeded' });
    expect(teacherDbExists(deactDb)).toBe(false);
    expect(registryRowExists(teacherId)).toBe(false);
  }, 240_000);
});

describe('privacy 限流（注销更严）', () => {
  it('注销窗口上限触发 → 429 RATE_LIMITED + Retry-After', async () => {
    const limiter = createSlidingWindowLimiter();
    const app = buildApp({
      limiter,
      rateLimitConfig: { deactivateWindowMs: 60_000, deactivateMax: 2 },
    });
    const email = `priv-rl-${randomBytes(4).toString('hex')}@example.com`;
    const { cookie } = await registerAndCookie(app, email);

    // 两次失败请求（邮箱不匹配 400）消耗限流额度
    for (let i = 0; i < 2; i += 1) {
      const res = await request(app)
        .post('/api/v1/privacy/deactivate')
        .set('Cookie', cookie)
        .send({ email: `wrong-${email}`, password: PASSWORD, confirm: email });
      expect(res.status).toBe(400);
    }

    const third = await request(app)
      .post('/api/v1/privacy/deactivate')
      .set('Cookie', cookie)
      .send({ email, password: PASSWORD, confirm: email });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
  });
});
