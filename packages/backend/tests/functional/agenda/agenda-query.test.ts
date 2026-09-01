import { describe, expect, it, vi } from 'vitest';
import {
  err,
  internalError,
  notFound,
  ok,
  type AgendaTodayDocument,
  type AgendaWeekDocument,
  type CommonError,
  type Result,
} from '@teacher-platform/contracts';
import type { ScheduleData } from '../../../src/features/scheduling/types.js';
import type { MemoData } from '../../../src/features/memos/types.js';
import type { PendingActionData } from '../../../src/features/pending-action/types.js';
import type { StudentData } from '../../../src/features/students/types.js';

interface AgendaQueryPortLike {
  getToday(input: {
    teacherId: string;
    timeZone: 'Asia/Shanghai';
  }): Promise<Result<AgendaTodayDocument, CommonError>>;
  getWeek(input: {
    teacherId: string;
    weekStart?: string;
    timeZone: 'Asia/Shanghai';
  }): Promise<Result<AgendaWeekDocument, CommonError>>;
}

interface AgendaQueryModule {
  createAgendaQuery?: (dependencies: unknown) => AgendaQueryPortLike;
}

interface DependencyResults {
  clock: Result<Date, CommonError>;
  schedules: Result<{ items: ScheduleData[]; total: number }, CommonError>;
  memos: Result<{ items: MemoData[]; total: number }, CommonError>;
  pendingActions: Result<{ items: PendingActionData[]; total: number }, CommonError>;
  students: Result<StudentData[], CommonError>;
}

const NOW = new Date('2030-07-24T01:00:00.000Z');
const CREATED_AT = new Date('2030-07-01T00:00:00.000Z');

async function loadQuery(): Promise<AgendaQueryModule> {
  try {
    return await import('../../../src/app/agenda/agenda-query.js') as unknown as AgendaQueryModule;
  } catch {
    return {};
  }
}

