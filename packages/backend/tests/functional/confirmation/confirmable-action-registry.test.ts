import { describe, expect, it, vi } from 'vitest';
import { ok } from '@teacher-platform/contracts';
import { CONFIRMABLE_ACTION_NAMES } from '../../../src/features/pending-action/index.js';
import { createConfirmableActionRegistry } from '../../../src/app/confirmation/confirmable-action-registry.js';
import type {
  ConfirmableActionExecutor,
  ConfirmableActionExecutorMap,
} from '../../../src/app/confirmation/types.js';

function executor(label: string): ConfirmableActionExecutor {
  return {
    execute: vi.fn(async () => ok({ summary: label, references: [] })),
  };
}

function completeMap(): ConfirmableActionExecutorMap {
  return {
    'scheduling.complete': executor('complete'),
    'scheduling.cancel': executor('cancel'),
    'lessons.updateStatus': executor('lesson'),
    'students.updateStatus': executor('student'),
    'students.updateProfile': executor('student-profile'),
    'scheduling.reschedule': executor('schedule-reschedule'),
    'lessons.updateRecord': executor('lesson-record'),
    'payments.update': executor('payment'),
    'memos.update': executor('memo'),
    'feedback.updateContent': executor('feedback-content'),
    'feedback.updateStatus': executor('feedback-status'),
    'payments.create': executor('payment-create'),
    'students.records.capture': executor('records-capture'),
  };
}

describe('ConfirmableActionRegistry', () => {
  it('显式映射且只能取得全部已批准动作', () => {
    const executors = completeMap();
    const registry = createConfirmableActionRegistry(executors);

    for (const actionName of CONFIRMABLE_ACTION_NAMES) {
      expect(registry.get(actionName)).toEqual({ ok: true, value: executors[actionName] });
    }
    expect(registry.get('payments.delete')).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '待确认操作类型未注册' },
    });
  });

  it('构造时拒绝缺失动作', () => {
    const incomplete = { ...completeMap() } as Record<string, ConfirmableActionExecutor>;
    delete incomplete['scheduling.cancel'];

    expect(() => createConfirmableActionRegistry(
      incomplete as unknown as ConfirmableActionExecutorMap,
    )).toThrow('ConfirmableActionRegistry 必须完整映射全部已批准动作');
  });

  it('构造时拒绝额外动作', () => {
    const extra = {
      ...completeMap(),
      'payments.delete': executor('unexpected'),
    } as unknown as ConfirmableActionExecutorMap;

    expect(() => createConfirmableActionRegistry(extra)).toThrow(
      'ConfirmableActionRegistry 只能映射已批准动作',
    );
  });

  it('复制并冻结映射，构造后的外部修改不能替换 executor', () => {
    const source = completeMap();
    const original = source['students.updateStatus'];
    const registry = createConfirmableActionRegistry(source);
    const mutableSource = source as Record<string, ConfirmableActionExecutor>;

    mutableSource['students.updateStatus'] = executor('replacement');

    expect(registry.get('students.updateStatus')).toEqual({ ok: true, value: original });
    expect(Object.isFrozen(registry)).toBe(true);
  });
});
