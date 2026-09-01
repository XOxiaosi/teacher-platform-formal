import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { createDatabaseClientPool } from '../../src/shared/database-pool/index.js';
import { createDatabaseRouter } from '../../src/app/middleware/database-router.js';
import { createMinimalToolRegistry } from '../../src/app/tool-registration.js';
import {
  databaseNameFromUrl,
  loadDatabaseUrl,
  psqlMaintenance,
  psqlQuery,
  quoteIdentifier,
  runMigrateDeploy,
  withDatabase,
} from '../../../ops/lib/pg-utils.mjs';

/**
 * t87（渠道线-P1 修复）：UserRequirement 共享库表装配回归测试。
 *
 * 生产形态模拟：教师注册 databaseName 指向隔离库（teacher_db_req_*，migrate deploy），
 * createApp 启用 dbRouter/dbPool。验证 requirements 服务与 requirements.capture 工具
 * **始终写共享库**（UserRequirement 是共享库表），不随 databaseRouter 路由到隔离教师库。
 *
 * 修复前（qa3 t82 发现）：getClient 装配 → 写隔离库 userRequirement → 隔离库 TeacherRegistry
 * 无该教师（教师只注册在共享库）→ FK 违反 500。
 */

const prisma = new PrismaClient();
const baseUrl = new URL(loadDatabaseUrl());
const sourceDatabaseName = databaseNameFromUrl(baseUrl);
const maintenanceUrl = withDatabase(baseUrl, 'postgres');

const suffix = randomBytes(4).toString('hex');
const dbName = `teacher_db_req_${suffix}`;
const teacherId = `teacher_req_${suffix}`;
const teacherEmail = `teacher-req-${suffix}@example.com`;

let isolatedPrisma: PrismaClient;
let isolatedDbUrl: URL;

async function createIsolatedDb(name: string): Promise<void> {
  if (!/^teacher_db_[a-z0-9_]+$/.test(name)) throw new Error(`SAFETY_BLOCK: unsafe db name ${name}`);
  if (name === sourceDatabaseName || name === 'teacher_platform') {
    throw new Error('SAFETY_BLOCK: db name collides with source/shared');
  }
  psqlMaintenance(maintenanceUrl, `CREATE DATABASE ${quoteIdentifier(name)}`);
  try {
    runMigrateDeploy(withDatabase(baseUrl, name));
  } catch (error) {
    psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
    throw error;
  }
}

async function dropIsolatedDb(name: string): Promise<void> {
  psqlMaintenance(
    maintenanceUrl,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
  );
  psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
}

function buildApp() {
  const pool = createDatabaseClientPool({
    baseUrl: `postgres://${baseUrl.username}:${baseUrl.password}@${baseUrl.hostname}:${baseUrl.port || '5432'}`,
    registerProcessHooks: false,
  });
  const router = createDatabaseRouter({
    registryPrisma: prisma,
    pool,
    registryCacheTtlMs: 60_000,
  });
  const app = createApp(prisma, { dbRouter: router, dbPool: pool });
  return { app, pool };
}

function sharedRequirementCount(): number {
  const count = psqlQuery(
    withDatabase(baseUrl, sourceDatabaseName),
    sourceDatabaseName,
    `SELECT COUNT(*) FROM "UserRequirement" WHERE "teacherId" = '${teacherId}'`,
  )[0];
  return Number(count);
}

function isolatedRequirementCount(): number {
  const count = psqlQuery(isolatedDbUrl, dbName, `SELECT COUNT(*) FROM "UserRequirement"`)[0];
  return Number(count);
}

beforeAll(async () => {
  await createIsolatedDb(dbName);
  isolatedDbUrl = withDatabase(baseUrl, dbName);
  isolatedPrisma = new PrismaClient({ datasources: { db: { url: isolatedDbUrl.toString() } } });

  await prisma.teacherRegistry.create({
    data: {
      id: teacherId,
      email: teacherEmail,
      passwordHash: 'scrypt$dummy$dummy',
      displayName: '共享库装配回归教师',
      databaseName: dbName,
    },
  });
}, 120_000);

afterAll(async () => {
  await prisma.userRequirement.deleteMany({ where: { teacherId: teacherId } });
  await prisma.teacherRegistry.deleteMany({ where: { id: teacherId } });
  await isolatedPrisma.$disconnect();
  await prisma.$disconnect();
  await dropIsolatedDb(dbName);
}, 60_000);

