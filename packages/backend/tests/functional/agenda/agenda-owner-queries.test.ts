import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, type CommonError, type Result } from '@teacher-platform/contracts';
import { createScheduleService } from '../../../src/features/scheduling/index.js';
import type { ScheduleData } from '../../../src/features/scheduling/types.js';
import { createMemoService } from '../../../src/features/memos/index.js';
import type { MemoData } from '../../../src/features/memos/types.js';
import { createPendingActionService } from '../../../src/features/pending-action/index.js';
import type { PendingActionData } from '../../../src/features/pending-action/types.js';
import { createStudentService } from '../../../src/features/students/index.js';
import type { StudentData } from '../../../src/features/students/types.js';

const prisma = new PrismaClient();
const TEACHER_A = 'agenda-owner-teacher-a';
const TEACHER_B = 'agenda-owner-teacher-b';

function method<T>(service: object, name: string): T {
  const candidate = (service as unknown as Record<string, unknown>)[name];
  expect(candidate, `${name} must exist before owner behavior can pass`).toBeTypeOf('function');
  if (typeof candidate !== 'function') throw new Error(`${name} is missing`);
  return candidate.bind(service) as T;
}

type ListOverlappingSchedules = (input: {
  teacherId: string;
  windowStart: Date;
  windowEndExclusive: Date;
  type: 'lesson';
}) => Promise<Result<{ items: ScheduleData[]; total: number }, CommonError>>;

type ListAgendaMemos = (input: {
  teacherId: string;
  dueAtFrom?: Date;
  dueAtBefore: Date;
}) => Promise<Result<{ items: MemoData[]; total: number }, CommonError>>;

type ListActivePendingActions = (input: {
  teacherId: string;
  activeAt: Date;
}) => Promise<Result<{ items: PendingActionData[]; total: number }, CommonError>>;

type ListOwnedStudentsByIds = (input: {
  teacherId: string;
  studentIds: string[];
}) => Promise<Result<StudentData[], CommonError>>;