const LESSON: ScheduleData = {
  id: 'schedule-1',
  teacherId: 'teacher-a',
  studentId: 'student-1',
  type: 'lesson',
  title: '物理课',
  scheduledStart: new Date('2030-07-24T02:00:00.000Z'),
  scheduledEnd: new Date('2030-07-24T03:00:00.000Z'),
  status: 'planned',
  confidence: 'high',
  pendingFields: null,
  sourceInput: null,
  parentId: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const MEMO: MemoData = {
  id: 'memo-1',
  teacherId: 'teacher-a',
  title: '今日备忘',
  content: 'private',
  status: 'active',
  dueAt: new Date('2030-07-24T04:00:00.000Z'),
  tags: null,
  source: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const PENDING: PendingActionData = {
  id: 'pending-1',
  teacherId: 'teacher-a',
  conversationId: 'conversation-1',
  toolCallId: 'tool-call-1',
  actionName: 'students.updateStatus',
  targetType: 'Student',
  targetId: 'student-1',
  parameters: { status: 'paused' },
  beforeSummary: 'active',
  afterSummary: '暂停学生',
  status: 'pending',
  expiresAt: new Date('2030-07-24T06:00:00.000Z'),
  consumedAt: null,
  cancelledAt: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const STUDENT: StudentData = {
  id: 'student-1',
  teacherId: 'teacher-a',
  name: '小明',
  grade: '高一',
  source: null,
  currentStatus: 'active',
  stageGoal: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

function createDependencies(overrides: Partial<DependencyResults> = {}) {
  const results: DependencyResults = {
    clock: ok(NOW),
    schedules: ok({ items: [LESSON], total: 1 }),
    memos: ok({ items: [MEMO], total: 1 }),
    pendingActions: ok({ items: [PENDING], total: 1 }),
    students: ok([STUDENT]),
    ...overrides,
  };
  const fns = {
    clock: vi.fn(async () => results.clock),
    schedules: vi.fn(async (_input: unknown) => results.schedules),
    memos: vi.fn(async (_input: unknown) => results.memos),
    pendingActions: vi.fn(async (_input: unknown) => results.pendingActions),
    students: vi.fn(async (_input: unknown) => results.students),
  };
  return {
    dependencies: {
      trustedClock: { now: fns.clock },
      schedules: { listOverlappingSchedules: fns.schedules },
      memos: { listAgendaMemos: fns.memos },
      pendingActions: { listActivePendingActions: fns.pendingActions },
      students: { listOwnedStudentsByIds: fns.students },
    },
    fns,
  };
}

async function createQuery(overrides: Partial<DependencyResults> = {}) {
  const module = await loadQuery();
  expect(module.createAgendaQuery).toBeTypeOf('function');
  const fixture = createDependencies(overrides);
  return {
    query: module.createAgendaQuery?.(fixture.dependencies),
    ...fixture,
  };
}

describe('Agenda Query orchestration', () => {
  it('Today先读一次可信时钟，使用上海窗口查询owners并批量解析Student', async () => {
    const { query, fns } = await createQuery();
    if (!query) return;

    const result = await query.getToday({ teacherId: 'teacher-a', timeZone: 'Asia/Shanghai' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      schemaVersion: 1,
      timeZone: 'Asia/Shanghai',
      businessDate: '2030-07-24',
      generatedAt: NOW.toISOString(),
    });
    expect(result.value.items.map((item) => item.id)).toEqual([
      'schedule:schedule-1',
      'pending-action:pending-1',
      'memo:memo-1',
    ]);
    expect(fns.clock).toHaveBeenCalledTimes(1);
    expect(fns.schedules).toHaveBeenCalledWith({
      teacherId: 'teacher-a',
      type: 'lesson',
      windowStart: new Date('2030-07-23T16:00:00.000Z'),
      windowEndExclusive: new Date('2030-07-24T16:00:00.000Z'),
    });
    expect(fns.memos).toHaveBeenCalledWith({
      teacherId: 'teacher-a',
      dueAtBefore: new Date('2030-07-24T16:00:00.000Z'),
    });
    expect(fns.pendingActions).toHaveBeenCalledWith({ teacherId: 'teacher-a', activeAt: NOW });
    expect(fns.students).toHaveBeenCalledWith({ teacherId: 'teacher-a', studentIds: ['student-1'] });
  });

  it('Week默认与显式weekStart都依赖各自单次可信时钟并返回同一连续7天窗口', async () => {
    const first = await createQuery();
    if (!first.query) return;
    const defaultResult = await first.query.getWeek({
      teacherId: 'teacher-a',
      timeZone: 'Asia/Shanghai',
    });
    expect(defaultResult.ok).toBe(true);
    if (!defaultResult.ok) return;

    const second = await createQuery();
    if (!second.query) return;
    const explicitResult = await second.query.getWeek({
      teacherId: 'teacher-a',
      weekStart: '2030-07-22',
      timeZone: 'Asia/Shanghai',
    });
    expect(explicitResult.ok).toBe(true);
    if (!explicitResult.ok) return;

    for (const result of [defaultResult.value, explicitResult.value]) {
      expect(result.weekStart).toBe('2030-07-22');
      expect(result.weekEndExclusive).toBe('2030-07-29');
      expect(result.generatedAt).toBe(NOW.toISOString());
      expect(result.days.map((day) => day.date)).toEqual([
        '2030-07-22',
        '2030-07-23',
        '2030-07-24',
        '2030-07-25',
        '2030-07-26',
        '2030-07-27',
        '2030-07-28',
      ]);
    }
    for (const fixture of [first, second]) {
      expect(fixture.fns.clock).toHaveBeenCalledTimes(1);
      expect(fixture.fns.schedules).toHaveBeenCalledWith({
        teacherId: 'teacher-a',
        type: 'lesson',
        windowStart: new Date('2030-07-21T16:00:00.000Z'),
        windowEndExclusive: new Date('2030-07-28T16:00:00.000Z'),
      });
      expect(fixture.fns.memos).toHaveBeenCalledWith({
        teacherId: 'teacher-a',
        dueAtFrom: new Date('2030-07-21T16:00:00.000Z'),
        dueAtBefore: new Date('2030-07-28T16:00:00.000Z'),
      });
      expect(fixture.fns.pendingActions).toHaveBeenCalledWith({ teacherId: 'teacher-a', activeAt: NOW });
    }
  });

  it('TrustedClock失败时返回原错误且四个owner调用均为0', async () => {
    const clockFailure = err(internalError('database clock unavailable'));
    const { query, fns } = await createQuery({ clock: clockFailure });
    if (!query) return;

    const result = await query.getToday({ teacherId: 'teacher-a', timeZone: 'Asia/Shanghai' });

    expect(result).toEqual(clockFailure);
    expect(fns.clock).toHaveBeenCalledTimes(1);
    expect(fns.schedules).not.toHaveBeenCalled();
    expect(fns.memos).not.toHaveBeenCalled();
    expect(fns.pendingActions).not.toHaveBeenCalled();
    expect(fns.students).not.toHaveBeenCalled();
  });

  it('teacher、timeZone或weekStart非法时在TrustedClock前返回VALIDATION_ERROR', async () => {
    const fixture = await createQuery();
    if (!fixture.query) return;

    const invalidTeacher = await fixture.query.getToday({
      teacherId: '   ',
      timeZone: 'Asia/Shanghai',
    });
    const invalidTimeZone = await fixture.query.getToday({
      teacherId: 'teacher-a',
      timeZone: 'UTC' as 'Asia/Shanghai',
    });
    const invalidWeek = await fixture.query.getWeek({
      teacherId: 'teacher-a',
      weekStart: '2030-07-23',
      timeZone: 'Asia/Shanghai',
    });

    for (const [result, field] of [
      [invalidTeacher, 'teacherId'],
      [invalidTimeZone, 'timeZone'],
      [invalidWeek, 'weekStart'],
    ] as const) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ code: 'VALIDATION_ERROR', field });
    }
    expect(fixture.fns.clock).not.toHaveBeenCalled();
    expect(fixture.fns.schedules).not.toHaveBeenCalled();
    expect(fixture.fns.memos).not.toHaveBeenCalled();
    expect(fixture.fns.pendingActions).not.toHaveBeenCalled();
    expect(fixture.fns.students).not.toHaveBeenCalled();
  });

  it.each(['schedules', 'memos', 'pendingActions'] as const)(
    '%s total超过500时整体返回INTERNAL_ERROR且不调用Student owner',
    async (source) => {
      const sourceResult = source === 'schedules'
        ? ok({ items: [LESSON], total: 501 })
        : source === 'memos'
          ? ok({ items: [MEMO], total: 501 })
          : ok({ items: [PENDING], total: 501 });
      const { query, fns } = await createQuery({ [source]: sourceResult });
      if (!query) return;

      const result = await query.getToday({ teacherId: 'teacher-a', timeZone: 'Asia/Shanghai' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INTERNAL_ERROR');
      expect(fns.students).not.toHaveBeenCalled();
    },
  );

  it.each(['schedules', 'memos', 'pendingActions', 'students'] as const)(
    '%s owner失败时传播原CommonError且不返回部分文档',
    async (source) => {
      const failure = err(notFound(`${source} failed`));
      const { query } = await createQuery({ [source]: failure });
      if (!query) return;

      const result = await query.getToday({ teacherId: 'teacher-a', timeZone: 'Asia/Shanghai' });

      expect(result).toEqual(failure);
    },
  );
});
