import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  archiveConversation,
  cancelPendingAction,
  confirmPendingAction,
  createConversation,
  getAgentExecution,
  getConversation,
  getPendingAction,
  listConversations,
  listConversationTurns,
  replayAgentExecution,
  sendConversationMessage,
} from './conversations';

const TEACHER_ID = 'demo-teacher';

function mockSuccess(data: unknown = {}) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, data }),
  } as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Conversation API client', () => {
  it('创建会话不携带 teacher header，body 为空', async () => {
    const fetchMock = mockSuccess({ conversation: { id: 'conversation-1' } });

    await createConversation(TEACHER_ID);

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/conversations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      credentials: 'include',
    });
  });

  it('列表只编码已定义参数，并保持 opaque cursor 原值语义', async () => {
    const fetchMock = mockSuccess({ items: [], nextCursor: null });

    await listConversations(TEACHER_ID, {
      status: 'archived',
      cursor: 'opaque+/= cursor',
      limit: 20,
    });
    await listConversations(TEACHER_ID);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/conversations?status=archived&cursor=opaque%2B%2F%3D+cursor&limit=20',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/conversations',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('详情、turns 和归档对 conversationId 与 before 做 URL 编码', async () => {
    const fetchMock = mockSuccess({});
    const conversationId = 'conversation/id with space';

    await getConversation(TEACHER_ID, conversationId);
    await listConversationTurns(TEACHER_ID, conversationId, { before: 'turn/id +', limit: 50 });
    await archiveConversation(TEACHER_ID, conversationId);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/conversations/conversation%2Fid%20with%20space',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/conversations/conversation%2Fid%20with%20space/turns?before=turn%2Fid+%2B&limit=50',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/v1/conversations/conversation%2Fid%20with%20space/archive',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('PendingAction 查询、确认和取消使用编码 path，token 只进入 confirm body', async () => {
    const fetchMock = mockSuccess({});
    const actionId = 'action/id with space';
    const token = 'secret-token-value';

    await getPendingAction(TEACHER_ID, actionId);
    await confirmPendingAction(TEACHER_ID, actionId, token);
    await cancelPendingAction(TEACHER_ID, actionId);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/pending-actions/action%2Fid%20with%20space',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/pending-actions/action%2Fid%20with%20space/confirm',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ actionToken: token }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/v1/pending-actions/action%2Fid%20with%20space/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(String(fetchMock.mock.calls[1][0])).not.toContain(token);
    expect(fetchMock.mock.calls[2][1]).not.toHaveProperty('body');
  });

  it('发送消息提交稳定 clientRequestId', async () => {
    const fetchMock = mockSuccess({ conversationId: 'conversation-1', reply: '已完成' });

    await sendConversationMessage(TEACHER_ID, {
      conversationId: 'conversation-1',
      message: '查一下今天的课程',
      clientRequestId: 'request-client-001',
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/agent/converse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        conversationId: 'conversation-1',
        message: '查一下今天的课程',
        clientRequestId: 'request-client-001',
      }),
    });
  });

  it('查询 execution 编码 path', async () => {
    const fetchMock = mockSuccess({ execution: { id: 'execution/1', status: 'running' } });

    await getAgentExecution(TEACHER_ID, 'execution/1');

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/agent/executions/execution%2F1', expect.objectContaining({
      method: 'GET',
    }));
  });

  it('失败回放只提交新 clientRequestId，不重提 message 或工具参数', async () => {
    const fetchMock = mockSuccess({
      conversationId: 'conversation-1', executionId: 'execution-2', status: 'succeeded', reply: '完成', replayed: false,
    });

    await replayAgentExecution(TEACHER_ID, 'execution/1', 'request-replay-001');

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/agent/executions/execution%2F1/replay', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ clientRequestId: 'request-replay-001' }),
    }));
  });
});
