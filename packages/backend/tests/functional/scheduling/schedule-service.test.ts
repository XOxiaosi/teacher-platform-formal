import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, internalError } from '@teacher-platform/contracts';
import { createScheduleService } from '../../../src/features/scheduling/schedule-service.js';
import {
  createChangelogService,
  withChangelog,
  type ChangelogFactory,
} from '../../../src/shared/changelog/index.js';

const prisma = new PrismaClient();
const service = createScheduleService(prisma);

const TEACHER_ID = 'test-teacher-scheduling';
const OTHER_TEACHER_ID = 'test-teacher-scheduling-other';
const AUDIT_SECRET = 'database audit failure detail';

const failingChangelogFactory: ChangelogFactory = () => ({
  async recordChange() {
    return err(internalError(AUDIT_SECRET));
  },
});

function createExtendedScheduleService(changelogFactory?: ChangelogFactory) {
  const extended = withChangelog(
    prisma,
    createChangelogService(prisma),
  ) as unknown as PrismaClient;
  return createScheduleService({
    getClient: async () => extended,
    ...(changelogFactory && { changelogFactory }),
  });
}

async function cleanup() {
  const teacherIds = [TEACHER_ID, OTHER_TEACHER_ID];
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teacherIds } } });
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
      type: 'lesson',
      title: '张三物理课',
      scheduledStart: new Date('2025-03-15T14:00:00'),
      scheduledEnd: new Date('2025-03-15T15:30:00'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.schedule.id).toBeDefined();
    expect(result.value.schedule.title).toBe('张三物理课');
    expect(result.value.schedule.status).toBe('planned');
    expect(result.value.schedule.type).toBe('lesson');
    expect(result.value.conflicts).toEqual([]);
  });

  it('创建日程时检测到时间冲突，返回冲突列表但不阻止创建', async () => {
    // 先创建一个日程
    await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'lesson',
      title: '第一节',
      scheduledStart: new Date('2025-03-15T14:00:00'),
      scheduledEnd: new Date('2025-03-15T15:30:00'),
    });

    // 再创建一个时间重叠的日程
    const result = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'lesson',
      title: '第二节',
      scheduledStart: new Date('2025-03-15T15:00:00'),
      scheduledEnd: new Date('2025-03-15T16:00:00'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.schedule.title).toBe('第二节');
    expect(result.value.conflicts.length).toBe(1);
    expect(result.value.conflicts[0].title).toBe('第一节');
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
      type: 'lesson',
      title: '张三物理课',
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
      type: 'lesson',
      title: '跨老师课程',
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
      type: 'lesson',
      title: '时间错误',
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
      type: 'lesson',
      title: '下午课',
      scheduledStart: new Date('2025-03-15T14:00:00'),
      scheduledEnd: new Date('2025-03-15T15:00:00'),
    });
    await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'lesson',
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
      type: 'lesson',
      title: '课程',
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
      type: 'lesson',
      title: '已完成课',
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
      type: 'lesson',
      title: '计划中课',
      scheduledStart: new Date('2025-03-16T14:00:00'),
      scheduledEnd: new Date('2025-03-16T15:00:00'),
    });

    const result = await service.listSchedules({ teacherId: TEACHER_ID, status: 'planned' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBe(1);
    expect(result.value.items[0].title).toBe('计划中课');
  });
});

