import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantWorkspace } from './AssistantWorkspace';
import { clearAssistantDrafts, readDraft } from './drafts';
import { detail, deferred, makeTransport, userTurn } from './assistant-test-support';
import type { AssistantTransport } from './transport';
import { ApiError } from '../../api/client';

const api = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), turns: vi.fn(), archive: vi.fn(), create: vi.fn() }));
vi.mock('../../api/conversations', () => ({
  listConversations: api.list, getConversation: api.detail, listConversationTurns: api.turns,
  archiveConversation: api.archive, createConversation: api.create,
}));

beforeEach(() => {
  vi.clearAllMocks();
  clearAssistantDrafts('teacher-a'); clearAssistantDrafts('teacher-b'); sessionStorage.clear();
  location.hash = '#/agent/one';
  api.list.mockResolvedValue({ items: [detail(), detail('two')], nextCursor: null });
  api.detail.mockImplementation((_teacher, id) => Promise.resolve({ conversation: detail(id) }));
  api.turns.mockResolvedValue({ items: [], previousCursor: null });
});

// These are synthetic session/client lifecycle tests in jsdom, not real-browser,
// cross-device or authenticated backend acceptance evidence.
describe('A03 uncertain receipt and synthetic client recovery', () => {
  it('allows correcting a first-attempt validation rejection but keeps an uncertain retry immutable', async () => {
    const transport = makeTransport();
    const rejected = new ApiError({ code: 'VALIDATION_ERROR', message: '消息未通过校验' }, 400);
    transport.sendMessage.mockRejectedValueOnce(rejected).mockRejectedValueOnce(new Error('response lost')).mockRejectedValueOnce(rejected);
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    fireEvent.change(await screen.findByLabelText('交给教学助手的工作'), { target: { value: '待纠正消息' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText(/这条消息未被接收/);
    await waitFor(() => expect(screen.getByLabelText('交给教学助手的工作')).not.toHaveAttribute('readonly'));
    fireEvent.change(screen.getByLabelText('交给教学助手的工作'), { target: { value: '纠正后的消息' } });
    fireEvent.click(screen.getByRole('button', { name: '重试发送' }));
    await screen.findByText(/尚未取得接收回执/);
    const uncertainRequest = transport.sendMessage.mock.calls[1][0];
    fireEvent.click(screen.getByRole('button', { name: '重试发送' }));
    await waitFor(() => expect(transport.sendMessage).toHaveBeenCalledTimes(3));
    expect(transport.sendMessage.mock.calls[2][0]).toEqual(uncertainRequest);
    expect(readDraft('teacher-a', 'one').awaitingReceipt).toBe(true);
    expect(screen.getByLabelText('交给教学助手的工作')).toHaveAttribute('readonly');
  });

  it('preserves the exact submitted request across editing attempts, switching and remount after a lost receipt', async () => {
    const transport = makeTransport();
    const accepted = new Map<string, string>();
    transport.sendMessage.mockImplementation(async ({ message, clientRequestId }) => {
      if (!accepted.has(clientRequestId)) {
        accepted.set(clientRequestId, message);
        throw new Error('Server committed, response was lost');
      }
      expect(accepted.get(clientRequestId)).toBe(message);
      return { accepted: true, task: { id: 'saved-once', status: 'queued', summary: '已接收同一条工作' } };
    });
    const view = render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    fireEvent.change(await screen.findByLabelText('交给教学助手的工作'), { target: { value: '  整理原始记录\n保留换行  ' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText(/尚未取得接收回执/);
    const original = transport.sendMessage.mock.calls[0][0];
    expect(readDraft('teacher-a', 'one')).toMatchObject({ text: original.message, requestId: original.clientRequestId, awaitingReceipt: true });
    expect(screen.getByLabelText('交给教学助手的工作')).toHaveAttribute('readonly');
    fireEvent.change(screen.getByLabelText('交给教学助手的工作'), { target: { value: '改过又换回也不能另开请求' } });
    expect(readDraft('teacher-a', 'one').text).toBe(original.message);
    expect(screen.getByRole('button', { name: '归档会话' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /会话two/ }));
    await screen.findByRole('heading', { name: '会话two' });
    fireEvent.click(screen.getByRole('button', { name: /会话one/ }));
    await screen.findByRole('heading', { name: '会话one' });
    view.unmount();
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    expect(await screen.findByLabelText('交给教学助手的工作')).toHaveValue(original.message);
    fireEvent.click(screen.getByRole('button', { name: '重试发送' }));
    await screen.findByText('已接收同一条工作');
    expect(transport.sendMessage.mock.calls[1][0]).toEqual(original);
    expect(accepted.size).toBe(1);
    await waitFor(() => expect(screen.getByLabelText('交给教学助手的工作')).toHaveValue(''));
    expect(screen.getByLabelText('交给教学助手的工作')).not.toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: '归档会话' })).toBeEnabled();
  });

  it('records the retry identity before a pending request is interrupted by unmount', async () => {
    const transport = makeTransport();
    const receipt = deferred<Awaited<ReturnType<AssistantTransport['sendMessage']>>>();
    transport.sendMessage.mockReturnValueOnce(receipt.promise).mockResolvedValue({ accepted: true, task: { id: 'task-1', status: 'queued', summary: '已找回' } });
    const view = render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    fireEvent.change(await screen.findByLabelText('交给教学助手的工作'), { target: { value: '等待回执的记录' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const original = transport.sendMessage.mock.calls[0][0];
    expect(readDraft('teacher-a', 'one').awaitingReceipt).toBe(true);
    view.unmount();
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    await screen.findByLabelText('交给教学助手的工作');
    await act(async () => receipt.resolve({ accepted: true, task: { id: 'task-1', status: 'queued', summary: '旧页面回执' } }));
    expect(screen.queryByText('旧页面回执')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试发送' }));
    await screen.findByText('已找回');
    expect(transport.sendMessage.mock.calls[1][0]).toEqual(original);
  });

  it('restores saved work after synthetic logout and login without resending or exposing the old draft', async () => {
    const transport = makeTransport();
    api.turns.mockImplementation((teacher) => Promise.resolve({ items: [userTurn(`${teacher}-saved`, `${teacher}已保存的记录`)], previousCursor: null }));
    transport.getTasks.mockImplementation(({ teacherId }) => Promise.resolve([{ id: `${teacherId}-task`, status: 'partial', summary: `${teacherId}待续做反馈` }]));
    const view = render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    await screen.findByText('teacher-a已保存的记录');
    fireEvent.change(screen.getByLabelText('交给教学助手的工作'), { target: { value: '退出后清理的草稿' } });
    clearAssistantDrafts('teacher-a'); view.unmount();
    const other = render(<AssistantWorkspace teacherId="teacher-b" transport={transport} />);
    await screen.findByText('teacher-b待续做反馈');
    expect(screen.queryByText('teacher-a已保存的记录')).not.toBeInTheDocument();
    expect(screen.getByLabelText('交给教学助手的工作')).toHaveValue('');
    other.unmount();
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    await screen.findByText('teacher-a已保存的记录');
    await screen.findByText('teacher-a待续做反馈');
    expect(screen.getByLabelText('交给教学助手的工作')).toHaveValue('');
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it('scopes two simultaneous synthetic clients by teacher despite identical conversation and task ids', async () => {
    api.turns.mockImplementation((teacher) => Promise.resolve({ items: [userTurn(`${teacher}-saved`, `${teacher}专属内容`)], previousCursor: null }));
    const firstTransport = makeTransport(); const secondTransport = makeTransport();
    firstTransport.getTasks.mockResolvedValue([{ id: 'same-task', status: 'partial', summary: '甲的任务' }]);
    secondTransport.getTasks.mockResolvedValue([{ id: 'same-task', status: 'failed', summary: '乙的任务' }]);
    const first = render(<AssistantWorkspace teacherId="teacher-a" transport={firstTransport} />);
    const second = render(<AssistantWorkspace teacherId="teacher-b" transport={secondTransport} />);
    const a = within(first.container); const b = within(second.container);
    await a.findByText('teacher-a专属内容'); await b.findByText('teacher-b专属内容');
    await a.findByText('甲的任务'); await b.findByText('乙的任务');
    expect(a.queryByText('teacher-b专属内容')).not.toBeInTheDocument();
    expect(b.queryByText('teacher-a专属内容')).not.toBeInTheDocument();
    expect(a.queryByText('乙的任务')).not.toBeInTheDocument();
    expect(b.queryByText('甲的任务')).not.toBeInTheDocument();
    expect(firstTransport.getTasks).toHaveBeenCalledWith({ teacherId: 'teacher-a', conversationId: 'one' });
    expect(secondTransport.getTasks).toHaveBeenCalledWith({ teacherId: 'teacher-b', conversationId: 'one' });
  });

  it('keeps an unsuccessful archive editable and restores archived history after switching and remount', async () => {
    let archived = false;
    api.archive.mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => {
      archived = true; return { conversation: detail('one', 'archived') };
    });
    api.detail.mockImplementation((_teacher, id) => Promise.resolve({ conversation: detail(id, archived && id === 'one' ? 'archived' : 'active') }));
    api.list.mockImplementation((_teacher, { status }) => Promise.resolve({ items: status === 'archived' ? [detail('one', 'archived')] : [detail(), detail('two')], nextCursor: null }));
    api.turns.mockImplementation((_teacher, id) => Promise.resolve({ items: id === 'one' ? [userTurn('saved', '归档后仍可查看的记录')] : [], previousCursor: null }));
    const view = render(<AssistantWorkspace teacherId="teacher-a" />);
    await screen.findByText('归档后仍可查看的记录');
    fireEvent.click(screen.getByRole('button', { name: '归档会话' }));
    await screen.findByText('会话尚未归档，请重试。');
    expect(screen.getByLabelText('交给教学助手的工作')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '归档会话' }));
    await screen.findByText('已归档 · 可完整回看');
    fireEvent.click(screen.getByRole('button', { name: /会话two/ }));
    await screen.findByRole('heading', { name: '会话two' });
    fireEvent.change(screen.getByLabelText('查看会话'), { target: { value: 'archived' } });
    fireEvent.click(await screen.findByRole('button', { name: /会话one/ }));
    await screen.findByText('已归档 · 可完整回看');
    view.unmount(); render(<AssistantWorkspace teacherId="teacher-a" />);
    await screen.findByText('归档后仍可查看的记录');
    await waitFor(() => expect(screen.queryByLabelText('交给教学助手的工作')).not.toBeInTheDocument());
  });
});
