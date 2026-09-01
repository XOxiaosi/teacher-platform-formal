import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, internalError, ok } from '@teacher-platform/contracts';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';

// P8 phase-3 批4：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);

let createUpdateStudentProfileUseCase: unknown;
let importError: unknown;
try {
  const module = await import('../../src/app/use-cases/update-student-profile/index.js');
  createUpdateStudentProfileUseCase = module.createUpdateStudentProfileUseCase;
} catch (caught) {
  importError = caught;
}

const prisma = new PrismaClient();
const TEACHER_A = 'student-profile-command-a';
const BASE_TOKEN = new Date('2000-01-01T00:00:00.000Z');
const NEXT_TOKEN = new Date('2030-01-01T00:00:00.000Z');

function requireFactory() {
  if (importError) {
    throw new Error(
      `update-student-profile production factory import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (typeof createUpdateStudentProfileUseCase !== 'function') {
    throw new Error('createUpdateStudentProfileUseCase export is missing');
  }
  return createUpdateStudentProfileUseCase as (options: any) => {
    updateStudentProfile(command: any): Promise<any>;
  };
}

function command(studentId: string, patch: Record<string, unknown> = {}) {
  return {
    teacherId: TEACHER_A,
    studentId,
    expectedUpdatedAt: BASE_TOKEN.toISOString(),
    source: 'manual-web',
    changes: { name: '张三同学', stageGoal: null },
    ...patch,
  };
}

function fixedClock(value = NEXT_TOKEN) {
  return { now: vi.fn().mockResolvedValue(ok(value)) };
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

async function databaseNow() {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  return rows[0].now;
}

async function cleanup() {
  await prisma.changeLog.deleteMany({ where: { teacherId: TEACHER_A } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER_A } });
}

async function expectUnchanged(studentId: string) {
  const persisted = await prisma.student.findUniqueOrThrow({ where: { id: studentId } });
  expect(persisted).toMatchObject({
    name: '张三',
    grade: '高一',
    source: '家长介绍',
    stageGoal: '夯实力学',
    updatedAtTs: BASE_TOKEN,
  });
  expect(await prisma.changeLog.count({ where: { targetId: studentId } })).toBe(0);
}

beforeEach(cleanup);
afterEach(cleanup);

describe('Student profile edit command raw transaction', () => {
  it('导出只接收raw Prisma的production factory', () => {
    expect(requireFactory()).toBeTypeOf('function');
  });

  it('默认使用PostgreSQL TrustedClock，成功写一条准确manual-web日志并返回receipt', async () => {
    const student = await createStudent();
    const lowerBound = await databaseNow();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updateStudentProfile(command(student.id));

    const upperBound = await databaseNow();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changeLogId).toBeTypeOf('string');
    const token = result.value.value.updatedAt as Date;
    expect(token.getTime()).not.toBe(BASE_TOKEN.getTime());
    expect(token.getTime()).toBeGreaterThanOrEqual(lowerBound.getTime() - 1);
    expect(token.getTime()).toBeLessThanOrEqual(upperBound.getTime() + 1);

    const logs = await prisma.changeLog.findMany({ where: { targetId: student.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      id: result.value.changeLogId,
      teacherId: TEACHER_A,
      module: 'students',
      action: 'update',
      targetType: 'Student',
      targetId: student.id,
      source: 'manual-web',
    });
    // P8 phase-3 批4：changelog before/after 整体加密落库，解密后断言
    expect(cipher.decryptJson<unknown>(logs[0].before as unknown as string)).toEqual({
      name: '张三',
      grade: '高一',
      source: '家长介绍',
      stageGoal: '夯实力学',
      updatedAt: BASE_TOKEN.toISOString(),
    });
    expect(cipher.decryptJson<unknown>(logs[0].after as unknown as string)).toEqual({
      name: '张三同学',
      grade: '高一',
      source: '家长介绍',
      stageGoal: null,
      updatedAt: token.toISOString(),
    });
  });

  it.each(['agent-confirmed', 'wechat-confirmed', 'system'])('日志source准确透传：%s', async (source) => {
    const student = await createStudent();
    const useCase = requireFactory()({ rawPrisma: prisma });
    const patch = source === 'system'
      ? { source, expectedUpdatedAt: undefined }
      : { source };

    const result = await useCase.updateStudentProfile(command(student.id, patch));

    expect(result.ok).toBe(true);
    const logs = await prisma.changeLog.findMany({ where: { targetId: student.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].source).toBe(source);
  });

  it.each([
    { expectedUpdatedAt: undefined },
    { expectedUpdatedAt: '2000-01-01T00:00:00' },
    { expectedUpdatedAt: '2000-02-30T00:00:00Z' },
  ])('expected缺失或格式非法时完整命令零写：$expectedUpdatedAt', async ({ expectedUpdatedAt }) => {
    const student = await createStudent();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updateStudentProfile(command(student.id, { expectedUpdatedAt }));

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'expectedUpdatedAt' }),
    });
    await expectUnchanged(student.id);
  });

  it('不存在时完整命令返回NOT_FOUND且零写', async () => {
    const student = await createStudent();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updateStudentProfile(command(
      'missing-student',
    ));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });
    await expectUnchanged(student.id);
  });

  it('stale完整命令返回VERSION_CONFLICT且零写零日志', async () => {
    const student = await createStudent();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updateStudentProfile(command(student.id, {
      expectedUpdatedAt: '1999-12-31T00:00:00.000Z',
      changes: { name: '张三' },
    }));

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VERSION_CONFLICT', field: 'expectedUpdatedAt' }),
    });
    await expectUnchanged(student.id);
  });

  it.each([
    { changes: { name: '   ' }, field: 'name' },
    { changes: { name: '张三', stageGoal: '夯实力学' }, field: 'changes' },
  ])('领域校验或事实no-op时完整命令零写：$field', async ({ changes, field }) => {
    const student = await createStudent();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updateStudentProfile(command(student.id, { changes }));

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }),
    });
    await expectUnchanged(student.id);
  });

  it('TrustedClock失败时返回INTERNAL_ERROR且零Student写零日志', async () => {
    const student = await createStudent();
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => ({
        now: vi.fn().mockResolvedValue(err(internalError('数据库可信时间不可用'))),
      }),
    });

    const result = await useCase.updateStudentProfile(command(student.id));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    const persisted = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(persisted).toMatchObject({ name: '张三', updatedAtTs: BASE_TOKEN });
    expect(await prisma.changeLog.count({ where: { targetId: student.id } })).toBe(0);
  });

  it('TrustedClock返回before同token时零Student写零日志', async () => {
    const student = await createStudent();
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => fixedClock(BASE_TOKEN),
    });

    const result = await useCase.updateStudentProfile(command(student.id));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).updatedAtTs).toEqual(BASE_TOKEN);
    expect(await prisma.changeLog.count({ where: { targetId: student.id } })).toBe(0);
  });

  it('ChangeLog返回失败时通过sentinel回滚已完成的Student条件写', async () => {
    const student = await createStudent();
    const recordChange = vi.fn().mockResolvedValue(err(internalError('审计写入失败')));
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => fixedClock(),
      changelogFactory: () => ({ recordChange }),
    });

    const result = await useCase.updateStudentProfile(command(student.id));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect(recordChange).toHaveBeenCalledTimes(1);
    const persisted = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(persisted).toMatchObject({ name: '张三', stageGoal: '夯实力学', updatedAtTs: BASE_TOKEN });
    expect(await prisma.changeLog.count({ where: { targetId: student.id } })).toBe(0);
  });

  it('完整命令同一expected并发恰好一胜一冲突且只留一条日志', async () => {
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
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => clock,
    });

    const results = await Promise.all([
      useCase.updateStudentProfile(command(student.id, { changes: { name: '并发A' } })),
      useCase.updateStudentProfile(command(student.id, { changes: { name: '并发B' } })),
    ]);

    expect(results.map((result) => result.ok ? 'OK' : result.error.code).sort()).toEqual([
      'OK',
      'VERSION_CONFLICT',
    ]);
    expect(await prisma.changeLog.count({ where: { targetId: student.id } })).toBe(1);
    const persisted = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(['并发A', '并发B']).toContain(persisted.name);
    expect(persisted.updatedAtTs).toEqual(NEXT_TOKEN);
  });
});
