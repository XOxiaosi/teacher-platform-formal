import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { acceptInvitation } from '../helpers/invitations.js';

/**
 * T-014 跨教师攻击矩阵。
 *
 * 只使用隔离测试库中的合成教师与合成学生，并强制 production 鉴权语义：
 * - 读取：B 猜中 A 的对象 ID 也只能得到 404；
 * - 写入：B 不能修改、取消 A 的对象；
 * - 对象引用：B 不能把 A 的学生 ID 作为自己新日程的外键；
 * - 身份伪造：有效 B session 不能被 x-teacher-id=A 覆盖，无 session 也不能只靠 header 登录。
 *
 * 导出 job 的 owner 隔离由 functional/privacy/privacy-api.test.ts 的真实导出流程覆盖，
 * 本文件不重复创建数据库/导出进程。
 */

const prisma = new PrismaClient();
const app = createApp(prisma, { rawPrisma: prisma });
const originalNodeEnv = process.env.NODE_ENV;
const createdTeacherIds: string[] = [];
const createdStudentIds: string[] = [];
const createdScheduleIds: string[] = [];

let teacherA: { cookie: string; teacherId: string };
let teacherB: { cookie: string; teacherId: string };
let studentA: { id: string; updatedAtTs: Date };

async function createTeacher(prefix: string): Promise<{ cookie: string; teacherId: string }> {
  const email = `t014-${prefix}-${randomBytes(6).toString('hex')}@example.com`;
  const { response } = await acceptInvitation(app, prisma, {
    email,
    password: 'password123',
    displayName: `${prefix}老师`,
  });
  expect(response.status).toBe(201);
  const teacherId = response.body.data.teacher.id as string;
  const setCookie = response.headers['set-cookie'] as unknown as string[];
  createdTeacherIds.push(teacherId);
  return { teacherId, cookie: setCookie[0].split(';')[0] };
}

beforeAll(async () => {
  process.env.NODE_ENV = 'production';
  teacherA = await createTeacher('a');
  teacherB = await createTeacher('b');

  const response = await request(app)
    .post('/api/v1/students')
    .set('Cookie', teacherA.cookie)
    .send({ name: 'A_ONLY_STUDENT', grade: '合成数据' });
  expect(response.status).toBe(201);
  const row = await prisma.student.findUniqueOrThrow({ where: { id: response.body.data.id } });
  studentA = { id: row.id, updatedAtTs: row.updatedAtTs };
  createdStudentIds.push(row.id);
});

afterAll(async () => {
  if (createdTeacherIds.length > 0) {
    await prisma.changeLog.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
    await prisma.schedule.deleteMany({ where: { id: { in: createdScheduleIds } } });
    await prisma.student.deleteMany({ where: { id: { in: createdStudentIds } } });
    await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
    await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  }
  await prisma.teacherInvitation.deleteMany({ where: { email: { startsWith: 't014-' } } });
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  await prisma.$disconnect();
});

describe.sequential('T-014 两名合成教师跨空间攻击矩阵', () => {
  it('跨教师读取：B 猜中 A 的学生 ID 仍返回 404，且列表不泄露 A 的记录', async () => {
    const profile = await request(app)
      .get(`/api/v1/students/${studentA.id}/profile`)
      .set('Cookie', teacherB.cookie);
    expect(profile.status).toBe(404);

    const list = await request(app)
      .get('/api/v1/students')
      .set('Cookie', teacherB.cookie);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('A_ONLY_STUDENT');
  });

  it('跨教师写入：B 不能修改 A 的学生，即使同时伪造身份 header', async () => {
    const response = await request(app)
      .patch(`/api/v1/students/${studentA.id}/profile`)
      .set('Cookie', teacherB.cookie)
      .set('x-teacher-id', teacherA.teacherId)
      .send({
        expectedUpdatedAt: studentA.updatedAtTs.toISOString(),
        changes: { name: 'B_ILLEGAL_WRITE' },
      });
    expect(response.status).toBe(404);

    const persisted = await prisma.student.findUniqueOrThrow({ where: { id: studentA.id } });
    expect(persisted.name).toBe('A_ONLY_STUDENT');
  });

  it('跨教师对象引用：B 不能用 A 的学生 ID 创建日程，也不能取消 A 的日程', async () => {
    const forgedReference = await request(app)
      .post('/api/v1/schedules')
      .set('Cookie', teacherB.cookie)
      .send({
        clientRequestId: 't014-cross-teacher-schedule-0001',
        type: 'lesson',
        participantIds: [studentA.id],
        classFormat: 'one_to_one',
        location: '线上',
        scheduledStart: '2030-09-02T09:00:00.000Z',
        scheduledEnd: '2030-09-02T10:00:00.000Z',
        confidence: 'high',
      });
    expect(forgedReference.status).toBe(404);

    const ownSchedule = await request(app)
      .post('/api/v1/schedules')
      .set('Cookie', teacherA.cookie)
      .send({
        clientRequestId: 't014-owned-schedule-0001',
        type: 'lesson',
        participantIds: [studentA.id],
        classFormat: 'one_to_one',
        location: '线上',
        scheduledStart: '2030-09-02T09:00:00.000Z',
        scheduledEnd: '2030-09-02T10:00:00.000Z',
        confidence: 'high',
      });
    expect(ownSchedule.status).toBe(201);
    const scheduleId = ownSchedule.body.data.schedule.id as string;
    createdScheduleIds.push(scheduleId);

    const crossedCancel = await request(app)
      .post(`/api/v1/schedules/${scheduleId}/cancel`)
      .set('Cookie', teacherB.cookie);
    expect(crossedCancel.status).toBe(404);
    expect((await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } })).status).toBe('planned');
  });

  it('身份伪造：production 下 header 不能覆盖 session，也不能代替 session', async () => {
    const withSession = await request(app)
      .get('/api/v1/students')
      .set('Cookie', teacherB.cookie)
      .set('x-teacher-id', teacherA.teacherId);
    expect(withSession.status).toBe(200);
    expect(JSON.stringify(withSession.body)).not.toContain('A_ONLY_STUDENT');

    const headerOnly = await request(app)
      .get('/api/v1/students')
      .set('x-teacher-id', teacherA.teacherId);
    expect(headerOnly.status).toBe(401);
  });
});
