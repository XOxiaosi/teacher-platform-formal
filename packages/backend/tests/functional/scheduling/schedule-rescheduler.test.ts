import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, internalError, ok } from '@teacher-platform/contracts';

let createScheduleRescheduler: unknown;
let importError: unknown;
try {
  const module = await import('../../../src/features/scheduling/schedule-rescheduler.js');
  createScheduleRescheduler = module.createScheduleRescheduler;
} catch (caught) {
  importError = caught;
}

const prisma = new PrismaClient();
const TEACHER_A = 'schedule-rescheduler-a';
const TEACHER_B = 'schedule-rescheduler-b';
const BASE_TOKEN = new Date('2000-01-01T00:00:00.000Z');
const NEXT_TOKEN = new Date('2030-01-02T00:00:00.000Z');
const OLD_START = new Date('2030-01-01T08:00:00.000Z');
const OLD_END = new Date('2030-01-01T09:00:00.000Z');
const NEW_START = new Date('2030-01-03T08:00:00.000Z');
const NEW_END = new Date('2030-01-03T09:00:00.000Z');

function requireFactory() {
  if (importError) {
    throw new Error(
      `schedule-rescheduler import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (typeof createScheduleRescheduler !== 'function') {
    throw new Error('createScheduleRescheduler export is missing');
  }
  return createScheduleRescheduler as (options: any) => {
    rescheduleLesson(input: any): Promise<any>;
  };
}

function fixedClock(value = NEXT_TOKEN) {
  return { now: vi.fn().mockResolvedValue(ok(value)) };
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
      title: '力学综合课',
      scheduledStartTs: OLD_START,
      scheduledEndTs: OLD_END,
      status: 'planned',
      confidence: 'high',
      pendingFields: ['room', { key: 'materials' }],
      sourceInput: '周三上午给张三上课',
      parentId: null,
      updatedAtTs: BASE_TOKEN,
      ...patch,
    },
  });
  return { student, schedule };
}

function input(scheduleId: string, patch: Record<string, unknown> = {}) {
  return {
    teacherId: TEACHER_A,
    scheduleId,
    expectedUpdatedAt: BASE_TOKEN,
    replacement: { scheduledStart: NEW_START, scheduledEnd: NEW_END },
    ...patch,
  };
}

async function cleanup() {
  const teachers = [TEACHER_A, TEACHER_B];
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teachers } } });
}

beforeEach(cleanup);
afterEach(cleanup);

describe('ScheduleRescheduler owner CAS and replacement', () => {
  it('导出独立ScheduleRescheduler owner', () => {
    expect(requireFactory()).toBeTypeOf('function');
  });

  it('原Schedule只改status和可信updatedAt，replacement按正确方向复制上下文与显式时间', async () => {
    const { schedule } = await createFixture({ parentId: null });
    const result = await requireFactory()({ prisma, trustedClock: fixedClock() })
      .rescheduleLesson(input(schedule.id));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.beforeOriginal).toMatchObject({ id: schedule.id, status: 'planned', updatedAt: BASE_TOKEN });
    expect(result.value.original).toMatchObject({
      id: schedule.id, teacherId: TEACHER_A, studentId: schedule.studentId, type: 'lesson', title: '力学综合课',
      scheduledStart: OLD_START, scheduledEnd: OLD_END, status: 'rescheduled', parentId: null, updatedAt: NEXT_TOKEN,
    });
    expect(result.value.replacement).toMatchObject({
      teacherId: TEACHER_A, studentId: schedule.studentId, type: 'lesson', title: '力学综合课',
      scheduledStart: NEW_START, scheduledEnd: NEW_END, status: 'planned', confidence: 'high',
      pendingFields: ['room', { key: 'materials' }], sourceInput: '周三上午给张三上课',
      parentId: schedule.id, createdAt: NEXT_TOKEN, updatedAt: NEXT_TOKEN,
    });
    expect(result.value.replacement.id).not.toBe(schedule.id);
  });

  it('reschedule 双写 shadow 列与旧列同值（scheduledStart/scheduledEnd/createdAt/updatedAt）', async () => {
    const { schedule } = await createFixture({ parentId: null });
    const result = await requireFactory()({ prisma, trustedClock: fixedClock() })
      .rescheduleLesson(input(schedule.id));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const original = await prisma.schedule.findUniqueOrThrow({ where: { id: schedule.id } });
    const replacement = await prisma.schedule.findUniqueOrThrow({
      where: { id: result.value.replacement.id },
    });

    // 原行 updateMany 只写 updatedAt → 必须同步 updatedAtTs
    expect(original.updatedAtTs).toBeInstanceOf(Date);
    expect(original.updatedAtTs).toBeInstanceOf(Date);

    // 新行 create 必须同步 scheduledStart/scheduledEnd/createdAt/updatedAt 及其 *Ts
    expect(replacement.scheduledStartTs).toBeInstanceOf(Date);
    expect(replacement.scheduledEndTs).toBeInstanceOf(Date);
    expect(replacement.createdAtTs).toBeInstanceOf(Date);
    expect(replacement.updatedAtTs).toBeInstanceOf(Date);
    expect(replacement.scheduledStartTs).toBeInstanceOf(Date);
    expect(replacement.scheduledEndTs).toBeInstanceOf(Date);
    expect(replacement.createdAtTs).toBeInstanceOf(Date);
    expect(replacement.updatedAtTs).toBeInstanceOf(Date);
  });

  it.each([
    { teacherId: TEACHER_B, scheduleId: 'owned' },
    { teacherId: TEACHER_A, scheduleId: 'missing' },
  ])('跨teacher或不存在统一NOT_FOUND', async ({ teacherId, scheduleId }) => {
    const { schedule } = await createFixture();
    const result = await requireFactory()({ prisma, trustedClock: fixedClock() }).rescheduleLesson(
      input(scheduleId === 'owned' ? schedule.id : scheduleId, { teacherId }),
    );
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });
    expect(await prisma.schedule.count({ where: { parentId: schedule.id } })).toBe(0);
  });

  it.each([
    { type: 'prep', status: 'planned', replacement: { scheduledStart: NEW_START, scheduledEnd: NEW_END } },
    { type: 'lesson', status: 'completed', replacement: { scheduledStart: NEW_START, scheduledEnd: NEW_END } },
    { type: 'lesson', status: 'planned', replacement: { scheduledStart: OLD_START, scheduledEnd: OLD_END } },
    { type: 'lesson', status: 'planned', replacement: { scheduledStart: NEW_END, scheduledEnd: NEW_START } },
  ])('owned stale优先于类型、状态、时间和no-op：$type/$status', async ({ type, status, replacement }) => {
    const { schedule } = await createFixture({ type, status });
    const result = await requireFactory()({ prisma, trustedClock: fixedClock() }).rescheduleLesson(
      input(schedule.id, { expectedUpdatedAt: new Date('1999-01-01T00:00:00.000Z'), replacement }),
    );
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VERSION_CONFLICT' }) });
  });

  it.each([
    { patch: { type: 'prep' }, field: 'type' },
    { patch: { status: 'completed' }, field: 'status' },
  ])('只接受planned lesson：$field', async ({ patch, field }) => {
    const { schedule } = await createFixture(patch);
    const result = await requireFactory()({ prisma, trustedClock: fixedClock() }).rescheduleLesson(input(schedule.id));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }) });
  });

  it('新时间与原时间两个instant相同为no-op且零写', async () => {
    const { schedule } = await createFixture();
    const result = await requireFactory()({ prisma, trustedClock: fixedClock() }).rescheduleLesson(
      input(schedule.id, { replacement: { scheduledStart: OLD_START, scheduledEnd: OLD_END } }),
    );
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'replacement' }) });
    expect(await prisma.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).toMatchObject({ status: 'planned', updatedAtTs: BASE_TOKEN });
    expect(await prisma.schedule.count({ where: { parentId: schedule.id } })).toBe(0);
  });

  it.each([
    { replacement: { scheduledStart: new Date('invalid'), scheduledEnd: NEW_END }, field: 'scheduledStart' },
    { replacement: { scheduledStart: NEW_END, scheduledEnd: NEW_START }, field: 'scheduledEnd' },
  ])('拒绝owner非法时间：$field', async ({ replacement, field }) => {
    const { schedule } = await createFixture();
    const result = await requireFactory()({ prisma, trustedClock: fixedClock() }).rescheduleLesson(input(schedule.id, { replacement }));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }) });
  });

  it('冲突仅报告同teacher planned/extra严格重叠，排除replacement并确定排序', async () => {
    const { schedule } = await createFixture();
    const rows = [
      { id: 'conflict-b', teacherId: TEACHER_A, status: 'extra', scheduledStartTs: new Date('2030-01-03T08:15:00Z'), scheduledEndTs: new Date('2030-01-03T08:45:00Z') },
      { id: 'conflict-a', teacherId: TEACHER_A, status: 'planned', scheduledStartTs: new Date('2030-01-03T08:15:00Z'), scheduledEndTs: new Date('2030-01-03T08:30:00Z') },
      { id: 'touch-start', teacherId: TEACHER_A, status: 'planned', scheduledStartTs: new Date('2030-01-03T07:00:00Z'), scheduledEndTs: NEW_START },
      { id: 'touch-end', teacherId: TEACHER_A, status: 'planned', scheduledStartTs: NEW_END, scheduledEndTs: new Date('2030-01-03T10:00:00Z') },
      { id: 'inactive', teacherId: TEACHER_A, status: 'cancelled', scheduledStartTs: NEW_START, scheduledEndTs: NEW_END },
      { id: 'other-teacher', teacherId: TEACHER_B, status: 'planned', scheduledStartTs: NEW_START, scheduledEndTs: NEW_END },
    ];
    await prisma.schedule.createMany({ data: rows.map((row) => ({ ...row, type: 'lesson', title: row.id })) });

    const result = await requireFactory()({ prisma, trustedClock: fixedClock() }).rescheduleLesson(input(schedule.id));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.conflicts.map((item: any) => item.id)).toEqual(['conflict-a', 'conflict-b']);
  });

  it('TrustedClock失败或返回before同token时零写', async () => {
    const { schedule } = await createFixture();
    const failed = await requireFactory()({
      prisma,
      trustedClock: { now: vi.fn().mockResolvedValue(err(internalError('clock failed'))) },
    }).rescheduleLesson(input(schedule.id));
    expect(failed).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });

    const same = await requireFactory()({ prisma, trustedClock: fixedClock(BASE_TOKEN) }).rescheduleLesson(input(schedule.id));
    expect(same).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect(await prisma.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).toMatchObject({ status: 'planned', updatedAtTs: BASE_TOKEN });
    expect(await prisma.schedule.count({ where: { parentId: schedule.id } })).toBe(0);
  });

  it('同expected并发恰好一胜一冲突且只创建一个replacement', async () => {
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
    const owner = requireFactory()({ prisma, trustedClock: clock });
    const results = await Promise.all([
      owner.rescheduleLesson(input(schedule.id, { replacement: { scheduledStart: NEW_START, scheduledEnd: NEW_END } })),
      owner.rescheduleLesson(input(schedule.id, { replacement: { scheduledStart: new Date('2030-01-04T08:00:00Z'), scheduledEnd: new Date('2030-01-04T09:00:00Z') } })),
    ]);
    expect(results.map((result) => result.ok ? 'OK' : result.error.code).sort()).toEqual(['OK', 'VERSION_CONFLICT']);
    expect(await prisma.schedule.count({ where: { parentId: schedule.id } })).toBe(1);
  });
});
