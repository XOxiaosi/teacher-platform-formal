import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentPage } from './AgentPage';

const conversation = {
  id: 'conversation-1',
  status: 'active',
  displayTitle: '学生情况查询',
  summary: null,
  lastMessagePreview: '已找到学生张三',
  lastTurnAt: '2026-07-23T10:01:00.000Z',
  createdAt: '2026-07-23T10:00:00.000Z',
  updatedAt: '2026-07-23T10:01:00.000Z',
};

const turns = [
  {
    id: 'user-1',
    conversationId: 'conversation-1',
    kind: 'user',
    content: '查询张三',
    inputSource: 'text',
    createdAt: '2026-07-23T10:00:00.000Z',
  },
  {
    id: 'assistant-1',
    conversationId: 'conversation-1',
    kind: 'assistant',
    content: '兼容文本',
    presentation: {
      schemaVersion: 1,
      title: '学生查询结果',
      summary: '已找到学生张三',
      sections: [{
        id: 'student-facts',
        kind: 'facts',
        heading: '学生信息',
        items: [{ label: '姓名', value: '张三' }],
      }],
      references: [],
      actions: [],
    },
    references: [],
    createdAt: '2026-07-23T10:00:30.000Z',
  },
  {
    id: 'tool-1',
    conversationId: 'conversation-1',
    kind: 'tool',
    toolCallId: 'call-1',
    toolName: 'students.get',
    displayName: '查询学生详情',
    sideEffect: 'read',
    status: 'success',
    inputSummary: { studentId: 'student-1' },
    resultSummary: '已找到学生张三',
    references: [],
    error: null,
    createdAt: '2026-07-23T10:01:00.000Z',
  },
];

function success(data: unknown): Response {
  return { json: async () => ({ ok: true, data }) } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Agent refresh recovery e2e', () => {
  it('使用真实 API client，在重新挂载后恢复持久化 turns', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/v1/conversations?status=active&limit=20' || url === '/api/v1/conversations') {
        return success({ items: [conversation], nextCursor: null });
      }
      if (url === '/api/v1/conversations/conversation-1') {
        return success({ conversation: { ...conversation, turnCount: turns.length } });
      }
      if (url === '/api/v1/conversations/conversation-1/turns') {
        return success({ items: turns, previousCursor: null });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const first = render(<AgentPage teacherId="demo-teacher" />);
    expect(await screen.findByRole('heading', { name: '学生查询结果' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: '工具：查询学生详情' })).toHaveTextContent('已找到学生张三');
    first.unmount();

    render(<AgentPage teacherId="demo-teacher" />);
    expect(await screen.findByRole('heading', { name: '学生查询结果' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: '工具：查询学生详情' })).toHaveTextContent('已找到学生张三');

    await waitFor(() => {
      const turnRequests = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/v1/conversations/conversation-1/turns');
      expect(turnRequests).toHaveLength(2);
    });
  });

  it('刷新恢复 pending token，确认后通过 refetch 恢复 consumed，token 不可见', async () => {
    let status: 'pending' | 'consumed' = 'pending';
    const confirmation = () => ({
      id: 'pending-1',
      conversationId: 'conversation-1',
      kind: 'confirmation',
      createdAt: '2030-01-01T10:00:00.000Z',
      actionId: 'pending-1',
      actionName: 'students.updateStatus',
      target: { type: 'Student', id: 'student-1' },
      beforeSummary: '学生当前状态：active',
      afterSummary: '学生将更新为 paused',
      parameterSummary: { studentId: 'student-1', status: 'paused' },
      status,
      expiresAt: '2030-01-01T10:10:00.000Z',
      actionToken: status === 'pending' ? 'refresh-secret-token' : null,
      error: null,
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/v1/conversations?status=active&limit=20' || url === '/api/v1/conversations') {
        return success({ items: [conversation], nextCursor: null });
      }
      if (url === '/api/v1/conversations/conversation-1') {
        return success({ conversation: { ...conversation, turnCount: 1 } });
      }
      if (url === '/api/v1/conversations/conversation-1/turns') {
        return success({ items: [confirmation()], previousCursor: null });
      }
      if (url === '/api/v1/pending-actions/pending-1/confirm') {
        expect(init).toMatchObject({
          method: 'POST',
          body: JSON.stringify({ actionToken: 'refresh-secret-token' }),
        });
        status = 'consumed';
        return success({ pendingAction: { status: 'consumed' }, result: { summary: '完成', references: [] } });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const first = render(<AgentPage teacherId="demo-teacher" />);
    expect(await screen.findByRole('button', { name: '确认执行' })).toBeEnabled();
    expect(document.body).not.toHaveTextContent('refresh-secret-token');
    first.unmount();

    render(<AgentPage teacherId="demo-teacher" />);
    const confirmButton = await screen.findByRole('button', { name: '确认执行' });
    fireEvent.click(confirmButton);

    expect(await screen.findByText('已完成')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认执行' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('refresh-secret-token');
    await waitFor(() => {
      const turnRequests = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/v1/conversations/conversation-1/turns');
      expect(turnRequests).toHaveLength(3);
    });
  });
});
