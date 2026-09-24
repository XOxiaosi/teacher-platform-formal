import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantWorkspace } from './AssistantWorkspace';
import { clearAssistantDrafts } from './drafts';
import { deferred, detail, userTurn } from './assistant-test-support';
import type { ConfirmationTurnDto } from '../../api/conversations';

const api = vi.hoisted(() => ({
  create: vi.fn(), list: vi.fn(), detail: vi.fn(), turns: vi.fn(), archive: vi.fn(),
  sendLegacy: vi.fn(), getLegacy: vi.fn(), confirmLegacy: vi.fn(), cancelLegacy: vi.fn(),
}));
vi.mock('../../api/conversations', () => ({
  createConversation: api.create, listConversations: api.list, getConversation: api.detail,
  listConversationTurns: api.turns, archiveConversation: api.archive, sendConversationMessage: api.sendLegacy,
  getPendingAction: api.getLegacy, confirmPendingAction: api.confirmLegacy, cancelPendingAction: api.cancelLegacy,
}));

beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); clearAssistantDrafts('teacher-a');
  location.hash = '#/agent/one';
  api.list.mockResolvedValue({ items: [detail()], nextCursor: null });
  api.detail.mockResolvedValue({ conversation: detail() });
  api.turns.mockResolvedValue({ items: [], previousCursor: null });
  api.cancelLegacy.mockResolvedValue({ pendingAction: { id: 'pending-1', status: 'cancelled' } });
  api.getLegacy.mockResolvedValue({ pendingAction: { id: 'pending-1', status: 'pending' } });
});

function action(actionName: 'scheduling.create' | 'memos.create', overrides: Partial<ConfirmationTurnDto>): ConfirmationTurnDto {
  return {
    id: 'confirmation-1', conversationId: 'one', kind: 'confirmation', actionId: 'pending-1', actionName,
    target: { type: 'Schedule', id: 'proposal-1' }, beforeSummary: null, afterSummary: '周三 19:00 为小明安排数学课。',
    parameterSummary: {}, status: 'pending', expiresAt: '2099-09-19T12:00:00Z', actionToken: 'private-confirmation-token', error: null,
    createdAt: '2026-09-19T12:00:00Z', ...overrides,
  };
}

function batch(taskId = 'task-batch'): ConfirmationTurnDto[] {
  return [
    action('scheduling.create', { taskId }),
    action('memos.create', {
      id: `${taskId}-memo`, taskId, actionId: `${taskId}-pending-memo`, actionToken: `${taskId}-memo-token`,
      target: { type: 'Memo', id: `${taskId}-proposal-memo` }, afterSummary: '周五提醒家长反馈。',
    }),
  ];
}

describe('DSH confirmation revision flow', () => {
  it('cancels the old batch before drafting a natural-language revision', async () => {
    api.turns.mockResolvedValue({ items: batch(), previousCursor: null });
    render(<AssistantWorkspace teacherId="teacher-a" />);
    fireEvent.click(await screen.findByRole('button', { name: '让助手修改' }));
    await waitFor(() => expect(api.cancelLegacy).toHaveBeenCalledTimes(2));
    const composer = screen.getByLabelText('交给教学助手的工作') as HTMLTextAreaElement;
    await waitFor(() => expect(composer.value).toContain('请修改这批安排：'));
    expect(composer.value).toContain('周三 19:00 为小明安排数学课。');
    expect(composer.value).toContain('周五提醒家长反馈。');
    expect(composer.value).toContain('我的修改是：');
    expect(screen.getAllByText('已取消')).toHaveLength(2);
  });

  it('does not draft a revision while an old proposal cancellation is unresolved', async () => {
    api.turns.mockResolvedValue({ items: batch(), previousCursor: null });
    api.cancelLegacy.mockRejectedValue(new Error('cancel unavailable'));
    api.getLegacy.mockImplementation((_teacher: string, actionId: string) => Promise.resolve({ pendingAction: { id: actionId, status: 'pending' } }));
    render(<AssistantWorkspace teacherId="teacher-a" />);
    fireEvent.click(await screen.findByRole('button', { name: '让助手修改' }));
    expect(await screen.findAllByText('旧候选尚未撤销，请重试修改。')).toHaveLength(2);
    expect((screen.getByLabelText('交给教学助手的工作') as HTMLTextAreaElement).value).toBe('');
  });

  it('preserves existing and concurrently entered drafts', async () => {
    api.turns.mockResolvedValue({ items: batch(), previousCursor: null });
    const view = render(<AssistantWorkspace teacherId="teacher-a" />);
    const composer = await screen.findByLabelText('交给教学助手的工作') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: '我正在写另一件事' } });
    fireEvent.click(screen.getByRole('button', { name: '让助手修改' }));
    await screen.findByText('输入框已有未发送内容，请先发送或清空，再修改这批安排。');
    expect(composer.value).toBe('我正在写另一件事');
    expect(api.cancelLegacy).not.toHaveBeenCalled();

    clearAssistantDrafts('teacher-a');
    const cancellation = deferred<{ pendingAction: { id: string; status: string } }>();
    api.cancelLegacy.mockReturnValue(cancellation.promise);
    view.unmount();
    render(<AssistantWorkspace teacherId="teacher-a" />);
    fireEvent.click(await screen.findByRole('button', { name: '让助手修改' }));
    const activeComposer = screen.getByLabelText('交给教学助手的工作') as HTMLTextAreaElement;
    fireEvent.change(activeComposer, { target: { value: '撤销期间写下的新内容' } });
    await act(async () => cancellation.resolve({ pendingAction: { id: 'resolved', status: 'cancelled' } }));
    await screen.findByText('旧候选已撤销；输入框内容已变化，请直接在当前输入中写明修改要求。');
    expect(activeComposer.value).toBe('撤销期间写下的新内容');
  });

  it('allows only one batch revision flow at a time', async () => {
    const cancellation = deferred<{ pendingAction: { id: string; status: string } }>();
    api.turns.mockResolvedValue({ items: [...batch('task-batch-1'), userTurn('between-batches', '另一项安排'), ...batch('task-batch-2')], previousCursor: null });
    api.cancelLegacy.mockReturnValue(cancellation.promise);
    render(<AssistantWorkspace teacherId="teacher-a" />);
    const reviseButtons = await screen.findAllByRole('button', { name: '让助手修改' });
    fireEvent.click(reviseButtons[0]!);
    await waitFor(() => expect(api.cancelLegacy).toHaveBeenCalledTimes(2));
    const lockedButtons = screen.getAllByRole('button', { name: '正在准备修改…' });
    expect(lockedButtons).toHaveLength(2);
    expect(lockedButtons.every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(lockedButtons[1]!);
    expect(api.cancelLegacy).toHaveBeenCalledTimes(2);
    await act(async () => cancellation.resolve({ pendingAction: { id: 'resolved', status: 'cancelled' } }));
    await waitFor(() => expect((screen.getByLabelText('交给教学助手的工作') as HTMLTextAreaElement).value).toContain('周三 19:00 为小明安排数学课。'));
  });
});
