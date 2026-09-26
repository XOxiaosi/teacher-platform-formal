import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantWorkspace } from './AssistantWorkspace';
import { clearAssistantDrafts } from './drafts';
import { detail, makeTransport, userTurn } from './assistant-test-support';

const api = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), detail: vi.fn(), turns: vi.fn() }));
vi.mock('../../api/conversations', () => ({
  createConversation: api.create, listConversations: api.list, getConversation: api.detail,
  listConversationTurns: api.turns,
}));

beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); clearAssistantDrafts('teacher-a');
  api.list.mockResolvedValue({ items: [], nextCursor: null });
  api.detail.mockImplementation((_teacher: string, id: string) => Promise.resolve({ conversation: detail(id) }));
  api.turns.mockResolvedValue({ items: [], previousCursor: null });
  api.create.mockResolvedValue({ conversation: detail('new') });
});

describe('single conversation first message flow', () => {
  it('creates one persistent conversation for the first message and sends the original request once', async () => {
    const transport = { ...makeTransport(), createConversation: vi.fn().mockResolvedValue('persistent-one') };
    transport.sendMessage.mockResolvedValue({ accepted: true, task: { id: 'task-1', status: 'queued', summary: 'received' } });
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    const composer = await screen.findByLabelText('交给教学助手的工作');
    fireEvent.change(composer, { target: { value: '准备课堂提纲' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(transport.sendMessage).toHaveBeenCalledTimes(1));
    expect(transport.createConversation).toHaveBeenCalledTimes(1);
    expect(transport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      teacherId: 'teacher-a', conversationId: 'persistent-one', message: '准备课堂提纲',
    }));
    expect(screen.queryByRole('button', { name: /新建|历史|归档/ })).not.toBeInTheDocument();
  });

  it('loads all older turn pages automatically without a history control', async () => {
    api.list.mockResolvedValue({ items: [detail('persistent')], nextCursor: null });
    api.turns.mockImplementation((_teacher: string, _id: string, params?: { before?: string }) => Promise.resolve(params?.before
      ? { items: [userTurn('old', '较早的合成消息')], previousCursor: null }
      : { items: [userTurn('recent', '最近的合成消息')], previousCursor: 'older-cursor' }));
    render(<AssistantWorkspace teacherId="teacher-a" />);
    expect(await screen.findByText('较早的合成消息')).toBeInTheDocument();
    expect(screen.getByText('最近的合成消息')).toBeInTheDocument();
    expect(api.turns).toHaveBeenCalledWith('teacher-a', 'persistent', { before: 'older-cursor' });
    expect(screen.queryByRole('button', { name: /较早|历史/ })).not.toBeInTheDocument();
  });
});
