import { describe, expect, it, vi } from 'vitest';
import { internalError, ok, versionConflict } from '@teacher-platform/contracts';

let createRescheduleLessonUseCaseWithServices: unknown;
let importError: unknown;
try {
  const module = await import(
    '../../../src/app/use-cases/reschedule-lesson/reschedule-lesson-use-case.js'
  );
  createRescheduleLessonUseCaseWithServices = module.createRescheduleLessonUseCaseWithServices;
} catch (caught) {
  importError = caught;
}

const beforeOriginal = {
  id: 'schedule-1', teacherId: 'teacher-1', studentId: 'student-1', type: 'lesson',
  title: '力学课', scheduledStart: new Date('2030-01-01T08:00:00.000Z'),
  scheduledEnd: new Date('2030-01-01T09:00:00.000Z'), status: 'planned',
  confidence: 'high', pendingFields: ['room'], sourceInput: '周三上午上课', parentId: null,
  createdAt: new Date('2029-01-01T00:00:00.000Z'), updatedAt: new Date('2030-01-01T00:00:00.000Z'),
};
const original = {
  ...beforeOriginal,
  status: 'rescheduled',
  updatedAt: new Date('2030-01-02T00:00:00.000Z'),
};
const replacement = {
  ...beforeOriginal,
  id: 'schedule-2',
  scheduledStart: new Date('2030-01-03T08:00:00.000Z'),
  scheduledEnd: new Date('2030-01-03T09:00:00.000Z'),
  status: 'planned',
  parentId: 'schedule-1',
  createdAt: new Date('2030-01-02T00:00:00.000Z'),
  updatedAt: new Date('2030-01-02T00:00:00.000Z'),
};
const conflicts = [{ ...replacement, id: 'conflict-1', parentId: null }];
const ownerValue = { beforeOriginal, original, replacement, conflicts };
const originalLog = { id: 'change-original' };
const replacementLog = { id: 'change-replacement' };

