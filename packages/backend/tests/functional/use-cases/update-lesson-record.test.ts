import { describe, expect, it, vi } from 'vitest';
import { internalError, ok, versionConflict } from '@teacher-platform/contracts';

let createUpdateLessonRecordUseCaseWithServices: unknown;
let importError: unknown;
try {
  const module = await import(
    '../../../src/app/use-cases/update-lesson-record/update-lesson-record-use-case.js'
  );
  createUpdateLessonRecordUseCaseWithServices = module.createUpdateLessonRecordUseCaseWithServices;
} catch (caught) {
  importError = caught;
}

const before = {
  id: 'lesson-1',
  teacherId: 'teacher-1',
  studentId: 'student-1',
  scheduleId: 'schedule-1',
  date: new Date('2030-01-01T08:00:00.000Z'),
  status: 'attended',
  progress: '力学综合题',
  studentState: '课堂专注',
  homework: '完成练习1-5',
  teacherNote: '计算细节待巩固',
  sourceNoteId: 'note-1',
  createdAt: new Date('2029-01-01T00:00:00.000Z'),
  updatedAt: new Date('2030-01-01T00:00:00.000Z'),
};
const after = {
  ...before,
  progress: '',
  studentState: null,
  homework: '完成专题训练',
  teacherNote: null,
  updatedAt: new Date('2030-01-02T00:00:00.000Z'),
};
const changeLog = {
  id: 'change-1',
  teacherId: 'teacher-1',
  timestamp: new Date('2030-01-02T00:00:00.000Z'),
  module: 'lessons',
  action: 'update',
  targetType: 'Lesson',
  targetId: 'lesson-1',
  before: null,
  after: null,
  diff: null,
  source: 'manual-web',
  operatorId: null,
};

function requireFactory() {
  if (importError) {
    throw new Error(
      `update-lesson-record use-case import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (typeof createUpdateLessonRecordUseCaseWithServices !== 'function') {
    throw new Error('createUpdateLessonRecordUseCaseWithServices export is missing');
  }
  return createUpdateLessonRecordUseCaseWithServices as (services: any) => {
    updateLessonRecord(command: any): Promise<any>;
  };
}

function createServices(ownerResult: any = ok({ before, after }), changeResult: any = ok(changeLog)) {
  const transactional = {
    lessons: {
      updateLessonRecord: vi.fn().mockResolvedValue(ownerResult),
    },
    changelog: {
      recordChange: vi.fn().mockResolvedValue(changeResult),
    },
  };
  return {
    transactional,
    transaction: vi.fn(async (work: (services: typeof transactional) => Promise<any>) => work(transactional)),
  };
}

function validCommand() {
  return {
    teacherId: 'teacher-1',
    lessonId: 'lesson-1',
    expectedUpdatedAt: '2030-01-01T08:00:00+08:00',
    source: 'manual-web',
    changes: {
      progress: '',
      studentState: null,
      homework: '完成专题训练',
      teacherNote: null,
    },
  };
}

describe('UpdateLessonRecordUseCase application contract', () => {
  it('导出可注入事务服务的Lesson record use-case', () => {
    expect(requireFactory()).toBeTypeOf('function');
  });

  it.each(['manual-web', 'agent-confirmed', 'wechat-confirmed'])('%s 缺少expected时在事务前返回VALIDATION_ERROR', async (source) => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateLessonRecord({
      ...validCommand(),
      source,
      expectedUpdatedAt: undefined,
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'expectedUpdatedAt' }),
    });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it.each([
    '2030-01-01T00:00:00',
    '2030-02-30T00:00:00Z',
    '2030-01-01T24:00:00Z',
    'not-an-instant',
  ])('拒绝非严格RFC3339 expected：%s', async (expectedUpdatedAt) => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateLessonRecord({ ...validCommand(), expectedUpdatedAt });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'expectedUpdatedAt' }),
    });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { changes: {}, field: 'changes' },
    { changes: null, field: 'changes' },
    { changes: [], field: 'changes' },
    { changes: { status: 'absent' }, field: 'changes' },
    { changes: { sourceNoteId: 'note-2' }, field: 'changes' },
    { changes: { progress: 42 }, field: 'progress' },
    { changes: { studentState: false }, field: 'studentState' },
    { changes: { homework: {} }, field: 'homework' },
    { changes: { teacherNote: undefined }, field: 'teacherNote' },
  ])('在事务前拒绝非法changes：$field/$changes', async ({ changes, field }) => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateLessonRecord({ ...validCommand(), changes });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }),
    });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { patch: { teacherId: ' ' }, field: 'teacherId' },
    { patch: { lessonId: '' }, field: 'lessonId' },
    { patch: { source: 'manual' }, field: 'source' },
  ])('拒绝不可信命令元数据：$field', async ({ patch, field }) => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateLessonRecord({ ...validCommand(), ...patch });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }),
    });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it('接受空字符串与null，将offset expected解析为同一instant并返回receipt', async () => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateLessonRecord(validCommand());

    expect(services.transactional.lessons.updateLessonRecord).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      lessonId: 'lesson-1',
      expectedUpdatedAt: new Date('2030-01-01T00:00:00.000Z'),
      changes: {
        progress: '',
        studentState: null,
        homework: '完成专题训练',
        teacherNote: null,
      },
    });
    expect(result).toEqual(ok({ value: after, changeLogId: 'change-1' }));
  });

  it('只用owner before/after生成记录字段审计快照并透传可信source', async () => {
    const services = createServices();
    const useCase = requireFactory()(services);

    await useCase.updateLessonRecord(validCommand());

    expect(services.transactional.changelog.recordChange).toHaveBeenCalledTimes(1);
    expect(services.transactional.changelog.recordChange).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      module: 'lessons',
      action: 'update',
      targetType: 'Lesson',
      targetId: 'lesson-1',
      before: {
        progress: '力学综合题',
        studentState: '课堂专注',
        homework: '完成练习1-5',
        teacherNote: '计算细节待巩固',
        updatedAt: '2030-01-01T00:00:00.000Z',
      },
      after: {
        progress: '',
        studentState: null,
        homework: '完成专题训练',
        teacherNote: null,
        updatedAt: '2030-01-02T00:00:00.000Z',
      },
      source: 'manual-web',
    });
  });

  it('owner失败时不调用ChangeLog并保持原错误', async () => {
    const ownerError = { ok: false, error: versionConflict() };
    const services = createServices(ownerError);
    const useCase = requireFactory()(services);

    const result = await useCase.updateLessonRecord(validCommand());

    expect(result).toEqual(ownerError);
    expect(services.transactional.changelog.recordChange).not.toHaveBeenCalled();
  });

  it('ChangeLog失败时保持INTERNAL_ERROR结果', async () => {
    const auditError = { ok: false, error: internalError('审计失败') };
    const services = createServices(undefined, auditError);
    const useCase = requireFactory()(services);

    const result = await useCase.updateLessonRecord(validCommand());

    expect(result).toEqual(auditError);
  });

  it('受控system来源可省略expected但仍进入同一owner命令', async () => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateLessonRecord({
      ...validCommand(),
      source: 'system',
      expectedUpdatedAt: undefined,
    });

    expect(result.ok).toBe(true);
    expect(services.transactional.lessons.updateLessonRecord).toHaveBeenCalledWith(
      expect.objectContaining({ expectedUpdatedAt: undefined }),
    );
  });
});
