import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantWorkspace } from './AssistantWorkspace';
import { clearAssistantDrafts, readDraft } from './drafts';
import { detail, makeTransport, userTurn } from './assistant-test-support';

const api = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), turns: vi.fn() }));
vi.mock('../../api/conversations', () => ({
  listConversations: api.list, getConversation: api.detail, listConversationTurns: api.turns,
}));

beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); clearAssistantDrafts('teacher-a');
  api.list.mockResolvedValue({ items: [detail('persistent')], nextCursor: null });
  api.detail.mockImplementation((_teacher: string, id: string) => Promise.resolve({ conversation: detail(id) }));
  api.turns.mockResolvedValue({ items: [userTurn('saved-user', '已保存的合成消息'), {
    id: 'saved-assistant', conversationId: 'persistent', kind: 'assistant', content: '对应的合成回复',
    createdAt: '2026-09-15T12:01:00Z', references: [],
  }], previousCursor: null });
});

describe('persistent conversation recovery', () => {
  it('restores persisted teacher and assistant messages after remount without creating or sending again', async () => {
    const transport = makeTransport();
    const first = render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    expect(await screen.findByText('已保存的合成消息')).toBeInTheDocument();
    expect(await screen.findByText('对应的合成回复')).toBeInTheDocument();
    first.unmount();
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    expect(await screen.findByText('已保存的合成消息')).toBeInTheDocument();
    expect(await screen.findByText('对应的合成回复')).toBeInTheDocument();
    expect(screen.getAllByText('已保存的合成消息')).toHaveLength(1);
    expect(screen.getAllByText('对应的合成回复')).toHaveLength(1);
    expect(api.detail).toHaveBeenCalledTimes(2);
    expect('createConversation' in transport).toBe(false);
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it('retries an uncertain send with the same request id and preserves the unsent text until receipt', async () => {
    const transport = makeTransport();
    transport.sendMessage.mockRejectedValueOnce(new Error('simulated lost receipt'))
      .mockResolvedValue({ accepted: true, task: { id: 'synthetic-task', status: 'queued', summary: 'accepted' } });
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    fireEvent.change(await screen.findByLabelText('交给教学助手的工作'), { target: { value: '合成工作请求' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText(/尚未确认发送成功/);
    const originalRequest = transport.sendMessage.mock.calls[0]![0];
    expect(readDraft('teacher-a', 'persistent')).toMatchObject({ text: originalRequest.message, requestId: originalRequest.clientRequestId, awaitingReceipt: true });
    fireEvent.click(screen.getByRole('button', { name: '重试发送' }));
    await waitFor(() => expect(transport.sendMessage).toHaveBeenCalledTimes(2));
    expect(transport.sendMessage.mock.calls[1]![0]).toEqual(originalRequest);
    await waitFor(() => expect(screen.getByLabelText('交给教学助手的工作')).toHaveValue(''));
  });
});
