import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { acceptInvitation } from '../helpers/invitations.js';

const prisma = new PrismaClient();
const app = createApp(prisma);
const teacherIds: string[] = [];

afterAll(async () => {
  await prisma.webMutationReceipt.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.teacherWorkspacePreference.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.memo.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.teacherInvitation.deleteMany({ where: { email: { startsWith: 'workspace-web-' } } });
  await prisma.$disconnect();
});

function uniqueEmail(): string {
  return `workspace-web-${randomBytes(8).toString('hex')}@example.com`;
}

async function createTeacher(label: string) {
  const agent = request.agent(app);
  const email = uniqueEmail();
  const { response } = await acceptInvitation(app, prisma, {
    email,
    password: 'password123',
    displayName: label,
  }, agent);
  expect(response.status).toBe(201);
  const id = response.body.data.teacher.id as string;
  teacherIds.push(id);
  return { agent, id };
}

async function mutate(agent: request.SuperAgentTest, operation: string, body: Record<string, unknown>) {
  return agent.post(`/api/v1/workspace-web/${operation}`).send(body);
}

describe('workspace-web 教师工作区', () => {
  it('学生、备忘、反馈写入可幂等重放，状态可读取且 receipt 不保存明文', async () => {
    const { agent, id: teacherId } = await createTeacher('工作区老师');
    const student = await mutate(agent, 'students', {
      clientRequestId: 'student-create-1', name: '工作区学生', grade: '高一',
    });
    expect(student.status).toBe(200);
    expect(student.body.ok).toBe(true);
    const studentId = student.body.data.id as string;
    const studentReplay = await mutate(agent, 'students', {
      clientRequestId: 'student-create-1', name: '工作区学生', grade: '高一',
    });
    expect(studentReplay.status).toBe(200);
    expect(studentReplay.body.data).toEqual(student.body.data);
    expect(await prisma.student.count({ where: { teacherId, name: '工作区学生' } })).toBe(1);

    const memo = await mutate(agent, 'memos', { clientRequestId: 'memo-create-1', text: '跟进工作区学生' });
    expect(memo.status).toBe(200);
    const memoReplay = await mutate(agent, 'memos', { clientRequestId: 'memo-create-1', text: '跟进工作区学生' });
    expect(memoReplay.status).toBe(200);
    expect(memoReplay.body.data).toEqual(memo.body.data);
    expect(await prisma.memo.count({ where: { teacherId, title: '跟进工作区学生' } })).toBe(1);

    const feedback = await mutate(agent, 'feedback', {
      clientRequestId: 'feedback-create-1', studentId, title: '阶段反馈', content: '保持练习节奏',
    });
    expect(feedback.status).toBe(200);
    const feedbackReplay = await mutate(agent, 'feedback', {
      clientRequestId: 'feedback-create-1', studentId, title: '阶段反馈', content: '保持练习节奏',
    });
    expect(feedbackReplay.status).toBe(200);
    expect(feedbackReplay.body.data).toEqual(feedback.body.data);
    expect(await prisma.parentFeedback.count({ where: { teacherId, studentId } })).toBe(1);

    const state = await agent.get('/api/v1/workspace-web/state');
    expect(state.status).toBe(200);
    expect(state.body.data.memos.some((item: { title: string }) => item.title === '跟进工作区学生')).toBe(true);

    const receiptRows = await prisma.$queryRaw<Array<{ ciphertext: string }>>`
      SELECT "ciphertext" FROM "WebMutationReceipt"
      WHERE "teacherId" = ${teacherId} AND "clientRequestId" = ${'memo-create-1'}
    `;
    expect(receiptRows).toHaveLength(1);
    expect(receiptRows[0]!.ciphertext).not.toContain('跟进工作区学生');
    expect(receiptRows[0]!.ciphertext).toMatch(/^enc:v1:/);
  });

  it('偏好写入可幂等重放，过期版本拒绝并要求刷新', async () => {
    const { agent } = await createTeacher('偏好老师');
    const first = await mutate(agent, 'preferences', {
      clientRequestId: 'preference-create-1', expectedUpdatedAt: null,
      changes: { studioName: '陶土工作室', modelChoice: 'deep' },
    });
    expect(first.status).toBe(200);
    expect(first.body.data.studioName).toBe('陶土工作室');
    const replay = await mutate(agent, 'preferences', {
      clientRequestId: 'preference-create-1', expectedUpdatedAt: null,
      changes: { studioName: '陶土工作室', modelChoice: 'deep' },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);

    const stale = await mutate(agent, 'preferences', {
      clientRequestId: 'preference-stale-1', expectedUpdatedAt: null,
      changes: { studioName: '过期写入' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');

    const current = first.body.data.updatedAtTs as string;
    const next = await mutate(agent, 'preferences', {
      clientRequestId: 'preference-update-1', expectedUpdatedAt: current,
      changes: { studioName: '更新后的工作室' },
    });
    expect(next.status).toBe(200);
    expect(next.body.data.studioName).toBe('更新后的工作室');
  });

  it('备忘状态可成功幂等重放，拒绝过期版本和跨教师访问', async () => {
    const owner = await createTeacher('备忘所属老师');
    const intruder = await createTeacher('备忘另一位老师');
    const memo = await mutate(owner.agent, 'memos', {
      clientRequestId: 'memo-status-create-1', text: '待处理备忘',
    });
    expect(memo.status).toBe(200);
    const memoId = memo.body.data.id as string;
    const expectedUpdatedAt = memo.body.data.updatedAt as string;

    const done = await mutate(owner.agent, 'memo-status', {
      clientRequestId: 'memo-status-done-1', id: memoId, done: true, expectedUpdatedAt,
    });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ id: memoId, status: 'done' });

    const replay = await mutate(owner.agent, 'memo-status', {
      clientRequestId: 'memo-status-done-1', id: memoId, done: true, expectedUpdatedAt,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(done.body.data);
    expect(await prisma.memo.count({ where: { teacherId: owner.id, id: memoId, status: 'done' } })).toBe(1);

    const stale = await mutate(owner.agent, 'memo-status', {
      clientRequestId: 'memo-status-stale-1', id: memoId, done: false, expectedUpdatedAt,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');

    const crossed = await mutate(intruder.agent, 'memo-status', {
      clientRequestId: 'memo-status-cross-1', id: memoId, done: false, expectedUpdatedAt: done.body.data.updatedAt,
    });
    expect(crossed.status).toBe(404);
    expect(crossed.body.error.code).toBe('NOT_FOUND');
  });

  it('同一请求编号更换 payload 或 operation 时拒绝重放', async () => {
    const { agent } = await createTeacher('幂等冲突老师');
    const first = await mutate(agent, 'memos', { clientRequestId: 'receipt-conflict-1', text: '第一份备忘' });
    expect(first.status).toBe(200);

    const changedPayload = await mutate(agent, 'memos', {
      clientRequestId: 'receipt-conflict-1', text: '改过的备忘',
    });
    expect(changedPayload.status).toBe(409);
    expect(changedPayload.body.error.code).toBe('VERSION_CONFLICT');

    const changedOperation = await mutate(agent, 'students', {
      clientRequestId: 'receipt-conflict-1', name: '学生', grade: '高一',
    });
    expect(changedOperation.status).toBe(409);
    expect(changedOperation.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('非法 operation、body 和 clientRequestId 在写入前返回 400', async () => {
    const { agent } = await createTeacher('非法请求老师');
    const cases = [
      agent.post('/api/v1/workspace-web/unknown').send({ clientRequestId: 'invalid-operation-1' }),
      agent.post('/api/v1/workspace-web/memos').send({ clientRequestId: 'invalid-body-1', text: '' }),
      agent.post('/api/v1/workspace-web/memos').send({ clientRequestId: '', text: '没有请求编号' }),
      agent.post('/api/v1/workspace-web/memos').send({ text: '缺少请求编号' }),
    ];
    const responses = await Promise.all(cases);
    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('并发重复请求只创建一份备忘和一份收据', async () => {
    const { agent, id: teacherId } = await createTeacher('并发幂等老师');
    const body = { clientRequestId: 'concurrent-memo-1', text: '并发只保存一次' };
    const responses = await Promise.all([
      mutate(agent, 'memos', body),
      mutate(agent, 'memos', body),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200]);
    expect(responses[0]!.body.data).toEqual(responses[1]!.body.data);
    expect(await prisma.memo.count({ where: { teacherId, title: body.text } })).toBe(1);
    expect(await prisma.webMutationReceipt.count({ where: { teacherId, clientRequestId: body.clientRequestId } })).toBe(1);
  });

  it('状态读取使用数据库可信时间并按 Asia/Shanghai 投影业务日期', async () => {
    const { agent } = await createTeacher('业务日期老师');
    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
    const expected = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(clock.now);
    const state = await agent.get('/api/v1/workspace-web/state');
    expect(state.status).toBe(200);
    expect(state.body.data.businessDate).toBe(expected);
    expect(state.body.data.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('跨教师 cookie 不得读取或写入他人学生，未登录也不能访问工作区', async () => {
    const owner = await createTeacher('学生所属老师');
    const intruder = await createTeacher('另一位老师');
    const student = await mutate(owner.agent, 'students', {
      clientRequestId: 'owner-student-1', name: '私有学生', grade: '初三',
    });
    expect(student.status).toBe(200);

    const crossed = await mutate(intruder.agent, 'feedback', {
      clientRequestId: 'cross-feedback-1', studentId: student.body.data.id,
      title: '越权反馈', content: '不应写入',
    });
    expect(crossed.status).toBe(404);
    expect(crossed.body.error.code).toBe('NOT_FOUND');

    const isolated = await intruder.agent.get('/api/v1/workspace-web/state');
    expect(isolated.status).toBe(200);
    expect(isolated.body.data.memos).toEqual([]);

    const anonymous = await request(app).get('/api/v1/workspace-web/state');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('PERMISSION_DENIED');
  });
});
