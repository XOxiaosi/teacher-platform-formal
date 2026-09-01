import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createChangelogService } from '../../../src/shared/changelog/changelog-service.js';

const prisma = new PrismaClient();
const service = createChangelogService(prisma);

const TEACHER_ID = 'test-teacher-changelog';

// 测试后清理
async function cleanup() {
  await prisma.changeLog.deleteMany({
    where: { teacherId: TEACHER_ID },
  });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('changelogService.recordChange', () => {
  it('create 动作：before 为 null，记录新对象', async () => {
    const result = await service.recordChange({
      teacherId: TEACHER_ID,
      module: 'students',
      action: 'create',
      targetType: 'Student',
      targetId: 'student-001',
      before: null,
      after: { name: '张三', grade: '高三' },
      source: 'manual',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.module).toBe('students');
    expect(result.value.action).toBe('create');
    expect(result.value.targetId).toBe('student-001');
    expect(result.value.before).toBeNull();
    expect(result.value.after).toEqual({ name: '张三', grade: '高三' });
    expect(result.value.diff).not.toBeNull();
    expect(result.value.diff!.length).toBe(2);
  });

  it('update 动作：记录 before/after/diff', async () => {
    const result = await service.recordChange({
      teacherId: TEACHER_ID,
      module: 'students',
      action: 'update',
      targetType: 'Student',
      targetId: 'student-002',
      before: { name: '张三', grade: '高三' },
      after: { name: '张三', grade: '高二' },
      source: 'manual',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.before).toEqual({ name: '张三', grade: '高三' });
    expect(result.value.after).toEqual({ name: '张三', grade: '高二' });
    expect(result.value.diff).toEqual([
      { field: 'grade', oldValue: '高三', newValue: '高二' },
    ]);
  });

  it('delete 动作：after 为 null', async () => {
    const result = await service.recordChange({
      teacherId: TEACHER_ID,
      module: 'students',
      action: 'delete',
      targetType: 'Student',
      targetId: 'student-003',
      before: { name: '张三' },
      after: null,
      source: 'system',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.after).toBeNull();
    expect(result.value.before).toEqual({ name: '张三' });
  });

  it('记录 operatorId（可选字段）', async () => {
    const result = await service.recordChange({
      teacherId: TEACHER_ID,
      module: 'scheduling',
      action: 'create',
      targetType: 'Schedule',
      targetId: 'schedule-001',
      before: null,
      after: { title: '物理课' },
      source: 'ai-note',
      operatorId: 'ai-session-001',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.operatorId).toBe('ai-session-001');
  });
});

describe('changelogService.queryChangeLogs', () => {
  it('按 teacherId 查询返回所有记录', async () => {
    await service.recordChange({
      teacherId: TEACHER_ID,
      module: 'students',
      action: 'create',
      targetType: 'Student',
      targetId: 's1',
      before: null,
      after: { name: '张三' },
      source: 'manual',
    });
    await service.recordChange({
      teacherId: TEACHER_ID,
      module: 'scheduling',
      action: 'create',
      targetType: 'Schedule',
      targetId: 'sc1',
      before: null,
      after: { title: '物理课' },
      source: 'ai-note',
    });

    const result = await service.queryChangeLogs({ teacherId: TEACHER_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.items.length).toBe(2);
    expect(result.value.total).toBe(2);
  });

  it('按 module 过滤', async () => {
    await service.recordChange({
      teacherId: TEACHER_ID,
      module: 'students',
      action: 'create',
      targetType: 'Student',
      targetId: 's1',
      before: null,
      after: { name: '张三' },
      source: 'manual',
    });
    await service.recordChange({
      teacherId: TEACHER_ID,
      module: 'scheduling',
      action: 'create',
      targetType: 'Schedule',
      targetId: 'sc1',
      before: null,
      after: { title: '物理课' },
      source: 'ai-note',
    });

    const result = await service.queryChangeLogs({
      teacherId: TEACHER_ID,
      module: 'students',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.items.length).toBe(1);
    expect(result.value.items[0].module).toBe('students');
  });

  it('按 targetType 和 targetId 过滤', async () => {
    await service.recordChange({
      teacherId: TEACHER_ID,
      module: 'students',
      action: 'create',
      targetType: 'Student',
      targetId: 's1',
      before: null,
      after: { name: '张三' },
      source: 'manual',
    });
    await service.recordChange({
      teacherId: TEACHER_ID,
      module: 'students',
      action: 'update',
      targetType: 'Student',
      targetId: 's1',
      before: { name: '张三' },
      after: { name: '李四' },
      source: 'manual',
    });
    await service.recordChange({
      teacherId: TEACHER_ID,
      module: 'students',
      action: 'create',
      targetType: 'Student',
      targetId: 's2',
      before: null,
      after: { name: '王五' },
      source: 'manual',
    });

    const result = await service.queryChangeLogs({
      teacherId: TEACHER_ID,
      targetType: 'Student',
      targetId: 's1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.items.length).toBe(2);
    expect(result.value.items.every((item) => item.targetId === 's1')).toBe(true);
  });

  it('按 action 过滤', async () => {
    await service.recordChange({
      teacherId: TEACHER_ID,
      module: 'students',
      action: 'create',
      targetType: 'Student',
      targetId: 's1',
      before: null,
      after: { name: '张三' },
      source: 'manual',
    });
    await service.recordChange({
      teacherId: TEACHER_ID,
      module: 'students',
      action: 'update',
      targetType: 'Student',
      targetId: 's1',
      before: { name: '张三' },
      after: { name: '李四' },
      source: 'manual',
    });

    const result = await service.queryChangeLogs({
      teacherId: TEACHER_ID,
      action: 'create',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.items.length).toBe(1);
    expect(result.value.items[0].action).toBe('create');
  });

  it('按时间范围过滤', async () => {
    const oldDate = new Date('2025-01-01');
    const newDate = new Date('2025-06-01');

    await service.recordChange({
      teacherId: TEACHER_ID,
      module: 'students',
      action: 'create',
      targetType: 'Student',
      targetId: 's1',
      before: null,
      after: { name: '张三' },
      source: 'manual',
    });

    const result = await service.queryChangeLogs({
      teacherId: TEACHER_ID,
      dateFrom: oldDate,
      dateTo: newDate,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.items.length).toBe(0);
  });

  it('结果按时间倒序排列', async () => {
    await service.recordChange({
      teacherId: TEACHER_ID,
      module: 'students',
      action: 'create',
      targetType: 'Student',
      targetId: 'first',
      before: null,
      after: { name: '第一个' },
      source: 'manual',
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    await service.recordChange({
      teacherId: TEACHER_ID,
      module: 'students',
      action: 'create',
      targetType: 'Student',
      targetId: 'second',
      before: null,
      after: { name: '第二个' },
      source: 'manual',
    });

    const result = await service.queryChangeLogs({ teacherId: TEACHER_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.items[0].targetId).toBe('second');
    expect(result.value.items[1].targetId).toBe('first');
  });

  it('分页：page 和 pageSize', async () => {
    for (let i = 0; i < 5; i++) {
      await service.recordChange({
        teacherId: TEACHER_ID,
        module: 'students',
        action: 'create',
        targetType: 'Student',
        targetId: `s${i}`,
        before: null,
        after: { name: `学生${i}` },
        source: 'manual',
      });
    }

    const result = await service.queryChangeLogs({
      teacherId: TEACHER_ID,
      page: 1,
      pageSize: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.items.length).toBe(2);
    expect(result.value.total).toBe(5);
  });
});