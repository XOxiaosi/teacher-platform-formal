import { describe, expect, it, vi } from 'vitest';
import { notFound, ok } from '@teacher-platform/contracts';
import { createConfirmationGateway } from '../../../src/app/confirmation/confirmation-gateway.js';
import type { CreateConfirmationGatewayOptions } from '../../../src/app/confirmation/types.js';
import type { CreatePendingActionInput } from '../../../src/features/pending-action/index.js';

const UPDATED_AT = new Date('2030-03-01T00:00:00.123Z');

const owned = {
  studentProfiles: { id: 'student-1', name: '小明', grade: '高二', source: null, currentStatus: 'active', stageGoal: '提升力学', createdAt: UPDATED_AT, updatedAt: UPDATED_AT, teacherId: 'teacher-1' },
  scheduleReschedules: { id: 'schedule-1', teacherId: 'teacher-1', studentId: 'student-1', type: 'lesson', title: '周六物理', scheduledStart: new Date('2030-03-02T02:00:00Z'), scheduledEnd: new Date('2030-03-02T03:00:00Z'), status: 'planned', confidence: 'high', pendingFields: null, sourceInput: null, parentId: null, createdAt: UPDATED_AT, updatedAt: UPDATED_AT },
  lessonRecords: { id: 'lesson-1', teacherId: 'teacher-1', studentId: 'student-1', scheduleId: 'schedule-1', date: new Date('2030-03-02T02:00:00Z'), status: 'attended', progress: '旧进度', studentState: null, homework: null, teacherNote: null, sourceNoteId: null, createdAt: UPDATED_AT, updatedAt: UPDATED_AT },
  payments: { id: 'payment-1', teacherId: 'teacher-1', studentId: 'student-1', amount: 1000, lessonCount: 10, paidAt: new Date('2030-02-01T00:00:00Z'), note: null, createdAt: UPDATED_AT, updatedAt: UPDATED_AT },
  memos: { id: 'memo-1', teacherId: 'teacher-1', title: '旧备忘', content: '旧内容', status: 'active', dueAt: null, tags: null, source: null, createdAt: UPDATED_AT, updatedAt: UPDATED_AT },
  feedback: { id: 'feedback-1', teacherId: 'teacher-1', studentId: 'student-1', lessonId: null, title: '旧反馈', content: '旧内容', status: 'draft', channel: null, parentName: null, sentAt: null, createdAt: UPDATED_AT, updatedAt: UPDATED_AT },
};

const scenarios = [
  { toolName: 'students.updateProfile', idField: 'studentId', id: 'student-1', nested: 'changes', patch: { grade: '高三' }, owner: 'studentProfiles', targetType: 'Student' },
  { toolName: 'scheduling.reschedule', idField: 'scheduleId', id: 'schedule-1', nested: 'replacement', patch: { scheduledStart: '2030-03-03T02:00:00.000Z', scheduledEnd: '2030-03-03T03:00:00.000Z' }, owner: 'scheduleReschedules', targetType: 'Schedule' },
  { toolName: 'lessons.updateRecord', idField: 'lessonId', id: 'lesson-1', nested: 'changes', patch: { progress: '新进度' }, owner: 'lessonRecords', targetType: 'Lesson' },
  { toolName: 'payments.update', idField: 'paymentId', id: 'payment-1', nested: 'changes', patch: { amount: 1200 }, owner: 'payments', targetType: 'Payment' },
  { toolName: 'memos.update', idField: 'memoId', id: 'memo-1', nested: 'changes', patch: { title: '新备忘' }, owner: 'memos', targetType: 'Memo' },
  { toolName: 'feedback.updateContent', idField: 'feedbackId', id: 'feedback-1', nested: 'changes', patch: { content: '新内容' }, owner: 'feedback', targetType: 'ParentFeedback' },
] as const;

function dependencies() {
  let captured: CreatePendingActionInput | undefined;
  const readers = {
    studentProfiles: { getOwnedStudentProfile: vi.fn(async () => ok(owned.studentProfiles)) },
    scheduleReschedules: { getOwnedSchedule: vi.fn(async () => ok(owned.scheduleReschedules)) },
    lessonRecords: { getOwnedLesson: vi.fn(async () => ok(owned.lessonRecords)) },
    payments: { getOwnedPayment: vi.fn(async () => ok(owned.payments)) },
    memos: { getOwnedMemo: vi.fn(async () => ok(owned.memos)) },
    feedback: { getOwnedFeedback: vi.fn(async () => ok(owned.feedback)) },
  };
  const options = {
    pendingActions: {
      createPendingAction: vi.fn(async (input: CreatePendingActionInput) => {
        captured = input;
        return ok({
          pendingAction: {
            id: 'pending-1', teacherId: input.teacherId, conversationId: input.conversationId,
            toolCallId: input.toolCallId, actionName: input.actionName, targetType: input.target.type,
            targetId: input.target.id, parameters: input.parameters, beforeSummary: input.beforeSummary,
            afterSummary: input.afterSummary, status: 'pending' as const, expiresAt: new Date('2030-03-01T00:10:00Z'),
            consumedAt: null, cancelledAt: null, createdAt: UPDATED_AT, updatedAt: UPDATED_AT,
          },
          actionToken: 'secret-token',
        });
      }),
    },
    schedules: { getSchedule: vi.fn() },
    lessons: { getLesson: vi.fn() },
    students: { getStudent: vi.fn() },
    editOwners: readers,
  } as unknown as CreateConfirmationGatewayOptions;
  return { options, readers, captured: () => captured };
}

