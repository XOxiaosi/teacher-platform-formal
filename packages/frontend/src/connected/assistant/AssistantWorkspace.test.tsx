import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantWorkspace } from './AssistantWorkspace';
import { clearAssistantDrafts } from './drafts';
import { detail, deferred, makeTransport, userTurn } from './assistant-test-support';
import type { ConfirmationTurnDto, ConversationResponse } from '../../api/conversations';

const api = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), detail: vi.fn(), turns: vi.fn(), archive: vi.fn(), sendLegacy: vi.fn(), confirmLegacy: vi.fn(), cancelLegacy: vi.fn() }));
vi.mock('../../api/conversations', () => ({
  createConversation: api.create, listConversations: api.list, getConversation: api.detail,
  listConversationTurns: api.turns, archiveConversation: api.archive,
  sendConversationMessage: api.sendLegacy, confirmPendingAction: api.confirmLegacy, cancelPendingAction: api.cancelLegacy,
}));
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); clearAssistantDrafts('teacher-a'); clearAssistantDrafts('teacher-b');
  location.hash = '#/agent/one';
  api.list.mockResolvedValue({ items: [detail(), detail('two')], nextCursor: null });
  api.detail.mockImplementation((_teacher: string, id: string) => Promise.resolve({ conversation: detail(id) }));
  api.turns.mockResolvedValue({ items: [], previousCursor: null });
  api.create.mockResolvedValue({ conversation: detail('new') });
  api.archive.mockResolvedValue({ conversation: detail('one', 'archived') });
  api.confirmLegacy.mockResolvedValue({ pendingAction: { id: 'pending-1', status: 'consumed' } });
  api.cancelLegacy.mockResolvedValue({ pendingAction: { id: 'pending-1', status: 'cancelled' } });
});

function proposedAction(actionName: 'scheduling.create' | 'memos.create' = 'scheduling.create'): ConfirmationTurnDto {
  return {
    id: 'confirmation-1', conversationId: 'one', kind: 'confirmation', actionId: 'pending-1', actionName,
    target: { type: 'Schedule', id: 'proposal-1' }, beforeSummary: null, afterSummary: '周三 19:00 为小明安排数学课。',
    parameterSummary: {}, status: 'pending', expiresAt: '2099-09-19T12:00:00Z', actionToken: 'private-confirmation-token', error: null,
    createdAt: '2026-09-19T12:00:00Z',
  };
}

