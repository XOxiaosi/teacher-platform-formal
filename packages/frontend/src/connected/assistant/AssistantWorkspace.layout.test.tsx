import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantWorkspace } from './AssistantWorkspace';
import { detail } from './assistant-test-support';

const api = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), turns: vi.fn() }));
vi.mock('../../api/conversations', () => ({
  listConversations: api.list, getConversation: api.detail, listConversationTurns: api.turns,
}));
vi.mock('./useAssistantMessages', () => ({ useAssistantMessages: () => ({ messages: {}, send: vi.fn() }) }));

beforeEach(() => {
  vi.clearAllMocks();
  api.list.mockResolvedValue({ items: [detail()], nextCursor: null });
  api.detail.mockImplementation((_teacher: string, id: string) => Promise.resolve({ conversation: detail(id) }));
  api.turns.mockResolvedValue({ items: [], previousCursor: null });
});

describe('assistant persistent chat layout', () => {
  it('shows only the teaching assistant brand and a fixed composer, with no session controls or internal labels', async () => {
    render(<AssistantWorkspace teacherId="teacher-a" />);
    await screen.findByLabelText('教学助手对话');
    expect(screen.getByText('教学助手')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /历史|新建|归档|会话/ })).not.toBeInTheDocument();
    expect(screen.queryByText('我')).not.toBeInTheDocument();
    expect(screen.queryByText(/思考|工具调用|处理过程|处理中|已处理|未完成/)).not.toBeInTheDocument();
    const composer = await screen.findByLabelText('交给教学助手的工作');
    expect(composer).toBeInTheDocument();
    fireEvent.change(composer, { target: { value: '这是一条草稿' } });
    expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledWith('teacher-a', { status: 'active' });
  });

  it('reuses the most recently updated active conversation without creating another', async () => {
    api.list.mockResolvedValue({ items: [detail('latest'), detail('older')], nextCursor: null });
    render(<AssistantWorkspace teacherId="teacher-a" />);
    await waitFor(() => expect(api.detail).toHaveBeenCalledWith('teacher-a', 'latest'));
    expect(api.detail).not.toHaveBeenCalledWith('teacher-a', 'older');
  });
});
