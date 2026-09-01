import { describe, expect, it } from 'vitest';
import type { ConversationTurnData } from '../../../src/features/conversation/index.js';
import type { PendingActionWithToken } from '../../../src/features/pending-action/index.js';
import {
  extractToolCallIds,
  toAgentTurnDtos,
} from '../../../src/app/routes/conversation-response.js';

function turn(input: Partial<ConversationTurnData> & Pick<ConversationTurnData, 'id' | 'role'>): ConversationTurnData {
  return {
    id: input.id,
    conversationId: 'conversation-1',
    teacherId: 'teacher-1',
    role: input.role,
    content: input.content ?? '',
    toolCalls: input.toolCalls ?? null,
    toolResults: input.toolResults ?? null,
    audioFileRef: null,
    createdAt: input.createdAt ?? new Date('2030-01-01T00:00:00.000Z'),
  };
}

function pending(toolCallId: string, status: 'pending' | 'consumed' = 'pending'): PendingActionWithToken {
  return {
    pendingAction: {
      id: `pending-${toolCallId}`,
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      toolCallId,
      actionName: 'students.updateStatus',
      targetType: 'Student',
      targetId: 'student-1',
      parameters: { studentId: 'student-1', status: 'paused' },
      beforeSummary: 'active',
      afterSummary: 'paused',
      status,
      expiresAt: new Date('2030-01-01T00:10:00.000Z'),
      consumedAt: status === 'consumed' ? new Date('2030-01-01T00:01:00.000Z') : null,
      cancelledAt: null,
      createdAt: new Date('2030-01-01T00:00:01.000Z'),
      updatedAt: new Date('2030-01-01T00:00:02.000Z'),
    },
    actionToken: `token-${toolCallId}`,
  };
}

const turns = [
  turn({
    id: 'assistant-1',
    role: 'assistant',
    content: '准备执行',
    toolCalls: [
      { id: 'tool-call-pending', name: 'students.updateStatus', args: { studentId: 'student-1' } },
      { id: 'tool-call-read', name: 'students.get', args: { studentId: 'student-1' } },
    ],
  }),
  turn({
    id: 'tool-pending',
    role: 'tool',
    content: '等待确认',
    toolResults: { toolCallId: 'tool-call-pending' },
  }),
  turn({
    id: 'tool-read',
    role: 'tool',
    content: '查询成功',
    toolResults: { toolCallId: 'tool-call-read' },
  }),
];

describe('conversation response confirmation projection', () => {
  it('只提取当前页 tool turn 的 toolCallId，并去重', () => {
    expect(extractToolCallIds([...turns, turns[1]])).toEqual([
      'tool-call-pending',
      'tool-call-read',
    ]);
  });

  it('匹配 PendingAction 的 ToolTurn 在原位置替换为 ConfirmationTurn', () => {
    const dtos = toAgentTurnDtos(turns, [
      pending('tool-call-pending'),
      pending('tool-call-not-on-page'),
    ]);

    expect(dtos).toHaveLength(3);
    expect(dtos[1]).toMatchObject({
      id: 'pending-tool-call-pending',
      kind: 'confirmation',
      actionId: 'pending-tool-call-pending',
      actionToken: 'token-tool-call-pending',
      status: 'pending',
    });
    expect(dtos[2]).toMatchObject({
      id: 'tool-read',
      kind: 'tool',
      toolCallId: 'tool-call-read',
    });
  });

  it('已消费 confirmation 不返回 token，且不额外追加未在本页的 PendingAction', () => {
    const dtos = toAgentTurnDtos(turns, [
      pending('tool-call-pending', 'consumed'),
      pending('tool-call-not-on-page'),
    ]);

    expect(dtos).toHaveLength(turns.length);
    expect(dtos[1]).toMatchObject({ kind: 'confirmation', status: 'consumed', actionToken: null });
  });
});
