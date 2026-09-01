import type { FormEvent } from 'react';
import { AgentErrorCard } from './AgentErrorCard';
import { AgentTodayContext } from './AgentTodayContext';
import { TurnList } from './TurnList';
import { useAgentConversation, type AgentConversationApi, type AgentPageState } from './useAgentConversation';
import './agent.css';
import './turns.css';
import './confirmation.css';

interface AgentPageProps {
  teacherId: string;
  api?: AgentConversationApi;
  onNavigate?: (path: string) => void;
}

const stateLabels: Record<AgentPageState, string> = {
  initializing: '正在初始化',
  empty: '等待新会话',
  'loading-conversation': '正在加载',
  ready: '准备就绪',
  sending: 'Agent 正在处理',
  'waiting-confirmation': '等待确认',
  'recoverable-error': '需要重试',
  'archived-readonly': '已归档，只读',
};

export function AgentPage({ teacherId, api, onNavigate }: AgentPageProps) {
  const state = useAgentConversation(teacherId, api);
  const busy = state.pageState === 'initializing'
    || state.pageState === 'loading-conversation'
    || state.pageState === 'sending'
    || state.confirmationBusyActionId !== null;
  const readonly = state.activeConversation?.status === 'archived';
  const composerDisabled = busy
    || readonly
    || state.pageState === 'waiting-confirmation'
    || !state.activeConversation;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void state.sendMessage();
  }

  return (
    <div className="agent-workspace">
      <section className="conversation-panel" aria-label="会话列表">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Agent</p>
            <h2>对话</h2>
          </div>
          <button
            type="button"
            className="quiet-button"
            disabled={busy}
            aria-label="新建会话"
            title="新建会话"
            onClick={() => void state.createNewConversation()}
          >＋</button>
        </div>

        {state.conversations.length === 0 ? (
          <div className="conversation-empty">
            <p>{state.pageState === 'initializing' ? '正在加载会话…' : '还没有会话'}</p>
            <span>新建会话后即可开始工作</span>
          </div>
        ) : (
          <div className="conversation-list">
            {state.conversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                className={conversation.id === state.activeConversation?.id ? 'conversation-item active' : 'conversation-item'}
                aria-current={conversation.id === state.activeConversation?.id ? 'true' : undefined}
                disabled={busy}
                onClick={() => void state.selectConversation(conversation.id)}
              >
                <strong>{conversation.displayTitle}</strong>
                <span>{conversation.lastMessagePreview ?? '暂无消息'}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="conversation-stage" aria-label="对话工作区">
        <header className="agent-topbar">
          <div>
            <p className="eyebrow">工作助理</p>
            <h2>{state.activeConversation?.displayTitle ?? '新会话'}</h2>
          </div>
          <div className="agent-topbar-actions">
            {state.activeConversation?.status === 'active' && (
              <button
                type="button"
                className="quiet-text-button"
                disabled={busy}
                onClick={() => void state.archiveCurrentConversation()}
              >归档会话</button>
            )}
            <span className="status-label">{stateLabels[state.pageState]}</span>
          </div>
        </header>

        {state.error && <AgentErrorCard message={state.error} />}

        {state.turns.length === 0 ? (
          <div className="agent-empty-state">
            <span className="agent-seal" aria-hidden="true">AI</span>
            <h3>从一句话开始</h3>
            <p>可以查询学生、安排日程、整理课堂记录，或核对今天的工作。</p>
          </div>
        ) : (
          <TurnList
            turns={state.turns}
            onNavigate={onNavigate}
            onConfirmAction={(actionId, actionToken) => void state.confirmAction(actionId, actionToken)}
            onCancelAction={(actionId) => void state.cancelAction(actionId)}
            onRetryExecution={(executionId) => void state.retryExecution(executionId)}
            executionBusy={state.pageState === 'sending'}
            confirmationBusyActionId={state.confirmationBusyActionId}
            confirmationOperation={state.confirmationOperation}
            confirmationErrors={state.confirmationErrors}
            readonly={readonly}
          />
        )}

        <form className="composer" aria-label="消息输入" onSubmit={submit}>
          <label htmlFor="agent-message" className="sr-only">给 Agent 发送消息</label>
          <textarea
            id="agent-message"
            aria-label="给 Agent 发送消息"
            placeholder="输入你想处理的事情…"
            disabled={composerDisabled}
            value={state.draft}
            onChange={(event) => state.setDraft(event.target.value)}
          />
          <button
            type="submit"
            disabled={composerDisabled || state.draft.trim() === ''}
            aria-label="发送消息"
          >发送</button>
        </form>
      </section>

      <aside className="context-panel" aria-label="上下文">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Context</p>
            <h2>上下文</h2>
          </div>
        </div>
        <AgentTodayContext teacherId={teacherId} onNavigate={onNavigate} />
        <dl className="context-list">
          <div><dt>当前会话</dt><dd>{state.activeConversation?.displayTitle ?? '尚未选择'}</dd></div>
          <div><dt>执行状态</dt><dd>{stateLabels[state.pageState]}</dd></div>
          <div><dt>消息数量</dt><dd>{state.turns.length}</dd></div>
        </dl>
      </aside>
    </div>
  );
}
