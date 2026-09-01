import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, internalError, ok } from '@teacher-platform/contracts';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';

// P8 phase-3 批4：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);

let createUpdateLessonRecordUseCase: unknown;
let importError: unknown;
try {
  const module = await import('../../src/app/use-cases/update-lesson-record/index.js');
  createUpdateLessonRecordUseCase = module.createUpdateLessonRecordUseCase;
} catch (caught) {
  importError = caught;
}

const prisma = new PrismaClient();
const TEACHER_A = 'lesson-record-command-a';
const BASE_TOKEN = new Date('2000-01-01T00:00:00.000Z');
const NEXT_TOKEN = new Date('2030-01-01T00:00:00.000Z');
const LESSON_DATE = new Date('2030-06-01T08:00:00.000Z');

function requireFactory() {
  if (importError) {
    throw new Error(
      `update-lesson-record production factory import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (typeof createUpdateLessonRecordUseCase !== 'function') {
    throw new Error('createUpdateLessonRecordUseCase export is missing');
  }
  return createUpdateLessonRecordUseCase as (options: any) => {
    updateLessonRecord(command: any): Promise<any>;
  };
}

function command(lessonId: string, patch: Record<string, unknown> = {}) {
  return {
    teacherId: TEACHER_A,
    lessonId,
    expectedUpdatedAt: BASE_TOKEN.toISOString(),
    source: 'manual-web',
    changes: {
      progress: '电场专题',
      studentState: null,
      homework: '',
      teacherNote: null,
    },
    ...patch,
  };
}

function fixedClock(value = NEXT_TOKEN) {
  return { now: vi.fn().mockResolvedValue(ok(value)) };
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
      title: 'Lesson record命令测试课',
      scheduledStartTs: LESSON_DATE,
      scheduledEndTs: new Date('2030-06-01T09:00:00.000Z'),
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

async function databaseNow() {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  return rows[0].now;
}

async function cleanup() {
  const teachers = [TEACHER_A];
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teachers } } });
}

async function expectUnchanged(lessonId: string) {
  const persisted = await prisma.lesson.findUniqueOrThrow({ where: { id: lessonId } });
  expect(persisted).toMatchObject({
    status: 'attended',
    progress: '力学综合题',
    studentState: '课堂专注',
    homework: '完成练习1-5',
    teacherNote: '计算细节待巩固',
    sourceNoteId: 'source-note-1',
    updatedAtTs: BASE_TOKEN,
  });
  expect(await prisma.changeLog.count({ where: { targetId: lessonId } })).toBe(0);
}

beforeEach(cleanup);
afterEach(cleanup);

describe('Lesson record edit command raw transaction', () => {
  it('导出只接收raw Prisma的production factory', () => {
    expect(requireFactory()).toBeTypeOf('function');
  });

  it('默认使用PostgreSQL TrustedClock，写一条准确manual-web日志并返回receipt', async () => {
    const { lesson } = await createFixture();
    const lowerBound = await databaseNow();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updateLessonRecord(command(lesson.id));

    const upperBound = await databaseNow();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value.value;
    expect(value.updatedAt.getTime()).not.toBe(BASE_TOKEN.getTime());
    expect(value.updatedAt.getTime()).toBeGreaterThanOrEqual(lowerBound.getTime() - 1);
    expect(value.updatedAt.getTime()).toBeLessThanOrEqual(upperBound.getTime() + 1);
    expect(value).toMatchObject({
      status: 'attended',
      studentId: lesson.studentId,
      scheduleId: lesson.scheduleId,
      date: LESSON_DATE,
      sourceNoteId: 'source-note-1',
      progress: '电场专题',
      studentState: null,
      homework: '',
      teacherNote: null,
    });

    const logs = await prisma.changeLog.findMany({ where: { targetId: lesson.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      id: result.value.changeLogId,
      teacherId: TEACHER_A,
      module: 'lessons',
      action: 'update',
      targetType: 'Lesson',
      targetId: lesson.id,
      source: 'manual-web',
    });
    // P8 phase-3 批4：changelog before/after 整体加密落库，解密后断言
    expect(cipher.decryptJson<unknown>(logs[0].before as unknown as string)).toEqual({
      progress: '力学综合题',
      studentState: '课堂专注',
      homework: '完成练习1-5',
      teacherNote: '计算细节待巩固',
      updatedAt: BASE_TOKEN.toISOString(),
    });
    expect(cipher.decryptJson<unknown>(logs[0].after as unknown as string)).toEqual({
      progress: '电场专题',
      studentState: null,
      homework: '',
      teacherNote: null,
      updatedAt: value.updatedAt.toISOString(),
    });
  });

  it.each(['agent-confirmed', 'wechat-confirmed', 'system'])('日志source准确透传：%s', async (source) => {
    const { lesson } = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma });
    const patch = source === 'system'
      ? { source, expectedUpdatedAt: undefined }
      : { source };

    const result = await useCase.updateLessonRecord(command(lesson.id, patch));

    expect(result.ok).toBe(true);
    const logs = await prisma.changeLog.findMany({ where: { targetId: lesson.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].source).toBe(source);
  });

  it.each([
    { expectedUpdatedAt: undefined },
    { expectedUpdatedAt: '2000-01-01T00:00:00' },
    { expectedUpdatedAt: '2000-02-30T00:00:00Z' },
  ])('expected缺失或格式非法时完整命令零写：$expectedUpdatedAt', async ({ expectedUpdatedAt }) => {
    const { lesson } = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updateLessonRecord(command(lesson.id, { expectedUpdatedAt }));

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'expectedUpdatedAt' }),
    });
    await expectUnchanged(lesson.id);
  });

  it('不存在时完整命令返回NOT_FOUND且零写', async () => {
    const { lesson } = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updateLessonRecord(command('missing-lesson'));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });
    await expectUnchanged(lesson.id);
  });

  it('stale完整命令优先返回VERSION_CONFLICT且零写零日志', async () => {
    const { lesson } = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updateLessonRecord(command(lesson.id, {
      expectedUpdatedAt: '1999-12-31T00:00:00.000Z',
      changes: { progress: lesson.progress },
    }));

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VERSION_CONFLICT', field: 'expectedUpdatedAt' }),
    });
    await expectUnchanged(lesson.id);
  });

  it('事实no-op时完整命令零写零日志', async () => {
    const { lesson } = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updateLessonRecord(command(lesson.id, {
      changes: { progress: lesson.progress, teacherNote: lesson.teacherNote },
    }));

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'changes' }),
    });
    await expectUnchanged(lesson.id);
  });

  it('TrustedClock失败时返回INTERNAL_ERROR且零Lesson写零日志', async () => {
    const { lesson } = await createFixture();
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => ({
        now: vi.fn().mockResolvedValue(err(internalError('数据库可信时间不可用'))),
      }),
    });

    const result = await useCase.updateLessonRecord(command(lesson.id));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    await expectUnchanged(lesson.id);
  });

  it('TrustedClock返回before同token时零Lesson写零日志', async () => {
    const { lesson } = await createFixture();
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => fixedClock(BASE_TOKEN),
    });

    const result = await useCase.updateLessonRecord(command(lesson.id));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    await expectUnchanged(lesson.id);
  });

  it('ChangeLog失败时通过sentinel回滚已完成的Lesson条件写', async () => {
    const { lesson } = await createFixture();
    const recordChange = vi.fn().mockResolvedValue(err(internalError('审计写入失败')));
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => fixedClock(),
      changelogFactory: () => ({ recordChange }),
    });

    const result = await useCase.updateLessonRecord(command(lesson.id));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect(recordChange).toHaveBeenCalledTimes(1);
    await expectUnchanged(lesson.id);
  });

  it('完整命令同一expected并发恰好一胜一冲突且只留一条日志', async () => {
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
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => clock,
    });

    const results = await Promise.all([
      useCase.updateLessonRecord(command(lesson.id, { changes: { progress: '并发A' } })),
      useCase.updateLessonRecord(command(lesson.id, { changes: { progress: '并发B' } })),
    ]);

    expect(results.map((result) => result.ok ? 'OK' : result.error.code).sort()).toEqual([
      'OK',
      'VERSION_CONFLICT',
    ]);
    expect(await prisma.changeLog.count({ where: { targetId: lesson.id } })).toBe(1);
    const persisted = await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } });
    // P8 phase-3 批4：progress 落库为密文，解密后为并发写入之一
    expect(['并发A', '并发B']).toContain(cipher.decrypt(persisted.progress!));
    expect(persisted.updatedAtTs).toEqual(NEXT_TOKEN);
  });
});
