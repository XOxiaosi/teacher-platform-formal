import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantWorkspace } from './AssistantWorkspace';

vi.mock('./ConversationPanel', () => ({ ConversationPanel: () => <section aria-label="当前会话"><h2>当前会话</h2></section> }));
vi.mock('./useConversationList', () => ({ useConversationList: () => ({
  items: [{ id: 'one', displayTitle: '会话 one', summary: '', lastTurnAt: null }], busy: false, error: '', creating: false, cursor: null,
  create: vi.fn(), load: vi.fn(),
}) }));
vi.mock('./useAssistantMessages', () => ({ useAssistantMessages: () => ({ messages: {}, send: vi.fn() }) }));

beforeEach(() => { location.hash = '#/agent/one'; });

describe('assistant conversation-first layout', () => {
  it('keeps the session column beside the main conversation without an embedded board', async () => {
    render(<AssistantWorkspace teacherId="teacher-a" />);
    expect(screen.queryByLabelText('任务看板')).not.toBeInTheDocument();
    const sessions = screen.getByLabelText('会话列表');
    const conversation = await screen.findByLabelText('当前会话');
    expect(sessions.compareDocumentPosition(conversation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