describe('A5-I9b ConfirmationGateway 编辑快照', () => {
  it.each(scenarios)('$toolName 按 teacher + target 调 owner reader 并写入服务端版本快照', async (scenario) => {
    const deps = dependencies();
    const args = { [scenario.idField]: scenario.id, [scenario.nested]: structuredClone(scenario.patch) };
    const beforeArgs = structuredClone(args);

    const result = await createConfirmationGateway(deps.options).requestConfirmation({
      teacherId: 'teacher-1', conversationId: 'conversation-1', toolCallId: `call-${scenario.id}`,
      toolName: scenario.toolName, args,
    });

    expect(result.ok).toBe(true);
    const reader = deps.readers[scenario.owner];
    expect(Object.values(reader)[0]).toHaveBeenCalledWith({ teacherId: 'teacher-1', [scenario.idField]: scenario.id });
    expect(deps.captured()).toMatchObject({
      actionName: scenario.toolName,
      target: { type: scenario.targetType, id: scenario.id },
      parameters: {
        [scenario.idField]: scenario.id,
        [scenario.nested]: scenario.patch,
        expectedUpdatedAt: UPDATED_AT.toISOString(),
      },
    });
    expect(deps.captured()?.beforeSummary).toBeTruthy();
    expect(deps.captured()?.afterSummary).toBeTruthy();
    expect(args).toEqual(beforeArgs);
    expect(JSON.stringify(args)).not.toContain('expectedUpdatedAt');
  });

  it('summary 仅投影变更字段、截断，且不含版本/token/完整对象', async () => {
    const unrelatedValues: Record<string, string[]> = {
      'students.updateProfile': ['小明', '提升力学'],
      'lessons.updateRecord': [UPDATED_AT.toISOString()],
      'payments.update': ['10 课时'],
      'feedback.updateContent': ['旧反馈'],
    };

    for (const scenario of scenarios) {
      const deps = dependencies();
      await createConfirmationGateway(deps.options).requestConfirmation({
        teacherId: 'teacher-1', conversationId: 'conversation-1', toolCallId: `summary-${scenario.id}`,
        toolName: scenario.toolName, args: { [scenario.idField]: scenario.id, [scenario.nested]: scenario.patch },
      });
      const summary = `${deps.captured()?.beforeSummary ?? ''}\n${deps.captured()?.afterSummary ?? ''}`;
      expect(summary.length).toBeLessThanOrEqual(480);
      expect(summary).not.toContain('expectedUpdatedAt');
      expect(summary).not.toContain('secret-token');
      expect(summary).not.toContain('当前版本');
      for (const value of unrelatedValues[scenario.toolName] ?? []) expect(summary).not.toContain(value);
    }
  });

  it('extra 顶层、extra nested 与模型注入 source/expected 全部 fail-closed', async () => {
    const invalidArgs = [
      { studentId: 'student-1', changes: { grade: '高三' }, teacherId: 'other' },
      { studentId: 'student-1', changes: { grade: '高三', source: 'system' } },
      { studentId: 'student-1', changes: { grade: '高三' }, expectedUpdatedAt: UPDATED_AT.toISOString() },
    ];

    for (const args of invalidArgs) {
      const deps = dependencies();
      const result = await createConfirmationGateway(deps.options).requestConfirmation({
        teacherId: 'teacher-1', conversationId: 'conversation-1', toolCallId: 'call-invalid',
        toolName: 'students.updateProfile', args,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(deps.captured()).toBeUndefined();
      expect(deps.readers.studentProfiles.getOwnedStudentProfile).not.toHaveBeenCalled();
    }
  });

  it('非法日历时间、越界时区及非递增改期在创建 PendingAction 前拒绝', async () => {
    const invalid = [
      { toolName: 'scheduling.reschedule', args: { scheduleId: 'schedule-1', replacement: { scheduledStart: '2030-02-30T02:00:00Z', scheduledEnd: '2030-03-03T03:00:00Z' } } },
      { toolName: 'scheduling.reschedule', args: { scheduleId: 'schedule-1', replacement: { scheduledStart: '2030-03-03T02:00:00+24:00', scheduledEnd: '2030-03-03T03:00:00Z' } } },
      { toolName: 'scheduling.reschedule', args: { scheduleId: 'schedule-1', replacement: { scheduledStart: '2030-03-03T03:00:00Z', scheduledEnd: '2030-03-03T03:00:00Z' } } },
      { toolName: 'scheduling.reschedule', args: { scheduleId: 'schedule-1', replacement: { scheduledStart: '2030-03-03T04:00:00Z', scheduledEnd: '2030-03-03T03:00:00Z' } } },
      { toolName: 'payments.update', args: { paymentId: 'payment-1', changes: { paidAt: '2030-04-31T00:00:00Z' } } },
      { toolName: 'memos.update', args: { memoId: 'memo-1', changes: { dueAt: '2030-01-01T00:00:00+25:00' } } },
    ];

    for (const scenario of invalid) {
      const deps = dependencies();
      const result = await createConfirmationGateway(deps.options).requestConfirmation({
        teacherId: 'teacher-1', conversationId: 'conversation-1', toolCallId: 'call-invalid-time',
        toolName: scenario.toolName, args: scenario.args,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(deps.captured()).toBeUndefined();
    }
  });

  it('owner reader 的跨 teacher 与不存在统一 NOT_FOUND 且不创建 PendingAction', async () => {
    const deps = dependencies();
    deps.readers.payments.getOwnedPayment.mockResolvedValueOnce({ ok: false, error: notFound('缴费记录不存在') });

    const result = await createConfirmationGateway(deps.options).requestConfirmation({
      teacherId: 'teacher-1', conversationId: 'conversation-1', toolCallId: 'call-cross',
      toolName: 'payments.update', args: { paymentId: 'payment-1', changes: { amount: 1200 } },
    });

    expect(result).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '缴费记录不存在' } });
    expect(deps.captured()).toBeUndefined();
  });
});
