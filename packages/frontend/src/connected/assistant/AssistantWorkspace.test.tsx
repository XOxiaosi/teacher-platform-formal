import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantWorkspace } from './AssistantWorkspace';
import { clearAssistantDrafts } from './drafts';
import { deferred, detail, makeTransport, userTurn } from './assistant-test-support';
import type { ConfirmationTurnDto } from '../../api/conversations';

const api = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), turns: vi.fn(), confirm: vi.fn(), cancel: vi.fn() }));
vi.mock('../../api/conversations', () => ({
  listConversations: api.list, getConversation: api.detail, listConversationTurns: api.turns,
  confirmPendingAction: api.confirm, cancelPendingAction: api.cancel,
}));

beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); clearAssistantDrafts('teacher-a');
  api.list.mockResolvedValue({ items: [detail('persistent')], nextCursor: null });
  api.detail.mockImplementation((_teacher: string, id: string) => Promise.resolve({ conversation: detail(id) }));
  api.turns.mockResolvedValue({ items: [], previousCursor: null });
  api.confirm.mockResolvedValue({ pendingAction: { id: 'synthetic-action', status: 'consumed' }, result: { summary: '合成课表回执：课程已成功保存。', references: [] } });
});

function proposal(): ConfirmationTurnDto {
  return {
    id: 'synthetic-confirmation', conversationId: 'persistent', kind: 'confirmation', actionId: 'synthetic-action',
    actionName: 'scheduling.create', target: { type: 'Schedule', id: 'synthetic-schedule' }, beforeSummary: null,
    afterSummary: '周三 19:00 安排一节数学课（合成内容）。', parameterSummary: {}, status: 'pending',
    expiresAt: '2099-09-19T12:00:00Z', actionToken: 'synthetic-token', error: null, createdAt: '2026-09-19T12:00:00Z',
  };
}

describe('persistent assistant chat', () => {
  it('restores the whole saved conversation, deduplicates repeated server turns, and exposes no management or internal process UI', async () => {
    const transport = makeTransport();
    api.turns.mockResolvedValue({ items: [
      userTurn('synthetic-user', '这是一条合成的教师消息', 'persistent'),
      { id: 'synthetic-answer', conversationId: 'persistent', kind: 'assistant', content: '这是对应的合成助手回复。', createdAt: '2026-09-15T12:01:00Z', references: [] },
      { id: 'synthetic-tool', conversationId: 'persistent', kind: 'tool', toolCallId: 'call', toolName: 'secret.internal', displayName: '内部工具调用', sideEffect: 'read', status: 'success', inputSummary: {}, resultSummary: '不应展示的内部处理结果', references: [], error: null, createdAt: '2026-09-15T12:02:00Z' },
      { id: 'synthetic-outcome', conversationId: 'persistent', kind: 'tool', toolCallId: 'write-call', toolName: 'students.create', displayName: '新增学生', sideEffect: 'create', status: 'success', inputSummary: {}, resultSummary: '合成资料已保存：1 条学生记录。', references: [], error: null, createdAt: '2026-09-15T12:03:00Z' },
    ], previousCursor: null });
    const view = render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    expect(await screen.findByText('这是一条合成的教师消息')).toBeInTheDocument();
    expect(await screen.findByText('这是对应的合成助手回复。')).toBeInTheDocument();
    expect(screen.queryByText('不应展示的内部处理结果')).not.toBeInTheDocument();
    expect(screen.queryByText('内部工具调用')).not.toBeInTheDocument();
    expect(screen.getByText('合成资料已保存：1 条学生记录。')).toBeInTheDocument();
    expect(screen.queryByText('新增学生')).not.toBeInTheDocument();
    expect(screen.queryByText('我', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/思考|处理过程|已处理|未完成/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新建|历史|归档/ })).not.toBeInTheDocument();
    view.unmount();
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    expect(await screen.findByText('这是一条合成的教师消息')).toBeInTheDocument();
    expect(screen.getAllByText('这是一条合成的教师消息')).toHaveLength(1);
    expect(screen.getAllByText('这是对应的合成助手回复。')).toHaveLength(1);
    expect(screen.getAllByText('合成资料已保存：1 条学生记录。')).toHaveLength(1);
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect('createConversation' in transport).toBe(false);
  });

  it('requires confirmation before showing completion and displays the actual save receipt', async () => {
    const receipt = deferred<{ pendingAction: { id: string; status: string }; result: { summary: string; references: [] } }>();
    api.confirm.mockReturnValue(receipt.promise);
    api.turns.mockResolvedValue({ items: [proposal()], previousCursor: null });
    render(<AssistantWorkspace teacherId="teacher-a" />);
    expect(await screen.findByText('周三 19:00 安排一节数学课（合成内容）。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '修改' })).toBeInTheDocument();
    expect(screen.queryByText(/合成课表回执/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith('teacher-a', 'synthetic-action', 'synthetic-token'));
    expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled();
    expect(screen.queryByText(/合成课表回执/)).not.toBeInTheDocument();
    await act(async () => receipt.resolve({ pendingAction: { id: 'synthetic-action', status: 'consumed' }, result: { summary: '合成课表回执：课程已成功保存。', references: [] } }));
    expect(await screen.findByText('合成课表回执：课程已成功保存。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认' })).not.toBeInTheDocument();
  });

  it('leaves an unconfirmed proposal available when saving fails', async () => {
    api.turns.mockResolvedValue({ items: [proposal()], previousCursor: null });
    api.confirm.mockRejectedValueOnce(new Error('synthetic confirmation failure'));
    render(<AssistantWorkspace teacherId="teacher-a" />);
    await screen.findByText('周三 19:00 安排一节数学课（合成内容）。');
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法确认保存，请重试。');
    expect(screen.getByRole('button', { name: '确认' })).toBeEnabled();
    expect(screen.queryByText(/已保存/)).not.toBeInTheDocument();
  });

  it('keeps one sent request while refreshing and shows only a concise send error', async () => {
    const transport = makeTransport();
    transport.sendMessage.mockRejectedValue(new Error('private internal exception'));
    render(<AssistantWorkspace teacherId="teacher-a" transport={transport} />);
    const composer = await screen.findByLabelText('交给教学助手的工作');
    fireEvent.change(composer, { target: { value: '合成发送失败场景' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/接收|发送/);
    expect(screen.queryByText('private internal exception')).not.toBeInTheDocument();
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
  });
});
