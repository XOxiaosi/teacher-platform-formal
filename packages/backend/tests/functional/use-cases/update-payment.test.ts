import { describe, expect, it, vi } from 'vitest';
import { internalError, ok, versionConflict } from '@teacher-platform/contracts';

let createUpdatePaymentUseCaseWithServices: unknown;
let importError: unknown;
try {
  const module = await import('../../../src/app/use-cases/update-payment/update-payment-use-case.js');
  createUpdatePaymentUseCaseWithServices = module.createUpdatePaymentUseCaseWithServices;
} catch (caught) {
  importError = caught;
}

const before = {
  id: 'payment-1',
  teacherId: 'teacher-1',
  studentId: 'student-1',
  amount: 3000,
  lessonCount: 20,
  paidAt: new Date('2030-06-01T00:00:00.000Z'),
  note: '首次缴费',
  createdAt: new Date('2029-01-01T00:00:00.000Z'),
  updatedAt: new Date('2030-01-01T00:00:00.000Z'),
};
const after = {
  ...before,
  amount: 3500.5,
  lessonCount: 24,
  paidAt: new Date('2030-06-15T08:30:00.000Z'),
  note: null,
  updatedAt: new Date('2030-01-02T00:00:00.000Z'),
};
const changeLog = {
  id: 'change-1',
  teacherId: 'teacher-1',
  timestamp: new Date('2030-01-02T00:00:00.000Z'),
  module: 'payments',
  action: 'update',
  targetType: 'Payment',
  targetId: 'payment-1',
  before: null,
  after: null,
  diff: null,
  source: 'manual-web',
  operatorId: null,
};

function requireFactory() {
  if (importError) {
    throw new Error(
      `update-payment use-case import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (typeof createUpdatePaymentUseCaseWithServices !== 'function') {
    throw new Error('createUpdatePaymentUseCaseWithServices export is missing');
  }
  return createUpdatePaymentUseCaseWithServices as (services: any) => {
    updatePayment(command: any): Promise<any>;
  };
}

function createServices(ownerResult: any = ok({ before, after }), changeResult: any = ok(changeLog)) {
  const transactional = {
    payments: {
      updatePayment: vi.fn().mockResolvedValue(ownerResult),
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
    paymentId: 'payment-1',
    expectedUpdatedAt: '2030-01-01T08:00:00+08:00',
    source: 'manual-web',
    changes: {
      amount: 3500.5,
      lessonCount: 24,
      paidAt: '2030-06-15T16:30:00+08:00',
      note: null,
    },
  };
}

describe('UpdatePaymentUseCase application contract', () => {
  it('导出可注入事务服务的Payment use-case', () => {
    expect(requireFactory()).toBeTypeOf('function');
  });

  it.each(['manual-web', 'agent-confirmed', 'wechat-confirmed'])('%s 缺少expected时在事务前返回VALIDATION_ERROR', async (source) => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updatePayment({
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

    const result = await useCase.updatePayment({ ...validCommand(), expectedUpdatedAt });

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
    { changes: { studentId: 'student-2' }, field: 'changes' },
    { changes: { amount: '3000' }, field: 'amount' },
    { changes: { lessonCount: '20' }, field: 'lessonCount' },
    { changes: { paidAt: new Date('2030-01-01T00:00:00.000Z') }, field: 'paidAt' },
    { changes: { paidAt: '2030-06-15T16:30:00' }, field: 'paidAt' },
    { changes: { paidAt: '2030-02-30T00:00:00Z' }, field: 'paidAt' },
    { changes: { note: 42 }, field: 'note' },
  ])('在事务前拒绝非法changes：$field/$changes', async ({ changes, field }) => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updatePayment({ ...validCommand(), changes });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }),
    });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { patch: { teacherId: ' ' }, field: 'teacherId' },
    { patch: { paymentId: '' }, field: 'paymentId' },
    { patch: { source: 'manual' }, field: 'source' },
  ])('拒绝不可信命令元数据：$field', async ({ patch, field }) => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updatePayment({ ...validCommand(), ...patch });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }),
    });
    expect(services.transaction).not.toHaveBeenCalled();
  });

  it('解析expected与paidAt为唯一instant，透传数值/null并返回receipt', async () => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updatePayment(validCommand());

    expect(services.transactional.payments.updatePayment).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      paymentId: 'payment-1',
      expectedUpdatedAt: new Date('2030-01-01T00:00:00.000Z'),
      changes: {
        amount: 3500.5,
        lessonCount: 24,
        paidAt: new Date('2030-06-15T08:30:00.000Z'),
        note: null,
      },
    });
    expect(result).toEqual(ok({ value: after, changeLogId: 'change-1' }));
  });

  it('数值领域规则交给owner，以保持版本优先级', async () => {
    const ownerError = { ok: false, error: versionConflict() };
    const services = createServices(ownerError);
    const useCase = requireFactory()(services);

    const result = await useCase.updatePayment({
      ...validCommand(),
      changes: { amount: 0, lessonCount: 1.5 },
    });

    expect(result).toEqual(ownerError);
    expect(services.transactional.payments.updatePayment).toHaveBeenCalledWith(
      expect.objectContaining({ changes: { amount: 0, lessonCount: 1.5 } }),
    );
  });

  it('只用owner before/after生成Payment字段审计快照并透传可信source', async () => {
    const services = createServices();
    const useCase = requireFactory()(services);

    await useCase.updatePayment(validCommand());

    expect(services.transactional.changelog.recordChange).toHaveBeenCalledTimes(1);
    expect(services.transactional.changelog.recordChange).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      module: 'payments',
      action: 'update',
      targetType: 'Payment',
      targetId: 'payment-1',
      before: {
        amount: 3000,
        lessonCount: 20,
        paidAt: '2030-06-01T00:00:00.000Z',
        note: '首次缴费',
        updatedAt: '2030-01-01T00:00:00.000Z',
      },
      after: {
        amount: 3500.5,
        lessonCount: 24,
        paidAt: '2030-06-15T08:30:00.000Z',
        note: null,
        updatedAt: '2030-01-02T00:00:00.000Z',
      },
      source: 'manual-web',
    });
  });

  it('owner失败时不调用ChangeLog并保持原错误', async () => {
    const ownerError = { ok: false, error: versionConflict() };
    const services = createServices(ownerError);
    const useCase = requireFactory()(services);

    const result = await useCase.updatePayment(validCommand());

    expect(result).toEqual(ownerError);
    expect(services.transactional.changelog.recordChange).not.toHaveBeenCalled();
  });

  it('ChangeLog失败时保持INTERNAL_ERROR结果', async () => {
    const auditError = { ok: false, error: internalError('审计失败') };
    const services = createServices(undefined, auditError);
    const useCase = requireFactory()(services);

    const result = await useCase.updatePayment(validCommand());

    expect(result).toEqual(auditError);
  });

  it('受控system来源可省略expected但仍进入同一owner命令', async () => {
    const services = createServices();
    const useCase = requireFactory()(services);

    const result = await useCase.updatePayment({
      ...validCommand(),
      source: 'system',
      expectedUpdatedAt: undefined,
    });

    expect(result.ok).toBe(true);
    expect(services.transactional.payments.updatePayment).toHaveBeenCalledWith(
      expect.objectContaining({ expectedUpdatedAt: undefined }),
    );
  });
});
