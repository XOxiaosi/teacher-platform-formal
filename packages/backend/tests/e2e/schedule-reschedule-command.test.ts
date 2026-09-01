import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, internalError, ok } from '@teacher-platform/contracts';
import { createChangelogService } from '../../src/shared/changelog/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';

// P8 phase-3 批4：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);

let createRescheduleLessonUseCase: unknown;
let importError: unknown;
try {
  const module = await import('../../src/app/use-cases/reschedule-lesson/index.js');
  createRescheduleLessonUseCase = module.createRescheduleLessonUseCase;
} catch (caught) {
  importError = caught;
}

const prisma = new PrismaClient();
const TEACHER_A = 'schedule-command-a';
const TEACHER_B = 'schedule-command-b';
const BASE_TOKEN = new Date('2000-01-01T00:00:00.000Z');
const NEXT_TOKEN = new Date('2030-01-02T00:00:00.000Z');
const OLD_START = new Date('2030-01-01T08:00:00.000Z');
const OLD_END = new Date('2030-01-01T09:00:00.000Z');
const NEW_START = new Date('2030-01-03T08:00:00.000Z');
const NEW_END = new Date('2030-01-03T09:00:00.000Z');

function requireFactory() {
  if (importError) {
    throw new Error(
      `reschedule-lesson production factory import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (typeof createRescheduleLessonUseCase !== 'function') {
    throw new Error('createRescheduleLessonUseCase export is missing');
  }
  return createRescheduleLessonUseCase as (options: any) => {
    rescheduleLesson(command: any): Promise<any>;
  };
}

function fixedClock(value = NEXT_TOKEN) {
  return { now: vi.fn().mockResolvedValue(ok(value)) };
}

function command(scheduleId: string, patch: Record<string, unknown> = {}) {
  return {
    teacherId: TEACHER_A,
    scheduleId,
    expectedUpdatedAt: BASE_TOKEN.toISOString(),
    source: 'manual-web',
    replacement: {
      scheduledStart: NEW_START.toISOString(),
      scheduledEnd: NEW_END.toISOString(),
    },
    ...patch,
  };
}

async function createFixture(patch: Record<string, unknown> = {}) {
  const student = await prisma.student.create({
    data: { teacherId: TEACHER_A, name: '张三', grade: '高一' },
  });
  const schedule = await prisma.schedule.create({
    data: {
      teacherId: TEACHER_A,
      studentId: student.id,
      type: 'lesson',
      title: '改期命令测试课',
      scheduledStartTs: OLD_START,
      scheduledEndTs: OLD_END,
      status: 'planned',
      confidence: 'medium',
      pendingFields: ['room'],
      sourceInput: '原始自然语言',
      updatedAtTs: BASE_TOKEN,
      ...patch,
    },
  });
  return { student, schedule };
}

async function databaseNow() {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  return rows[0].now;
}

async function cleanup() {
  const teachers = [TEACHER_A, TEACHER_B];
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teachers } } });
}

async function expectUnchanged(scheduleId: string) {
  expect(await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } })).toMatchObject({
    status: 'planned',
    scheduledStartTs: OLD_START,
    scheduledEndTs: OLD_END,
    parentId: null,
    updatedAtTs: BASE_TOKEN,
  });
  expect(await prisma.schedule.count({ where: { parentId: scheduleId } })).toBe(0);
  expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A } })).toBe(0);
}

function rawPrismaFailingSchedule(method: 'create' | 'findMany') {
  return {
    $transaction: (work: (tx: any) => Promise<any>) => prisma.$transaction(async (tx) => {
      const schedule = new Proxy(tx.schedule, {
        get(target, property) {
          if (property === method) return async () => { throw new Error(`forced schedule.${method} failure`); };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const proxied = new Proxy(tx, {
        get(target, property) {
          if (property === 'schedule') return schedule;
          return Reflect.get(target, property, target);
        },
      });
      return work(proxied);
    }),
  };
}

beforeEach(cleanup);
afterEach(cleanup);

describe('Schedule reschedule command raw transaction', () => {
  it('导出只接收raw Prisma的production factory', () => {
    expect(requireFactory()).toBeTypeOf('function');
  });

  it('默认使用PostgreSQL TrustedClock，原记录与replacement共享显式token并写两条准确日志', async () => {
    const { schedule } = await createFixture();
    const lowerBound = await databaseNow();
    const result = await requireFactory()({ rawPrisma: prisma }).rescheduleLesson(command(schedule.id));
    const upperBound = await databaseNow();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { original, replacement, changeLogIds } = result.value;
    expect(original).toMatchObject({
      id: schedule.id, status: 'rescheduled', parentId: null,
      scheduledStart: OLD_START, scheduledEnd: OLD_END,
    });
    expect(original.updatedAt.getTime()).not.toBe(BASE_TOKEN.getTime());
    expect(original.updatedAt.getTime()).toBeGreaterThanOrEqual(lowerBound.getTime() - 1);
    expect(original.updatedAt.getTime()).toBeLessThanOrEqual(upperBound.getTime() + 1);
    expect(replacement).toMatchObject({
      teacherId: TEACHER_A, studentId: schedule.studentId, type: 'lesson', title: '改期命令测试课',
      scheduledStart: NEW_START, scheduledEnd: NEW_END, status: 'planned', confidence: 'medium',
      pendingFields: ['room'], sourceInput: '原始自然语言', parentId: schedule.id,
      createdAt: original.updatedAt, updatedAt: original.updatedAt,
    });

    const logs = await prisma.changeLog.findMany({ where: { teacherId: TEACHER_A } });
    expect(logs).toHaveLength(2);
    const originalLog = logs.find((log) => log.id === changeLogIds.original)!;
    const replacementLog = logs.find((log) => log.id === changeLogIds.replacement)!;
    expect(originalLog).toMatchObject({ module: 'scheduling', action: 'update', targetType: 'Schedule', targetId: schedule.id, source: 'manual-web' });
    // P8 phase-3 批4：changelog before/after 整体加密落库，解密后断言
    expect(cipher.decryptJson<unknown>(originalLog.before as unknown as string)).toEqual({ status: 'planned', updatedAt: BASE_TOKEN.toISOString() });
    expect(cipher.decryptJson<unknown>(originalLog.after as unknown as string)).toEqual({ status: 'rescheduled', updatedAt: original.updatedAt.toISOString() });
    expect(replacementLog).toMatchObject({ module: 'scheduling', action: 'create', targetType: 'Schedule', targetId: replacement.id, source: 'manual-web' });
    expect(replacementLog.before).toBeNull();
    expect(cipher.decryptJson<unknown>(replacementLog.after as unknown as string)).toEqual({
      studentId: schedule.studentId, type: 'lesson', title: '改期命令测试课',
      scheduledStart: NEW_START.toISOString(), scheduledEnd: NEW_END.toISOString(), status: 'planned',
      confidence: 'medium', pendingFields: ['room'], sourceInput: '原始自然语言',
      parentId: schedule.id, updatedAt: original.updatedAt.toISOString(),
    });
  });

  it.each(['manual-web', 'agent-confirmed', 'wechat-confirmed', 'system'])('双日志source准确透传：%s', async (source) => {
    const { schedule } = await createFixture();
    const patch = source === 'system' ? { source, expectedUpdatedAt: undefined } : { source };
    const result = await requireFactory()({ rawPrisma: prisma, trustedClockFactory: () => fixedClock() })
      .rescheduleLesson(command(schedule.id, patch));
    expect(result.ok).toBe(true);
    expect((await prisma.changeLog.findMany({ where: { teacherId: TEACHER_A } })).map((log) => log.source)).toEqual([source, source]);
  });

  it('不存在时完整命令NOT_FOUND且零写', async () => {
    const { schedule } = await createFixture();
    const result = await requireFactory()({ rawPrisma: prisma, trustedClockFactory: () => fixedClock() })
      .rescheduleLesson(command('missing-schedule'));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });
    await expectUnchanged(schedule.id);
  });

  it.each([
    { type: 'prep', status: 'planned', replacement: { scheduledStart: NEW_START.toISOString(), scheduledEnd: NEW_END.toISOString() } },
    { type: 'lesson', status: 'completed', replacement: { scheduledStart: NEW_START.toISOString(), scheduledEnd: NEW_END.toISOString() } },
    { type: 'lesson', status: 'planned', replacement: { scheduledStart: OLD_START.toISOString(), scheduledEnd: OLD_END.toISOString() } },
  ])('stale完整命令优先于类型、状态和no-op且零写：$type/$status', async ({ type, status, replacement }) => {
    const { schedule } = await createFixture({ type, status });
    const result = await requireFactory()({ rawPrisma: prisma, trustedClockFactory: () => fixedClock() })
      .rescheduleLesson(command(schedule.id, { expectedUpdatedAt: '1999-01-01T00:00:00Z', replacement }));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VERSION_CONFLICT' }) });
    expect(await prisma.schedule.count({ where: { parentId: schedule.id } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('事实no-op时零Schedule写零日志', async () => {
    const { schedule } = await createFixture();
    const result = await requireFactory()({ rawPrisma: prisma, trustedClockFactory: () => fixedClock() })
      .rescheduleLesson(command(schedule.id, { replacement: { scheduledStart: OLD_START.toISOString(), scheduledEnd: OLD_END.toISOString() } }));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'replacement' }) });
    await expectUnchanged(schedule.id);
  });

  it('overlap只报告且不阻止成功，边界相接、非活跃、跨teacher均排除', async () => {
    const { schedule } = await createFixture();
    await prisma.schedule.createMany({ data: [
      { id: 'overlap', teacherId: TEACHER_A, type: 'lesson', title: 'overlap', status: 'extra', scheduledStartTs: new Date('2030-01-03T08:30:00Z'), scheduledEndTs: new Date('2030-01-03T09:30:00Z') },
      { id: 'touch', teacherId: TEACHER_A, type: 'lesson', title: 'touch', status: 'planned', scheduledStartTs: NEW_END, scheduledEndTs: new Date('2030-01-03T10:00:00Z') },
      { id: 'inactive', teacherId: TEACHER_A, type: 'lesson', title: 'inactive', status: 'cancelled', scheduledStartTs: NEW_START, scheduledEndTs: NEW_END },
      { id: 'other', teacherId: TEACHER_B, type: 'lesson', title: 'other', status: 'planned', scheduledStartTs: NEW_START, scheduledEndTs: NEW_END },
    ] });
    const result = await requireFactory()({ rawPrisma: prisma, trustedClockFactory: () => fixedClock() })
      .rescheduleLesson(command(schedule.id));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.conflicts.map((item: any) => item.id)).toEqual(['overlap']);
  });

  it('TrustedClock失败或返回before同token时完整事务零写', async () => {
    const { schedule } = await createFixture();
    const failed = await requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => ({ now: vi.fn().mockResolvedValue(err(internalError('clock failed'))) }),
    }).rescheduleLesson(command(schedule.id));
    expect(failed).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    await expectUnchanged(schedule.id);

    const same = await requireFactory()({ rawPrisma: prisma, trustedClockFactory: () => fixedClock(BASE_TOKEN) })
      .rescheduleLesson(command(schedule.id));
    expect(same).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    await expectUnchanged(schedule.id);
  });

  it.each(['create', 'findMany'] as const)('owner内schedule.%s失败时回滚原状态与replacement', async (method) => {
    const { schedule } = await createFixture();
    const result = await requireFactory()({
      rawPrisma: rawPrismaFailingSchedule(method),
      trustedClockFactory: () => fixedClock(),
    }).rescheduleLesson(command(schedule.id));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    await expectUnchanged(schedule.id);
  });

  it.each([1, 2])('第%s条ChangeLog失败时双Schedule与半条真实日志全部回滚', async (failureAt) => {
    const { schedule } = await createFixture();
    let calls = 0;
    const result = await requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => fixedClock(),
      changelogFactory: (tx: any) => {
        const real = createChangelogService(tx);
        return {
          recordChange: vi.fn(async (input: any) => {
            calls += 1;
            return calls === failureAt
              ? err(internalError('审计失败'))
              : real.recordChange(input);
          }),
        };
      },
    }).rescheduleLesson(command(schedule.id));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect(calls).toBe(failureAt);
    await expectUnchanged(schedule.id);
  });

  it('完整命令同expected并发恰好一胜一冲突，只留一个replacement和两条日志', async () => {
    const { schedule } = await createFixture();
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
    const useCase = requireFactory()({ rawPrisma: prisma, trustedClockFactory: () => clock });
    const results = await Promise.all([
      useCase.rescheduleLesson(command(schedule.id)),
      useCase.rescheduleLesson(command(schedule.id, { replacement: { scheduledStart: '2030-01-04T08:00:00Z', scheduledEnd: '2030-01-04T09:00:00Z' } })),
    ]);
    expect(results.map((result) => result.ok ? 'OK' : result.error.code).sort()).toEqual(['OK', 'VERSION_CONFLICT']);
    expect(await prisma.schedule.count({ where: { parentId: schedule.id } })).toBe(1);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A } })).toBe(2);
  });
});
