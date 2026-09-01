import { describe, expect, it, vi } from 'vitest';
import { notFound, ok } from '@teacher-platform/contracts';
import { createConfirmationGateway } from '../../../src/app/confirmation/confirmation-gateway.js';
import type { CreateConfirmationGatewayOptions } from '../../../src/app/confirmation/types.js';
import type { CreatePendingActionInput } from '../../../src/features/pending-action/index.js';

// P29-W1 红灯：ConfirmationGateway 尚不支持 feedback.updateStatus。
// requestConfirmation({ toolName: 'feedback.updateStatus', ... }) 目前落入默认分支，
// 返回 VALIDATION_ERROR('工具不支持可信确认','toolName')。以下契约断言全部红灯，
// 直到 confirmation-gateway.ts 新增 feedbackStatusIntent 分支。

const UPDATED_AT = new Date('2030-03-01T00:00:00.123Z');
const ACTION_TOKEN = 'secret-token';

const owned = {
  feedback: {
    id: 'feedback-1',
    teacherId: 'teacher-1',
    studentId: 'student-1',
    lessonId: null,
    title: '旧反馈标题',
    content: '旧反馈正文',
    status: 'reviewed' as const,
    channel: null,
    parentName: null,
    sentAt: null,
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
  },
};

function dependencies() {
  let captured: CreatePendingActionInput | undefined;
  const readers = {
    feedback: {
      getOwnedFeedback: vi.fn(async () => ok(owned.feedback)),
    },
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
          actionToken: ACTION_TOKEN,
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

describe('P29-W1 ConfirmationGateway feedback.updateStatus 红灯', () => {
  it('合法参数通过 owner reader（teacher+feedbackId）创建 PendingAction：allowlist 参数 + 服务端 expectedUpdatedAt 快照', async () => {
    const deps = dependencies();
    const result = await createConfirmationGateway(deps.options).requestConfirmation({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-feedback-1',
      toolName: 'feedback.updateStatus',
      args: { feedbackId: 'feedback-1', status: 'sent', sentAt: '2031-02-03T12:05:06.123456789+08:00' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('pending_confirmation');
    expect(deps.readers.feedback.getOwnedFeedback).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      feedbackId: 'feedback-1',
    });
    expect(deps.captured()).toMatchObject({
      actionName: 'feedback.updateStatus',
      target: { type: 'ParentFeedback', id: 'feedback-1' },
      parameters: {
        feedbackId: 'feedback-1',
        status: 'sent',
        sentAt: '2031-02-03T12:05:06.123456789+08:00',
        expectedUpdatedAt: UPDATED_AT.toISOString(),
      },
    });
  });

  it('未提供 sentAt 时 parameters 不含 sentAt 键，且 allowlist 原样保留', async () => {
    const deps = dependencies();
    const result = await createConfirmationGateway(deps.options).requestConfirmation({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-feedback-2',
      toolName: 'feedback.updateStatus',
      args: { feedbackId: 'feedback-1', status: 'archived' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.captured()?.parameters).toEqual({
      feedbackId: 'feedback-1',
      status: 'archived',
      expectedUpdatedAt: UPDATED_AT.toISOString(),
    });
    expect(deps.captured()?.beforeSummary).toBeTruthy();
    expect(deps.captured()?.afterSummary).toBeTruthy();
  });

  it('allowlist 严格：confirm/teacherId/actionToken/source/expectedUpdatedAt/extra/嵌套 parameters 全部拒绝，不读 owner、不创建 PendingAction', async () => {
    const invalidArgs = [
      { feedbackId: 'feedback-1', status: 'sent', confirm: true },
      { feedbackId: 'feedback-1', status: 'sent', teacherId: 'other-teacher' },
      { feedbackId: 'feedback-1', status: 'sent', actionToken: 'malicious' },
      { feedbackId: 'feedback-1', status: 'sent', source: 'system' },
      { feedbackId: 'feedback-1', status: 'sent', expectedUpdatedAt: UPDATED_AT.toISOString() },
      { feedbackId: 'feedback-1', status: 'sent', extra: 'x' },
      { feedbackId: 'feedback-1', status: 'sent', parameters: { status: 'archived' } },
      { feedbackId: 'feedback-1', status: 'sent', changes: { status: 'archived' } },
    ];

    for (const args of invalidArgs) {
      const deps = dependencies();
      const result = await createConfirmationGateway(deps.options).requestConfirmation({
        teacherId: 'teacher-1',
        conversationId: 'conversation-1',
        toolCallId: 'call-invalid',
        toolName: 'feedback.updateStatus',
        args,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'args' } });
      expect(deps.captured()).toBeUndefined();
      expect(deps.readers.feedback.getOwnedFeedback).not.toHaveBeenCalled();
    }
  });

  it('owner reader 的跨 teacher 与不存在统一 NOT_FOUND 且不创建 PendingAction', async () => {
    const deps = dependencies();
    deps.readers.feedback.getOwnedFeedback.mockResolvedValueOnce({
      ok: false,
      error: notFound('家长反馈不存在'),
    });

    const result = await createConfirmationGateway(deps.options).requestConfirmation({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-cross',
      toolName: 'feedback.updateStatus',
      args: { feedbackId: 'feedback-1', status: 'sent' },
    });

    expect(result).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '家长反馈不存在' } });
    expect(deps.captured()).toBeUndefined();
  });

  it('摘要只含状态流转，不含正文、expectedUpdatedAt、actionToken', async () => {
    const deps = dependencies();
    const result = await createConfirmationGateway(deps.options).requestConfirmation({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-summary',
      toolName: 'feedback.updateStatus',
      args: { feedbackId: 'feedback-1', status: 'sent' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const captured = deps.captured();
    expect(captured).toBeDefined();
    const summary = `${captured?.beforeSummary ?? ''}\n${captured?.afterSummary ?? ''}`;
    expect(summary.length).toBeLessThanOrEqual(480);
    expect(summary).toContain('reviewed');
    expect(summary).toContain('sent');
    expect(summary).not.toContain('旧反馈正文');
    expect(summary).not.toContain('旧反馈标题');
    expect(summary).not.toContain('expectedUpdatedAt');
    expect(summary).not.toContain(ACTION_TOKEN);
    expect(summary).not.toContain('actionToken');
  });

  it('非法状态流转在创建 PendingAction 前拒绝', async () => {
    const invalidTransitions = [
      { status: 'draft' as const, target: 'sent' as const },
      { status: 'reviewed' as const, target: 'draft' as const },
      { status: 'sent' as const, target: 'reviewed' as const },
      { status: 'archived' as const, target: 'sent' as const },
    ];

    for (const transition of invalidTransitions) {
      const deps = dependencies();
      deps.readers.feedback.getOwnedFeedback.mockResolvedValueOnce(ok({
        ...owned.feedback,
        status: transition.status,
      }));
      const result = await createConfirmationGateway(deps.options).requestConfirmation({
        teacherId: 'teacher-1',
        conversationId: 'conversation-1',
        toolCallId: 'call-bad-transition',
        toolName: 'feedback.updateStatus',
        args: { feedbackId: 'feedback-1', status: transition.target },
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'status' } });
      expect(deps.captured()).toBeUndefined();
    }
  });

  it('非法 status 值在创建 PendingAction 前拒绝', async () => {
    const deps = dependencies();
    const result = await createConfirmationGateway(deps.options).requestConfirmation({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-bad-status',
      toolName: 'feedback.updateStatus',
      args: { feedbackId: 'feedback-1', status: 'invalid' },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'status' } });
    expect(deps.captured()).toBeUndefined();
  });

  it('sentAt 规则：非 sent 携带 sentAt 拒绝、非法 RFC3339 拒绝', async () => {
    const invalidArgs = [
      { feedbackId: 'feedback-1', status: 'reviewed', sentAt: '2031-02-03T04:05:06Z' },
      { feedbackId: 'feedback-1', status: 'archived', sentAt: '2031-02-03T04:05:06Z' },
      { feedbackId: 'feedback-1', status: 'sent', sentAt: '2031-02-03T04:05:06' },
      { feedbackId: 'feedback-1', status: 'sent', sentAt: '2031-02-30T04:05:06Z' },
      { feedbackId: 'feedback-1', status: 'sent', sentAt: 123 },
    ];

    for (const args of invalidArgs) {
      const deps = dependencies();
      const result = await createConfirmationGateway(deps.options).requestConfirmation({
        teacherId: 'teacher-1',
        conversationId: 'conversation-1',
        toolCallId: 'call-bad-sentat',
        toolName: 'feedback.updateStatus',
        args,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'sentAt' } });
      expect(deps.captured()).toBeUndefined();
    }
  });
});
