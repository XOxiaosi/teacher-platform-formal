import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { createDatabaseClientPool } from '../../src/shared/database-pool/index.js';
import { createDatabaseRouter } from '../../src/app/middleware/database-router.js';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';
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
 * P7 S5：db-routing e2e 隔离测试（设计 §6.1）。
 *
 * 双隔离教师库 teacher_db_a/teacher_db_b（各自 migrate deploy，安全前缀+随机后缀），
 * TeacherRegistry 两条记录分别指向二者；验证：
 * 1. A 库写学生 → B 库 SELECT 为空（物理隔离断言）
 * 2. 未注册 databaseName（库不存在）→ 明确 5xx「未就绪」语义
 * 3. 连接池复用：同 dbName 两次请求同一 client 实例
 * 4. 清理（dropdb --force + 安全前缀断言）
 */

const prisma = new PrismaClient();
const baseUrl = new URL(loadDatabaseUrl());
const sourceDatabaseName = databaseNameFromUrl(baseUrl);
const maintenanceUrl = withDatabase(baseUrl, 'postgres');

const suffixA = randomBytes(4).toString('hex');
const suffixB = randomBytes(4).toString('hex');
const dbA = `teacher_db_a_${suffixA}`;
const dbB = `teacher_db_b_${suffixB}`;

let teacherAId: string;
let teacherBId: string;
let teacherAEmail: string;
let teacherBEmail: string;

async function createIsolatedDb(dbName: string): Promise<void> {
  // 安全前缀断言（本地红线）
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

async function createTeacher(teacherId: string, email: string, databaseName: string): Promise<void> {
  await prisma.teacherRegistry.create({
    data: {
      id: teacherId,
      email,
      passwordHash: 'scrypt$dummy$dummy',
      displayName: '隔离测试教师',
      databaseName,
    },
  });
}

beforeAll(async () => {
  await createIsolatedDb(dbA);
  await createIsolatedDb(dbB);

  teacherAId = `teacher_a_${suffixA}`;
  teacherBId = `teacher_b_${suffixB}`;
  teacherAEmail = `teacher-a-${suffixA}@example.com`;
  teacherBEmail = `teacher-b-${suffixB}@example.com`;
  await createTeacher(teacherAId, teacherAEmail, dbA);
  await createTeacher(teacherBId, teacherBEmail, dbB);
});

afterAll(async () => {
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: [teacherAId, teacherBId] } } });
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: [teacherAId, teacherBId] } } });
  await prisma.$disconnect();
  await dropIsolatedDb(dbA);
  await dropIsolatedDb(dbB);
});

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
  const app = createApp(prisma, { rawPrisma: prisma, dbRouter: router, dbPool: pool });
  return { app, pool };
}

