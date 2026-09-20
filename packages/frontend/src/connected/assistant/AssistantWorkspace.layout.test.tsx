import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantWorkspace } from './AssistantWorkspace';

vi.mock('./ConversationPanel', () => ({ ConversationPanel: ({ headerActions }: { headerActions?: ReactNode }) => <section aria-label="当前会话"><h2>当前会话</h2>{headerActions}</section> }));
vi.mock('./useConversationList', () => ({ useConversationList: () => ({
  items: [{ id: 'one', displayTitle: '会话 one', summary: '', lastTurnAt: null }], busy: false, error: '', creating: false, cursor: null,
  create: vi.fn(), load: vi.fn(),
}) }));
vi.mock('./useAssistantMessages', () => ({ useAssistantMessages: () => ({ messages: {}, send: vi.fn() }) }));

beforeEach(() => { location.hash = '#/agent/one'; });

describe('assistant conversation-first layout', () => {
  it('keeps conversation flat and exposes history only through its on-demand sheet', async () => {
    render(<AssistantWorkspace teacherId="teacher-a" />);
    expect(screen.queryByLabelText('任务看板')).not.toBeInTheDocument();
    await screen.findByLabelText('当前会话');
    expect(screen.queryByRole('heading', { name: '历史会话' })).not.toBeInTheDocument();
    const history = screen.getByRole('button', { name: '历史' });
    fireEvent.click(history);
    expect(await screen.findByRole('heading', { name: '历史会话' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭导航' }));
    await waitFor(() => expect(history).toHaveFocus());
  });
});