describe('scheduleService.listSchedulesStartingInWindow', () => {
  const windowStart = new Date('2030-05-01T16:00:00.000Z');
  const windowEndExclusive = new Date('2030-05-02T16:00:00.000Z');

  it('按 scheduledStart 半开窗口归属，纳入跨午夜日程并隔离 teacher', async () => {
    await prisma.schedule.createMany({
      data: [
        {
          id: 'window-before', teacherId: TEACHER_ID, type: 'meeting', title: '零点前',
          scheduledStartTs: new Date('2030-05-01T15:59:59.999Z'), scheduledEndTs: new Date('2030-05-01T16:30:00.000Z'),
        },
        {
          id: 'window-start', teacherId: TEACHER_ID, type: 'meeting', title: '零点纳入',
          scheduledStartTs: windowStart, scheduledEndTs: new Date('2030-05-01T17:00:00.000Z'),
        },
        {
          id: 'window-cross-midnight', teacherId: TEACHER_ID, type: 'meeting', title: '跨午夜按开始日',
          scheduledStartTs: new Date('2030-05-02T15:30:00.000Z'), scheduledEndTs: new Date('2030-05-02T16:30:00.000Z'),
        },
        {
          id: 'window-end', teacherId: TEACHER_ID, type: 'meeting', title: '次日零点排除',
          scheduledStartTs: windowEndExclusive, scheduledEndTs: new Date('2030-05-02T17:00:00.000Z'),
        },
        {
          id: 'window-other-teacher', teacherId: OTHER_TEACHER_ID, type: 'meeting', title: '其他老师',
          scheduledStartTs: windowStart, scheduledEndTs: new Date('2030-05-01T17:00:00.000Z'),
        },
      ],
    });

    const result = await service.listSchedulesStartingInWindow({
      teacherId: TEACHER_ID,
      windowStart,
      windowEndExclusive,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((item) => item.id)).toEqual([
      'window-start',
      'window-cross-midnight',
    ]);
    expect(result.value.total).toBe(2);
  });

  it.each([101, 500])('完整返回 %i 条并按 scheduledStart、scheduledEnd、id 升序', async (count) => {
    await prisma.schedule.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        id: `capacity-schedule-${String(count - index).padStart(3, '0')}`,
        teacherId: TEACHER_ID,
        type: 'meeting',
        title: `容量日程 ${index}`,
        scheduledStartTs: windowStart,
        scheduledEndTs: new Date('2030-05-01T17:00:00.000Z'),
      })),
    });

    const result = await service.listSchedulesStartingInWindow({
      teacherId: TEACHER_ID,
      windowStart,
      windowEndExclusive,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(count);
    expect(result.value.total).toBe(count);
    expect(result.value.items.map((item) => item.id)).toEqual(
      [...result.value.items.map((item) => item.id)].sort(),
    );
  });

  it('501 条返回 INTERNAL_ERROR，不静默截断', async () => {
    await prisma.schedule.createMany({
      data: Array.from({ length: 501 }, (_, index) => ({
        teacherId: TEACHER_ID,
        type: 'meeting',
        title: `溢出日程 ${index}`,
        scheduledStartTs: new Date(windowStart.getTime() + index),
        scheduledEndTs: new Date(windowStart.getTime() + 60_000 + index),
      })),
    });

    const result = await service.listSchedulesStartingInWindow({
      teacherId: TEACHER_ID,
      windowStart,
      windowEndExclusive,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
  });

  it.each([
    ['', windowStart, windowEndExclusive],
    [TEACHER_ID, new Date(Number.NaN), windowEndExclusive],
    [TEACHER_ID, windowStart, new Date(Number.NaN)],
    [TEACHER_ID, windowStart, windowStart],
    [TEACHER_ID, windowEndExclusive, windowStart],
  ])('拒绝非法 teacher 或半开窗口 %#', async (teacherId, start, endExclusive) => {
    const result = await service.listSchedulesStartingInWindow({
      teacherId,
      windowStart: start,
      windowEndExclusive: endExclusive,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('scheduleService.updateScheduleStatus', () => {
  it('planned -> completed: 合法转换', async () => {
    const created = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'lesson',
      title: '待完成',
      scheduledStart: new Date('2025-03-15T14:00:00'),
      scheduledEnd: new Date('2025-03-15T15:00:00'),
    });
    if (!created.ok) return;

    const result = await service.updateScheduleStatus({
      scheduleId: created.value.schedule.id,
      targetStatus: 'completed',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('completed');
  });

  it('planned -> cancelled: 合法转换', async () => {
    const created = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'lesson',
      title: '待取消',
      scheduledStart: new Date('2025-03-15T14:00:00'),
      scheduledEnd: new Date('2025-03-15T15:00:00'),
    });
    if (!created.ok) return;

    const result = await service.updateScheduleStatus({
      scheduleId: created.value.schedule.id,
      targetStatus: 'cancelled',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('cancelled');
  });

  it('completed -> planned: 非法转换返回 VALIDATION_ERROR', async () => {
    const created = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'lesson',
      title: '已完成',
      scheduledStart: new Date('2025-03-15T14:00:00'),
      scheduledEnd: new Date('2025-03-15T15:00:00'),
    });
    if (!created.ok) return;
    await service.updateScheduleStatus({
      scheduleId: created.value.schedule.id,
      targetStatus: 'completed',
    });

    const result = await service.updateScheduleStatus({
      scheduleId: created.value.schedule.id,
      targetStatus: 'planned',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('不存在的日程返回 NOT_FOUND', async () => {
    const result = await service.updateScheduleStatus({
      scheduleId: 'nonexistent',
      targetStatus: 'completed',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('scheduleService.cancelSchedule', () => {
  it('取消日程：状态变为 cancelled，写 ChangeLog', async () => {
    const created = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'lesson',
      title: '待取消',
      scheduledStart: new Date('2025-03-15T14:00:00'),
      scheduledEnd: new Date('2025-03-15T15:00:00'),
    });
    if (!created.ok) return;

    const result = await createExtendedScheduleService().cancelSchedule({
      teacherId: TEACHER_ID,
      scheduleId: created.value.schedule.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('cancelled');

    const logs = await prisma.changeLog.findMany({
      where: { targetType: 'Schedule', targetId: created.value.schedule.id },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(expect.objectContaining({ action: 'cancel', source: 'manual' }));
  });

  it('审计写入 Err 时取消整体回滚，且不泄露底层错误', async () => {
    const created = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'lesson',
      title: '审计失败待取消',
      scheduledStart: new Date('2025-03-16T14:00:00'),
      scheduledEnd: new Date('2025-03-16T15:00:00'),
    });
    if (!created.ok) return;

    const failingService = createExtendedScheduleService(failingChangelogFactory);
    const result = await failingService.cancelSchedule({
      teacherId: TEACHER_ID,
      scheduleId: created.value.schedule.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(expect.objectContaining({
      code: 'INTERNAL_ERROR',
      message: '取消日程失败',
    }));
    expect(result.error.message).not.toContain(AUDIT_SECRET);
    expect((await prisma.schedule.findUniqueOrThrow({
      where: { id: created.value.schedule.id },
    })).status).toBe('planned');
    expect(await prisma.changeLog.count({
      where: { targetType: 'Schedule', targetId: created.value.schedule.id, action: 'cancel' },
    })).toBe(0);
  });

  it('取消不存在的日程返回 NOT_FOUND', async () => {
    const result = await service.cancelSchedule({ teacherId: TEACHER_ID, scheduleId: 'nonexistent' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('scheduleService.restoreSchedule', () => {
  it('恢复已取消日程：状态回到 planned，写 ChangeLog', async () => {
    const created = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'lesson',
      title: '待恢复',
      scheduledStart: new Date('2025-04-01T10:00:00'),
      scheduledEnd: new Date('2025-04-01T11:00:00'),
    });
    if (!created.ok) return;
    const cancelled = await service.cancelSchedule({ teacherId: TEACHER_ID, scheduleId: created.value.schedule.id });
    expect(cancelled.ok).toBe(true);
    await prisma.changeLog.deleteMany({ where: { targetId: created.value.schedule.id } });

    const restored = await createExtendedScheduleService().restoreSchedule({
      teacherId: TEACHER_ID,
      scheduleId: created.value.schedule.id,
    });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.status).toBe('planned');

    const logs = await prisma.changeLog.findMany({
      where: { targetType: 'Schedule', targetId: created.value.schedule.id },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(expect.objectContaining({ action: 'restore', source: 'manual' }));
  });

  it('审计写入 Err 时恢复整体回滚，且不泄露底层错误', async () => {
    const created = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'lesson',
      title: '审计失败待恢复',
      scheduledStart: new Date('2025-04-01T12:00:00'),
      scheduledEnd: new Date('2025-04-01T13:00:00'),
    });
    if (!created.ok) return;
    const cancelled = await service.cancelSchedule({
      teacherId: TEACHER_ID,
      scheduleId: created.value.schedule.id,
    });
    if (!cancelled.ok) return;
    await prisma.changeLog.deleteMany({ where: { targetId: created.value.schedule.id } });

    const failingService = createExtendedScheduleService(failingChangelogFactory);
    const result = await failingService.restoreSchedule({
      teacherId: TEACHER_ID,
      scheduleId: created.value.schedule.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(expect.objectContaining({
      code: 'INTERNAL_ERROR',
      message: '恢复日程失败',
    }));
    expect(result.error.message).not.toContain(AUDIT_SECRET);
    expect((await prisma.schedule.findUniqueOrThrow({
      where: { id: created.value.schedule.id },
    })).status).toBe('cancelled');
    expect(await prisma.changeLog.count({
      where: { targetType: 'Schedule', targetId: created.value.schedule.id, action: 'restore' },
    })).toBe(0);
  });

  it('恢复时与其他日程时间重叠返回 VALIDATION_ERROR', async () => {
    const created = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'lesson',
      title: '冲突源',
      scheduledStart: new Date('2025-04-02T10:00:00'),
      scheduledEnd: new Date('2025-04-02T11:00:00'),
    });
    if (!created.ok) return;
    await service.cancelSchedule({ teacherId: TEACHER_ID, scheduleId: created.value.schedule.id });

    const overlap = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'lesson',
      title: '重叠占用',
      scheduledStart: new Date('2025-04-02T10:30:00'),
      scheduledEnd: new Date('2025-04-02T11:30:00'),
    });
    if (!overlap.ok) return;

    const restored = await service.restoreSchedule({ teacherId: TEACHER_ID, scheduleId: created.value.schedule.id });
    expect(restored.ok).toBe(false);
    if (restored.ok) return;
    expect(restored.error.code).toBe('VALIDATION_ERROR');
  });

  it('恢复非 cancelled 日程返回 VALIDATION_ERROR', async () => {
    const created = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'lesson',
      title: '未取消',
      scheduledStart: new Date('2025-04-03T10:00:00'),
      scheduledEnd: new Date('2025-04-03T11:00:00'),
    });
    if (!created.ok) return;

    const restored = await service.restoreSchedule({ teacherId: TEACHER_ID, scheduleId: created.value.schedule.id });
    expect(restored.ok).toBe(false);
    if (restored.ok) return;
    expect(restored.error.code).toBe('VALIDATION_ERROR');
  });

  it('跨 teacher 恢复返回 NOT_FOUND', async () => {
    const created = await service.createSchedule({
      teacherId: TEACHER_ID,
      type: 'lesson',
      title: '隔离',
      scheduledStart: new Date('2025-04-04T10:00:00'),
      scheduledEnd: new Date('2025-04-04T11:00:00'),
    });
    if (!created.ok) return;

    const restored = await service.restoreSchedule({ teacherId: 'other-teacher', scheduleId: created.value.schedule.id });
    expect(restored.ok).toBe(false);
    if (restored.ok) return;
    expect(restored.error.code).toBe('NOT_FOUND');
  });
});
