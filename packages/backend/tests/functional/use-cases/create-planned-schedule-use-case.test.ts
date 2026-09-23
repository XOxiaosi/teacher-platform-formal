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
    participantIds: ['student-1'],
    type: 'lesson',
    title: '',
    location: '线上',
    classFormat: 'one_to_one',
    operationalNote: null,
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
    clientRequestId: 'schedule-valid-0001',
    type: 'lesson',
    participantIds: ['student-1'],
    location: '线上',
    classFormat: 'one_to_one',
    scheduledStart: '2030-07-20T16:00:00+08:00',
    scheduledEnd: '2030-07-20T18:00:00+08:00',
  };
}

describe('CreatePlannedScheduleUseCase', () => {
  it('导出统一计划日程 use-case', () => {
    expect(createPlannedScheduleUseCase).toBeDefined();
  });

  it('正式一对一课程透传结构化字段且不需要课程标题', async () => {
    const deps = createDeps();
    const useCase = requireFactory()(deps);

    const result = await useCase.create({
      teacherId: 'teacher-1',
      clientRequestId: 'schedule-create-0001',
      type: 'lesson',
      participantIds: ['student-1'],
      location: '工作室 A',
      classFormat: 'one_to_one',
      operationalNote: '先确认错题订正',
      scheduledStart: '2030-07-20T16:00:00+08:00',
      scheduledEnd: '2030-07-20T18:00:00+08:00',
    });

    expect(result.ok).toBe(true);
    expect(deps.scheduling.createSchedule).toHaveBeenCalledExactlyOnceWith({
      teacherId: 'teacher-1',
      clientRequestId: 'schedule-create-0001',
      studentId: undefined,
      participantIds: ['student-1'],
      type: 'lesson',
      title: undefined,
      location: '工作室 A',
      classFormat: 'one_to_one',
      operationalNote: '先确认错题订正',
      scheduledStart: new Date('2030-07-20T08:00:00.000Z'),
      scheduledEnd: new Date('2030-07-20T10:00:00.000Z'),
      confidence: undefined,
      pendingFields: undefined,
      sourceInput: undefined,
    });
  });

  it.each([
    { field: 'clientRequestId', patch: { clientRequestId: undefined } },
    { field: 'clientRequestId', patch: { clientRequestId: 'short' } },
    { field: 'title', patch: { title: '不应出现的课程名称' } },
    { field: 'studentId', patch: { studentId: 'student-1' } },
    { field: 'participantIds', patch: { participantIds: ['student-1', 42] } },
    { field: 'participantIds', patch: { participantIds: [' student-1'] } },
    { field: 'participantIds', patch: { participantIds: ['student-1', 'student-1'] } },
    { field: 'participantIds', patch: { participantIds: [] } },
    { field: 'participantIds', patch: { participantIds: ['student-1', 'student-2'] } },
    { field: 'location', patch: { location: '   ' } },
    { field: 'classFormat', patch: { classFormat: 'group' } },
    { field: 'operationalNote', patch: { operationalNote: 42 } },
  ])('正式课程拒绝非法 $field 且零领域写入：$patch', async ({ field, patch }) => {
    const deps = createDeps();
    const useCase = requireFactory()(deps);

    const result = await useCase.create({
      teacherId: 'teacher-1',
      clientRequestId: 'schedule-create-0001',
      type: 'lesson',
      participantIds: ['student-1'],
      location: '工作室 A',
      classFormat: 'one_to_one',
      scheduledStart: '2030-07-20T16:00:00+08:00',
      scheduledEnd: '2030-07-20T18:00:00+08:00',
      ...patch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VALIDATION_ERROR', field });
    expect(deps.trustedClock.now).not.toHaveBeenCalled();
    expect(deps.scheduling.createSchedule).not.toHaveBeenCalled();
  });

  it('正式小班至少两名参与人并精确透传', async () => {
    const deps = createDeps();
    const useCase = requireFactory()(deps);

    const result = await useCase.create({
      teacherId: 'teacher-1',
      clientRequestId: 'schedule-group-0001',
      type: 'lesson',
      participantIds: ['student-1', 'student-2'],
      location: '线上',
      classFormat: 'small_group',
      scheduledStart: '2030-07-20T16:00:00+08:00',
      scheduledEnd: '2030-07-20T18:00:00+08:00',
    });

    expect(result.ok).toBe(true);
    expect(deps.scheduling.createSchedule).toHaveBeenCalledWith(expect.objectContaining({
      clientRequestId: 'schedule-group-0001',
      participantIds: ['student-1', 'student-2'],
      classFormat: 'small_group',
    }));
  });

  it('非课程日程继续要求标题且不接受结构化课程字段', async () => {
    const deps = createDeps();
    const useCase = requireFactory()(deps);
    const valid = await useCase.create({
      teacherId: 'teacher-1',
      clientRequestId: 'schedule-meeting-0001',
      type: 'meeting',
      title: '教研会议',
      scheduledStart: '2030-07-20T16:00:00+08:00',
      scheduledEnd: '2030-07-20T18:00:00+08:00',
    });
    const invalid = await useCase.create({
      teacherId: 'teacher-1',
      clientRequestId: 'schedule-meeting-0002',
      type: 'meeting',
      title: '教研会议',
      participantIds: ['student-1'],
      scheduledStart: '2030-07-20T16:00:00+08:00',
      scheduledEnd: '2030-07-20T18:00:00+08:00',
    });

    expect(valid.ok).toBe(true);
    expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'type' } });
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
      title: undefined,
      participantIds: ['student-1'],
      location: '线上',
      classFormat: 'one_to_one',
      scheduledStart: new Date('2030-07-20T08:00:00.000Z'),
      scheduledEnd: new Date('2030-07-20T10:00:00.000Z'),
    }));
  });
});
