import { describe, expect, it, vi } from 'vitest';
import { ok } from '@teacher-platform/contracts';
import { CONFIRMABLE_ACTION_NAMES } from '../../../src/features/pending-action/index.js';

const module = await import('../../../src/app/confirmation/edit-action-executors.js').catch(() => undefined);

function requireFactory() {
  if (!module?.createEditActionExecutorsWithCommands) {
    throw new Error('createEditActionExecutorsWithCommands export is missing');
  }
  return module.createEditActionExecutorsWithCommands;
}

const scenarios = [
  { key: 'studentUpdateProfile', actionName: 'students.updateProfile', type: 'Student', idField: 'studentId', id: 'student-1', nested: 'changes', patch: { grade: '高三' }, command: 'updateStudentProfile' },
  { key: 'scheduleReschedule', actionName: 'scheduling.reschedule', type: 'Schedule', idField: 'scheduleId', id: 'schedule-1', nested: 'replacement', patch: { scheduledStart: '2030-03-03T02:00:00Z', scheduledEnd: '2030-03-03T03:00:00Z' }, command: 'rescheduleLesson' },
  { key: 'lessonUpdateRecord', actionName: 'lessons.updateRecord', type: 'Lesson', idField: 'lessonId', id: 'lesson-1', nested: 'changes', patch: { progress: '新进度' }, command: 'updateLessonRecord' },
  { key: 'paymentUpdate', actionName: 'payments.update', type: 'Payment', idField: 'paymentId', id: 'payment-1', nested: 'changes', patch: { amount: 1200 }, command: 'updatePayment' },
  { key: 'memoUpdate', actionName: 'memos.update', type: 'Memo', idField: 'memoId', id: 'memo-1', nested: 'changes', patch: { title: '新标题' }, command: 'updateMemo' },
  { key: 'feedbackUpdateContent', actionName: 'feedback.updateContent', type: 'ParentFeedback', idField: 'feedbackId', id: 'feedback-1', nested: 'changes', patch: { content: '新内容' }, command: 'updateParentFeedbackContent' },
] as const;

function commands() {
  return {
    students: { updateStudentProfile: vi.fn(async () => ok({})) },
    scheduling: { rescheduleLesson: vi.fn(async () => ok({})) },
    lessons: { updateLessonRecord: vi.fn(async () => ok({})) },
    payments: { updatePayment: vi.fn(async () => ok({})) },
    memos: { updateMemo: vi.fn(async () => ok({})) },
    feedback: { updateParentFeedbackContent: vi.fn(async () => ok({})) },
  };
}

describe('A5-I9c PendingAction 编辑 executor', () => {
  it('白名单 additive 包含六个新动作且保留原四动作顺序与值', () => {
    expect(CONFIRMABLE_ACTION_NAMES).toEqual([
      'scheduling.complete',
      'scheduling.cancel',
      'lessons.updateStatus',
      'students.updateStatus',
      'students.updateProfile',
      'scheduling.reschedule',
      'lessons.updateRecord',
      'payments.update',
      'memos.update',
      'feedback.updateContent',
      'feedback.updateStatus',
      'payments.create',
      'students.records.capture',
    ]);
  });

  it.each(scenarios)('$actionName exact 解析快照并固定 agent-confirmed 调同一 typed command', async (scenario) => {
    const ports = commands();
    const executors = requireFactory()(ports);
    const executor = executors[scenario.key];
    const parameters = {
      [scenario.idField]: scenario.id,
      [scenario.nested]: structuredClone(scenario.patch),
      expectedUpdatedAt: '2030-03-01T00:00:00.123Z',
    };

    const result = await executor.execute({
      teacherId: 'teacher-1',
      target: { type: scenario.type, id: scenario.id },
      parameters,
    });

    expect(result.ok).toBe(true);
    const command = ports[scenario.key.startsWith('student') ? 'students'
      : scenario.key.startsWith('schedule') ? 'scheduling'
        : scenario.key.startsWith('lesson') ? 'lessons'
          : scenario.key.startsWith('payment') ? 'payments'
            : scenario.key.startsWith('memo') ? 'memos' : 'feedback'][scenario.command];
    expect(command).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      [scenario.idField]: scenario.id,
      [scenario.nested]: scenario.patch,
      expectedUpdatedAt: '2030-03-01T00:00:00.123Z',
      source: 'agent-confirmed',
    });
    expect(result).toMatchObject({ ok: true, value: { references: [{ type: scenario.type, id: scenario.id }] } });
  });

  it.each(scenarios)('$actionName 拒绝 target ID 不一致、extra parameters 与 extra nested', async (scenario) => {
    for (const mutation of ['target', 'parameters', 'nested'] as const) {
      const ports = commands();
      const executor = requireFactory()(ports)[scenario.key];
      const parameters: Record<string, unknown> = {
        [scenario.idField]: scenario.id,
        [scenario.nested]: { ...scenario.patch },
        expectedUpdatedAt: '2030-03-01T00:00:00.123Z',
      };
      if (mutation === 'parameters') parameters.source = 'system';
      if (mutation === 'nested') (parameters[scenario.nested] as Record<string, unknown>).forbidden = true;
      const result = await executor.execute({
        teacherId: 'teacher-1',
        target: { type: scenario.type, id: mutation === 'target' ? 'other-id' : scenario.id },
        parameters,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'parameters' } });
      const calls = Object.values(ports).flatMap((group) => Object.values(group)).map((fn) => fn.mock.calls.length);
      expect(calls.every((count) => count === 0)).toBe(true);
    }
  });
});
