import { FormEvent, useState } from 'react';
import { PreviewActions } from './PreviewApp';
import { Schedule, today as fallbackToday } from './data';
import { scheduleObjectLabel, schedulesInRange } from './recurrence';
import { openScheduleDetails } from './ScheduleDetails';
import './today-columns.css';
import './redesign-business.css';
import { commitAction } from './action-result';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { WechatFeedbackInbox } from './WechatFeedbackInbox';

function ScheduleCard({ item, actions }: { item: Schedule; actions: PreviewActions }) {
  return <article className="today-course-row"><Button variant="ghost" className="today-course-open" aria-label={`查看 ${item.start} 至 ${item.end} ${scheduleObjectLabel(actions.data, item)} 排期详情`} onClick={() => openScheduleDetails(actions, item)}><dl>
    <div><dt>时间</dt><dd><time>{item.start}<br />{item.end}</time></dd></div>
    <div><dt>地点</dt><dd>{item.location || '待补充地点'}</dd></div>
    <div><dt>对象</dt><dd><b>{scheduleObjectLabel(actions.data, item)}</b></dd></div>
  </dl></Button></article>;
}

export function TodayPage({ actions }: { actions: PreviewActions }) {
  const today = actions.data.businessDate || fallbackToday;
  const [memo, setMemo] = useState('');
  const allSchedules = schedulesInRange(actions.data, today, today);
  const schedules = allSchedules.filter((item) => item.status !== '已取消');
  const pending = schedules.filter((item) => item.status === '已排期').length;
  const lowBalance = actions.data.students.filter((item) => item.balance <= 3).length;
  const monday = new Date(`${today}T12:00:00Z`); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const mondayIso = monday.toISOString().slice(0, 10);
  const weekDone = schedulesInRange(actions.data, mondayIso, today).filter((item) => item.status === '已完成').length;
  const addMemo = (event: FormEvent) => { event.preventDefault(); if (!memo.trim()) return; if (actions.saveMemo) return commitAction(actions, () => actions.saveMemo!(memo.trim()), () => setMemo('')); actions.setData((old) => ({ ...old, memos: [...old.memos, { id: `m-${Date.now()}`, text: memo.trim(), done: false }] })); setMemo(''); };
  const toggleMemo = (id: string) => actions.toggleMemo ? commitAction(actions, () => actions.toggleMemo!(id, !actions.data.memos.find((item) => item.id === id)?.done)) : actions.setData((old) => ({ ...old, memos: old.memos.map((item) => item.id === id ? { ...item, done: !item.done } : item) }));
  const readableToday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${today}T12:00:00+08:00`));
  const showPending = () => actions.setUi?.((old) => ({ ...old, 'schedule.status': '已排期', 'schedule.view': 'list', 'schedule.weekOffset': 0 }));
  const wechatPending = actions.connected ? null : actions.data.wechatFeedbacks?.filter((item) => item.status === '待核对' || item.status === '需补充').length || 0;
  const showWechatFeedback = () => document.getElementById('wechat-feedback-inbox')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return <section className="page preview-page today-page"><header className="today-page-header"><div><h1>今日工作台</h1><p>{readableToday} · 今天有 {schedules.length} 项排期</p></div><Button type="button" variant="outline" className="today-wechat-jump" onClick={showWechatFeedback}>微信反馈 · {wechatPending === null ? '暂未接入' : `${wechatPending} 项待核对`}</Button></header>
    <div className="stat-grid"><Card><CardContent><strong>{schedules.length}</strong><span>今日排期</span></CardContent></Card><Card><CardContent><strong className="coral">{pending}</strong><span>待完成排期</span></CardContent></Card><Card><CardContent><strong>{weekDone}</strong><span>本周已完成排期</span></CardContent></Card><Card><CardContent><strong className="amber">{lowBalance}</strong><span>余额预警学生</span></CardContent></Card></div>
    <div className="today-grid"><section><h2>今日排期</h2>
      {schedules.length === 0 && <Card className="white-card today-empty"><CardContent><p>今天没有待上或已完成的课程。</p><Button asChild variant="link"><a className="text-link" href="#/schedules">安排课程</a></Button></CardContent></Card>}
      {(['已排期', '已完成'] as const).map((status) => {
        const items = schedules.filter((item) => item.status === status);
        return items.length > 0 && <section className="today-course-group" key={status} aria-label={status === '已排期' ? '待上课程' : '已完成课程'}><h3>{status === '已排期' ? '待上课程' : '已完成课程'}<Badge variant="secondary">{items.length}</Badge></h3><Card className="white-card">{items.map((item) => <ScheduleCard key={item.id} item={item} actions={actions} />)}</Card></section>;
      })}
      {allSchedules.some((item) => item.status === '已取消') && <details className="today-cancelled"><summary>已取消课程 · {allSchedules.filter((item) => item.status === '已取消').length}</summary><Card className="white-card">{allSchedules.filter((item) => item.status === '已取消').map((item) => <ScheduleCard key={item.id} item={item} actions={actions} />)}</Card></details>}
    </section><div className="today-side"><section><div className="section-head"><h2>待完成</h2><Badge variant="secondary">{pending}</Badge></div><Card className="white-card"><CardContent><p className="muted">{pending ? `还有 ${pending} 节课待完成。` : '今天的课程已全部处理。'}</p><Button asChild variant="link"><a className="text-link" href="#/schedules" onClick={showPending}>查看并处理排期</a></Button></CardContent></Card></section><section><div className="section-head"><h2>备忘录</h2><Badge variant="secondary">{actions.data.memos.filter((item) => !item.done).length} 项</Badge></div><Card className="white-card memo-card"><CardContent>{actions.data.memos.map((item) => <label key={item.id} className={item.done ? 'memo done' : 'memo'}><input type="checkbox" checked={item.done} onChange={() => toggleMemo(item.id)} /> <span>{item.text}</span></label>)}<form className="memo-add" onSubmit={addMemo}><label className="sr-only" htmlFor="new-memo">添加备忘</label><Input id="new-memo" value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="添加备忘…" /><Button variant="outline" size="sm" disabled={!memo.trim()}>添加</Button></form></CardContent></Card></section></div></div>
    <WechatFeedbackInbox actions={actions} />
  </section>;
}
