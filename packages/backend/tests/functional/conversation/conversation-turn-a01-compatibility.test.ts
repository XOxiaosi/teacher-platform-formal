import { describe, expect, it } from 'vitest';
import { toAgentTurnDtos } from '../../../src/app/routes/conversation-response.js';
import type { ConversationTurnData } from '../../../src/features/conversation/index.js';

const baseTurn: ConversationTurnData = {
  id: 'turn-1', conversationId: 'conversation-1', teacherId: 'teacher-1', role: 'user',
  content: 'legacy message', toolCalls: null, toolResults: null, audioFileRef: null,
  createdAt: new Date('2026-09-15T00:00:00.000Z'),
};

describe('A01 conversation turn association compatibility', () => {
  it('keeps legacy turns readable with nullable runtime fields', () => {
    const [dto] = toAgentTurnDtos([baseTurn]);
    expect(dto).toMatchObject({ taskId: null, executionId: null, seq: null, eventKind: null });
    expect(dto).toMatchObject({ id: 'turn-1', conversationId: 'conversation-1', kind: 'user', content: 'legacy message' });
  });

  it('projects task and execution receipt associations on new turns', () => {
    const [dto] = toAgentTurnDtos([{
      ...baseTurn,
      id: 'turn-2',
      content: 'runtime message',
      taskId: 'task-1',
      executionId: 'execution-1',
      seq: 7,
      eventKind: 'message_received',
    }]);
    expect(dto).toMatchObject({
      taskId: 'task-1', executionId: 'execution-1', seq: 7, eventKind: 'message_received',
      content: 'runtime message',
    });
  });

  it('keeps error-turn execution fallback while preferring the persisted association', () => {
    const [legacy] = toAgentTurnDtos([{
      ...baseTurn,
      id: 'turn-error-legacy',
      role: 'error',
      content: '旧错误',
      toolResults: { executionId: 'legacy-execution', error: { code: 'INTERNAL_ERROR', message: '旧错误' } },
    }]);
    expect(legacy).toMatchObject({ kind: 'error', executionId: 'legacy-execution', taskId: null });

    const [associated] = toAgentTurnDtos([{
      ...baseTurn,
      id: 'turn-error-associated',
      role: 'error',
      content: '新错误',
      executionId: 'persisted-execution',
      taskId: 'task-1',
      seq: 8,
      eventKind: 'task_error',
      toolResults: { executionId: 'legacy-execution', error: { code: 'INTERNAL_ERROR', message: '新错误' } },
    }]);
    expect(associated).toMatchObject({ kind: 'error', executionId: 'persisted-execution', taskId: 'task-1', seq: 8, eventKind: 'task_error' });
  });
});
