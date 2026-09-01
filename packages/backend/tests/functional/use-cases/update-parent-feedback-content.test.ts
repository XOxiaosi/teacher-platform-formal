import { describe, expect, it, vi } from 'vitest';
import { internalError, ok, versionConflict } from '@teacher-platform/contracts';

let createUseCaseWithServices: unknown;
let importError: unknown;
try {
  const module = await import('../../../src/app/use-cases/update-parent-feedback-content/update-parent-feedback-content-use-case.js');
  createUseCaseWithServices = module.createUpdateParentFeedbackContentUseCaseWithServices;
} catch (caught) {
  importError = caught;
}

const before = {
  id: 'feedback-1', teacherId: 'teacher-1', studentId: 'student-1', lessonId: null,
  title: '原反馈', content: '原内容', status: 'draft' as const, channel: 'wechat',
  parentName: '家长', sentAt: null, createdAt: new Date('2029-01-01T00:00:00.000Z'),
  updatedAt: new Date('2030-01-01T00:00:00.000Z'),
};
const after = {
  ...before, title: '新反馈', content: '新内容',
  updatedAt: new Date('2030-01-02T00:00:00.000Z'),
};
const changeLog = {
  id: 'change-1', teacherId: 'teacher-1', timestamp: after.updatedAt,
  module: 'feedback', action: 'update', targetType: 'ParentFeedback', targetId: before.id,
  before: null, after: null, diff: null, source: 'manual-web', operatorId: null,
};

function requireFactory() {
  if (importError) {
    throw new Error(`update-parent-feedback-content import failed: ${importError instanceof Error ? importError.message : String(importError)}`);
  }
  if (typeof createUseCaseWithServices !== 'function') {
    throw new Error('createUpdateParentFeedbackContentUseCaseWithServices export is missing');
  }
  return createUseCaseWithServices as (services: any) => {
    updateParentFeedbackContent(command: any): Promise<any>;
  };
}

function createServices(ownerResult: any = ok({ before, after }), auditResult: any = ok(changeLog)) {
  const transactional = {
    feedback: { updateParentFeedbackContent: vi.fn().mockResolvedValue(ownerResult) },
    changelog: { recordChange: vi.fn().mockResolvedValue(auditResult) },
  };
  return {
    transactional,
    transaction: vi.fn(async (work: (services: typeof transactional) => Promise<any>) => work(transactional)),
  };
}

function validCommand() {
  return {
    teacherId: 'teacher-1', feedbackId: 'feedback-1',
    expectedUpdatedAt: '2030-01-01T08:00:00+08:00', source: 'manual-web',
    changes: { title: '新反馈', content: '新内容' },
  };
}

describe('UpdateParentFeedbackContentUseCase application contract', () => {
  it('导出可注入事务服务的窄use-case', () => {
    expect(requireFactory()).toBeTypeOf('function');
  });

  it.each(['manual-web', 'agent-confirmed', 'wechat-confirmed'])('%s 缺少expected时事务前失败', async (source) => {
    const services = createServices();
    const useCase = requireFactory()(services);
    const result = await useCase.updateParentFeedbackContent({ ...validCommand(), source, expectedUpdatedAt: undefined });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'expectedUpdatedAt' }) });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it.each(['2030-01-01T00:00:00', '2030-02-30T00:00:00Z', '2030-01-01T24:00:00Z', 'bad'])('拒绝非严格RFC3339 expected：%s', async (expectedUpdatedAt) => {
    const services = createServices();
    const result = await requireFactory()(services).updateParentFeedbackContent({ ...validCommand(), expectedUpdatedAt });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'expectedUpdatedAt' }) });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { changes: {}, field: 'changes' },
    { changes: null, field: 'changes' },
    { changes: [], field: 'changes' },
    { changes: { status: 'sent' }, field: 'changes' },
    { changes: { sentAt: null }, field: 'changes' },
    { changes: { studentId: 'other' }, field: 'changes' },
    { changes: { lessonId: 'lesson' }, field: 'changes' },
    { changes: { channel: null }, field: 'changes' },
    { changes: { parentName: null }, field: 'changes' },
    { changes: { title: null }, field: 'title' },
    { changes: { content: 1 }, field: 'content' },
  ])('事务前拒绝非法changes：$field', async ({ changes, field }) => {
    const services = createServices();
    const result = await requireFactory()(services).updateParentFeedbackContent({ ...validCommand(), changes });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }) });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { patch: { teacherId: ' ' }, field: 'teacherId' },
    { patch: { feedbackId: '' }, field: 'feedbackId' },
    { patch: { source: 'manual' }, field: 'source' },
  ])('拒绝不可信命令元数据：$field', async ({ patch, field }) => {
    const services = createServices();
    const result = await requireFactory()(services).updateParentFeedbackContent({ ...validCommand(), ...patch });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }) });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it('解析expected、调用窄owner、记录白名单快照并返回receipt', async () => {
    const services = createServices();
    const result = await requireFactory()(services).updateParentFeedbackContent(validCommand());
    expect(services.transactional.feedback.updateParentFeedbackContent).toHaveBeenCalledWith({
      teacherId: 'teacher-1', feedbackId: 'feedback-1',
      expectedUpdatedAt: new Date('2030-01-01T00:00:00.000Z'),
      changes: { title: '新反馈', content: '新内容' },
    });
    expect(services.transactional.changelog.recordChange).toHaveBeenCalledWith({
      teacherId: 'teacher-1', module: 'feedback', action: 'update',
      targetType: 'ParentFeedback', targetId: 'feedback-1',
      before: { title: '原反馈', content: '原内容', updatedAt: '2030-01-01T00:00:00.000Z' },
      after: { title: '新反馈', content: '新内容', updatedAt: '2030-01-02T00:00:00.000Z' },
      source: 'manual-web',
    });
    expect(result).toEqual(ok({ value: after, changeLogId: 'change-1' }));
  });

  it('空白文本交给owner以保持stale优先级', async () => {
    const ownerError = { ok: false, error: versionConflict() };
    const services = createServices(ownerError);
    const result = await requireFactory()(services).updateParentFeedbackContent({ ...validCommand(), changes: { title: ' ', content: '' } });
    expect(result).toEqual(ownerError);
    expect(services.transactional.changelog.recordChange).not.toHaveBeenCalled();
  });

  it('system可省略expected并仍调用owner', async () => {
    const services = createServices();
    const result = await requireFactory()(services).updateParentFeedbackContent({ ...validCommand(), source: 'system', expectedUpdatedAt: undefined });
    expect(result.ok).toBe(true);
    expect(services.transactional.feedback.updateParentFeedbackContent).toHaveBeenCalledWith(expect.objectContaining({ expectedUpdatedAt: undefined }));
  });

  it('owner失败直接返回且不写审计', async () => {
    const ownerError = { ok: false, error: versionConflict() };
    const services = createServices(ownerError);
    const result = await requireFactory()(services).updateParentFeedbackContent(validCommand());
    expect(result).toEqual(ownerError);
    expect(services.transactional.changelog.recordChange).not.toHaveBeenCalled();
  });

  it('审计失败原样返回给事务边界', async () => {
    const auditError = { ok: false, error: internalError('审计失败') };
    const services = createServices(ok({ before, after }), auditError);
    const result = await requireFactory()(services).updateParentFeedbackContent(validCommand());
    expect(result).toEqual(auditError);
  });
});
