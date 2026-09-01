import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';

/**
 * P0 修复回归：IDOR 水平越权（qa3 t11 真实验收实测）。
 *
 * 根因：api-helpers.getTeacherId 无条件读 x-teacher-id header → 持有效 session 的教师 B
 * 可伪造 x-teacher-id=A 以 A 身份读写。修复后身份唯一来源 = requireAuth 注入的 req.teacherId
 * （session），header 完全忽略。
 *
 * 断言：
 * 1. 写方向：B session + x-teacher-id=A → POST /feedback 落库 teacherId=B（A 名下无记录）；
 * 2. 读方向：B session + x-teacher-id=A → GET /feedback 不得返回 A 的反馈（防泄露）；
 * 3. dev fallback 兼容：无 session 仅 x-teacher-id（非生产 requireAuth fallback）仍注入身份
 *    （测试基线依赖，本文件验证不破坏）。
 */

const prisma = new PrismaClient();
const app = createApp(prisma);

const createdTeacherIds: string[] = [];
const createdStudentIds: string[] = [];
const createdFeedbackIds: string[] = [];

afterAll(async () => {
  await prisma.parentFeedback.deleteMany({ where: { id: { in: createdFeedbackIds } } });
  await prisma.student.deleteMany({ where: { id: { in: createdStudentIds } } });
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
});

async function registerTeacher(prefix: string): Promise<{ cookie: string; teacherId: string }> {
  const email = `${prefix}-${randomBytes(6).toString('hex')}@example.com`;
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: 'password123', displayName: prefix });
  expect(res.status).toBe(201);
  const teacherId = res.body.data.teacher.id;
  createdTeacherIds.push(teacherId);
  const cookie = res.headers['set-cookie'][0].split(';')[0];
  return { cookie, teacherId };
}

async function createStudent(cookie: string, name: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/students')
    .set('Cookie', cookie)
    .send({ name, grade: '高一' });
  expect(res.status).toBe(201);
  const id = res.body.data.id;
  createdStudentIds.push(id);
  return id;
}

async function createFeedback(cookie: string, studentId: string, title: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/feedback')
    .set('Cookie', cookie)
    .send({ studentId, title, content: '反馈内容' });
  expect(res.status).toBe(201);
  const id = res.body.data.id;
  createdFeedbackIds.push(id);
  return id;
}

describe('P0 IDOR 水平越权回归（x-teacher-id 已下线）', () => {
  it('写方向：B session + x-teacher-id=A → POST /feedback 落库 teacherId=B（A 名下无记录）', async () => {
    const teacherA = await registerTeacher('idor-write-a');
    const teacherB = await registerTeacher('idor-write-b');
    const studentB = await createStudent(teacherB.cookie, 'B 的学生');

    // B 持有效 session，伪造 x-teacher-id=A 创建反馈 → 身份必须来自 session（B）
    const res = await request(app)
      .post('/api/v1/feedback')
      .set('Cookie', teacherB.cookie)
      .set('x-teacher-id', teacherA.teacherId)
      .send({ studentId: studentB, title: '越权写测试反馈', content: '内容' });
    expect(res.status).toBe(201);
    expect(res.body.data.teacherId).toBe(teacherB.teacherId); // 响应身份 = B

    const row = await prisma.parentFeedback.findFirst({
      where: { id: res.body.data.id },
    });
    expect(row).not.toBeNull();
    expect(row!.teacherId).toBe(teacherB.teacherId); // 落库 teacherId=B，非伪造 A
    createdFeedbackIds.push(row!.id);

    // A 名下无该记录（水平越权未发生）
    const aOwned = await prisma.parentFeedback.findFirst({
      where: { id: row!.id, teacherId: teacherA.teacherId },
    });
    expect(aOwned).toBeNull();
  });

  it('读方向：B session + x-teacher-id=A → GET /feedback 不得返回 A 的反馈（防泄露）', async () => {
    const teacherA = await registerTeacher('idor-read-a');
    const teacherB = await registerTeacher('idor-read-b');
    const studentA = await createStudent(teacherA.cookie, 'A 的学生');

    // A 真实身份创建反馈
    const feedbackA = await createFeedback(teacherA.cookie, studentA, 'A 的私密反馈');

    // B 伪造 A 身份读列表 → 不得包含 A 的反馈
    const list = await request(app)
      .get('/api/v1/feedback')
      .set('Cookie', teacherB.cookie)
      .set('x-teacher-id', teacherA.teacherId);
    expect(list.status).toBe(200);
    const items = list.body.data.items as Array<{ id: string }>;
    expect(items.some((item) => item.id === feedbackA)).toBe(false);

    // B 不带伪造头读列表 → 同样看不到（B 名下为空）
    const ownList = await request(app)
      .get('/api/v1/feedback')
      .set('Cookie', teacherB.cookie);
    expect(ownList.status).toBe(200);
    const ownItems = ownList.body.data.items as Array<{ id: string }>;
    expect(ownItems.some((item) => item.id === feedbackA)).toBe(false);
  });

  it('dev fallback 兼容：无 session 仅 x-teacher-id（非生产）仍注入身份（测试基线不破坏）', async () => {
    const res = await request(app)
      .post('/api/v1/students')
      .set('x-teacher-id', 'dev-fallback-teacher')
      .send({ name: 'fallback 学生', grade: '高二' });
    expect(res.status).toBe(201);
    expect(res.body.data.teacherId).toBe('dev-fallback-teacher');
    createdStudentIds.push(res.body.data.id);
  });
});