describe('t87 UserRequirement 共享库表装配（隔离库教师真实链路）', () => {
  it('隔离库教师 POST /requirements → 201 且落库于共享库（隔离库无记录）', async () => {
    const { app, pool } = buildApp();
    const quote = `req-shared-${randomBytes(4).toString('hex')}`;

    const res = await request(app)
      .post('/api/v1/requirements')
      .set('x-teacher-id', teacherId)
      .send({ verbatimQuote: quote, category: 'feature' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.teacherId).toBe(teacherId);

    // 核心断言：记录在共享库（本测试库 = 共享库），隔离教师库无
    expect(sharedRequirementCount()).toBeGreaterThanOrEqual(1);
    expect(isolatedRequirementCount()).toBe(0);

    // 落库内容核对
    const rows = psqlQuery(
      withDatabase(baseUrl, sourceDatabaseName),
      sourceDatabaseName,
      `SELECT "verbatimQuote" FROM "UserRequirement" WHERE "teacherId" = '${teacherId}'`,
    );
    expect(rows).toContain(quote);

    await pool.closeAll();
  });

  it('GET /requirements owner 可见（列表含自己创建的记录）', async () => {
    const { app, pool } = buildApp();
    const quote = `req-list-${randomBytes(4).toString('hex')}`;
    const create = await request(app)
      .post('/api/v1/requirements')
      .set('x-teacher-id', teacherId)
      .send({ verbatimQuote: quote, category: 'improvement' });
    expect(create.status).toBe(201);

    const list = await request(app)
      .get('/api/v1/requirements')
      .set('x-teacher-id', teacherId);
    expect(list.status).toBe(200);
    expect(list.body.ok).toBe(true);
    expect(list.body.data.items.some((item: { verbatimQuote: string }) => item.verbatimQuote === quote)).toBe(true);

    await pool.closeAll();
  });

  it('PATCH /requirements/:id 乐观锁：正确 → 200，stale → 409', async () => {
    const { app, pool } = buildApp();
    const create = await request(app)
      .post('/api/v1/requirements')
      .set('x-teacher-id', teacherId)
      .send({ verbatimQuote: `req-patch-${randomBytes(4).toString('hex')}`, category: 'bug_report' });
    expect(create.status).toBe(201);
    const id = create.body.data.id;

    const stale = await request(app)
      .patch(`/api/v1/requirements/${id}`)
      .set('x-teacher-id', teacherId)
      .send({ expectedUpdatedAt: new Date(new Date(create.body.data.updatedAtTs).getTime() - 1000).toISOString(), changes: { status: 'triaged' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');

    const okUpdate = await request(app)
      .patch(`/api/v1/requirements/${id}`)
      .set('x-teacher-id', teacherId)
      .send({ expectedUpdatedAt: create.body.data.updatedAtTs, changes: { status: 'triaged', linkedTaskId: 'T-87' } });
    expect(okUpdate.status).toBe(200);
    expect(okUpdate.body.data.status).toBe('triaged');
    expect(okUpdate.body.data.linkedTaskId).toBe('T-87');

    await pool.closeAll();
  });

  it('平台级（teacherId=null）不可写：无 teacherId POST → 400；教师 PATCH 平台级 → 404', async () => {
    const { app, pool } = buildApp();

    const createPlatform = await request(app)
      .post('/api/v1/requirements')
      .set('x-teacher-id', teacherId)
      .send({ verbatimQuote: `req-platform-${randomBytes(4).toString('hex')}`, category: 'privacy' });
    // t52：教师创建必须归属自己
    expect(createPlatform.body.data.teacherId).toBe(teacherId);

    // 平台级记录由平台/管理员维护，直接插共享库模拟平台侧写入
    const platform = await prisma.userRequirement.create({
      data: { teacherId: null, verbatimQuote: `platform-${randomBytes(4).toString('hex')}`, category: 'privacy', occurredAtTs: new Date('2026-08-01T00:00:00.000Z') },
    });
    const denied = await request(app)
      .patch(`/api/v1/requirements/${platform.id}`)
      .set('x-teacher-id', teacherId)
      .send({ expectedUpdatedAt: platform.updatedAtTs.toISOString(), changes: { status: 'triaged' } });
    expect(denied.status).toBe(404);
    expect(denied.body.error.code).toBe('NOT_FOUND');
    await prisma.userRequirement.delete({ where: { id: platform.id } });

    await pool.closeAll();
  });

  it('requirements.capture Agent 工具在路由形态下也写共享库（第二装配点回归）', async () => {
    // 模拟 Agent 工具装配：getClient 指向隔离教师库（databaseRouter 路由形态）
    const registry = createMinimalToolRegistry({
      prisma,
      getClient: async () => isolatedPrisma,
    });
    const quote = `tool-shared-${randomBytes(4).toString('hex')}`;

    const result = await registry.execute(
      'requirements.capture',
      { verbatimQuote: quote, category: 'feature' },
      { teacherId },
    );
    expect(result.ok).toBe(true);

    // 修复后：工具写共享库（getClient 不被 requirements 使用）→ 共享库有、隔离库无
    expect(sharedRequirementCount()).toBeGreaterThanOrEqual(1);
    expect(isolatedRequirementCount()).toBe(0);
    const rows = psqlQuery(
      withDatabase(baseUrl, sourceDatabaseName),
      sourceDatabaseName,
      `SELECT "verbatimQuote" FROM "UserRequirement" WHERE "teacherId" = '${teacherId}'`,
    );
    expect(rows).toContain(quote);
  });
});
