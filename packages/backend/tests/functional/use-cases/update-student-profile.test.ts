import { describe, expect, it, vi } from 'vitest';
import { internalError, ok, versionConflict } from '@teacher-platform/contracts';

let createUpdateStudentProfileUseCaseWithServices: unknown;
let importError: unknown;
try {
  const module = await import(
    '../../../src/app/use-cases/update-student-profile/update-student-profile-use-case.js'
  );
  createUpdateStudentProfileUseCaseWithServices = module.createUpdateStudentProfileUseCaseWithServices;
} catch (caught) {
  importError = caught;
}

const before = {
  id: 'student-1',
  teacherId: 'teacher-1',
  name: '张三',
  grade: '高一',
  source: '家长介绍',
  currentStatus: 'active',
  stageGoal: '夯实力学',
  createdAt: new Date('2029-01-01T00:00:00.000Z'),
  updatedAt: new Date('2030-01-01T00:00:00.000Z'),
};
const after = {
  ...before,
  name: '张三同学',
  stageGoal: null,
  updatedAt: new Date('2030-01-02T00:00:00.000Z'),
};
const changeLog = {
  id: 'change-1',
  teacherId: 'teacher-1',
  timestamp: new Date('2030-01-02T00:00:00.000Z'),
  module: 'students',
  action: 'update',
  targetType: 'Student',
  targetId: 'student-1',
  before: null,
  after: null,
  diff: null,
  source: 'manual-web',
  operatorId: null,
};

function requireFactory() {
  if (importError) {
    throw new Error(
      `update-student-profile use-case import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (typeof createUpdateStudentProfileUseCaseWithServices !== 'function') {
    throw new Error('createUpdateStudentProfileUseCaseWithServices export is missing');
  }
  return createUpdateStudentProfileUseCaseWithServices as (services: any) => {
    updateStudentProfile(command: any): Promise<any>;
  };
}

function createServices(ownerResult: any = ok({ before, after }), changeResult: any = ok(changeLog)) {
  const transactional = {
    students: {
      updateStudentProfile: vi.fn().mockResolvedValue(ownerResult),
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
    studentId: 'student-1',
    expectedUpdatedAt: '2030-01-01T08:00:00+08:00',
    source: 'manual-web',
    changes: { name: '张三同学', stageGoal: null },
  };
}

describe('UpdateStudentProfileUseCase application contract', () => {
  it('导出可注入事务服务的Student profile use-case', () => {
    expect(requireFactory()).toBeTypeOf('function');
  });

  it.each(['manual-web', 'agent-confirmed', 'wechat-confirmed'])('%s 缺少expected时在事务前返回VALIDATION_ERROR', async (source) => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateStudentProfile({
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

    const result = await useCase.updateStudentProfile({ ...validCommand(), expectedUpdatedAt });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'expectedUpdatedAt' }),
    });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { changes: {}, field: 'changes' },
    { changes: { currentStatus: 'paused' }, field: 'changes' },
    { changes: { name: 42 }, field: 'name' },
    { changes: { stageGoal: 42 }, field: 'stageGoal' },
  ])('在事务前拒绝非法changes：$changes', async ({ changes, field }) => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateStudentProfile({ ...validCommand(), changes });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }),
    });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { patch: { teacherId: ' ' }, field: 'teacherId' },
    { patch: { studentId: '' }, field: 'studentId' },
    { patch: { source: 'manual' }, field: 'source' },
  ])('拒绝不可信命令元数据：$field', async ({ patch, field }) => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateStudentProfile({ ...validCommand(), ...patch });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }),
    });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it('将offset expected解析为同一instant，调用owner并返回receipt', async () => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateStudentProfile(validCommand());

    expect(services.transactional.students.updateStudentProfile).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      studentId: 'student-1',
      expectedUpdatedAt: new Date('2030-01-01T00:00:00.000Z'),
      changes: { name: '张三同学', stageGoal: null },
    });
    expect(result).toEqual(ok({ value: after, changeLogId: 'change-1' }));
  });

  it('只用owner before/after生成profile审计快照并透传可信source', async () => {
    const services = createServices();
    const useCase = requireFactory()(services);

    await useCase.updateStudentProfile(validCommand());

    expect(services.transactional.changelog.recordChange).toHaveBeenCalledTimes(1);
    expect(services.transactional.changelog.recordChange).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      module: 'students',
      action: 'update',
      targetType: 'Student',
      targetId: 'student-1',
      before: {
        name: '张三',
        grade: '高一',
        source: '家长介绍',
        stageGoal: '夯实力学',
        updatedAt: '2030-01-01T00:00:00.000Z',
      },
      after: {
        name: '张三同学',
        grade: '高一',
        source: '家长介绍',
        stageGoal: null,
        updatedAt: '2030-01-02T00:00:00.000Z',
      },
      source: 'manual-web',
    });
  });

  it('owner失败时不调用ChangeLog并保持原错误', async () => {
    const ownerError = { ok: false, error: versionConflict() };
    const services = createServices(ownerError);
    const useCase = requireFactory()(services);

    const result = await useCase.updateStudentProfile(validCommand());

    expect(result).toEqual(ownerError);
    expect(services.transactional.changelog.recordChange).not.toHaveBeenCalled();
  });

  it('ChangeLog失败时保持INTERNAL_ERROR结果', async () => {
    const auditError = { ok: false, error: internalError('审计失败') };
    const services = createServices(undefined, auditError);
    const useCase = requireFactory()(services);

    const result = await useCase.updateStudentProfile(validCommand());

    expect(result).toEqual(auditError);
  });

  it('受控system来源可省略expected但仍进入同一owner命令', async () => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updateStudentProfile({
      ...validCommand(),
      source: 'system',
      expectedUpdatedAt: undefined,
    });

    expect(result.ok).toBe(true);
    expect(services.transactional.students.updateStudentProfile).toHaveBeenCalledWith(
      expect.objectContaining({ expectedUpdatedAt: undefined }),
    );
  });
});