describe('A03 server-backed assistant conversations', () => {
  it('completes the latest load when StrictMode runs the effect twice', async () => {
    render(<StrictMode><AssistantWorkspace teacherId="teacher-a" /></StrictMode>);
    await screen.findByRole('heading', { name: '会话one' });
    expect(screen.queryByText('正在读取会话…')).not.toBeInTheDocument();
    expect(api.detail.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('uses the shared Beijing date format for conversation and turn timestamps', async () => {
    api.list.mockResolvedValue({ items: [{ ...detail(), lastTurnAt: '2026-09-15T12:00:00Z' }], nextCursor: null });
    api.turns.mockResolvedValue({ items: [userTurn('recent', '最近材料')], previousCursor: null });
    render(<AssistantWorkspace teacherId="teacher-a" />);
    expect((await screen.findAllByText('2026年9月15日 20:00')).length).toBe(2);
    expect(await screen.findByText('最近材料')).toBeInTheDocument();
  });

  it('opens a saved URL and never calls the old executor or renders a board', async () => {
    render(<AssistantWorkspace teacherId="teacher-a" />);
    await screen.findByRole('heading', { name: '会话one' });
    expect(api.detail).toHaveBeenCalledWith('teacher-a', 'one');
    expect(screen.queryByLabelText('任务看板')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('交给教学助手的工作'), { target: { value: '整理记录' } });
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    expect(api.sendLegacy).not.toHaveBeenCalled(); expect(api.confirmLegacy).not.toHaveBeenCalled();
  });
  it('creates exactly one conversation while the request is pending and navigates to its real id', async () => {
    const pending = deferred<ConversationResponse>(); api.create.mockReturnValue(pending.promise);
    render(<AssistantWorkspace teacherId="teacher-a" />);
    await screen.findByRole('heading', { name: '会话one' });
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
    expect(screen.getByRole('button', { name: '正在新建…' })).toBeDisabled();
    expect(api.create).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ conversation: detail('server-new') }));
    await screen.findByRole('heading', { name: '会话server-new' });
    expect(location.hash).toBe('#/agent/server-new');
  });
  it('lets a teacher start from the empty workspace without submitting a prefilled request', async () => {
    location.hash = '#/agent';
    render(<AssistantWorkspace teacherId="teacher-a" />);
    expect(await screen.findByRole('heading', { name: '今天想先完成什么？' })).toBeInTheDocument();
    expect(screen.queryByLabelText('交给教学助手的工作')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '新建会话' }).at(-1)!);
    await screen.findByRole('heading', { name: '会话new' });
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.sendLegacy).not.toHaveBeenCalled();
  });
  it('keeps the current conversation usable while its navigation list is collapsed or filtered to archived work', async () => {
    render(<AssistantWorkspace teacherId="teacher-a" />);
    await screen.findByRole('heading', { name: '会话one' });
    fireEvent.click(screen.getByRole('button', { name: '收起会话列表' }));
    expect(screen.getByRole('button', { name: '展开会话列表' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /会话two/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '会话one' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开会话列表' }));
    fireEvent.change(screen.getByLabelText('查看会话'), { target: { value: 'archived' } });
    await waitFor(() => expect(api.list).toHaveBeenCalledWith('teacher-a', { status: 'archived', cursor: undefined }));
  });
  it('starts with the navigation collapsed on a narrow screen so the active conversation keeps the available height', async () => {
    const previousMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn().mockReturnValue({ matches: true }) });
    try {
      render(<AssistantWorkspace teacherId="teacher-a" />);
      await screen.findByRole('heading', { name: '会话one' });
      expect(screen.getByRole('button', { name: '展开会话列表' })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('button', { name: '新建会话' })).not.toBeInTheDocument();
    } finally {
      if (previousMatchMedia) Object.defineProperty(window, 'matchMedia', previousMatchMedia);
      else Reflect.deleteProperty(window, 'matchMedia');
    }
  });
  it('closes the narrow-screen navigation after a teacher chooses a conversation', async () => {
    const previousMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn().mockReturnValue({ matches: true }) });
    try {
      render(<AssistantWorkspace teacherId="teacher-a" />);
      await screen.findByRole('heading', { name: '会话one' });
      fireEvent.click(screen.getByRole('button', { name: '展开会话列表' }));
      fireEvent.click(await screen.findByRole('button', { name: /会话two/ }));
      await screen.findByRole('heading', { name: '会话two' });
      expect(screen.getByRole('button', { name: '展开会话列表' })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('button', { name: /会话one/ })).not.toBeInTheDocument();
    } finally {
      if (previousMatchMedia) Object.defineProperty(window, 'matchMedia', previousMatchMedia);
      else Reflect.deleteProperty(window, 'matchMedia');
    }
  });
  it('loads complete older history and paginates the conversation list', async () => {
    api.list.mockImplementation((_teacher, params) => Promise.resolve(params.cursor
      ? { items: [detail('older')], nextCursor: null } : { items: [detail()], nextCursor: 'page-two' }));
    api.turns.mockImplementation((_teacher, _id, params) => Promise.resolve(params?.before
      ? { items: [userTurn('old', '较早完整材料')], previousCursor: null }
      : { items: [userTurn('recent', '最近材料')], previousCursor: 'old-cursor' }));
    render(<AssistantWorkspace teacherId="teacher-a" />);
    await screen.findByText('最近材料');
    fireEvent.click(screen.getByRole('button', { name: '加载较早内容' }));
    await screen.findByText('较早完整材料');
    expect(screen.getByText('最近材料')).toBeInTheDocument();
    expect(api.turns).toHaveBeenCalledWith('teacher-a', 'one', { before: 'old-cursor' });
    fireEvent.click(screen.getByRole('button', { name: '加载更多会话' }));
    await screen.findByRole('button', { name: /会话older/ });
    expect(api.list).toHaveBeenCalledWith('teacher-a', { status: 'active', cursor: 'page-two' });
  });
  it('retries a failed detail request without inventing a saved conversation', async () => {
    api.detail.mockRejectedValueOnce(new Error('private backend stack'));
    render(<AssistantWorkspace teacherId="teacher-a" />);
    await screen.findByText('会话暂时无法读取，请重试。');
    expect(screen.queryByText('private backend stack')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('交给教学助手的工作')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新读取会话' }));
    await screen.findByLabelText('交给教学助手的工作');
  });
  it('archives only after server success and retains complete history', async () => {
    const pending = deferred<ConversationResponse>(); api.archive.mockReturnValue(pending.promise);
    api.turns.mockResolvedValue({ items: [userTurn('saved', '保留的记录')], previousCursor: null });
    render(<AssistantWorkspace teacherId="teacher-a" />);
    await screen.findByText('保留的记录'); fireEvent.click(screen.getByRole('button', { name: '归档会话' }));
    expect(screen.queryByText('已归档 · 可完整回看')).not.toBeInTheDocument();
    await act(async () => pending.resolve({ conversation: detail('one', 'archived') }));
    await screen.findByText('已归档 · 可完整回看');
    expect(screen.getByText('保留的记录')).toBeInTheDocument();
    expect(screen.queryByLabelText('交给教学助手的工作')).not.toBeInTheDocument();
  });
  it('ignores late conversation responses after switching and after changing account', async () => {
    const late = deferred<ConversationResponse>(); api.detail.mockImplementation((teacher, id) => teacher === 'teacher-a' && id === 'one'
      ? late.promise : Promise.resolve({ conversation: { ...detail(id), displayTitle: `${teacher}资料` } }));
    const view = render(<AssistantWorkspace teacherId="teacher-a" />);
    fireEvent.click(await screen.findByRole('button', { name: /会话two/ }));
    await screen.findByRole('heading', { name: 'teacher-a资料' });
    view.rerender(<AssistantWorkspace teacherId="teacher-b" />);
    expect(screen.queryByRole('heading', { name: 'teacher-a资料' })).not.toBeInTheDocument();
    await screen.findByRole('heading', { name: 'teacher-b资料' });
    await act(async () => late.resolve({ conversation: { ...detail(), displayTitle: '不可串入的旧资料' } }));
    expect(screen.queryByText('不可串入的旧资料')).not.toBeInTheDocument();
  });
  it('retains separate unsent drafts on conversation changes and remount, then clears them on account change', async () => {
    const view = render(<AssistantWorkspace teacherId="teacher-a" />);
    fireEvent.change(await screen.findByLabelText('交给教学助手的工作'), { target: { value: '学生甲未送达' } });
    fireEvent.click(screen.getByRole('button', { name: /会话two/ }));
    await screen.findByRole('heading', { name: '会话two' });
    expect(screen.getByLabelText('交给教学助手的工作')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('交给教学助手的工作'), { target: { value: '学生乙未送达' } });
    fireEvent.click(screen.getByRole('button', { name: /会话one/ }));
    await screen.findByRole('heading', { name: '会话one' });
    expect(screen.getByLabelText('交给教学助手的工作')).toHaveValue('学生甲未送达');
    view.unmount(); const restored = render(<AssistantWorkspace teacherId="teacher-a" />);
    expect(await screen.findByLabelText('交给教学助手的工作')).toHaveValue('学生甲未送达');
    restored.rerender(<AssistantWorkspace teacherId="teacher-b" />);
    expect(await screen.findByLabelText('交给教学助手的工作')).toHaveValue('');
    expect(JSON.stringify(sessionStorage)).not.toContain('学生甲');
    expect(JSON.stringify(localStorage)).not.toContain('学生甲');
  });
  it('keeps an unacknowledged message and retries with the same idempotency key', async () => {
    const transport = makeTransport(); transport.sendMessage.mockRejectedValue(new Error('network lost'));
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    fireEvent.change(await screen.findByLabelText('交给教学助手的工作'), { target: { value: '整理课堂记录' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText(/尚未取得接收回执/);
    expect(screen.getByLabelText('交给教学助手的工作')).toHaveValue('整理课堂记录');
    fireEvent.click(screen.getByRole('button', { name: '重试发送' }));
    await waitFor(() => expect(transport.sendMessage).toHaveBeenCalledTimes(2));
    expect(transport.sendMessage.mock.calls[1][0]).toEqual(transport.sendMessage.mock.calls[0][0]);
  });
  it('uses a durable receipt before clearing input, and can show unavailable without claiming completion', async () => {
    const transport = makeTransport(); const pending = deferred<{ accepted: true; task: { id: string; status: 'unavailable'; summary: string } }>();
    transport.sendMessage.mockReturnValue(pending.promise);
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    fireEvent.change(await screen.findByLabelText('交给教学助手的工作'), { target: { value: '待接收内容' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(screen.getByRole('button', { name: '提交中…' })).toBeDisabled();
    expect(screen.getByLabelText('交给教学助手的工作')).toHaveValue('待接收内容');
    await act(async () => pending.resolve({ accepted: true, task: { id: 'task-1', status: 'unavailable', summary: '内容已收到，等待服务恢复。' } }));
    await screen.findByText('已收到，AI 服务尚不可用');
    expect(screen.getByLabelText('交给教学助手的工作')).toHaveValue('');
    expect(screen.queryByText('已完成')).not.toBeInTheDocument();
  });
  it('shows a local submission echo before the durable turn arrives, then retires it after persistence', async () => {
    const transport = makeTransport(); const pending = deferred<{ accepted: true; task: { id: string; status: 'queued'; summary: string } }>();
    const persisted = { ...userTurn('durable-user', '先显示再落盘'), createdAt: new Date().toISOString() };
    api.turns.mockResolvedValueOnce({ items: [], previousCursor: null }).mockResolvedValue({ items: [persisted], previousCursor: null });
    transport.sendMessage.mockReturnValue(pending.promise);
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    const input = await screen.findByLabelText('交给教学助手的工作');
    fireEvent.change(input, { target: { value: '先显示再落盘' } }); fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('正在发送…')).toBeInTheDocument();
    await act(async () => pending.resolve({ accepted: true, task: { id: 'task-echo', status: 'queued', summary: '已排队' } }));
    await waitFor(() => expect(screen.getByText('先显示再落盘')).toBeInTheDocument());
    expect(screen.queryByText('已接收，等待会话记录')).not.toBeInTheDocument();
  });
  it('uses Codex-style Enter submission while Shift+Enter keeps the draft for a newline', async () => {
    const transport = makeTransport(); transport.sendMessage.mockResolvedValue({ accepted: true, task: { id: 'task-enter', status: 'queued', summary: '已排队' } });
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    const input = await screen.findByLabelText('交给教学助手的工作');
    fireEvent.change(input, { target: { value: '按回车提交' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(transport.sendMessage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(input).toHaveValue(''));
    fireEvent.change(input, { target: { value: '保留换行' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: true });
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('保留换行');
  });
  it('does not mix in-flight send results into another conversation', async () => {
    const transport = makeTransport(); const pending = deferred<{ accepted: true; task: { id: string; status: 'succeeded'; summary: string } }>();
    transport.sendMessage.mockReturnValue(pending.promise);
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    fireEvent.change(await screen.findByLabelText('交给教学助手的工作'), { target: { value: '第一条工作' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(screen.getByRole('button', { name: /会话two/ }));
    await screen.findByRole('heading', { name: '会话two' });
    fireEvent.change(screen.getByLabelText('交给教学助手的工作'), { target: { value: '第二条草稿' } });
    await act(async () => pending.resolve({ accepted: true, task: { id: 'first-task', status: 'succeeded', summary: '第一条结果' } }));
    expect(screen.queryByText('第一条结果')).not.toBeInTheDocument();
    expect(screen.getByLabelText('交给教学助手的工作')).toHaveValue('第二条草稿');
    fireEvent.click(screen.getByRole('button', { name: /会话one/ }));
    await screen.findByText('第一条结果');
    expect(screen.getByLabelText('交给教学助手的工作')).toHaveValue('');
  });
  it('restores task statuses from the server without relying on a browser-held task id', async () => {
    const transport = makeTransport(); transport.getTasks.mockResolvedValue([{ id: 'persistent-task', status: 'partial', summary: '记录已保存，反馈尚未生成。' }]);
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    await screen.findByText('本轮部分完成');
    expect(screen.getByText('记录已保存，反馈尚未生成。')).toBeInTheDocument();
    expect(transport.getTasks).toHaveBeenCalledWith({ teacherId: 'teacher-a', conversationId: 'one' });
  });
  it('offers a server-backed recovery entry for resumable failed work', async () => {
    const transport = makeTransport();
    transport.getTasks.mockResolvedValue([{ id: 'failed-task', status: 'failed', summary: '反馈生成失败，记录已经保存。', canResume: true }]);
    transport.resumeTask.mockResolvedValue({ id: 'failed-task', status: 'running', summary: '已重新排队处理。', canResume: false });
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    await screen.findByText('反馈生成失败，记录已经保存。');
    fireEvent.click(screen.getByRole('button', { name: '继续处理' }));
    await screen.findByText('已重新排队处理。');
    expect(transport.resumeTask).toHaveBeenCalledWith({ teacherId: 'teacher-a', conversationId: 'one', taskId: 'failed-task' });
  });
  it('refreshes task events immediately after recovery without duplicating prior events', async () => {
    const transport = makeTransport();
    transport.getTasks.mockResolvedValue([{ id: 'failed-task', status: 'failed', summary: '反馈生成失败。', canResume: true }]);
    const oldEvent = { seq: 1, eventKey: 'old-event', eventKind: 'task_state' as const, executionId: 'exec-1', role: 'assistant' as const, content: '任务已保存。', createdAt: '2026-09-15T12:00:00Z' };
    const resumedEvent = { seq: 2, eventKey: 'resumed-event', eventKind: 'task_state' as const, executionId: 'exec-2', role: 'assistant' as const, content: '任务已恢复。', createdAt: '2026-09-15T12:01:00Z' };
    transport.getTaskEvents.mockImplementation(({ afterSeq }: { afterSeq?: number }) => Promise.resolve(afterSeq === 1
      ? { items: [oldEvent, resumedEvent], nextSeq: null } : { items: [oldEvent], nextSeq: null }));
    transport.resumeTask.mockResolvedValue({ id: 'failed-task', status: 'running', summary: '已重新排队。', canResume: false });
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    await screen.findByText('任务已保存。');
    fireEvent.click(screen.getByRole('button', { name: '继续处理' }));
    await screen.findByText('任务已恢复。');
    expect(screen.getAllByText('任务已保存。')).toHaveLength(1);
    expect(transport.getTaskEvents).toHaveBeenLastCalledWith({ teacherId: 'teacher-a', conversationId: 'one', taskId: 'failed-task', afterSeq: 1 });
  });
  it('rebuilds visible task progress from server events and de-duplicates a repeated cursor page', async () => {
    const transport = makeTransport();
    transport.getTasks.mockResolvedValue([{ id: 'task-1', status: 'running', summary: '正在处理。', canResume: false }]);
    const event1 = { seq: 1, eventKey: 'event-1', eventKind: 'task_state' as const, executionId: 'exec-1', role: 'assistant' as const, content: '任务已收到并保存。', createdAt: '2026-09-15T12:00:00Z' };
    const event2 = { seq: 2, eventKey: 'event-2', eventKind: 'assistant_message' as const, executionId: 'exec-1', role: 'assistant' as const, content: '已恢复并继续处理。', createdAt: '2026-09-15T12:01:00Z' };
    transport.getTaskEvents.mockImplementation(({ afterSeq }: { afterSeq?: number }) => Promise.resolve(afterSeq === 1
      ? { items: [event1, event2], nextSeq: 2 }
      : { items: [event1], nextSeq: null }));
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    await screen.findByText('任务已收到并保存。');
    expect(screen.getAllByText('任务已收到并保存。')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '刷新处理过程' }));
    await screen.findByText('已恢复并继续处理。');
    expect(screen.getAllByText('任务已收到并保存。')).toHaveLength(1);
    expect(transport.getTaskEvents).toHaveBeenLastCalledWith({ teacherId: 'teacher-a', conversationId: 'one', taskId: 'task-1', afterSeq: 1 });
  });
  it('shows the 21st persisted task and reads its server event after a full refresh', async () => {
    const transport = makeTransport();
    const tasks = Array.from({ length: 21 }, (_, index) => ({ id: `task-${index + 1}`, status: 'partial' as const, summary: `任务${index + 1}`, canResume: false }));
    transport.getTasks.mockResolvedValue(tasks);
    transport.getTaskEvents.mockImplementation(({ taskId }: { taskId: string }) => Promise.resolve({ items: taskId === 'task-21'
      ? [{ seq: 1, eventKey: 'task-21-event-1', eventKind: 'task_state' as const, executionId: 'exec-21', role: 'assistant' as const, content: '任务21已恢复', createdAt: '2026-09-15T12:00:00Z' }]
      : [], nextSeq: taskId === 'task-21' ? 1 : null }));
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    await screen.findByText('任务21');
    await screen.findByText('任务21已恢复');
    expect(transport.getTaskEvents).toHaveBeenCalledWith({ teacherId: 'teacher-a', conversationId: 'one', taskId: 'task-21', afterSeq: undefined });
  });
  it('keeps the conversation live with a 3 second turns poll and stops after unmount', async () => {
    vi.useFakeTimers();
    try {
      const first = userTurn('first', '初始消息');
      const later = userTurn('later', '实时新增消息');
      api.turns.mockResolvedValueOnce({ items: [first], previousCursor: null });
      const view = render(<AssistantWorkspace teacherId="teacher-a" />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(screen.getByText('初始消息')).toBeInTheDocument();
      api.turns.mockResolvedValue({ items: [first, later], previousCursor: null });
      const detailCallsBeforePoll = api.detail.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(3000);
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      });
      expect(screen.getByText('实时新增消息')).toBeInTheDocument();
      expect(api.detail).toHaveBeenCalledTimes(detailCallsBeforePoll);
      const callsAfterPoll = api.detail.mock.calls.length;
      // The interval is cleaned up with the conversation panel and cannot write
      // into a later account/session after unmount.
      view.unmount();
      await act(async () => { vi.advanceTimersByTime(6000); await Promise.resolve(); });
      expect(api.detail).toHaveBeenCalledTimes(callsAfterPoll);
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not poll completed task events or reread conversation details every cycle', async () => {
    vi.useFakeTimers();
    try {
      const transport = makeTransport();
      transport.getTasks.mockResolvedValue([{ id: 'done-task', status: 'succeeded', summary: '已完成。', canResume: false }]);
      transport.getTaskEvents.mockResolvedValue({ items: [], nextSeq: null });
      render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      const detailCallsAfterInitialLoad = api.detail.mock.calls.length;
      const taskCallsAfterInitialLoad = transport.getTasks.mock.calls.length;
      const eventCallsAfterInitialLoad = transport.getTaskEvents.mock.calls.length;
      const turnCallsAfterInitialLoad = api.turns.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(9000);
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      });
      expect(api.detail).toHaveBeenCalledTimes(detailCallsAfterInitialLoad);
      expect(transport.getTasks).toHaveBeenCalledTimes(taskCallsAfterInitialLoad);
      expect(transport.getTaskEvents).toHaveBeenCalledTimes(eventCallsAfterInitialLoad);
      expect(api.turns.mock.calls.length).toBeGreaterThan(turnCallsAfterInitialLoad);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps same-status tasks separate and labels a runtime success as a finished reply', async () => {
    const transport = makeTransport();
    transport.getTasks.mockResolvedValue([
      { id: 'task-first', status: 'succeeded', version: 1, summary: '' },
      { id: 'task-second', status: 'succeeded', version: 1, summary: '' },
    ]);
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    expect(await screen.findAllByText('本轮回复已结束')).toHaveLength(2);
    expect(screen.getByText('历史处理过程')).toBeInTheDocument();
    expect(screen.queryByText('任务 task-fir')).not.toBeInTheDocument();
    expect(screen.queryByText('未提供任务摘要，请查看会话内容。')).not.toBeInTheDocument();
  });

  it('places a task process beneath its linked conversation turn and collapses only unlinked history', async () => {
    api.turns.mockResolvedValue({ items: [{ ...userTurn('linked-turn', '这条消息对应处理过程'), taskId: 'linked-task' }], previousCursor: null });
    const transport = makeTransport();
    transport.getTasks.mockResolvedValue([{ id: 'linked-task', status: 'partial', version: 1, summary: '已保存一部分资料。' }]);
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    const wrapper = (await screen.findByText('这条消息对应处理过程')).closest('.assistant-turn-with-process');
    expect(wrapper?.textContent).toContain('本轮部分完成');
    expect(wrapper?.textContent).toContain('处理过程');
    expect(screen.queryByText('历史处理过程')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('linked-task');
  });

  it('refreshes workspace once after a terminal task transition, never from its receipt alone', async () => {
    const transport = makeTransport();
    const refreshWorkspace = vi.fn().mockResolvedValue(undefined);
    transport.getTasks.mockResolvedValueOnce([{ id: 'task-refresh', status: 'queued', version: 1, summary: '' }])
      .mockResolvedValue([{ id: 'task-refresh', status: 'failed', version: 2, summary: '本轮未完成' }]);
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} onWorkspaceRefresh={refreshWorkspace} />);
    await screen.findByText('等待处理');
    expect(refreshWorkspace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '刷新处理过程' }));
    await waitFor(() => expect(refreshWorkspace).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '刷新处理过程' }));
    await waitFor(() => expect(transport.getTasks.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(refreshWorkspace).toHaveBeenCalledTimes(1);
  });

  it('refreshes once for a durable assistant event and drops a late refresh failure after account change', async () => {
    const transport = makeTransport();
    const late = deferred<void>();
    const refreshWorkspace = vi.fn().mockReturnValue(late.promise);
    transport.getTasks.mockResolvedValueOnce([{ id: 'task-event', status: 'running', version: 1, summary: '' }]).mockResolvedValue([]);
    transport.getTaskEvents.mockResolvedValue({ items: [{ seq: 1, eventKey: 'event-result', eventKind: 'assistant_message', executionId: 'run-1', role: 'assistant', content: '已写入会话', createdAt: '2026-09-19T12:00:00Z' }], nextSeq: null });
    const view = render(<AssistantWorkspace teacherId="teacher-a" transport={transport} onWorkspaceRefresh={refreshWorkspace} />);
    await waitFor(() => expect(refreshWorkspace).toHaveBeenCalledTimes(1));
    view.rerender(<AssistantWorkspace teacherId="teacher-b" transport={transport} onWorkspaceRefresh={refreshWorkspace} />);
    await act(async () => late.reject(new Error('workspace down')));
    expect(screen.queryByText('助手本轮已返回，资料刷新失败；请先刷新核对，不要重复登记。')).not.toBeInTheDocument();
  });

  it('shows a precise refresh failure after a durable terminal outcome', async () => {
    const transport = makeTransport();
    transport.getTasks.mockResolvedValue([{ id: 'task-terminal', status: 'partial', version: 4, summary: '' }]);
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} onWorkspaceRefresh={async () => { throw new Error('workspace down'); }} />);
    await screen.findByText('助手本轮已返回，资料刷新失败；请先刷新核对，不要重复登记。');
  });

  it('confirms an eligible schedule proposal once, then refreshes the saved data', async () => {
    const refreshWorkspace = vi.fn().mockResolvedValue(undefined);
    api.turns.mockResolvedValue({ items: [proposedAction()], previousCursor: null });
    render(<AssistantWorkspace teacherId="teacher-a" onWorkspaceRefresh={refreshWorkspace} />);
    await screen.findByText(/周三 19:00 为小明安排数学课。/);
    const confirm = screen.getByRole('button', { name: '确认保存' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(api.confirmLegacy).toHaveBeenCalledTimes(1));
    expect(api.confirmLegacy).toHaveBeenCalledWith('teacher-a', 'pending-1', 'private-confirmation-token');
    await screen.findByRole('heading', { name: '已保存' });
    expect(screen.getByRole('link', { name: '查看课表' })).toHaveAttribute('href', '#/schedules');
    await waitFor(() => expect(refreshWorkspace).toHaveBeenCalledTimes(1));
    expect(document.body.textContent).not.toContain('private-confirmation-token');
  });

  it('retains an actionable proposal when saving fails', async () => {
    api.turns.mockResolvedValue({ items: [proposedAction('memos.create')], previousCursor: null });
    api.confirmLegacy.mockRejectedValue(new Error('backend rejected the action'));
    render(<AssistantWorkspace teacherId="teacher-a" />);
    fireEvent.click(await screen.findByRole('button', { name: '确认保存' }));
    await screen.findByText('保存尚未确认，请重试。');
    expect(screen.getByRole('button', { name: '确认保存' })).toBeEnabled();
    expect(screen.getByText(/周三 19:00 为小明安排数学课。/)).toBeInTheDocument();
  });

  it('cancels a pending memo proposal without claiming it was saved', async () => {
    api.turns.mockResolvedValue({ items: [proposedAction('memos.create')], previousCursor: null });
    render(<AssistantWorkspace teacherId="teacher-a" />);
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    await waitFor(() => expect(api.cancelLegacy).toHaveBeenCalledWith('teacher-a', 'pending-1'));
    await screen.findByText('该操作已取消。不会写入资料。');
    expect(screen.queryByRole('link', { name: '查看待办' })).not.toBeInTheDocument();
  });
});
