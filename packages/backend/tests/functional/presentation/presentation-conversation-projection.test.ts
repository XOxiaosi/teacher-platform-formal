import { describe, expect, it } from 'vitest';
import { toAgentTurnDtos } from '../../../src/app/routes/conversation-response.js';
import type { ConversationTurnData } from '../../../src/features/conversation/types.js';

const document = {
  schemaVersion: 1,
  title: '学生信息',
  summary: '已找到张三。',
  sections: [],
  references: [{ id: 'Student:student-1', type: 'Student', objectId: 'student-1', label: '张三' }],
  actions: [],
};

function assistant(toolResults: unknown, toolCalls: unknown = null): ConversationTurnData {
  return {
    id: 'assistant-1',
    conversationId: 'conversation-1',
    teacherId: 'teacher-1',
    role: 'assistant',
    content: '历史兼容文本',
    toolCalls,
    toolResults,
    audioFileRef: null,
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
  };
}

describe('Conversation Assistant presentation projection', () => {
  it('合法V1信封投影为Assistant presentation', () => {
    const [dto] = toAgentTurnDtos([assistant({
      kind: 'assistant-presentation',
      version: 1,
      document,
    })]);

    expect(dto).toMatchObject({
      kind: 'assistant',
      content: '历史兼容文本',
      presentation: document,
      references: [],
    });
  });

  it('历史Assistant无信封时由服务端提供fallback presentation', () => {
    const [dto] = toAgentTurnDtos([assistant(null)]);

    expect(dto).toMatchObject({
      kind: 'assistant',
      presentation: {
        schemaVersion: 1,
        summary: '历史兼容文本',
        sections: [],
        references: [],
        actions: [],
      },
    });
  });

  it('含toolCalls的中间Assistant保持纯文本，不附加fallback presentation', () => {
    const [dto] = toAgentTurnDtos([assistant(null, [{
      id: 'call-1',
      name: 'students.get',
      args: { studentId: 'student-1' },
    }])]);

    expect(dto).toMatchObject({ kind: 'assistant', content: '历史兼容文本', references: [] });
    expect(dto).not.toHaveProperty('presentation');
  });

  it('非法或未知版本信封整体降级，不透传任意route', () => {
    const [dto] = toAgentTurnDtos([assistant({
      kind: 'assistant-presentation',
      version: 99,
      document: { ...document, route: 'https://evil.example' },
    })]);

    expect(dto).toMatchObject({
      kind: 'assistant',
      presentation: expect.objectContaining({ summary: '历史兼容文本' }),
    });
    expect(JSON.stringify(dto)).not.toContain('evil.example');
  });
});
