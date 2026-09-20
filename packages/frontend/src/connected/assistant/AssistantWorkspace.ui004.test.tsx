import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantWorkspace } from './AssistantWorkspace';
import { clearAssistantDrafts } from './drafts';
import { detail, deferred, makeTransport } from './assistant-test-support';
import type { ConversationResponse } from '../../api/conversations';

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

async function openHistory() {
  fireEvent.click(screen.getByRole('button', { name: '历史' }));
  await screen.findByRole('heading', { name: '历史会话' });
}

describe('UI-004 assistant chat entry and history', () => {
  it('lazily creates one conversation for the first message and sends its original snapshot', async () => {
    const pending = deferred<ConversationResponse>(); api.create.mockReturnValue(pending.promise);
    const transport = makeTransport();
    location.hash = '#/agent';
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    const composer = await screen.findByLabelText('交给教学助手的工作');
    fireEvent.change(composer, { target: { value: '为明天的课整理提纲' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(screen.getByRole('button', { name: '提交中' }));
    expect(api.create).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ conversation: detail('server-new') }));
    await screen.findByRole('heading', { name: '会话server-new' });
    expect(location.hash).toBe('#/agent/server-new');
    await waitFor(() => expect(transport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      teacherId: 'teacher-a', conversationId: 'server-new', message: '为明天的课整理提纲',
    })));
  });

  it('keeps the blank draft after creation fails and reuses an id whose detail read failed', async () => {
    location.hash = '#/agent';
    const transport = {
      ...makeTransport(),
      createConversation: vi.fn().mockResolvedValue('created-once'),
      conversationApi: {
        list: api.list,
        detail: vi.fn().mockRejectedValueOnce(new Error('detail unavailable')).mockResolvedValue({ conversation: detail('created-once') }),
        turns: api.turns,
        archive: api.archive,
      },
    };
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    const composer = await screen.findByLabelText('交给教学助手的工作');
    fireEvent.change(composer, { target: { value: '保留首发草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByRole('button', { name: '重试发送' });
    expect(composer).toHaveValue('保留首发草稿');
    fireEvent.click(screen.getByRole('button', { name: '重试发送' }));
    await screen.findByRole('heading', { name: '会话created-once' });
    expect(transport.createConversation).toHaveBeenCalledTimes(1);
    expect(transport.conversationApi.detail.mock.calls.length).toBeGreaterThanOrEqual(2);
    await waitFor(() => expect(transport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'created-once', message: '保留首发草稿',
    })));
  });

  it('does not replace a route chosen while first-message creation is pending', async () => {
    location.hash = '#/agent';
    const pending = deferred<ConversationResponse>();
    const transport = makeTransport();
    api.create.mockReturnValue(pending.promise);
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    fireEvent.change(await screen.findByLabelText('交给教学助手的工作'), { target: { value: '首发快照' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await act(async () => {
      location.hash = '#/agent/two';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await screen.findByRole('heading', { name: '会话two' });
    await act(async () => pending.resolve({ conversation: detail('created-late') }));
    await waitFor(() => expect(transport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'created-late', message: '首发快照',
    })));
    expect(screen.getByRole('heading', { name: '会话two' })).toBeInTheDocument();
  });

  it('clears only the submitted blank draft when new conversation is chosen during creation', async () => {
    location.hash = '#/agent';
    const pending = deferred<ConversationResponse>();
    const transport = makeTransport();
    transport.sendMessage.mockResolvedValue({ accepted: true, task: { id: 'first-task', status: 'queued', summary: '已接收' } });
    api.create.mockReturnValue(pending.promise);
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    const composer = await screen.findByLabelText('交给教学助手的工作');
    fireEvent.change(composer, { target: { value: '不要重复发送的首发' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    await act(async () => pending.resolve({ conversation: detail('created-after-new') }));
    await waitFor(() => expect(composer).toHaveValue(''));
    expect(api.create).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(transport.sendMessage).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('heading', { name: '会话created-after-new' })).not.toBeInTheDocument();
  });

  it('returns to an empty workspace for a new conversation without creating a record', async () => {
    render(<AssistantWorkspace teacherId="teacher-a" />);
    await screen.findByRole('heading', { name: '会话one' });
    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    expect(await screen.findByRole('heading', { name: '今天想一起完成什么？' })).toBeInTheDocument();
    expect(screen.getByLabelText('交给教学助手的工作')).toHaveValue('');
    expect(api.create).not.toHaveBeenCalled();
    expect(api.sendLegacy).not.toHaveBeenCalled();
  });

  it('keeps history closed by default, opens it on demand, and filters archived work', async () => {
    render(<AssistantWorkspace teacherId="teacher-a" />);
    await screen.findByRole('heading', { name: '会话one' });
    expect(screen.queryByRole('button', { name: /会话two/ })).not.toBeInTheDocument();
    await openHistory();
    expect(screen.getByRole('button', { name: /会话two/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('查看会话'), { target: { value: 'archived' } });
    await waitFor(() => expect(api.list).toHaveBeenCalledWith('teacher-a', { status: 'archived', cursor: undefined }));
  });

  it('refreshes the latest conversation summary each time history opens', async () => {
    api.list.mockResolvedValueOnce({ items: [detail()], nextCursor: null })
      .mockResolvedValueOnce({ items: [{ ...detail(), summary: '已完成第二轮回复', lastTurnAt: '2026-09-15T12:00:00Z' }], nextCursor: null });
    render(<AssistantWorkspace teacherId="teacher-a" />);
    await screen.findByRole('heading', { name: '会话one' });
    await act(async () => { await Promise.resolve(); });
    await openHistory();
    expect(await screen.findByText('已完成第二轮回复')).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledTimes(2);
  });
});
