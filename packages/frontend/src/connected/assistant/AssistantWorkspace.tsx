import { useEffect, useState } from 'react';
import type { ConversationStatus } from '../../api/conversations';
import { retainOnlyTeacherDrafts } from './drafts';
import { ConversationPanel } from './ConversationPanel';
import { useConversationList } from './useConversationList';
import { useAssistantMessages } from './useAssistantMessages';
import type { AssistantTransport } from './transport';
import './assistant.css';
import { formatDateTime } from '../../shared/date-format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ChevronLeft, ChevronRight, MessageSquarePlus, MessagesSquare } from 'lucide-react';

interface Props {
  teacherId: string;
  transport?: AssistantTransport;
  /** Reload formal workspace data after a durable assistant outcome. */
  onWorkspaceRefresh?: () => Promise<void>;
}
function routeConversation(): string | null {
  const match = /^#\/agent\/([^/?#]+)$/.exec(window.location.hash);
  try { return match ? decodeURIComponent(match[1]) : null; } catch { return null; }
}
function isNarrowAssistantViewport(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches;
}
function startsWithSessionsOpen(): boolean {
  return !isNarrowAssistantViewport();
}
function AccountWorkspace({ teacherId, transport, onWorkspaceRefresh }: Props) {
  const [conversationId, setConversationId] = useState(routeConversation);
  const [status, setStatus] = useState<ConversationStatus>('active');
  const [sessionsOpen, setSessionsOpen] = useState(startsWithSessionsOpen);
  const list = useConversationList(teacherId, status, transport);
  const { messages, send } = useAssistantMessages(teacherId, transport);
  useEffect(() => { retainOnlyTeacherDrafts(teacherId); }, [teacherId]);
  useEffect(() => {
    const onHash = () => setConversationId(routeConversation());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  function select(id: string) {
    window.location.hash = `/agent/${encodeURIComponent(id)}`;
    setConversationId(id);
    if (isNarrowAssistantViewport()) setSessionsOpen(false);
  }
  return <TooltipProvider delayDuration={350}><div className="assistant-workspace">
    <header className="assistant-page-heading">
      <div><span className="assistant-eyebrow">AI 工作空间</span><h1>教学助手</h1><p>把教学事务交给 AI，并始终看得见处理进度和保存结果。</p></div>
      <Badge variant="secondary" className="assistant-page-status">会话自动同步</Badge>
    </header>
    <div className={`assistant-layout${sessionsOpen ? '' : ' assistant-layout-sessions-collapsed'}`}>
      <aside className="assistant-session-column" aria-label="会话列表">
        <Card className="assistant-session-panel">
        <CardContent className="assistant-session-panel-content">
        <div className="assistant-session-toolbar"><div><span className="assistant-eyebrow">工作记录</span><strong>会话</strong></div><Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" className="assistant-compact-button" aria-label={sessionsOpen ? '收起会话列表' : '展开会话列表'} aria-expanded={sessionsOpen} onClick={() => setSessionsOpen(open => !open)}>{sessionsOpen ? <ChevronLeft size={17} /> : <ChevronRight size={17} />}</Button></TooltipTrigger><TooltipContent>{sessionsOpen ? '收起会话列表' : '展开会话列表'}</TooltipContent></Tooltip></div>
        {sessionsOpen && <>
        <Button type="button" className="assistant-new" disabled={list.creating} onClick={() => { void list.create().then(id => { if (id) { setStatus('active'); select(id); } }); }}><MessageSquarePlus size={16} />{list.creating ? '正在新建…' : '新建会话'}</Button>
        <Separator />
        <label>查看会话<select value={status} onChange={event => setStatus(event.target.value as ConversationStatus)}><option value="active">进行中的会话</option><option value="archived">已归档的会话</option></select></label>
        {list.busy && <p role="status">正在读取会话列表…</p>}
        {list.error && <div role="alert"><p>{list.error}</p><Button type="button" variant="outline" onClick={() => { void list.load(); }}>重试读取列表</Button></div>}
        {!list.busy && !list.error && list.items.length === 0 && <div className="assistant-session-empty"><MessagesSquare size={20} aria-hidden="true" /><p>{status === 'archived' ? '还没有已归档会话。' : '还没有会话，先新建一条。'}</p></div>}
        <ul>{list.items.map(item => <li key={item.id}><button type="button" className="assistant-session-item" aria-current={conversationId === item.id ? 'page' : undefined} onClick={() => select(item.id)}><strong>{item.displayTitle}</strong>{item.summary && <span>{item.summary}</span>}<small>{item.lastTurnAt ? formatDateTime(item.lastTurnAt) : '尚无消息'}</small></button></li>)}</ul>
        {list.cursor && <Button type="button" variant="ghost" disabled={list.busy} onClick={() => { void list.load(true); }}>加载更多会话</Button>}
        </>}
        </CardContent>
        </Card>
      </aside>
      {conversationId ? <ConversationPanel key={conversationId} teacherId={teacherId} conversationId={conversationId} transport={transport} messageState={messages[conversationId]} send={send} onArchive={() => { void list.load(); }} onWorkspaceRefresh={onWorkspaceRefresh} />
        : <Card className="assistant-welcome"><CardContent><span className="assistant-welcome-icon"><MessagesSquare size={26} /></span><div><span className="assistant-eyebrow">开始工作</span><h2>今天想先完成什么？</h2><p>新建一条会话，或选择已有会话接着处理。</p><p>已保存的记录和材料可以从原会话找回。</p></div><Button type="button" onClick={() => { void list.create().then(id => { if (id) { setStatus('active'); select(id); } }); }} disabled={list.creating}><MessageSquarePlus size={16} />{list.creating ? '正在新建…' : '新建会话'}</Button></CardContent></Card>}
    </div>
  </div></TooltipProvider>;
}
export function AssistantWorkspace(props: Props) { return <AccountWorkspace key={props.teacherId} {...props} />; }
