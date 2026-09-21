import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Dialog } from './Chrome';
import type { PreviewActions } from './PreviewApp';
import type { WechatFeedback, WechatFeedbackStatus } from './wechat-feedback';
import './WechatFeedbackInbox.css';

type StatusFilter = '全部' | WechatFeedbackStatus;

function formatReceivedAt(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function statusVariant(status: WechatFeedbackStatus) {
  if (status === '失败' || status === '已拒绝') return 'destructive' as const;
  if (status === '已记录') return 'secondary' as const;
  return 'outline' as const;
}

function studentLabel(actions: PreviewActions, item: WechatFeedback) {
  if (item.studentId) return actions.data.students.find((student) => student.id === item.studentId)?.name || '已归属学生不可用';
  return item.providedStudentName ? `${item.providedStudentName}（待确认）` : '未识别学生';
}

function updateDemoItem(actions: PreviewActions, id: string, patch: Partial<WechatFeedback>) {
  if (actions.connected) return;
  actions.setData((old) => ({
    ...old,
    wechatFeedbacks: (old.wechatFeedbacks || []).map((item) => item.id === id ? { ...item, ...patch } : item),
  }));
}

function FeedbackRow({ actions, item, onOpen }: { actions: PreviewActions; item: WechatFeedback; onOpen: (id: string) => void }) {
  return <article className="wechat-feedback-row">
    <div className="wechat-feedback-row-main">
      <div className="wechat-feedback-row-title"><strong>{studentLabel(actions, item)}</strong><Badge variant={statusVariant(item.status)}>{item.status}</Badge></div>
      <p>{item.summary}</p>
      <div className="wechat-feedback-row-meta"><span>来源：微信教师私聊</span><span>{item.senderLabel}</span><time dateTime={item.receivedAt}>{formatReceivedAt(item.receivedAt)}</time></div>
    </div>
    <Button variant="outline" size="sm" onClick={() => onOpen(item.id)}>{item.status === '失败' ? '查看处理说明' : item.status === '已记录' ? '查看记录详情' : '核对详情'}</Button>
  </article>;
}

export function WechatFeedbackInbox({ actions }: { actions: PreviewActions }) {
  const [filter, setFilter] = useState<StatusFilter>('全部');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [recordDraft, setRecordDraft] = useState('');
  const isDemo = !actions.connected;
  const items = actions.data.wechatFeedbacks;
  const selected = items?.find((item) => item.id === selectedId) || null;
  const pendingCount = items?.filter((item) => item.status === '待核对' || item.status === '需补充').length || 0;
  const visibleItems = useMemo(() => (items || []).filter((item) => filter === '全部' || item.status === filter), [filter, items]);

  const openDetail = (id: string) => {
    const item = items?.find((candidate) => candidate.id === id);
    if (!item) return;
    setSelectedId(id);
    setSelectedStudentId(item.studentId || '');
    setRecordDraft(item.proposedRecord || '');
  };
  const closeDetail = () => setSelectedId(null);
  useEffect(() => {
    if (!selected) return;
    setSelectedStudentId(selected.studentId || '');
    setRecordDraft(selected.proposedRecord || '');
  }, [selected?.id]);

  if (actions.connected) {
    return <section className="wechat-feedback-inbox" id="wechat-feedback-inbox" aria-labelledby="wechat-feedback-title"><div className="wechat-feedback-heading"><div><p className="wechat-feedback-eyebrow">来自微信</p><h2 id="wechat-feedback-title">微信学生反馈</h2></div><Badge variant="outline">通道尚未接入</Badge></div><Card className="wechat-feedback-unavailable"><CardContent><p>微信学生反馈通道尚未接入当前工作台，暂无法读取或核对消息。</p><small>你仍可查看已有待核对材料；微信连接后收到的学生情况将在这里展示。</small><div className="wechat-feedback-unavailable-actions"><Button asChild variant="outline" size="sm"><a href="#/settings/wechat">查看微信连接</a></Button><Button asChild variant="outline" size="sm"><a href="#/captures">查看已有待核对材料</a></Button></div></CardContent></Card></section>;
  }

  return <section className="wechat-feedback-inbox" id="wechat-feedback-inbox" aria-labelledby="wechat-feedback-title">
    <div className="wechat-feedback-heading"><div><p className="wechat-feedback-eyebrow">来自微信</p><h2 id="wechat-feedback-title">微信学生反馈</h2><p>教师在微信私聊中转述或录入的学生相关消息需要先核对，和“家长反馈草稿”分开处理。</p></div><Badge variant="secondary">{pendingCount} 项待核对</Badge></div>
    {isDemo && <p className="wechat-feedback-demo-note" role="status">合成演示：确认只更新当前页面内存，不会保存真实档案、扣课时或发送微信回复。</p>}
    <div className="wechat-feedback-filter" aria-label="微信反馈状态筛选">{(['全部', '待核对', '已记录', '需补充', '已拒绝', '失败'] as const).map((status) => <Button key={status} variant="ghost" size="sm" className={filter === status ? 'is-active' : ''} onClick={() => setFilter(status)}>{status}</Button>)}</div>
    <Card className="wechat-feedback-list"><CardContent>{visibleItems.length ? visibleItems.map((item) => <FeedbackRow key={item.id} actions={actions} item={item} onOpen={openDetail} />) : <p className="empty">没有符合当前筛选条件的微信反馈。</p>}</CardContent></Card>
    {selected && <WechatFeedbackDialog actions={actions} item={selected} studentId={selectedStudentId} onStudentIdChange={setSelectedStudentId} recordDraft={recordDraft} onRecordDraftChange={setRecordDraft} onClose={closeDetail} />}
  </section>;
}

function WechatFeedbackDialog({ actions, item, studentId, onStudentIdChange, recordDraft, onRecordDraftChange, onClose }: {
  actions: PreviewActions; item: WechatFeedback; studentId: string; onStudentIdChange: (value: string) => void;
  recordDraft: string; onRecordDraftChange: (value: string) => void; onClose: () => void;
}) {
  const isDemo = !actions.connected;
  const hasValidStudent = actions.data.students.some((student) => student.id === studentId);
  const canConfirm = isDemo && item.status !== '已记录' && item.status !== '已拒绝' && item.status !== '失败' && hasValidStudent && Boolean(recordDraft.trim());
  const confirm = () => {
    if (!canConfirm) return;
    updateDemoItem(actions, item.id, { status: '已记录', summary: recordDraft.trim(), studentId, assignment: '已匹配学生', proposedRecord: recordDraft.trim(), recordState: '演示已记录', replyState: '未发送', reviewNote: '已在当前页面演示中确认；未同步真实学生档案。' });
    actions.toast('已标记为已记录（仅当前演示）');
    onClose();
  };
  const hold = () => {
    if (!isDemo || item.status === '已记录' || item.status === '已拒绝') return;
    updateDemoItem(actions, item.id, { status: '需补充', studentId: studentId || undefined, assignment: studentId ? '已匹配学生' : '待人工确认', proposedRecord: recordDraft, recordState: '未保存', reviewNote: '已暂留，等待教师补充或再次核对。' });
    actions.toast('已暂留（仅当前演示）');
    onClose();
  };
  const reject = () => {
    if (!isDemo || item.status === '已记录' || item.status === '已拒绝') return;
    updateDemoItem(actions, item.id, { status: '已拒绝', recordState: '无需保存', reviewNote: '教师在演示中拒绝归档；消息未写入学生档案。' });
    actions.toast('已拒绝归档（仅当前演示）');
    onClose();
  };
  const retry = () => {
    if (!isDemo || item.status !== '失败') return;
    updateDemoItem(actions, item.id, { status: '待核对', retryRequested: true, summary: '已提出演示重试，仍需人工核对，尚未形成学生记录。', recordState: '未保存', replyState: '未回复' });
    actions.toast('已提出演示重试，尚未自动成功');
    onClose();
  };

  return <Dialog title="核对微信学生反馈" onClose={onClose}><div className="wechat-feedback-dialog">
    <p className="wechat-feedback-demo-note">{isDemo ? '合成演示：下列确认不会写入真实档案，也不会向微信发送回复。' : '当前通道仅支持查看，尚未接入保存或回复操作。'}</p>
    <section><h3>收到的原话</h3><blockquote>{item.rawText}</blockquote><p className="wechat-feedback-source">来源：微信教师私聊 · {item.senderLabel} · 收到时间：{formatReceivedAt(item.receivedAt)}</p></section>
    <section className="wechat-feedback-proposal"><h3>归属与拟记录</h3><label>归属学生<select aria-label="归属学生" value={studentId} disabled={!isDemo || item.status === '已记录'} onChange={(event) => onStudentIdChange(event.target.value)}><option value="">请人工选择学生</option>{actions.data.students.map((student) => <option key={student.id} value={student.id}>{student.name} · {student.grade}</option>)}</select></label>{!studentId && <p className="wechat-feedback-warning">尚未确认学生，不能归档；系统不会按相似称呼自动匹配。</p>}<label>拟写入记录<Textarea aria-label="拟写入记录" value={recordDraft} disabled={!isDemo || item.status === '已记录'} onChange={(event) => onRecordDraftChange(event.target.value)} placeholder="补充需要归档的教学记录…" /></label></section>
    <section className="wechat-feedback-outcomes"><div><span>记录保存</span><strong>{item.recordState}</strong><small>{item.status === '已记录' ? '仅合成演示状态，未同步真实学生档案。' : '尚未写入任何学生档案。'}</small></div><div><span>微信回复</span><strong>{item.replyState}</strong><small>本轮未接入微信回复，不会自动发送任何消息。</small></div></section>
    {item.failureReason && <p className="wechat-feedback-error" role="alert">{item.failureReason}</p>}
    {item.reviewNote && <p className="wechat-feedback-review">{item.reviewNote}</p>}
    <div className="dialog-actions">{item.status === '失败' ? <Button variant="outline" onClick={retry} disabled={!isDemo}>演示重试</Button> : item.status === '已记录' ? <Button variant="outline" onClick={onClose}>关闭</Button> : item.status === '已拒绝' ? <><Button variant="outline" onClick={() => updateDemoItem(actions, item.id, { status: '需补充', recordState: '未保存', reviewNote: '教师明确要求再次核对；仍未写入学生档案。' })} disabled={!isDemo}>重新核对</Button><Button variant="outline" onClick={onClose}>关闭</Button></> : <><Button variant="outline" onClick={reject} disabled={!isDemo}>拒绝归档</Button><Button variant="outline" onClick={hold} disabled={!isDemo}>暂留</Button><Button onClick={confirm} disabled={!canConfirm}>确认并标记已记录</Button></>}</div>
  </div></Dialog>;
}
