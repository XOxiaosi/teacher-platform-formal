import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createStudentService } from '../../../src/features/students/student-service.js';

const prisma = new PrismaClient();
const service = createStudentService(prisma);

const TEACHER_ID = 'test-teacher-students';

async function cleanup() {
  await prisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.changeLog.deleteMany({ where: { teacherId: TEACHER_ID } });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('studentService.createStudent', () => {
  it('创建学生：默认状态为 active', async () => {
    const result = await service.createStudent({
      teacherId: TEACHER_ID,
      name: '张三',
      grade: '高三',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('张三');
    expect(result.value.grade).toBe('高三');
    expect(result.value.currentStatus).toBe('active');
  });

  it('创建学生带可选字段', async () => {
    const result = await service.createStudent({
      teacherId: TEACHER_ID,
      name: '李四',
      grade: '高二',
      source: '朋友介绍',
      stageGoal: '高考冲刺',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe('朋友介绍');
    expect(result.value.stageGoal).toBe('高考冲刺');
  });

  it('缺少必填字段返回 VALIDATION_ERROR', async () => {
    const result = await service.createStudent({
      teacherId: TEACHER_ID,
      name: '',
      grade: '高三',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('studentService.getStudent', () => {
  it('查询单个学生：返回完整数据', async () => {
    const created = await service.createStudent({
      teacherId: TEACHER_ID,
      name: '张三',
      grade: '高三',
    });
    if (!created.ok) return;

    const result = await service.getStudent(created.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('张三');
  });

  it('查询不存在的学生返回 NOT_FOUND', async () => {
    const result = await service.getStudent('nonexistent');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('studentService.listStudents', () => {
  it('按 teacherId 查询返回所有学生', async () => {
    await service.createStudent({ teacherId: TEACHER_ID, name: '张三', grade: '高三' });
    await service.createStudent({ teacherId: TEACHER_ID, name: '李四', grade: '高二' });

    const result = await service.listStudents({ teacherId: TEACHER_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBe(2);
  });

  it('按 status 过滤', async () => {
    const s1 = await service.createStudent({ teacherId: TEACHER_ID, name: '在读', grade: '高三' });
    const s2 = await service.createStudent({ teacherId: TEACHER_ID, name: '暂停', grade: '高二' });
    if (!s1.ok || !s2.ok) return;
    await service.updateStudentStatus({ studentId: s2.value.id, targetStatus: 'paused' });

    const result = await service.listStudents({ teacherId: TEACHER_ID, status: 'paused' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBe(1);
    expect(result.value.items[0].name).toBe('暂停');
  });

  it('不返回其他老师的学生', async () => {
    await service.createStudent({ teacherId: TEACHER_ID, name: '我的学生', grade: '高三' });
    await service.createStudent({ teacherId: 'other-teacher', name: '别人的学生', grade: '高三' });

    const result = await service.listStudents({ teacherId: TEACHER_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBe(1);
    expect(result.value.items[0].name).toBe('我的学生');
  });
});

describe('studentService.updateStudent', () => {
  it('修改学生信息', async () => {
    const created = await service.createStudent({ teacherId: TEACHER_ID, name: '张三', grade: '高三' });
    if (!created.ok) return;

    const result = await service.updateStudent({
      studentId: created.value.id,
      name: '张三丰',
      stageGoal: '竞赛保送',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('张三丰');
    expect(result.value.stageGoal).toBe('竞赛保送');
  });

  it('修改不存在的学生返回 NOT_FOUND', async () => {
    const result = await service.updateStudent({ studentId: 'nonexistent', name: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('studentService.updateStudentStatus', () => {
  it('active -> paused: 合法', async () => {
    const created = await service.createStudent({ teacherId: TEACHER_ID, name: '张三', grade: '高三' });
    if (!created.ok) return;

    const result = await service.updateStudentStatus({
      studentId: created.value.id,
      targetStatus: 'paused',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currentStatus).toBe('paused');
    const persisted = await prisma.student.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(persisted.updatedAtTs).toBeInstanceOf(Date);
  });

  it('paused -> active: 合法', async () => {
    const created = await service.createStudent({ teacherId: TEACHER_ID, name: '张三', grade: '高三' });
    if (!created.ok) return;
    await service.updateStudentStatus({ studentId: created.value.id, targetStatus: 'paused' });

    const result = await service.updateStudentStatus({
      studentId: created.value.id,
      targetStatus: 'active',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currentStatus).toBe('active');
  });

  it('finished -> active: 非法', async () => {
    const created = await service.createStudent({ teacherId: TEACHER_ID, name: '张三', grade: '高三' });
    if (!created.ok) return;
    await service.updateStudentStatus({ studentId: created.value.id, targetStatus: 'finished' });

    const result = await service.updateStudentStatus({
      studentId: created.value.id,
      targetStatus: 'active',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('不存在的学生返回 NOT_FOUND', async () => {
    const result = await service.updateStudentStatus({
      studentId: 'nonexistent',
      targetStatus: 'paused',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});