async function cleanup() {
  await prisma.pendingAction.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.conversation.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.memo.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('Agenda owner read queries', () => {
  it('Schedule按半开窗口overlap、lesson type和teacher过滤并稳定排序', async () => {
    const windowStart = new Date('2030-07-21T16:00:00.000Z');
    const windowEndExclusive = new Date('2030-07-22T16:00:00.000Z');
    const records = await Promise.all([
      prisma.schedule.create({ data: {
        teacherId: TEACHER_A, type: 'lesson', title: '跨入窗口',
        scheduledStartTs: new Date('2030-07-21T15:30:00.000Z'),
        scheduledEndTs: new Date('2030-07-21T16:30:00.000Z'),
      } }),
      prisma.schedule.create({ data: {
        teacherId: TEACHER_A, type: 'lesson', title: '窗口内课程',
        scheduledStartTs: new Date('2030-07-22T02:00:00.000Z'),
        scheduledEndTs: new Date('2030-07-22T03:00:00.000Z'),
      } }),
      prisma.schedule.create({ data: {
        teacherId: TEACHER_A, type: 'lesson', title: '结束边界相接',
        scheduledStartTs: new Date('2030-07-21T14:00:00.000Z'),
        scheduledEndTs: windowStart,
      } }),
      prisma.schedule.create({ data: {
        teacherId: TEACHER_A, type: 'lesson', title: '开始边界相接',
        scheduledStartTs: windowEndExclusive,
        scheduledEndTs: new Date('2030-07-22T17:00:00.000Z'),
      } }),
      prisma.schedule.create({ data: {
        teacherId: TEACHER_A, type: 'meeting', title: '非课程日程',
        scheduledStartTs: new Date('2030-07-22T04:00:00.000Z'),
        scheduledEndTs: new Date('2030-07-22T05:00:00.000Z'),
      } }),
      prisma.schedule.create({ data: {
        teacherId: TEACHER_B, type: 'lesson', title: '其他教师课程',
        scheduledStartTs: new Date('2030-07-22T06:00:00.000Z'),
        scheduledEndTs: new Date('2030-07-22T07:00:00.000Z'),
      } }),
    ]);
    const list = method<ListOverlappingSchedules>(
      createScheduleService(prisma),
      'listOverlappingSchedules',
    );

    const result = await list({ teacherId: TEACHER_A, windowStart, windowEndExclusive, type: 'lesson' });

    expect(result).toEqual({
      ok: true,
      value: { items: [expect.objectContaining({ id: records[0].id }), expect.objectContaining({ id: records[1].id })], total: 2 },
    });
  });

  it('Memo Today包含逾期active，显式下界时只返回窗口内dueAt', async () => {
    const windowStart = new Date('2030-07-21T16:00:00.000Z');
    const windowEndExclusive = new Date('2030-07-22T16:00:00.000Z');
    const overdue = await prisma.memo.create({ data: {
      teacherId: TEACHER_A, title: '逾期备忘', content: '逾期', dueAtTs: new Date('2030-07-20T01:00:00.000Z'),
    } });
    const today = await prisma.memo.create({ data: {
      teacherId: TEACHER_A, title: '今日备忘', content: '今日', dueAtTs: new Date('2030-07-22T01:00:00.000Z'),
    } });
    await Promise.all([
      prisma.memo.create({ data: {
        teacherId: TEACHER_A, title: '上界相接', content: '下一日', dueAtTs: windowEndExclusive,
      } }),
      prisma.memo.create({ data: {
        teacherId: TEACHER_A, title: '已完成', content: '完成', status: 'done', dueAtTs: new Date('2030-07-22T02:00:00.000Z'),
      } }),
      prisma.memo.create({ data: { teacherId: TEACHER_A, title: '无期限', content: '无期限' } }),
      prisma.memo.create({ data: {
        teacherId: TEACHER_B, title: '其他教师', content: '隔离', dueAtTs: new Date('2030-07-22T03:00:00.000Z'),
      } }),
    ]);
    const list = method<ListAgendaMemos>(createMemoService({ prisma }), 'listAgendaMemos');

    const todayResult = await list({ teacherId: TEACHER_A, dueAtBefore: windowEndExclusive });
    const weekResult = await list({
      teacherId: TEACHER_A,
      dueAtFrom: windowStart,
      dueAtBefore: windowEndExclusive,
    });

    expect(todayResult).toEqual({
      ok: true,
      value: {
        items: [expect.objectContaining({ id: overdue.id }), expect.objectContaining({ id: today.id })],
        total: 2,
      },
    });
    expect(weekResult).toEqual({
      ok: true,
      value: { items: [expect.objectContaining({ id: today.id })], total: 1 },
    });
  });

  it('PendingAction只读返回可信instant仍有效的pending且不签token、不写expired', async () => {
    const activeAt = new Date('2030-07-22T01:00:00.000Z');
    const [conversationA, conversationB] = await Promise.all([
      prisma.conversation.create({ data: { teacherId: TEACHER_A } }),
      prisma.conversation.create({ data: { teacherId: TEACHER_B } }),
    ]);
    const active = await prisma.pendingAction.create({ data: {
      teacherId: TEACHER_A,
      conversationId: conversationA.id,
      toolCallId: 'agenda-active',
      actionName: 'students.updateStatus',
      targetType: 'Student',
      targetId: 'student-a',
      parameters: {},
      afterSummary: '更新学生状态',
      expiresAtTs: new Date('2030-07-22T02:00:00.000Z'),
    } });
    const expired = await prisma.pendingAction.create({ data: {
      teacherId: TEACHER_A,
      conversationId: conversationA.id,
      toolCallId: 'agenda-expired',
      actionName: 'students.updateStatus',
      targetType: 'Student',
      targetId: 'student-a',
      parameters: {},
      afterSummary: '已过期操作',
      expiresAtTs: new Date('2030-07-22T00:59:59.000Z'),
    } });
    await Promise.all([
      prisma.pendingAction.create({ data: {
        teacherId: TEACHER_A,
        conversationId: conversationA.id,
        toolCallId: 'agenda-executing',
        actionName: 'students.updateStatus',
        targetType: 'Student',
        targetId: 'student-a',
        parameters: {},
        afterSummary: '执行中操作',
        status: 'executing',
        expiresAtTs: new Date('2030-07-22T02:00:00.000Z'),
      } }),
      prisma.pendingAction.create({ data: {
        teacherId: TEACHER_B,
        conversationId: conversationB.id,
        toolCallId: 'agenda-cross-teacher',
        actionName: 'students.updateStatus',
        targetType: 'Student',
        targetId: 'student-b',
        parameters: {},
        afterSummary: '其他教师操作',
        expiresAtTs: new Date('2030-07-22T02:00:00.000Z'),
      } }),
    ]);
    const sign = vi.fn(() => ok('must-not-be-used'));
    const service = createPendingActionService({
      prisma,
      actionTokenSigner: {
        sign,
        verify: () => ok({ pendingActionId: 'unused' }),
      },
      conversationOwner: {
        getOwnedConversation: async () => ok({ id: conversationA.id, status: 'active' }),
      },
    });
    const list = method<ListActivePendingActions>(service, 'listActivePendingActions');

    const result = await list({ teacherId: TEACHER_A, activeAt });

    expect(result).toEqual({
      ok: true,
      value: { items: [expect.objectContaining({ id: active.id })], total: 1 },
    });
    expect(sign).not.toHaveBeenCalled();
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: expired.id } })).status).toBe('pending');
  });

  it('Student批量查询去重并只返回同teacher对象', async () => {
    const [studentA1, studentA2, studentB] = await Promise.all([
      prisma.student.create({ data: { teacherId: TEACHER_A, name: '甲', grade: '高一' } }),
      prisma.student.create({ data: { teacherId: TEACHER_A, name: '乙', grade: '高二' } }),
      prisma.student.create({ data: { teacherId: TEACHER_B, name: '其他教师学生', grade: '高三' } }),
    ]);
    const list = method<ListOwnedStudentsByIds>(
      createStudentService(prisma),
      'listOwnedStudentsByIds',
    );

    const result = await list({
      teacherId: TEACHER_A,
      studentIds: [studentA2.id, studentB.id, studentA1.id, studentA2.id, 'missing'],
    });

    const expectedIds = [studentA1.id, studentA2.id].sort((left, right) => left.localeCompare(right));
    expect(result).toEqual({
      ok: true,
      value: expectedIds.map((id) => expect.objectContaining({ id, teacherId: TEACHER_A })),
    });
  });
});
