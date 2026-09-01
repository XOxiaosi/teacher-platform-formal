import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgendaTodayDocument,
} from '@teacher-platform/contracts';
import type {
  AgentTurnDto,
  ConfirmationTurnDto,
  ConversationDetailDto,
  ConversationSummaryDto,
} from '../../api/conversations';
import { agendaApi } from '../../api/agenda';
import { AgentPage } from './AgentPage';

vi.mock('../../api/agenda', () => ({
  agendaApi: {
    getToday: vi.fn(),
    getWeek: vi.fn(),
  },
}));
import type { AgentConversationApi } from './useAgentConversation';

const teacherId = 'demo-teacher';
const emptyTodayDocument: AgendaTodayDocument = {
  schemaVersion: 1,
  timeZone: 'Asia/Shanghai',
  businessDate: '2030-07-24',
  generatedAt: '2030-07-24T01:00:00.000Z',
  items: [],
};

beforeEach(() => {
  vi.mocked(agendaApi.getToday).mockReset().mockResolvedValue(emptyTodayDocument);
});

function summary(id = 'conversation-1'): ConversationSummaryDto {
  return {
    id,
    status: 'active',
    displayTitle: '重点题型复习',
    summary: null,
    lastMessagePreview: '帮我整理重点',
    lastTurnAt: '2026-07-23T10:00:00.000Z',
    createdAt: '2026-07-23T09:00:00.000Z',
    updatedAt: '2026-07-23T10:00:00.000Z',
  };
}

function detail(id = 'conversation-1'): ConversationDetailDto {
  return { ...summary(id), turnCount: 2 };
}

function userTurn(content: string): AgentTurnDto {
  return {
    id: `user-${content}`,
    conversationId: 'conversation-1',
    kind: 'user',
    content,
    inputSource: 'text',
    createdAt: '2026-07-23T10:00:00.000Z',
  };
}

function assistantTurn(content: string): AgentTurnDto {
  return {
    id: `assistant-${content}`,
    conversationId: 'conversation-1',
    kind: 'assistant',
    content,
    references: [],
    createdAt: '2026-07-23T10:01:00.000Z',
  };
}

function errorTurn() {
  return {
    id: 'error-1',
    conversationId: 'conversation-1',
    kind: 'error' as const,
    createdAt: '2030-01-01T10:00:00.000Z',
    executionId: 'execution-1',
    stage: 'model' as const,
    error: { code: 'INTERNAL_ERROR' as const, message: '模型响应超时' },
    retryable: true,
    retryAction: 'retry-model' as const,
    completedToolCallIds: [],
  };
}

function confirmationTurn(overrides: Partial<ConfirmationTurnDto> = {}): ConfirmationTurnDto {
  return {
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
    status: 'pending',
    expiresAt: '2030-01-01T10:10:00.000Z',
    actionToken: 'server-action-token',
    error: null,
    ...overrides,
  };
}

function createApi(overrides: Partial<AgentConversationApi> = {}): AgentConversationApi {
  return {
    listConversations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getConversation: vi.fn().mockResolvedValue({ conversation: detail() }),
    getAgentExecution: vi.fn().mockResolvedValue({ execution: { status: 'succeeded' } }),
    listConversationTurns: vi.fn().mockResolvedValue({ items: [], previousCursor: null }),
    createConversation: vi.fn().mockResolvedValue({ conversation: { ...detail(), displayTitle: '新会话', turnCount: 0 } }),
    archiveConversation: vi.fn().mockResolvedValue({ conversation: { ...detail(), status: 'archived' } }),
    sendConversationMessage: vi.fn().mockResolvedValue({
      conversationId: 'conversation-1', executionId: 'execution-1', status: 'succeeded', reply: '完成', replayed: false,
    }),
    replayAgentExecution: vi.fn().mockResolvedValue({
      conversationId: 'conversation-1', executionId: 'execution-2', status: 'succeeded', reply: '完成', replayed: false,
    }),
    confirmPendingAction: vi.fn().mockResolvedValue({ pendingAction: {} }),
    cancelPendingAction: vi.fn().mockResolvedValue({ pendingAction: {} }),
    ...overrides,
  };
}

