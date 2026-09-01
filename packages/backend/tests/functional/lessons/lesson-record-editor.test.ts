import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { internalError, ok } from '@teacher-platform/contracts';
import { createLessonService } from '../../../src/features/lessons/lesson-service.js';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';

// P8 phase-3 批4：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);

let createLessonRecordEditor: unknown;
let importError: unknown;
try {
  const module = await import('../../../src/features/lessons/lesson-record-editor.js');
  createLessonRecordEditor = module.createLessonRecordEditor;
} catch (caught) {
  importError = caught;
}

const prisma = new PrismaClient();
const TEACHER_A = 'lesson-record-owner-a';
const TEACHER_B = 'lesson-record-owner-b';
const BASE_TOKEN = new Date('2030-01-01T00:00:00.000Z');
const NEXT_TOKEN = new Date('2030-01-02T00:00:00.000Z');
const LESSON_DATE = new Date('2030-01-01T08:00:00.000Z');

function requireFactory() {
  if (importError) {
    throw new Error(
      `lesson-record editor import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (typeof createLessonRecordEditor !== 'function') {
    throw new Error('createLessonRecordEditor export is missing');
  }
  return createLessonRecordEditor as (options: { prisma: PrismaClient; trustedClock: any }) => {
    updateLessonRecord(input: any): Promise<any>;
  };
}

function trustedClock(result: any = ok(NEXT_TOKEN)) {
  return { now: vi.fn().mockResolvedValue(result) };
}

async function createFixture(teacherId = TEACHER_A) {
  const student = await prisma.student.create({
    data: { teacherId, name: '张三', grade: '高一' },
  });
  const schedule = await prisma.schedule.create({
    data: {
      teacherId,
      studentId: student.id,
      type: 'lesson',
      title: 'Lesson record测试课',
      scheduledStartTs: LESSON_DATE,
      scheduledEndTs: new Date('2030-01-01T09:00:00.000Z'),
      status: 'completed',
    },
  });
  const lesson = await prisma.lesson.create({
    data: {
      teacherId,
      studentId: student.id,
      scheduleId: schedule.id,
      dateTs: LESSON_DATE,
      status: 'attended',
      progress: '力学综合题',
      studentState: '课堂专注',
      homework: '完成练习1-5',
      teacherNote: '计算细节待巩固',
      sourceNoteId: 'source-note-1',
      updatedAtTs: BASE_TOKEN,
    },
  });
  return { student, schedule, lesson };
}

async function cleanup() {
  const teachers = [TEACHER_A, TEACHER_B];
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teachers } } });
}

beforeEach(cleanup);
afterEach(cleanup);

describe('LessonRecordEditor owner CAS', () => {
  it('导出独立窄owner且不替换旧LessonService', () => {
    expect(requireFactory()).toBeTypeOf('function');
    expect(createLessonService(prisma).updateLesson).toBeTypeOf('function');
  });

  it('owned对象接受空字符串与null，只更新四个记录字段并返回before/after', async () => {
    const { lesson } = await createFixture();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateLessonRecord({
      teacherId: TEACHER_A,
      lessonId: lesson.id,
      expectedUpdatedAt: lesson.updatedAtTs,
      changes: {
        progress: '',
        studentState: null,
        homework: '完成专题训练',
        teacherNote: null,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.before).toMatchObject({
      progress: '力学综合题',
      studentState: '课堂专注',
      homework: '完成练习1-5',
      teacherNote: '计算细节待巩固',
    });
    expect(result.value.after).toMatchObject({
      progress: '',
      studentState: null,
      homework: '完成专题训练',
      teacherNote: null,
      status: 'attended',
      studentId: lesson.studentId,
      scheduleId: lesson.scheduleId,
      date: LESSON_DATE,
      sourceNoteId: 'source-note-1',
      updatedAt: NEXT_TOKEN,
    });
    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(await prisma.changeLog.count({ where: { targetId: lesson.id } })).toBe(0);

    const persisted = await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } });
    expect(persisted.updatedAtTs).toBeInstanceOf(Date);
    expect(persisted.updatedAtTs!.getTime()).toBe(NEXT_TOKEN.getTime());
  });

  it('省略字段保持原值', async () => {
    const { lesson } = await createFixture();
    const editor = requireFactory()({ prisma, trustedClock: trustedClock() });

    const result = await editor.updateLessonRecord({
      teacherId: TEACHER_A,
      lessonId: lesson.id,
      expectedUpdatedAt: lesson.updatedAtTs,
      changes: { progress: '电场专题' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.after).toMatchObject({
      progress: '电场专题',
      studentState: '课堂专注',
      homework: '完成练习1-5',
      teacherNote: '计算细节待巩固',
    });
  });

  it.each([
    { teacherId: TEACHER_B, lessonId: 'owned-id' },
    { teacherId: TEACHER_A, lessonId: 'missing-id' },
  ])('跨teacher或不存在统一NOT_FOUND且不调用clock：$teacherId/$lessonId', async ({ teacherId, lessonId }) => {
    const { lesson } = await createFixture();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateLessonRecord({
      teacherId,
      lessonId: lessonId === 'owned-id' ? lesson.id : lessonId,
      expectedUpdatedAt: new Date('1999-01-01T00:00:00.000Z'),
      changes: { progress: lesson.progress },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(clock.now).not.toHaveBeenCalled();
    expect((await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } })).progress).toBe('力学综合题');
  });

  it('owned stale优先于no-op返回VERSION_CONFLICT', async () => {
    const { lesson } = await createFixture();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateLessonRecord({
      teacherId: TEACHER_A,
      lessonId: lesson.id,
      expectedUpdatedAt: new Date('2029-12-31T00:00:00.000Z'),
      changes: { progress: lesson.progress, teacherNote: lesson.teacherNote },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VERSION_CONFLICT', field: 'expectedUpdatedAt' });
    expect(clock.now).not.toHaveBeenCalled();
  });

  it.each([
    { changes: {}, field: 'changes' },
    { changes: { status: 'absent' }, field: 'changes' },
    { changes: { date: LESSON_DATE }, field: 'changes' },
    { changes: { sourceNoteId: 'note-2' }, field: 'changes' },
    { changes: { progress: 42 }, field: 'progress' },
    { changes: { homework: undefined }, field: 'homework' },
  ])('拒绝非法owner输入：$field/$changes', async ({ changes, field }) => {
    const { lesson } = await createFixture();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateLessonRecord({
      teacherId: TEACHER_A,
      lessonId: lesson.id,
      expectedUpdatedAt: lesson.updatedAtTs,
      changes,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VALIDATION_ERROR', field });
    expect(clock.now).not.toHaveBeenCalled();
    expect((await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } })).updatedAtTs).toEqual(BASE_TOKEN);
  });

  it('事实no-op不调用clock、不推进token且不写日志', async () => {
    const { lesson } = await createFixture();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateLessonRecord({
      teacherId: TEACHER_A,
      lessonId: lesson.id,
      expectedUpdatedAt: lesson.updatedAtTs,
      changes: {
        progress: lesson.progress,
        studentState: lesson.studentState,
        homework: lesson.homework,
        teacherNote: lesson.teacherNote,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'changes' });
    expect(clock.now).not.toHaveBeenCalled();
    expect((await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } })).updatedAtTs).toEqual(BASE_TOKEN);
    expect(await prisma.changeLog.count({ where: { targetId: lesson.id } })).toBe(0);
  });

  it('TrustedClock失败时零业务写', async () => {
    const { lesson } = await createFixture();
    const editor = requireFactory()({
      prisma,
      trustedClock: trustedClock({ ok: false, error: internalError('数据库可信时间不可用') }),
    });

    const result = await editor.updateLessonRecord({
      teacherId: TEACHER_A,
      lessonId: lesson.id,
      expectedUpdatedAt: lesson.updatedAtTs,
      changes: { progress: '新进度' },
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect((await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } }))).toMatchObject({
      progress: '力学综合题',
      updatedAtTs: BASE_TOKEN,
    });
  });

  it('TrustedClock返回before同token时零业务写', async () => {
    const { lesson } = await createFixture();
    const editor = requireFactory()({ prisma, trustedClock: trustedClock(ok(BASE_TOKEN)) });

    const result = await editor.updateLessonRecord({
      teacherId: TEACHER_A,
      lessonId: lesson.id,
      expectedUpdatedAt: lesson.updatedAtTs,
      changes: { progress: '新进度' },
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect((await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } })).progress).toBe('力学综合题');
  });

  it('system省略expected仍以读取到的before token执行成功CAS', async () => {
    const { lesson } = await createFixture();
    const editor = requireFactory()({ prisma, trustedClock: trustedClock() });

    const result = await editor.updateLessonRecord({
      teacherId: TEACHER_A,
      lessonId: lesson.id,
      expectedUpdatedAt: undefined,
      changes: { teacherNote: null },
    });

    expect(result.ok).toBe(true);
    expect((await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } })).updatedAtTs).toEqual(NEXT_TOKEN);
  });

  it('条件写前对象消失时重读分类为NOT_FOUND', async () => {
    const { lesson } = await createFixture();
    const clock = {
      now: vi.fn(async () => {
        await prisma.lesson.delete({ where: { id: lesson.id } });
        return ok(NEXT_TOKEN);
      }),
    };
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateLessonRecord({
      teacherId: TEACHER_A,
      lessonId: lesson.id,
      expectedUpdatedAt: lesson.updatedAtTs,
      changes: { progress: '新进度' },
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });
  });

  it('同一expected并发且都已读取before时恰好一胜一冲突', async () => {
    const { lesson } = await createFixture();
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
      editor.updateLessonRecord({
        teacherId: TEACHER_A,
        lessonId: lesson.id,
        expectedUpdatedAt: lesson.updatedAtTs,
        changes: { progress: '并发A' },
      }),
      editor.updateLessonRecord({
        teacherId: TEACHER_A,
        lessonId: lesson.id,
        expectedUpdatedAt: lesson.updatedAtTs,
        changes: { progress: '并发B' },
      }),
    ]);

    expect(results.map((result) => result.ok ? 'OK' : result.error.code).sort()).toEqual([
      'OK',
      'VERSION_CONFLICT',
    ]);
    const persisted = await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } });
    // P8 phase-3 批4：progress 落库为密文，解密后为并发写入之一
    expect(['并发A', '并发B']).toContain(cipher.decrypt(persisted.progress!));
    expect(persisted.updatedAtTs).toEqual(NEXT_TOKEN);
  });
});