function requireFactory() {
  if (importError) {
    throw new Error(
      `reschedule-lesson use-case import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (typeof createRescheduleLessonUseCaseWithServices !== 'function') {
    throw new Error('createRescheduleLessonUseCaseWithServices export is missing');
  }
  return createRescheduleLessonUseCaseWithServices as (services: any) => {
    rescheduleLesson(command: any): Promise<any>;
  };
}

function createServices(ownerResult: any = ok(ownerValue), logResults: any[] = [ok(originalLog), ok(replacementLog)]) {
  const transactional = {
    scheduling: { rescheduleLesson: vi.fn().mockResolvedValue(ownerResult) },
    changelog: { recordChange: vi.fn().mockResolvedValueOnce(logResults[0]).mockResolvedValueOnce(logResults[1]) },
  };
  return {
    transactional,
    transaction: vi.fn(async (work: (services: typeof transactional) => Promise<any>) => work(transactional)),
  };
}

function validCommand(patch: Record<string, unknown> = {}) {
  return {
    teacherId: 'teacher-1',
    scheduleId: 'schedule-1',
    expectedUpdatedAt: '2030-01-01T08:00:00+08:00',
    source: 'manual-web',
    replacement: {
      scheduledStart: '2030-01-03T16:00:00+08:00',
      scheduledEnd: '2030-01-03T17:00:00+08:00',
    },
    ...patch,
  };
}

describe('RescheduleLessonUseCase application contract', () => {
  it('导出可注入事务服务的reschedule use-case', () => {
    expect(requireFactory()).toBeTypeOf('function');
  });

  it.each(['manual-web', 'agent-confirmed', 'wechat-confirmed'])('%s 缺少expected时在事务前返回VALIDATION_ERROR', async (source) => {
    const services = createServices();
    const useCase = requireFactory()(services);
    const result = await useCase.rescheduleLesson(validCommand({ source, expectedUpdatedAt: undefined }));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'expectedUpdatedAt' }) });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it.each([
    '2030-01-01T00:00:00',
    '2030-02-30T00:00:00Z',
    '2030-01-01T24:00:00Z',
    'not-an-instant',
  ])('拒绝非严格RFC3339 expected：%s', async (expectedUpdatedAt) => {
    const services = createServices();
    const result = await requireFactory()(services).rescheduleLesson(validCommand({ expectedUpdatedAt }));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'expectedUpdatedAt' }) });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { replacement: null },
    { replacement: [] },
    { replacement: { scheduledStart: '2030-01-03T08:00:00Z' } },
    { replacement: { scheduledEnd: '2030-01-03T09:00:00Z' } },
    { replacement: { scheduledStart: '2030-01-03T08:00:00Z', scheduledEnd: '2030-01-03T09:00:00Z', title: '越权' } },
  ])('拒绝非普通、非成对或含额外字段的replacement：$replacement', async ({ replacement }) => {
    const services = createServices();
    const result = await requireFactory()(services).rescheduleLesson(validCommand({ replacement }));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'replacement' }) });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { scheduledStart: '2030-01-03T08:00:00', scheduledEnd: '2030-01-03T09:00:00Z', field: 'scheduledStart' },
    { scheduledStart: '2030-01-03T08:00:00Z', scheduledEnd: '2030-02-30T09:00:00Z', field: 'scheduledEnd' },
    { scheduledStart: '2030-01-03T09:00:00Z', scheduledEnd: '2030-01-03T09:00:00Z', field: 'scheduledEnd' },
    { scheduledStart: '2030-01-03T10:00:00Z', scheduledEnd: '2030-01-03T09:00:00Z', field: 'scheduledEnd' },
  ])('拒绝非法replacement instant或非正区间：$field', async ({ scheduledStart, scheduledEnd, field }) => {
    const services = createServices();
    const result = await requireFactory()(services).rescheduleLesson(validCommand({ replacement: { scheduledStart, scheduledEnd } }));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }) });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { patch: { teacherId: ' ' }, field: 'teacherId' },
    { patch: { scheduleId: '' }, field: 'scheduleId' },
    { patch: { source: 'manual' }, field: 'source' },
  ])('拒绝不可信命令元数据：$field', async ({ patch, field }) => {
    const services = createServices();
    const result = await requireFactory()(services).rescheduleLesson(validCommand(patch));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }) });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it('解析offset instant，调用owner并返回结果与双日志ID', async () => {
    const services = createServices();
    const result = await requireFactory()(services).rescheduleLesson(validCommand());
    expect(services.transactional.scheduling.rescheduleLesson).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      scheduleId: 'schedule-1',
      expectedUpdatedAt: new Date('2030-01-01T00:00:00.000Z'),
      replacement: {
        scheduledStart: new Date('2030-01-03T08:00:00.000Z'),
        scheduledEnd: new Date('2030-01-03T09:00:00.000Z'),
      },
    });
    expect(result).toEqual(ok({
      original,
      replacement,
      conflicts,
      changeLogIds: { original: 'change-original', replacement: 'change-replacement' },
    }));
  });

  it('只用owner事实生成两条来源准确的Schedule审计', async () => {
    const services = createServices();
    await requireFactory()(services).rescheduleLesson(validCommand());
    expect(services.transactional.changelog.recordChange).toHaveBeenCalledTimes(2);
    expect(services.transactional.changelog.recordChange).toHaveBeenNthCalledWith(1, {
      teacherId: 'teacher-1', module: 'scheduling', action: 'update', targetType: 'Schedule', targetId: 'schedule-1',
      before: { status: 'planned', updatedAt: '2030-01-01T00:00:00.000Z' },
      after: { status: 'rescheduled', updatedAt: '2030-01-02T00:00:00.000Z' },
      source: 'manual-web',
    });
    expect(services.transactional.changelog.recordChange).toHaveBeenNthCalledWith(2, {
      teacherId: 'teacher-1', module: 'scheduling', action: 'create', targetType: 'Schedule', targetId: 'schedule-2',
      before: null,
      after: {
        studentId: 'student-1', type: 'lesson', title: '力学课',
        scheduledStart: '2030-01-03T08:00:00.000Z', scheduledEnd: '2030-01-03T09:00:00.000Z',
        status: 'planned', confidence: 'high', pendingFields: ['room'], sourceInput: '周三上午上课',
        parentId: 'schedule-1', updatedAt: '2030-01-02T00:00:00.000Z',
      },
      source: 'manual-web',
    });
  });

  it('owner失败时不写日志并保持原错误', async () => {
    const ownerError = { ok: false, error: versionConflict() };
    const services = createServices(ownerError);
    const result = await requireFactory()(services).rescheduleLesson(validCommand());
    expect(result).toEqual(ownerError);
    expect(services.transactional.changelog.recordChange).not.toHaveBeenCalled();
  });

  it('任一ChangeLog失败时停止并保持INTERNAL_ERROR', async () => {
    const auditError = { ok: false, error: internalError('审计失败') };
    const services = createServices(undefined, [ok(originalLog), auditError]);
    const result = await requireFactory()(services).rescheduleLesson(validCommand());
    expect(result).toEqual(auditError);
  });

  it('system可省略expected，提供时仍解析比较', async () => {
    const services = createServices();
    const useCase = requireFactory()(services);
    expect((await useCase.rescheduleLesson(validCommand({ source: 'system', expectedUpdatedAt: undefined }))).ok).toBe(true);
    expect(services.transactional.scheduling.rescheduleLesson).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedUpdatedAt: undefined }),
    );
  });
});