describe('AgentPage conversation loop', () => {
  it('无最近会话时进入 empty，新建后启用输入', async () => {
    const api = createApi();
    render(<AgentPage teacherId={teacherId} api={api} />);

    expect(await screen.findByText('还没有会话')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '给 Agent 发送消息' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '新建会话' })).toHaveAttribute('title', '新建会话');

    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));

    await waitFor(() => expect(api.createConversation).toHaveBeenCalledWith(teacherId));
    expect(screen.getByRole('textbox', { name: '给 Agent 发送消息' })).toBeEnabled();
  });

  it('进入页面时恢复最近 active 会话及持久化 turns', async () => {
    const api = createApi({
      listConversations: vi.fn().mockResolvedValue({ items: [summary()], nextCursor: null }),
      listConversationTurns: vi.fn().mockResolvedValue({
        items: [userTurn('帮我整理重点'), assistantTurn('先梳理三个核心模型。')],
        previousCursor: null,
      }),
    });

    render(<AgentPage teacherId={teacherId} api={api} />);

    expect(await screen.findByText('先梳理三个核心模型。')).toBeInTheDocument();
    expect(api.getConversation).toHaveBeenCalledWith(teacherId, 'conversation-1');
    expect(api.listConversationTurns).toHaveBeenCalledWith(teacherId, 'conversation-1');
    expect(screen.getByRole('textbox', { name: '给 Agent 发送消息' })).toBeEnabled();
  });

  it('发送成功后 refetch turns，不使用 reply 伪造消息', async () => {
    const listTurns = vi.fn()
      .mockResolvedValueOnce({ items: [userTurn('旧问题')], previousCursor: null })
      .mockResolvedValueOnce({
        items: [userTurn('旧问题'), userTurn('新问题'), assistantTurn('持久化后的回答')],
        previousCursor: null,
      });
    const api = createApi({
      listConversations: vi.fn().mockResolvedValue({ items: [summary()], nextCursor: null }),
      listConversationTurns: listTurns,
      sendConversationMessage: vi.fn().mockResolvedValue({ conversationId: 'conversation-1', reply: '不应直接展示的 reply' }),
    });
    render(<AgentPage teacherId={teacherId} api={api} />);
    const textbox = await screen.findByRole('textbox', { name: '给 Agent 发送消息' });

    fireEvent.change(textbox, { target: { value: '新问题' } });
    fireEvent.submit(screen.getByRole('form', { name: '消息输入' }));

    await waitFor(() => expect(listTurns).toHaveBeenCalledTimes(2));
    expect(api.sendConversationMessage).toHaveBeenCalledWith(teacherId, {
      conversationId: 'conversation-1',
      message: '新问题',
      clientRequestId: expect.any(String),
    });
    expect(await screen.findByText('持久化后的回答')).toBeInTheDocument();
    expect(screen.queryByText('不应直接展示的 reply')).not.toBeInTheDocument();
  });

  it('确认 pending action 后 refetch turns，不使用 POST 响应伪造状态', async () => {
    const listTurns = vi.fn()
      .mockResolvedValueOnce({ items: [confirmationTurn()], previousCursor: null })
      .mockResolvedValueOnce({ items: [confirmationTurn({ status: 'consumed', actionToken: null })], previousCursor: null });
    const api = createApi({
      listConversations: vi.fn().mockResolvedValue({ items: [summary()], nextCursor: null }),
      listConversationTurns: listTurns,
      confirmPendingAction: vi.fn().mockResolvedValue({
        pendingAction: { status: 'consumed', actionToken: null, afterSummary: '不应直接渲染的响应' },
      }),
    });
    render(<AgentPage teacherId={teacherId} api={api} />);

    const confirm = await screen.findByRole('button', { name: '确认执行' });
    expect(screen.getByRole('textbox', { name: '给 Agent 发送消息' })).toBeDisabled();
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(api.confirmPendingAction).toHaveBeenCalledTimes(1));
    expect(api.confirmPendingAction).toHaveBeenCalledWith(teacherId, 'pending-1', 'server-action-token');
    await waitFor(() => expect(listTurns).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('已完成')).toBeInTheDocument();
    expect(screen.queryByText('不应直接渲染的响应')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认执行' })).not.toBeInTheDocument();
  });

  it('确认失败保留 pending 卡和 token，可明确重试', async () => {
    const api = createApi({
      listConversations: vi.fn().mockResolvedValue({ items: [summary()], nextCursor: null }),
      listConversationTurns: vi.fn().mockResolvedValue({ items: [confirmationTurn()], previousCursor: null }),
      confirmPendingAction: vi.fn().mockRejectedValue(new Error('确认请求失败')),
    });
    render(<AgentPage teacherId={teacherId} api={api} />);

    fireEvent.click(await screen.findByRole('button', { name: '确认执行' }));

    expect(await screen.findByText('确认请求失败')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认执行' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '取消操作' })).toBeEnabled();
    expect(api.listConversationTurns).toHaveBeenCalledTimes(1);
  });

  it('取消 pending action 后 refetch cancelled turn', async () => {
    const listTurns = vi.fn()
      .mockResolvedValueOnce({ items: [confirmationTurn()], previousCursor: null })
      .mockResolvedValueOnce({ items: [confirmationTurn({ status: 'cancelled', actionToken: null })], previousCursor: null });
    const api = createApi({
      listConversations: vi.fn().mockResolvedValue({ items: [summary()], nextCursor: null }),
      listConversationTurns: listTurns,
    });
    render(<AgentPage teacherId={teacherId} api={api} />);

    fireEvent.click(await screen.findByRole('button', { name: '取消操作' }));

    await waitFor(() => expect(api.cancelPendingAction).toHaveBeenCalledWith(teacherId, 'pending-1'));
    await waitFor(() => expect(listTurns).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('已取消')).toBeInTheDocument();
  });

  it('结构化 error turn 可安全回放，成功后 refetch turns', async () => {
    const listTurns = vi.fn()
      .mockResolvedValueOnce({ items: [errorTurn()], previousCursor: null })
      .mockResolvedValueOnce({ items: [assistantTurn('重试完成')], previousCursor: null });
    const api = createApi({
      listConversations: vi.fn().mockResolvedValue({ items: [summary()], nextCursor: null }),
      listConversationTurns: listTurns,
    });
    render(<AgentPage teacherId={teacherId} api={api} />);

    fireEvent.click(await screen.findByRole('button', { name: '安全重试' }));

    await waitFor(() => expect(api.replayAgentExecution).toHaveBeenCalledWith(
      teacherId,
      'execution-1',
      expect.any(String),
    ));
    await waitFor(() => expect(listTurns).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('重试完成')).toBeInTheDocument();
  });

  it('归档当前会话后进入只读，仍可新建会话', async () => {
    const api = createApi({
      listConversations: vi.fn().mockResolvedValue({ items: [summary()], nextCursor: null }),
    });
    render(<AgentPage teacherId={teacherId} api={api} />);
    expect(await screen.findByRole('textbox', { name: '给 Agent 发送消息' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '归档会话' }));

    await waitFor(() => expect(api.archiveConversation).toHaveBeenCalledWith(teacherId, 'conversation-1'));
    expect(screen.getByRole('textbox', { name: '给 Agent 发送消息' })).toBeDisabled();
    expect(screen.getAllByText('已归档，只读').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '新建会话' })).toBeEnabled();
  });

  it('网络失败重试同一消息复用 clientRequestId，成功后清除输入', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce({
        conversationId: 'conversation-1', executionId: 'execution-1', status: 'succeeded', reply: '完成', replayed: true,
      });
    const api = createApi({
      listConversations: vi.fn().mockResolvedValue({ items: [summary()], nextCursor: null }),
      sendConversationMessage: send,
    });
    render(<AgentPage teacherId={teacherId} api={api} />);
    const textbox = await screen.findByRole('textbox', { name: '给 Agent 发送消息' });

    fireEvent.change(textbox, { target: { value: '同一条消息' } });
    fireEvent.submit(screen.getByRole('form', { name: '消息输入' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('网络中断');
    fireEvent.submit(screen.getByRole('form', { name: '消息输入' }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][1].clientRequestId).toBe(send.mock.calls[0][1].clientRequestId);
    await waitFor(() => expect(textbox).toHaveValue(''));
  });

  it('发送失败保留输入并显示可恢复错误', async () => {
    const api = createApi({
      listConversations: vi.fn().mockResolvedValue({ items: [summary()], nextCursor: null }),
      sendConversationMessage: vi.fn().mockRejectedValue(new Error('模型暂不可用')),
    });
    render(<AgentPage teacherId={teacherId} api={api} />);
    const textbox = await screen.findByRole('textbox', { name: '给 Agent 发送消息' });

    fireEvent.change(textbox, { target: { value: '请重试这条消息' } });
    fireEvent.submit(screen.getByRole('form', { name: '消息输入' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('模型暂不可用');
    expect(textbox).toHaveValue('请重试这条消息');
  });

  it('Agenda失败不改变Conversation状态，重试也不触发Conversation refetch', async () => {
    vi.mocked(agendaApi.getToday)
      .mockRejectedValueOnce(new Error('agenda down'))
      .mockResolvedValueOnce(emptyTodayDocument);
    const api = createApi({
      listConversations: vi.fn().mockResolvedValue({ items: [summary()], nextCursor: null }),
    });
    render(<AgentPage teacherId={teacherId} api={api} />);

    const textbox = await screen.findByRole('textbox', { name: '给 Agent 发送消息' });
    expect(textbox).toBeEnabled();
    expect(await screen.findByText('agenda down')).toBeInTheDocument();

    fireEvent.change(textbox, { target: { value: 'Agenda失败后仍可发送' } });
    fireEvent.submit(screen.getByRole('form', { name: '消息输入' }));
    await waitFor(() => expect(api.sendConversationMessage).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '重试今日摘要' }));
    await waitFor(() => expect(agendaApi.getToday).toHaveBeenCalledTimes(2));
    expect(api.listConversations).toHaveBeenCalledTimes(1);
  });
});
