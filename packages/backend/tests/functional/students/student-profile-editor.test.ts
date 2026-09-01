import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { internalError, ok } from '@teacher-platform/contracts';
import { createStudentService } from '../../../src/features/students/student-service.js';

let createStudentProfileEditor: unknown;
let importError: unknown;
try {
  const module = await import('../../../src/features/students/student-profile-editor.js');
  createStudentProfileEditor = module.createStudentProfileEditor;
} catch (caught) {
  importError = caught;
}

const prisma = new PrismaClient();
const TEACHER_A = 'student-profile-owner-a';
const TEACHER_B = 'student-profile-owner-b';
const BASE_TOKEN = new Date('2030-01-01T00:00:00.000Z');
const NEXT_TOKEN = new Date('2030-01-02T00:00:00.000Z');

function requireFactory() {
  if (importError) {
    throw new Error(
      `student-profile editor import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (typeof createStudentProfileEditor !== 'function') {
    throw new Error('createStudentProfileEditor export is missing');
  }
  return createStudentProfileEditor as (options: { prisma: PrismaClient; trustedClock: any }) => {
    updateStudentProfile(input: any): Promise<any>;
  };
}

function trustedClock(result: any = ok(NEXT_TOKEN)) {
  return { now: vi.fn().mockResolvedValue(result) };
}

async function createStudent(teacherId = TEACHER_A) {
  return prisma.student.create({
    data: {
      teacherId,
      name: '张三',
      grade: '高一',
      source: '家长介绍',
      stageGoal: '夯实力学',
      updatedAtTs: BASE_TOKEN,
    },
  });
}

async function cleanup() {
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
}

beforeEach(cleanup);
afterEach(cleanup);

describe('StudentProfileEditor owner CAS', () => {
  it('导出独立窄owner且不替换旧StudentService', () => {
    expect(requireFactory()).toBeTypeOf('function');
    expect(createStudentService(prisma).updateStudent).toBeTypeOf('function');
  });

  it('owned对象按白名单更新并返回before/after，不由owner写ChangeLog', async () => {
    const student = await createStudent();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateStudentProfile({
      teacherId: TEACHER_A,
      studentId: student.id,
      expectedUpdatedAt: BASE_TOKEN,
      changes: {
        name: '张三同学',
        grade: '高二',
        source: null,
        stageGoal: null,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.before).toMatchObject({ name: '张三', grade: '高一', source: '家长介绍' });
    expect(result.value.after).toMatchObject({
      name: '张三同学',
      grade: '高二',
      source: null,
      stageGoal: null,
      updatedAt: NEXT_TOKEN,
    });
    expect(result.value.after.updatedAt.getTime()).not.toBe(result.value.before.updatedAt.getTime());
    expect(clock.now).toHaveBeenCalledTimes(1);
    const persisted = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(persisted.updatedAtTs).toBeInstanceOf(Date);
    expect(persisted.updatedAtTs).toBeInstanceOf(Date);
    expect(await prisma.changeLog.count({ where: { targetId: student.id } })).toBe(0);
  });

  it.each([
    { teacherId: TEACHER_B, studentId: 'owned-id' },
    { teacherId: TEACHER_A, studentId: 'missing-id' },
  ])('跨teacher或不存在统一NOT_FOUND且不调用clock：$teacherId/$studentId', async ({ teacherId, studentId }) => {
    const student = await createStudent();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateStudentProfile({
      teacherId,
      studentId: studentId === 'owned-id' ? student.id : studentId,
      expectedUpdatedAt: new Date('1999-01-01T00:00:00.000Z'),
      changes: { name: '   ' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(clock.now).not.toHaveBeenCalled();
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).name).toBe('张三');
  });

  it('owned stale优先于字段与no-op校验返回VERSION_CONFLICT', async () => {
    const student = await createStudent();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateStudentProfile({
      teacherId: TEACHER_A,
      studentId: student.id,
      expectedUpdatedAt: new Date('2029-12-31T00:00:00.000Z'),
      changes: { name: '   ', grade: student.grade },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VERSION_CONFLICT', field: 'expectedUpdatedAt' });
    expect(clock.now).not.toHaveBeenCalled();
  });

  it.each([
    { changes: { name: '   ' }, field: 'name' },
    { changes: { grade: '' }, field: 'grade' },
    { changes: {}, field: 'changes' },
    { changes: { currentStatus: 'paused' }, field: 'changes' },
  ])('版本通过后拒绝非法领域修改：$field/$changes', async ({ changes, field }) => {
    const student = await createStudent();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateStudentProfile({
      teacherId: TEACHER_A,
      studentId: student.id,
      expectedUpdatedAt: student.updatedAtTs,
      changes,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VALIDATION_ERROR', field });
    expect(clock.now).not.toHaveBeenCalled();
    const persisted = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(persisted.updatedAtTs).toEqual(BASE_TOKEN);
  });

  it('事实no-op不调用clock、不推进token且不写日志', async () => {
    const student = await createStudent();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateStudentProfile({
      teacherId: TEACHER_A,
      studentId: student.id,
      expectedUpdatedAt: student.updatedAtTs,
      changes: { name: student.name, source: student.source, stageGoal: student.stageGoal },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'changes' });
    expect(clock.now).not.toHaveBeenCalled();
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).updatedAtTs).toEqual(BASE_TOKEN);
    expect(await prisma.changeLog.count({ where: { targetId: student.id } })).toBe(0);
  });

  it('TrustedClock失败时零业务写', async () => {
    const student = await createStudent();
    const clock = trustedClock({ ok: false, error: internalError('数据库可信时间不可用') });
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateStudentProfile({
      teacherId: TEACHER_A,
      studentId: student.id,
      expectedUpdatedAt: student.updatedAtTs,
      changes: { name: '新姓名' },
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    const persisted = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(persisted).toMatchObject({ name: '张三', updatedAtTs: BASE_TOKEN });
  });

  it('TrustedClock返回before同token时零业务写', async () => {
    const student = await createStudent();
    const editor = requireFactory()({ prisma, trustedClock: trustedClock(ok(BASE_TOKEN)) });

    const result = await editor.updateStudentProfile({
      teacherId: TEACHER_A,
      studentId: student.id,
      expectedUpdatedAt: student.updatedAtTs,
      changes: { name: '新姓名' },
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).name).toBe('张三');
  });

  it('system省略expected仍以读取到的before token执行成功CAS', async () => {
    const student = await createStudent();
    const editor = requireFactory()({ prisma, trustedClock: trustedClock() });

    const result = await editor.updateStudentProfile({
      teacherId: TEACHER_A,
      studentId: student.id,
      expectedUpdatedAt: undefined,
      changes: { stageGoal: '提升实验题' },
    });

    expect(result.ok).toBe(true);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).updatedAtTs).toEqual(NEXT_TOKEN);
  });

  it('条件写前对象消失时重读分类为NOT_FOUND', async () => {
    const student = await createStudent();
    const clock = {
      now: vi.fn(async () => {
        await prisma.student.delete({ where: { id: student.id } });
        return ok(NEXT_TOKEN);
      }),
    };
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateStudentProfile({
      teacherId: TEACHER_A,
      studentId: student.id,
      expectedUpdatedAt: student.updatedAtTs,
      changes: { name: '新姓名' },
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });
  });

  it('同一expected并发且都已读取before时恰好一胜一冲突', async () => {
    const student = await createStudent();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const clock = {
      now: vi.fn(async () => {
        calls += 1;
        if (calls === 2) release();
        await gate;
        return ok(NEXT_TOKEN);
      }),
    };
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const results = await Promise.all([
      editor.updateStudentProfile({
        teacherId: TEACHER_A,
        studentId: student.id,
        expectedUpdatedAt: student.updatedAtTs,
        changes: { name: '并发A' },
      }),
      editor.updateStudentProfile({
        teacherId: TEACHER_A,
        studentId: student.id,
        expectedUpdatedAt: student.updatedAtTs,
        changes: { name: '并发B' },
      }),
    ]);

    expect(results.map((result) => result.ok ? 'OK' : result.error.code).sort()).toEqual([
      'OK',
      'VERSION_CONFLICT',
    ]);
    const persisted = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(['并发A', '并发B']).toContain(persisted.name);
    expect(persisted.updatedAtTs).toEqual(NEXT_TOKEN);
  });
});
