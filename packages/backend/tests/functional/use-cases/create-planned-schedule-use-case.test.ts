import { describe, expect, it, vi } from 'vitest';
import { internalError, ok } from '@teacher-platform/contracts';

let createPlannedScheduleUseCase: any;
try {
  const module = await import('../../../src/app/use-cases/create-planned-schedule/create-planned-schedule-use-case.js');
  createPlannedScheduleUseCase = module.createPlannedScheduleUseCase;
} catch {
  // R5 red: module does not exist yet.
}

const futureResult = {
  schedule: {
    id: 'schedule-1',
    teacherId: 'teacher-1',
    studentId: null,
    type: 'lesson',
    title: '未来物理课',
    scheduledStart: new Date('2030-07-20T08:00:00.000Z'),
    scheduledEnd: new Date('2030-07-20T10:00:00.000Z'),
    status: 'planned',
    confidence: null,
    pendingFields: null,
    sourceInput: null,
    parentId: null,
    createdAt: new Date('2030-07-19T00:00:00.000Z'),
    updatedAt: new Date('2030-07-19T00:00:00.000Z'),
  },
  conflicts: [],
};

function requireFactory() {
  if (!createPlannedScheduleUseCase) {
    throw new Error('createPlannedScheduleUseCase export is missing');
  }
  return createPlannedScheduleUseCase as (deps: any) => {
    create(input: any): Promise<any>;
  };
}

function createDeps(nowResult: any = ok(new Date('2030-07-19T00:00:00.000Z'))) {
  return {
    scheduling: {
      createSchedule: vi.fn().mockResolvedValue(ok(futureResult)),
    },
    trustedClock: {
      now: vi.fn().mockResolvedValue(nowResult),
    },
  };
}

function validInput() {
  return {
    teacherId: 'teacher-1',
    type: 'lesson',
    title: '未来物理课',
    scheduledStart: '2030-07-20T16:00:00+08:00',
    scheduledEnd: '2030-07-20T18:00:00+08:00',
  };
}

describe('CreatePlannedScheduleUseCase', () => {
  it('导出统一计划日程 use-case', () => {
    expect(createPlannedScheduleUseCase).toBeDefined();
  });

  it.each([
    { field: 'scheduledStart', patch: { scheduledStart: '2030-07-20T16:00:00' } },
    { field: 'scheduledEnd', patch: { scheduledEnd: '2030-07-20T18:00:00' } },
  ])('拒绝缺少时区 offset 的 $field 且不调用领域写入', async ({ field, patch }) => {
    const deps = createDeps();
    const useCase = requireFactory()(deps);

    const result = await useCase.create({ ...validInput(), ...patch });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe(field);
    expect(deps.scheduling.createSchedule).not.toHaveBeenCalled();
  });

  it.each([
    '2030-07-18T23:59:59.999Z',
    '2030-07-19T00:00:00.000Z',
  ])('拒绝早于或等于 trusted now 的 planned 日程：%s', async (scheduledStart) => {
    const deps = createDeps();
    const useCase = requireFactory()(deps);

    const result = await useCase.create({
      ...validInput(),
      scheduledStart,
      scheduledEnd: '2030-07-20T18:00:00+08:00',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('scheduledStart');
    expect(deps.scheduling.createSchedule).not.toHaveBeenCalled();
  });

  it('TrustedClock 失败时返回 INTERNAL_ERROR 且不调用领域写入', async () => {
    const deps = createDeps({ ok: false, error: internalError('数据库可信时间不可用') });
    const useCase = requireFactory()(deps);

    const result = await useCase.create(validInput());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(deps.scheduling.createSchedule).not.toHaveBeenCalled();
  });

  it('带 +08:00 的未来时间投影为唯一 instant 并调用领域服务一次', async () => {
    const deps = createDeps();
    const useCase = requireFactory()(deps);

    const result = await useCase.create(validInput());

    expect(result.ok).toBe(true);
    expect(deps.scheduling.createSchedule).toHaveBeenCalledTimes(1);
    expect(deps.scheduling.createSchedule).toHaveBeenCalledWith(expect.objectContaining({
      teacherId: 'teacher-1',
      type: 'lesson',
      title: '未来物理课',
      scheduledStart: new Date('2030-07-20T08:00:00.000Z'),
      scheduledEnd: new Date('2030-07-20T10:00:00.000Z'),
    }));
  });
});
