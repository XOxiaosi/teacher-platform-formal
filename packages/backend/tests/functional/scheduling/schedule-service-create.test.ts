import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createScheduleService } from '../../../src/features/scheduling/schedule-service.js';

const prisma = new PrismaClient();
const service = createScheduleService(prisma);

const TEACHER_ID = 'test-teacher-scheduling-create';
const OTHER_TEACHER_ID = 'test-teacher-scheduling-create-other';

async function cleanup() {
  const teacherIds = [TEACHER_ID, OTHER_TEACHER_ID];
  await prisma.scheduleParticipant.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.recurrenceRuleParticipant.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.recurrenceRule.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teacherIds } } });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('scheduleService.createSchedule', () => {
  it('创建日程成功，返回日程数据和空冲突列表', async () => {
    const result = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'meeting',
      title: '教研会议',
      scheduledStart: new Date('2025-03-15T14:00:00'),
      scheduledEnd: new Date('2025-03-15T15:30:00'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.schedule.id).toBeDefined();
    expect(result.value.schedule.title).toBe('教研会议');
    expect(result.value.schedule.status).toBe('planned');
    expect(result.value.schedule.type).toBe('meeting');
    expect(result.value.conflicts).toEqual([]);
  });

  it('创建日程时检测到时间冲突，返回冲突列表但不阻止创建', async () => {
    // 先创建一个日程
    await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'meeting',
      title: '第一场会议',
      scheduledStart: new Date('2025-03-15T14:00:00'),
      scheduledEnd: new Date('2025-03-15T15:30:00'),
    });

    // 再创建一个时间重叠的日程
    const result = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'meeting',
      title: '第二场会议',
      scheduledStart: new Date('2025-03-15T15:00:00'),
      scheduledEnd: new Date('2025-03-15T16:00:00'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.schedule.title).toBe('第二场会议');
    expect(result.value.conflicts.length).toBe(1);
    expect(result.value.conflicts[0].title).toBe('第一场会议');
  });

  it('正式课程在时间冲突时整次拒绝，且课程、参与关系和计费表均零新增', async () => {
    const student = await prisma.student.create({
      data: { teacherId: TEACHER_ID, name: '冲突验证学生', grade: '高一' },
    });
    await prisma.schedule.create({
      data: {
        teacherId: TEACHER_ID,
        type: 'lesson',
        title: '历史兼容课程',
        scheduledStartTs: new Date('2030-08-20T01:00:00.000Z'),
        scheduledEndTs: new Date('2030-08-20T02:00:00.000Z'),
      },
    });
    const before = {
      schedules: await prisma.schedule.count({ where: { teacherId: TEACHER_ID } }),
      participants: await prisma.scheduleParticipant.count({ where: { teacherId: TEACHER_ID } }),
      lessons: await prisma.lesson.count({ where: { teacherId: TEACHER_ID } }),
      payments: await prisma.payment.count({ where: { teacherId: TEACHER_ID } }),
      ledgerEntries: await prisma.lessonLedgerEntry.count({ where: { teacherId: TEACHER_ID } }),
      completionSnapshots: await prisma.scheduleCompletionSnapshot.count({ where: { teacherId: TEACHER_ID } }),
    };

    const result = await service.createSchedule({
      teacherId: TEACHER_ID,
      clientRequestId: 'formal-conflict-0001',
      type: 'lesson',
      participantIds: [student.id],
      location: '工作室 A',
      classFormat: 'one_to_one',
      scheduledStart: new Date('2030-08-20T01:30:00.000Z'),
      scheduledEnd: new Date('2030-08-20T02:30:00.000Z'),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'scheduledStart' },
    });
    expect({
      schedules: await prisma.schedule.count({ where: { teacherId: TEACHER_ID } }),
      participants: await prisma.scheduleParticipant.count({ where: { teacherId: TEACHER_ID } }),
      lessons: await prisma.lesson.count({ where: { teacherId: TEACHER_ID } }),
      payments: await prisma.payment.count({ where: { teacherId: TEACHER_ID } }),
      ledgerEntries: await prisma.lessonLedgerEntry.count({ where: { teacherId: TEACHER_ID } }),
      completionSnapshots: await prisma.scheduleCompletionSnapshot.count({ where: { teacherId: TEACHER_ID } }),
    }).toEqual(before);
  });

  it('领域服务拒绝缺少幂等键或携带旧标题的正式课程', async () => {
    const student = await prisma.student.create({
      data: { teacherId: TEACHER_ID, name: '正式契约学生', grade: '高一' },
    });
    const base = {
      teacherId: TEACHER_ID,
      type: 'lesson' as const,
      participantIds: [student.id],
      location: '工作室 A',
      classFormat: 'one_to_one' as const,
      scheduledStart: new Date('2030-08-21T01:00:00.000Z'),
      scheduledEnd: new Date('2030-08-21T02:00:00.000Z'),
    };

    const missingKey = await service.createSchedule(base);
    const titled = await service.createSchedule({
      ...base,
      clientRequestId: 'formal-title-0001',
      title: '不应写入的新课程名称',
    });
    const titleOnlyLegacyShape = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'lesson',
      title: '旧写法也不应继续写入',
      scheduledStart: new Date('2030-08-21T03:00:00.000Z'),
      scheduledEnd: new Date('2030-08-21T04:00:00.000Z'),
    });

    expect(missingKey).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'clientRequestId' } });
    expect(titled).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'title' } });
    expect(titleOnlyLegacyShape).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'title' } });
    expect(await prisma.schedule.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('同一幂等键修改任一持久请求字段均返回版本冲突', async () => {
    const student = await prisma.student.create({
      data: { teacherId: TEACHER_ID, name: '幂等载荷学生', grade: '高一' },
    });
    const base = {
      teacherId: TEACHER_ID,
      clientRequestId: 'formal-payload-0001',
      type: 'lesson' as const,
      participantIds: [student.id],
      location: '工作室 A',
      classFormat: 'one_to_one' as const,
      operationalNote: '准备小测',
      scheduledStart: new Date('2030-08-22T01:00:00.000Z'),
      scheduledEnd: new Date('2030-08-22T02:00:00.000Z'),
      confidence: 'high' as const,
      pendingFields: ['field-a'],
      sourceInput: '第一次请求',
    };
    const first = await service.createSchedule(base);
    expect(first.ok).toBe(true);

    const changed = await Promise.all([
      service.createSchedule({ ...base, confidence: 'low' }),
      service.createSchedule({ ...base, pendingFields: ['field-b'] }),
      service.createSchedule({ ...base, sourceInput: '第二次请求' }),
    ]);
    expect(changed).toEqual(changed.map(() => expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'VERSION_CONFLICT' }),
    })));
    expect(await prisma.schedule.count({ where: { teacherId: TEACHER_ID } })).toBe(1);
    expect(await prisma.scheduleParticipant.count({ where: { teacherId: TEACHER_ID } })).toBe(1);
  });

  it('创建日程时带 studentId 和 confidence', async () => {
    // 先创建学生（满足外键约束）
    await prisma.student.create({
      data: { teacherId: TEACHER_ID, name: '张三', grade: '高三' },
    });
    const student = await prisma.student.findFirst({ where: { teacherId: TEACHER_ID } });

    const result = await service.createSchedule({
      teacherId: TEACHER_ID,
      studentId: student!.id,
      type: 'meeting',
      title: '张三家长沟通',
      scheduledStart: new Date('2025-03-15T14:00:00'),
      scheduledEnd: new Date('2025-03-15T15:30:00'),
      confidence: 'high',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.schedule.studentId).toBe(student!.id);
    expect(result.value.schedule.confidence).toBe('high');
  });

  it('拒绝关联其他 teacher 的学生，且零写入', async () => {
    const otherStudent = await prisma.student.create({
      data: { teacherId: OTHER_TEACHER_ID, name: '其他老师学生', grade: '高二' },
    });

    const result = await service.createSchedule({
      teacherId: TEACHER_ID,
      studentId: otherStudent.id,
      type: 'meeting',
      title: '跨老师关联日程',
      scheduledStart: new Date('2025-03-15T14:00:00'),
      scheduledEnd: new Date('2025-03-15T15:30:00'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(expect.objectContaining({ code: 'NOT_FOUND', message: '学生不存在' }));
    expect(await prisma.schedule.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('结束时间早于开始时间：返回 VALIDATION_ERROR', async () => {
    const result = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'meeting',
      title: '时间错误日程',
      scheduledStart: new Date('2025-03-15T15:00:00'),
      scheduledEnd: new Date('2025-03-15T14:00:00'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('scheduleService.getSchedule', () => {
  it('查询单个日程：返回完整数据', async () => {
    const created = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'meeting',
      title: '教研会议',
      scheduledStart: new Date('2025-03-15T10:00:00'),
      scheduledEnd: new Date('2025-03-15T11:00:00'),
    });
    if (!created.ok) return;

    const result = await service.getSchedule(created.value.schedule.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('教研会议');
    expect(result.value.type).toBe('meeting');
  });

  it('查询不存在的日程：返回 NOT_FOUND', async () => {
    const result = await service.getSchedule('nonexistent-id');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('scheduleService.listSchedules', () => {
  it('按 teacherId 查询返回所有日程，按时间正序排列', async () => {
    await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'meeting',
      title: '下午课',
      scheduledStart: new Date('2025-03-15T14:00:00'),
      scheduledEnd: new Date('2025-03-15T15:00:00'),
    });
    await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'meeting',
      title: '上午课',
      scheduledStart: new Date('2025-03-15T09:00:00'),
      scheduledEnd: new Date('2025-03-15T10:00:00'),
    });

    const result = await service.listSchedules({ teacherId: TEACHER_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.items.length).toBe(2);
    expect(result.value.items[0].title).toBe('上午课');
    expect(result.value.items[1].title).toBe('下午课');
  });

  it('按 type 过滤', async () => {
    await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'prep',
      title: '备课',
      scheduledStart: new Date('2025-03-15T14:00:00'),
      scheduledEnd: new Date('2025-03-15T15:00:00'),
    });
    await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'meeting',
      title: '会议',
      scheduledStart: new Date('2025-03-15T16:00:00'),
      scheduledEnd: new Date('2025-03-15T17:00:00'),
    });

    const result = await service.listSchedules({ teacherId: TEACHER_ID, type: 'meeting' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBe(1);
    expect(result.value.items[0].title).toBe('会议');
  });

  it('按 status 过滤', async () => {
    const created = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'meeting',
      title: '已完成会议',
      scheduledStart: new Date('2025-03-15T14:00:00'),
      scheduledEnd: new Date('2025-03-15T15:00:00'),
    });
    if (!created.ok) return;
    await service.updateScheduleStatus({
      scheduleId: created.value.schedule.id,
      targetStatus: 'completed',
    });

    await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'meeting',
      title: '计划中会议',
      scheduledStart: new Date('2025-03-16T14:00:00'),
      scheduledEnd: new Date('2025-03-16T15:00:00'),
    });

    const result = await service.listSchedules({ teacherId: TEACHER_ID, status: 'planned' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBe(1);
    expect(result.value.items[0].title).toBe('计划中会议');
  });
});