describe('db-routing e2e：双隔离教师库', () => {
  it('A 库写学生 → B 库 SELECT 为空（物理隔离）', async () => {
    const { app, pool } = buildApp();

    // A 教师（x-teacher-id dev fallback → requireAuth → databaseRouter 解析 dbA）
    const createRes = await request(app)
      .post('/api/v1/students')
      .set('x-teacher-id', teacherAId)
      .send({ name: '隔离学生A', grade: 'grade-1' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.ok).toBe(true);

    // B 库直接查：无此学生（隔离断言）
    const bCount = psqlQuery(withDatabase(baseUrl, dbB), dbB, 'SELECT COUNT(*) FROM "Student"')[0];
    expect(bCount).toBe('0');

    // A 库有 1 行
    const aCount = psqlQuery(withDatabase(baseUrl, dbA), dbA, 'SELECT COUNT(*) FROM "Student"')[0];
    expect(aCount).toBe('1');

    // 同 teacherId 第二次请求走同一 dbName（连接池复用由单测覆盖，此处验证请求仍成功）
    const listRes = await request(app)
      .get('/api/v1/students')
      .set('x-teacher-id', teacherAId);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.total).toBe(1);
    expect(listRes.body.data.items).toHaveLength(1);

    await pool.closeAll();
  });

  it('B 教师路由到 B 库：互不串库（双写隔离）', async () => {
    const { app, pool } = buildApp();

    const createB = await request(app)
      .post('/api/v1/students')
      .set('x-teacher-id', teacherBId)
      .send({ name: '隔离学生B', grade: 'grade-1' });
    expect(createB.status).toBe(201);

    // A 库仍只有 A 的学生；B 库有 B 的学生
    const aNames = psqlQuery(withDatabase(baseUrl, dbA), dbA, 'SELECT name FROM "Student" ORDER BY name');
    const bNames = psqlQuery(withDatabase(baseUrl, dbB), dbB, 'SELECT name FROM "Student" ORDER BY name');
    expect(aNames).toEqual(['隔离学生A']);
    expect(bNames).toEqual(['隔离学生B']);

    await pool.closeAll();
  });

  it('生产装配的六个编辑 API 只修改 databaseRouter 选中的教师库', async () => {
    const teacherPrisma = new PrismaClient({
      datasources: { db: { url: withDatabase(baseUrl, dbA).toString() } },
    });
    const { app, pool } = buildApp();
    const token = new Date('2000-01-01T00:00:00.000Z');
    const cipher = createFieldCipher(loadEncryptionKey().key);

    try {
      const student = await teacherPrisma.student.create({
        data: {
          teacherId: teacherAId,
          name: '编辑路由原学生',
          grade: '高一',
          updatedAtTs: token,
        },
      });
      const schedule = await teacherPrisma.schedule.create({
        data: {
          teacherId: teacherAId,
          studentId: student.id,
          type: 'lesson',
          title: '编辑路由原课程',
          scheduledStartTs: new Date('2030-09-20T01:00:00.000Z'),
          scheduledEndTs: new Date('2030-09-20T02:00:00.000Z'),
          updatedAtTs: token,
        },
      });
      const lesson = await teacherPrisma.lesson.create({
        data: {
          teacherId: teacherAId,
          studentId: student.id,
          scheduleId: schedule.id,
          dateTs: new Date('2030-09-20T01:00:00.000Z'),
          progress: '编辑路由原进度',
          updatedAtTs: token,
        },
      });
      const payment = await teacherPrisma.payment.create({
        data: {
          teacherId: teacherAId,
          studentId: student.id,
          amount: 1000,
          lessonCount: 8,
          paidAtTs: new Date('2030-09-01T00:00:00.000Z'),
          updatedAtTs: token,
        },
      });
      const memo = await teacherPrisma.memo.create({
        data: {
          teacherId: teacherAId,
          title: '编辑路由原备忘',
          content: '原内容',
          updatedAtTs: token,
        },
      });
      const feedback = await teacherPrisma.parentFeedback.create({
        data: {
          teacherId: teacherAId,
          studentId: student.id,
          lessonId: lesson.id,
          title: '编辑路由原反馈',
          content: '编辑路由原反馈内容',
          updatedAtTs: token,
        },
      });

      expect({
        sharedStudents: await prisma.student.count({ where: { id: student.id } }),
        sharedSchedules: await prisma.schedule.count({ where: { id: schedule.id } }),
        sharedLessons: await prisma.lesson.count({ where: { id: lesson.id } }),
        sharedPayments: await prisma.payment.count({ where: { id: payment.id } }),
        sharedMemos: await prisma.memo.count({ where: { id: memo.id } }),
        sharedFeedback: await prisma.parentFeedback.count({ where: { id: feedback.id } }),
        teacherStudents: await teacherPrisma.student.count({ where: { id: student.id } }),
        teacherSchedules: await teacherPrisma.schedule.count({ where: { id: schedule.id } }),
        teacherLessons: await teacherPrisma.lesson.count({ where: { id: lesson.id } }),
        teacherPayments: await teacherPrisma.payment.count({ where: { id: payment.id } }),
        teacherMemos: await teacherPrisma.memo.count({ where: { id: memo.id } }),
        teacherFeedback: await teacherPrisma.parentFeedback.count({ where: { id: feedback.id } }),
      }).toEqual({
        sharedStudents: 0,
        sharedSchedules: 0,
        sharedLessons: 0,
        sharedPayments: 0,
        sharedMemos: 0,
        sharedFeedback: 0,
        teacherStudents: 1,
        teacherSchedules: 1,
        teacherLessons: 1,
        teacherPayments: 1,
        teacherMemos: 1,
        teacherFeedback: 1,
      });

      const profile = await request(app)
        .patch(`/api/v1/students/${student.id}/profile`)
        .set('x-teacher-id', teacherAId)
        .send({
          expectedUpdatedAt: token.toISOString(),
          changes: { name: '编辑路由新学生' },
        });
      expect(profile.status).toBe(200);
      expect(profile.body.ok).toBe(true);

      const reschedule = await request(app)
        .post(`/api/v1/schedules/${schedule.id}/reschedule`)
        .set('x-teacher-id', teacherAId)
        .send({
          expectedUpdatedAt: token.toISOString(),
          replacement: {
            scheduledStart: '2030-09-21T01:00:00.000Z',
            scheduledEnd: '2030-09-21T02:00:00.000Z',
          },
        });
      expect(reschedule.status).toBe(200);
      expect(reschedule.body.ok).toBe(true);

      const record = await request(app)
        .patch(`/api/v1/lessons/${lesson.id}/record`)
        .set('x-teacher-id', teacherAId)
        .send({
          expectedUpdatedAt: token.toISOString(),
          changes: { progress: '编辑路由新进度' },
        });
      expect(record.status).toBe(200);
      expect(record.body.ok).toBe(true);

      const paymentEdit = await request(app)
        .patch(`/api/v1/payments/${payment.id}`)
        .set('x-teacher-id', teacherAId)
        .send({
          expectedUpdatedAt: token.toISOString(),
          changes: { note: '编辑路由新缴费备注' },
        });
      const memoEdit = await request(app)
        .patch(`/api/v1/memos/${memo.id}`)
        .set('x-teacher-id', teacherAId)
        .send({
          expectedUpdatedAt: token.toISOString(),
          changes: { title: '编辑路由新备忘' },
        });
      const feedbackEdit = await request(app)
        .patch(`/api/v1/feedback/${feedback.id}/content`)
        .set('x-teacher-id', teacherAId)
        .send({
          expectedUpdatedAt: token.toISOString(),
          changes: { content: '编辑路由新反馈内容' },
        });
      expect({
        payment: paymentEdit.status,
        memo: memoEdit.status,
        feedback: feedbackEdit.status,
      }).toEqual({ payment: 200, memo: 200, feedback: 200 });
      expect([paymentEdit.body.ok, memoEdit.body.ok, feedbackEdit.body.ok]).toEqual([true, true, true]);

      expect((await teacherPrisma.student.findUniqueOrThrow({ where: { id: student.id } })).name)
        .toBe('编辑路由新学生');
      expect((await teacherPrisma.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).status)
        .toBe('rescheduled');
      const storedLesson = await teacherPrisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } });
      expect(storedLesson.progress).not.toBe('编辑路由新进度');
      expect(cipher.decrypt(storedLesson.progress!)).toBe('编辑路由新进度');
      const storedPayment = await teacherPrisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(storedPayment.note).not.toBe('编辑路由新缴费备注');
      expect(cipher.decrypt(storedPayment.note!)).toBe('编辑路由新缴费备注');
      expect((await teacherPrisma.memo.findUniqueOrThrow({ where: { id: memo.id } })).title)
        .toBe('编辑路由新备忘');
      const storedFeedback = await teacherPrisma.parentFeedback.findUniqueOrThrow({
        where: { id: feedback.id },
      });
      expect(storedFeedback.content).not.toBe('编辑路由新反馈内容');
      expect(cipher.decrypt(storedFeedback.content)).toBe('编辑路由新反馈内容');
      expect(await teacherPrisma.changeLog.count({ where: { teacherId: teacherAId } })).toBe(7);

      expect({
        sharedStudents: await prisma.student.count({ where: { id: student.id } }),
        sharedSchedules: await prisma.schedule.count({ where: { id: schedule.id } }),
        sharedLessons: await prisma.lesson.count({ where: { id: lesson.id } }),
        sharedPayments: await prisma.payment.count({ where: { id: payment.id } }),
        sharedMemos: await prisma.memo.count({ where: { id: memo.id } }),
        sharedFeedback: await prisma.parentFeedback.count({ where: { id: feedback.id } }),
        sharedChangeLogs: await prisma.changeLog.count({ where: { teacherId: teacherAId } }),
      }).toEqual({
        sharedStudents: 0,
        sharedSchedules: 0,
        sharedLessons: 0,
        sharedPayments: 0,
        sharedMemos: 0,
        sharedFeedback: 0,
        sharedChangeLogs: 0,
      });
    } finally {
      await teacherPrisma.$disconnect();
      await pool.closeAll();
    }
  });

  it('未注册 databaseName（库不存在）→ 503「教师数据库未就绪」', async () => {
    const { app, pool } = buildApp();

    // TeacherRegistry 记录指向一个不存在的库
    const ghostTeacherId = `teacher_ghost_${suffixA}`;
    await prisma.teacherRegistry.create({
      data: {
        id: ghostTeacherId,
        email: `ghost-${suffixA}@example.com`,
        passwordHash: 'scrypt$dummy$dummy',
        displayName: '幽灵教师',
        databaseName: 'teacher_db_ghost_missing',
      },
    });

    try {
      const res = await request(app)
        .get('/api/v1/students')
        .set('x-teacher-id', ghostTeacherId);
      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe('DATABASE_NOT_READY');
    } finally {
      await prisma.teacherRegistry.delete({ where: { id: ghostTeacherId } });
    }
    await pool.closeAll();
  });

  it('未带 teacherId（无 cookie 无 x-teacher-id）→ 401（requireAuth 兜底）', async () => {
    const { app, pool } = buildApp();

    const res = await request(app).get('/api/v1/students');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);

    await pool.closeAll();
  });

  it('未知 teacherId（TeacherRegistry 查无）→ 404 NOT_FOUND', async () => {
    const { app, pool } = buildApp();

    const res = await request(app)
      .get('/api/v1/students')
      .set('x-teacher-id', 'teacher_definitely_unknown');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');

    await pool.closeAll();
  });
});
