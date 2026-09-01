import { describe, expect, it } from 'vitest';
import type { PendingActionWithToken } from '../../../src/features/pending-action/index.js';
import {
  toConfirmationTurnDto,
  toPendingActionDto,
} from '../../../src/app/routes/pending-action-response.js';

function action(overrides: Partial<PendingActionWithToken['pendingAction']> = {}): PendingActionWithToken {
  return {
    pendingAction: {
      id: 'pending-1',
      teacherId: 'teacher-secret',
      conversationId: 'conversation-1',
      toolCallId: 'tool-call-secret',
      actionName: 'students.updateStatus',
      targetType: 'Student',
      targetId: 'student-1',
      parameters: {
        studentId: 'student-1',
        status: 'paused',
        count: 2,
        approved: true,
        note: null,
        nested: { sensitive: 'hidden' },
        list: ['hidden'],
      },
      beforeSummary: 'active',
      afterSummary: 'paused',
      status: 'pending',
      expiresAt: new Date('2030-01-01T00:10:00.000Z'),
      consumedAt: null,
      cancelledAt: null,
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
      updatedAt: new Date('2030-01-01T00:00:01.000Z'),
      ...overrides,
    },
    actionToken: 'signed-token',
  };
}

describe('PendingAction response projection', () => {
  it('PendingActionDto 只暴露白名单字段与标量参数摘要', () => {
    const dto = toPendingActionDto(action());

    expect(dto).toEqual({
      id: 'pending-1',
      conversationId: 'conversation-1',
      actionName: 'students.updateStatus',
      target: { type: 'Student', id: 'student-1' },
      beforeSummary: 'active',
      afterSummary: 'paused',
      parameterSummary: {
        studentId: 'student-1',
        status: 'paused',
        count: 2,
        approved: true,
        note: null,
      },
      status: 'pending',
      expiresAt: '2030-01-01T00:10:00.000Z',
      actionToken: 'signed-token',
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:01.000Z',
      error: null,
    });
    expect(dto).not.toHaveProperty('teacherId');
    expect(dto).not.toHaveProperty('toolCallId');
    expect(dto).not.toHaveProperty('parameters');
  });

  it.each([
    ['executing', 'running'],
    ['consumed', 'consumed'],
    ['cancelled', 'cancelled'],
    ['expired', 'expired'],
  ] as const)('%s 状态映射为 %s 且不返回 actionToken', (storedStatus, dtoStatus) => {
    const dto = toPendingActionDto(action({ status: storedStatus }));

    expect(dto.status).toBe(dtoStatus);
    expect(dto.actionToken).toBeNull();
  });

  it('ConfirmationTurnDto 使用 PendingAction id，字段与 PendingActionDto 一致', () => {
    const dto = toConfirmationTurnDto(action());

    expect(dto).toMatchObject({
      id: 'pending-1',
      conversationId: 'conversation-1',
      kind: 'confirmation',
      createdAt: '2030-01-01T00:00:00.000Z',
      actionId: 'pending-1',
      actionName: 'students.updateStatus',
      target: { type: 'Student', id: 'student-1' },
      status: 'pending',
      actionToken: 'signed-token',
    });
  });
});
