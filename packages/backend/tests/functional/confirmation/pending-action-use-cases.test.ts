import { describe, expect, it, vi } from 'vitest';
import { alreadyConsumed, err, ok, validationError } from '@teacher-platform/contracts';
import { createConfirmPendingActionUseCase } from '../../../src/app/use-cases/confirm-pending-action/confirm-pending-action-use-case.js';
import { createCancelPendingActionUseCase } from '../../../src/app/use-cases/cancel-pending-action/cancel-pending-action-use-case.js';
import type {
  ActionTokenSigner,
  PendingActionData,
  PendingActionExecutionStore,
} from '../../../src/features/pending-action/index.js';
import type {
  ConfirmableActionExecutor,
  ConfirmableActionRegistry,
  ConfirmationTransactionPort,
} from '../../../src/app/confirmation/types.js';

const DATABASE_NOW = new Date('2030-01-01T00:00:00.000Z');

function pendingAction(overrides: Partial<PendingActionData> = {}): PendingActionData {
  return {
    id: 'pending-1',
    teacherId: 'teacher-1',
    conversationId: 'conversation-1',
    toolCallId: 'tool-1',
    actionName: 'students.updateStatus',
    targetType: 'Student',
    targetId: 'student-1',
    parameters: { studentId: 'student-1', status: 'paused' },
    beforeSummary: 'active',
    afterSummary: 'paused',
    status: 'executing',
    expiresAt: new Date('2030-01-01T00:10:00.000Z'),
    consumedAt: null,
    cancelledAt: null,
    createdAt: new Date('2029-01-01T00:00:00.000Z'),
    updatedAt: new Date('2029-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function signer(result = ok({ pendingActionId: 'pending-1' })): ActionTokenSigner {
  return {
    sign: vi.fn(() => ok('token')),
    verify: vi.fn(() => result),
  };
}

function dependencies(overrides: {
  store?: Partial<PendingActionExecutionStore>;
  executor?: ConfirmableActionExecutor;
  registry?: ConfirmableActionRegistry;
  paymentReceipt?: { summary: string; references: Array<{ type: 'Payment'; id: string }> } | null;
} = {}) {
  const executing = pendingAction();
  const consumed = pendingAction({ status: 'consumed', consumedAt: DATABASE_NOW });
  const executor = overrides.executor ?? {
    execute: vi.fn(async () => ok({
      summary: '学生状态已更新',
      references: [{ type: 'Student', id: 'student-1' }],
    })),
  };
  const store: PendingActionExecutionStore = {
    getDatabaseNow: vi.fn(async () => ok(DATABASE_NOW)),
    getOwned: vi.fn(async () => ok(executing)),
    claim: vi.fn(async () => ok({ kind: 'claimed' as const, pendingAction: executing })),
    markConsumed: vi.fn(async () => ok(consumed)),
    cancel: vi.fn(async () => ok(pendingAction({ status: 'cancelled', cancelledAt: DATABASE_NOW }))),
    ...overrides.store,
  };
  const registry = overrides.registry ?? {
    get: vi.fn(() => ok(executor)),
  };
  const paymentReceipts = {
    findPaymentCreateReceipt: vi.fn(async () => overrides.paymentReceipt ?? null),
  };
  const transaction: ConfirmationTransactionPort = {
    run: vi.fn(async (work) => work({ pendingActions: store, registry, paymentReceipts })),
  };
  return { store, executor, registry, paymentReceipts, transaction };
}

describe('ConfirmPendingActionUseCase', () => {
  it('验签失败时不进入事务', async () => {
    const deps = dependencies();
    const useCase = createConfirmPendingActionUseCase({
      actionTokenSigner: signer(err(validationError('actionToken 无效', 'actionToken'))),
      transaction: deps.transaction,
    });

    const result = await useCase.confirm({
      teacherId: 'teacher-1',
      pendingActionId: 'pending-1',
      actionToken: 'bad-token',
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'actionToken 无效', field: 'actionToken' },
    });
    expect(deps.transaction.run).not.toHaveBeenCalled();
  });

  it('token id 与 path id 不一致时不进入事务', async () => {
    const deps = dependencies();
    const useCase = createConfirmPendingActionUseCase({
      actionTokenSigner: signer(ok({ pendingActionId: 'pending-other' })),
      transaction: deps.transaction,
    });

    const result = await useCase.confirm({
      teacherId: 'teacher-1', pendingActionId: 'pending-1', actionToken: 'token',
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'actionToken 与待确认操作不匹配', field: 'actionToken' },
    });
    expect(deps.transaction.run).not.toHaveBeenCalled();
  });

  it('只使用 claim 返回的数据库动作、target 和 parameters 执行并消费', async () => {
    const deps = dependencies();
    const useCase = createConfirmPendingActionUseCase({
      actionTokenSigner: signer(),
      transaction: deps.transaction,
    });

    const result = await useCase.confirm({
      teacherId: 'teacher-1', pendingActionId: 'pending-1', actionToken: 'token',
    });

    expect(deps.store.claim).toHaveBeenCalledWith({
      teacherId: 'teacher-1', pendingActionId: 'pending-1', databaseNow: DATABASE_NOW,
    });
    expect(deps.registry.get).toHaveBeenCalledWith('students.updateStatus');
    expect(deps.executor.execute).toHaveBeenCalledWith({
      pendingActionId: 'pending-1',
      teacherId: 'teacher-1',
      target: { type: 'Student', id: 'student-1' },
      parameters: { studentId: 'student-1', status: 'paused' },
    });
    expect(deps.store.markConsumed).toHaveBeenCalledWith({
      teacherId: 'teacher-1', pendingActionId: 'pending-1', databaseNow: DATABASE_NOW,
    });
    expect(result).toMatchObject({ ok: true, value: { pendingAction: { status: 'consumed' } } });
  });

  it('executor 返回错误时不消费，原错误保持结构化', async () => {
    const executor: ConfirmableActionExecutor = {
      execute: vi.fn(async () => err(validationError('目标状态不合法', 'status'))),
    };
    const deps = dependencies({ executor });
    const useCase = createConfirmPendingActionUseCase({
      actionTokenSigner: signer(), transaction: deps.transaction,
    });

    const result = await useCase.confirm({
      teacherId: 'teacher-1', pendingActionId: 'pending-1', actionToken: 'token',
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: '目标状态不合法', field: 'status' },
    });
    expect(deps.store.markConsumed).not.toHaveBeenCalled();
  });

  it('仅已消费 payments.create 用稳定回执重放，且不再次 claim 或执行写入 executor', async () => {
    const consumedPayment = pendingAction({
      actionName: 'payments.create',
      status: 'consumed',
      consumedAt: DATABASE_NOW,
    });
    const deps = dependencies({
      store: { getOwned: vi.fn(async () => ok(consumedPayment)) },
      paymentReceipt: {
        summary: '已为学生创建缴费记录：金额 1200 元、课时 10 节',
        references: [{ type: 'Payment', id: 'payment-1' }],
      },
    });
    const useCase = createConfirmPendingActionUseCase({
      actionTokenSigner: signer(), transaction: deps.transaction,
    });

    const result = await useCase.confirm({
      teacherId: 'teacher-1', pendingActionId: 'pending-1', actionToken: 'token',
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        pendingAction: { status: 'consumed' },
        result: { references: [{ type: 'Payment', id: 'payment-1' }] },
      },
    });
    expect(deps.paymentReceipts.findPaymentCreateReceipt).toHaveBeenCalledWith({
      teacherId: 'teacher-1', pendingActionId: 'pending-1',
    });
    expect(deps.store.claim).not.toHaveBeenCalled();
    expect(deps.executor.execute).not.toHaveBeenCalled();
    expect(deps.store.markConsumed).not.toHaveBeenCalled();
  });

  it('已消费的非 payments.create 仍由 claim 拒绝，不能读取或重放支付回执', async () => {
    const consumedStudentUpdate = pendingAction({ status: 'consumed', consumedAt: DATABASE_NOW });
    const deps = dependencies({
      store: {
        getOwned: vi.fn(async () => ok(consumedStudentUpdate)),
        claim: vi.fn(async () => err(alreadyConsumed('待确认操作已被占用或消费'))),
      },
    });
    const useCase = createConfirmPendingActionUseCase({
      actionTokenSigner: signer(), transaction: deps.transaction,
    });

    const result = await useCase.confirm({
      teacherId: 'teacher-1', pendingActionId: 'pending-1', actionToken: 'token',
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'ALREADY_CONSUMED' } });
    expect(deps.paymentReceipts.findPaymentCreateReceipt).not.toHaveBeenCalled();
    expect(deps.executor.execute).not.toHaveBeenCalled();
  });
});

describe('CancelPendingActionUseCase', () => {
  it('在事务内使用同一数据库时间取消且不读取 registry', async () => {
    const deps = dependencies();
    const useCase = createCancelPendingActionUseCase({ transaction: deps.transaction });

    const result = await useCase.cancel({ teacherId: 'teacher-1', pendingActionId: 'pending-1' });

    expect(deps.store.cancel).toHaveBeenCalledWith({
      teacherId: 'teacher-1', pendingActionId: 'pending-1', databaseNow: DATABASE_NOW,
    });
    expect(deps.registry.get).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, value: { pendingAction: { status: 'cancelled' } } });
  });
});
