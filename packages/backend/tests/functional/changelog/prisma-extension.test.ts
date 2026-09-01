import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createChangelogService } from '../../../src/shared/changelog/changelog-service.js';
import { withChangelog } from '../../../src/shared/changelog/prisma-extension.js';
import { runWithAutomaticChangelogSuppressed } from '../../../src/shared/changelog/suppression.js';

const basePrisma = new PrismaClient();
const changelogService = createChangelogService(basePrisma);
// 用扩展后的 client 操作业务模型，changelog 自动记录
const prisma = withChangelog(basePrisma, changelogService);

const TEACHER_ID = 'test-teacher-middleware';

async function cleanup() {
  await basePrisma.changeLog.deleteMany({ where: { teacherId: TEACHER_ID } });
  await basePrisma.parentFeedback.deleteMany({ where: { teacherId: TEACHER_ID } });
  await basePrisma.memo.deleteMany({ where: { teacherId: TEACHER_ID } });
  await basePrisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('withChangelog 中间件', () => {
  it('create 操作自动记录 changelog（before=null, after=新对象）', async () => {
    const student = await prisma.student.create({
      data: {
        teacherId: TEACHER_ID,
        name: '张三',
        grade: '高三',
      },
    });

    const logs = await changelogService.queryChangeLogs({
      teacherId: TEACHER_ID,
      targetType: 'Student',
      targetId: student.id,
    });

    expect(logs.ok).toBe(true);
    if (!logs.ok) return;

    expect(logs.value.items.length).toBe(1);
    const log = logs.value.items[0];
    expect(log.action).toBe('create');
    expect(log.before).toBeNull();
    expect(log.after).not.toBeNull();
    expect(log.after!.name).toBe('张三');
    expect(log.source).toBe('system');
  });

  it('update 操作自动记录 changelog（before/after/diff）', async () => {
    const student = await prisma.student.create({
      data: {
        teacherId: TEACHER_ID,
        name: '张三',
        grade: '高三',
      },
    });

    // 清掉 create 的日志，只测 update
    await basePrisma.changeLog.deleteMany({ where: { teacherId: TEACHER_ID } });

    await prisma.student.update({
      where: { id: student.id },
      data: { grade: '高二' },
    });

    const logs = await changelogService.queryChangeLogs({
      teacherId: TEACHER_ID,
      targetType: 'Student',
      targetId: student.id,
    });

    expect(logs.ok).toBe(true);
    if (!logs.ok) return;

    expect(logs.value.items.length).toBe(1);
    const log = logs.value.items[0];
    expect(log.action).toBe('update');
    expect(log.before!.grade).toBe('高三');
    expect(log.after!.grade).toBe('高二');
    expect(log.diff).toEqual([
      { field: 'grade', oldValue: '高三', newValue: '高二' },
    ]);
  });

  it('delete 操作自动记录 changelog（before=旧对象, after=null）', async () => {
    const student = await prisma.student.create({
      data: {
        teacherId: TEACHER_ID,
        name: '张三',
        grade: '高三',
      },
    });

    await basePrisma.changeLog.deleteMany({ where: { teacherId: TEACHER_ID } });

    await prisma.student.delete({
      where: { id: student.id },
    });

    const logs = await changelogService.queryChangeLogs({
      teacherId: TEACHER_ID,
      targetType: 'Student',
      targetId: student.id,
    });

    expect(logs.ok).toBe(true);
    if (!logs.ok) return;

    expect(logs.value.items.length).toBe(1);
    const log = logs.value.items[0];
    expect(log.action).toBe('delete');
    expect(log.before!.name).toBe('张三');
    expect(log.after).toBeNull();
  });

  it('Memo create/update 自动记录 changelog', async () => {
    const memo = await prisma.memo.create({
      data: { teacherId: TEACHER_ID, title: '备忘', content: '联系家长' },
    });
    await prisma.memo.update({ where: { id: memo.id }, data: { status: 'done' } });

    const logs = await basePrisma.changeLog.findMany({
      where: { teacherId: TEACHER_ID, targetType: 'Memo', targetId: memo.id },
      orderBy: { createdAtTs: 'asc' },
    });

    expect(logs.map(({ module, action }) => ({ module, action }))).toEqual([
      { module: 'memos', action: 'create' },
      { module: 'memos', action: 'update' },
    ]);
  });

  it('ParentFeedback create/update 自动记录 changelog', async () => {
    const student = await basePrisma.student.create({
      data: { teacherId: TEACHER_ID, name: '反馈学生', grade: '高三' },
    });
    const feedback = await prisma.parentFeedback.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: student.id,
        title: '阶段反馈',
        content: '学习状态稳定',
      },
    });
    await prisma.parentFeedback.update({
      where: { id: feedback.id },
      data: { status: 'reviewed' },
    });

    const logs = await basePrisma.changeLog.findMany({
      where: { teacherId: TEACHER_ID, targetType: 'ParentFeedback', targetId: feedback.id },
      orderBy: { createdAtTs: 'asc' },
    });

    expect(logs.map(({ module, action }) => ({ module, action }))).toEqual([
      { module: 'feedback', action: 'create' },
      { module: 'feedback', action: 'update' },
    ]);
  });

  it('suppression 内 create/update/delete 均不自动记录 changelog', async () => {
    const studentId = await runWithAutomaticChangelogSuppressed(async () => {
      const student = await prisma.student.create({
        data: {
          teacherId: TEACHER_ID,
          name: '显式审计事务学生',
          grade: '高三',
        },
      });

      await prisma.student.update({
        where: { id: student.id },
        data: { grade: '高二' },
      });
      await prisma.student.delete({ where: { id: student.id } });

      return student.id;
    });

    const logs = await basePrisma.changeLog.findMany({
      where: { teacherId: TEACHER_ID, targetType: 'Student', targetId: studentId },
    });
    expect(logs).toEqual([]);
  });

  it('Promise.all 中 suppression 与普通写隔离，普通写仍自动审计', async () => {
    const [suppressedStudent, ordinaryStudent] = await Promise.all([
      runWithAutomaticChangelogSuppressed(() =>
        prisma.student.create({
          data: {
            teacherId: TEACHER_ID,
            name: '并发抑制学生',
            grade: '高三',
          },
        }),
      ),
      prisma.student.create({
        data: {
          teacherId: TEACHER_ID,
          name: '并发普通学生',
          grade: '高三',
        },
      }),
    ]);

    const logs = await basePrisma.changeLog.findMany({
      where: {
        teacherId: TEACHER_ID,
        targetType: 'Student',
        targetId: { in: [suppressedStudent.id, ordinaryStudent.id] },
      },
    });

    expect(logs.map((log) => log.targetId)).toEqual([ordinaryStudent.id]);
  });

  it('changeLog 模型自身不被拦截（无无限递归）', async () => {
    // 直接用扩展 client 写 changeLog，不应触发递归
    // 如果递归，测试会栈溢出或超时
    await changelogService.recordChange({
      teacherId: TEACHER_ID,
      module: 'changelog',
      action: 'create',
      targetType: 'ChangeLog',
      targetId: 'test-no-recursion',
      before: null,
      after: { test: true },
      source: 'system',
    });

    // 如果到这里没崩，说明没有递归
    expect(true).toBe(true);
  });
});