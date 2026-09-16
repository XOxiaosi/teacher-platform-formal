import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantWorkspace } from './AssistantWorkspace';
import { clearAssistantDrafts } from './drafts';
import { detail, deferred, makeTransport, userTurn } from './assistant-test-support';
import type { ConversationResponse } from '../../api/conversations';

const api = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), detail: vi.fn(), turns: vi.fn(), archive: vi.fn(), sendLegacy: vi.fn(), confirmLegacy: vi.fn() }));
vi.mock('../../api/conversations', () => ({
  createConversation: api.create, listConversations: api.list, getConversation: api.detail,
  listConversationTurns: api.turns, archiveConversation: api.archive,
  sendConversationMessage: api.sendLegacy, confirmPendingAction: api.confirmLegacy,
}));
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); clearAssistantDrafts('teacher-a'); clearAssistantDrafts('teacher-b');
  location.hash = '#/agent/one';
  api.list.mockResolvedValue({ items: [detail(), detail('two')], nextCursor: null });
  api.detail.mockImplementation((_teacher: string, id: string) => Promise.resolve({ conversation: detail(id) }));
  api.turns.mockResolvedValue({ items: [], previousCursor: null });
  api.create.mockResolvedValue({ conversation: detail('new') });
  api.archive.mockResolvedValue({ conversation: detail('one', 'archived') });
});

describe('A03 server-backed assistant conversations', () => {
  it('opens a saved URL, shows true service availability and never calls the old executor', async () => {
    render(<AssistantWorkspace teacherId="teacher-a" />);
    await screen.findByRole('heading', { name: '会话one' });
    expect(api.detail).toHaveBeenCalledWith('teacher-a', 'one');
    expect(screen.getByText(/AI 服务尚不可用/)).toBeInTheDocument();
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
    await screen.findByText('部分完成');
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
});
