import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantWorkspace } from './AssistantWorkspace';
import { clearAssistantDrafts } from './drafts';
import { deferred, detail } from './assistant-test-support';
import type { ConfirmationTurnDto } from '../../api/conversations';

const api = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), turns: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), get: vi.fn() }));
vi.mock('../../api/conversations', () => ({
  listConversations: api.list, getConversation: api.detail, listConversationTurns: api.turns,
  getPendingAction: api.get, confirmPendingAction: api.confirm, cancelPendingAction: api.cancel,
}));

beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); clearAssistantDrafts('teacher-a');
  api.list.mockResolvedValue({ items: [detail('persistent')], nextCursor: null });
  api.detail.mockResolvedValue({ conversation: detail('persistent') });
  api.turns.mockResolvedValue({ items: [], previousCursor: null });
  api.cancel.mockResolvedValue({ pendingAction: { id: 'synthetic-action', status: 'cancelled' } });
  api.get.mockResolvedValue({ pendingAction: { id: 'synthetic-action', status: 'pending' } });
});

function proposal(id = 'proposal-1', actionId = 'action-1'): ConfirmationTurnDto {
  return {
    id, conversationId: 'persistent', kind: 'confirmation', actionId, actionName: 'scheduling.create',
    target: { type: 'Schedule', id: `synthetic-${id}` }, beforeSummary: null, afterSummary: `周三 19:00 安排数学课（${id}）。`,
    parameterSummary: {}, status: 'pending', expiresAt: '2099-09-19T12:00:00Z', actionToken: `token-${id}`,
    error: null, createdAt: '2026-09-19T12:00:00Z',
  };
}

describe('confirmation modification flow', () => {
  it('cancels the proposal before preparing a revision draft', async () => {
    api.turns.mockResolvedValue({ items: [proposal()], previousCursor: null });
    render(<AssistantWorkspace teacherId="teacher-a" />);
    fireEvent.click(await screen.findByRole('button', { name: '修改' }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith('teacher-a', 'action-1'));
    const composer = await screen.findByLabelText('交给教学助手的工作') as HTMLTextAreaElement;
    await waitFor(() => expect(composer.value).toContain('请修改这项安排：'));
    expect(composer.value).toContain('周三 19:00 安排数学课（proposal-1）。');
    expect(screen.getByText('该操作已取消。不会写入资料。')).toBeInTheDocument();
  });

  it('keeps the proposal available when cancellation cannot be verified', async () => {
    api.turns.mockResolvedValue({ items: [proposal()], previousCursor: null });
    api.cancel.mockRejectedValue(new Error('synthetic failure'));
    api.get.mockResolvedValue({ pendingAction: { id: 'action-1', status: 'pending' } });
    render(<AssistantWorkspace teacherId="teacher-a" />);
    fireEvent.click(await screen.findByRole('button', { name: '修改' }));
    expect(await screen.findByText('这项待确认变更尚未撤销，请重试修改。')).toBeInTheDocument();
    expect((screen.getByLabelText('交给教学助手的工作') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByText('周三 19:00 安排数学课（proposal-1）。')).toBeInTheDocument();
  });

  it('does not replace text already being written in the composer', async () => {
    api.turns.mockResolvedValue({ items: [proposal()], previousCursor: null });
    render(<AssistantWorkspace teacherId="teacher-a" />);
    const composer = await screen.findByLabelText('交给教学助手的工作');
    fireEvent.change(composer, { target: { value: '正在写的其他工作' } });
    fireEvent.click(screen.getByRole('button', { name: '修改' }));
    expect(await screen.findByText('输入框已有未发送内容，请先发送或清空后再修改。')).toBeInTheDocument();
    expect(api.cancel).not.toHaveBeenCalled();
    expect(composer).toHaveValue('正在写的其他工作');
  });

  it('prevents parallel modifications across proposals', async () => {
    const cancellation = deferred<{ pendingAction: { id: string; status: string } }>();
    api.turns.mockResolvedValue({ items: [proposal('first', 'action-first'), proposal('second', 'action-second')], previousCursor: null });
    api.cancel.mockReturnValue(cancellation.promise);
    render(<AssistantWorkspace teacherId="teacher-a" />);
    const buttons = await screen.findAllByRole('button', { name: '修改' });
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(api.cancel).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: '正在修改…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '修改' })).toBeDisabled();
    await act(async () => cancellation.resolve({ pendingAction: { id: 'action-first', status: 'cancelled' } }));
    await waitFor(() => expect((screen.getByLabelText('交给教学助手的工作') as HTMLTextAreaElement).value).toContain('请修改这项安排：'));
    expect(api.cancel).toHaveBeenCalledTimes(1);
  });
});
