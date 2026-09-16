import { useEffect, useState } from 'react';
import type { ConversationStatus } from '../../api/conversations';
import { retainOnlyTeacherDrafts } from './drafts';
import { ConversationPanel } from './ConversationPanel';
import { useConversationList } from './useConversationList';
import { useAssistantMessages } from './useAssistantMessages';
import type { AssistantTransport } from './transport';
import './assistant.css';
import { formatDateTime } from '../../shared/date-format';

interface Props { teacherId: string; transport?: AssistantTransport }
function routeConversation(): string | null {
  const match = /^#\/agent\/([^/?#]+)$/.exec(window.location.hash);
  try { return match ? decodeURIComponent(match[1]) : null; } catch { return null; }
}
function AccountWorkspace({ teacherId, transport }: Props) {
  const [conversationId, setConversationId] = useState(routeConversation);
  const [status, setStatus] = useState<ConversationStatus>('active');
  const list = useConversationList(teacherId, status, transport);
  const { messages, send } = useAssistantMessages(teacherId, transport);
  useEffect(() => { retainOnlyTeacherDrafts(teacherId); }, [teacherId]);
  useEffect(() => {
    const onHash = () => setConversationId(routeConversation());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  function select(id: string) { window.location.hash = `/agent/${encodeURIComponent(id)}`; setConversationId(id); }
  return <div className="assistant-workspace">
    <header className="assistant-page-heading"><h1>教学助手</h1><p>整理教学记录、核对课时，接着完成手头的工作。</p></header>
    {(!transport || transport.runtimeAvailability === 'unavailable') && <p className="assistant-availability" role="status">AI 服务尚不可用。可以新建、查看和归档会话；输入暂存后可在服务恢复时发送。</p>}
    <div className="assistant-layout">
      <aside className="assistant-sidebar" aria-label="会话列表">
        <button type="button" className="assistant-new" disabled={list.creating} onClick={() => { void list.create().then(id => { if (id) { setStatus('active'); select(id); } }); }}>{list.creating ? '正在新建…' : '新建会话'}</button>
        <label>查看会话<select value={status} onChange={event => setStatus(event.target.value as ConversationStatus)}><option value="active">进行中的会话</option><option value="archived">已归档的会话</option></select></label>
        {list.busy && <p role="status">正在读取会话列表…</p>}
        {list.error && <div role="alert"><p>{list.error}</p><button type="button" onClick={() => { void list.load(); }}>重试读取列表</button></div>}
        {!list.busy && !list.error && list.items.length === 0 && <p>{status === 'archived' ? '还没有已归档会话。' : '还没有会话，先新建一条。'}</p>}
        <ul>{list.items.map(item => <li key={item.id}><button type="button" aria-current={conversationId === item.id ? 'page' : undefined} onClick={() => select(item.id)}><strong>{item.displayTitle}</strong>{item.summary && <span>{item.summary}</span>}<small>{item.lastTurnAt ? formatDateTime(item.lastTurnAt) : '尚无消息'}</small></button></li>)}</ul>
        {list.cursor && <button type="button" disabled={list.busy} onClick={() => { void list.load(true); }}>加载更多会话</button>}
      </aside>
      {conversationId ? <ConversationPanel key={conversationId} teacherId={teacherId} conversationId={conversationId} transport={transport} messageState={messages[conversationId]} send={send} onArchive={() => { void list.load(); }} />
        : <section className="assistant-welcome"><h2>今天想先完成什么？</h2><p>新建一条会话，或选择已有会话接着处理。</p><p>已保存的记录和材料可以从原会话找回。</p></section>}
    </div>
  </div>;
}
export function AssistantWorkspace(props: Props) { return <AccountWorkspace key={props.teacherId} {...props} />; }
