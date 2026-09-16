import { useMemo } from 'react';
import type { RecurrenceRule, Schedule } from './data';
import { today as fallbackToday } from './data';
import type { PreviewActions } from './PreviewApp';
import { dateAdd, recurrenceConflict, scheduleObjectLabel, schedulesInRange } from './recurrence';
import { openScheduleDetails } from './ScheduleDetails';
import { NewScheduleForm, RuleEditor } from './ScheduleForm';
import { usePreviewState } from './ui-state';
import './schedule.css';
import { commitAction } from './action-result';
import { formatDate } from '../shared/date-format';

type StatusFilter = '全部' | Schedule['status'];
type ScheduleView = 'week' | 'list';

function mondayFor(value: string, offset: number) {
  return dateAdd(value, -((new Date(`${value}T12:00:00Z`).getUTCDay() + 6) % 7) + offset * 7);
}

function weekday(value: string) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${value}T12:00:00Z`).getUTCDay()];
}

function clockMinutes(value: string) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export function dateRangeLabel(start: string, end: string) {
  const [startYear, startMonth, startDay] = start.split('-').map(Number);
  const [endYear, endMonth, endDay] = end.split('-').map(Number);
  if (startYear === endYear && startMonth === endMonth) return `${startYear}年${startMonth}月${startDay}日—${endDay}日`;
  if (startYear === endYear) return `${startYear}年${startMonth}月${startDay}日—${endMonth}月${endDay}日`;
  return `${startYear}年${startMonth}月${startDay}日—${endYear}年${endMonth}月${endDay}日`;
}

export function weekTimeRange(schedules: Schedule[]) {
  const earliest = schedules.length ? Math.min(...schedules.map((item) => clockMinutes(item.start))) : 8 * 60;
  const latest = schedules.length ? Math.max(...schedules.map((item) => clockMinutes(item.end))) : 21 * 60;
  const firstHour = Math.max(0, Math.min(8, Math.floor(earliest / 60)));
  const lastHour = Math.min(24, Math.max(21, Math.ceil(latest / 60)));
  return { firstHour, lastHour, height: (lastHour - firstHour) * 68 };
}

export function scheduleGeometry(start: string, end: string, baseStart = 8) {
  const fromStart = clockMinutes(start) - baseStart * 60;
  const duration = clockMinutes(end) - clockMinutes(start);
  return { top: Math.max(0, fromStart) * 68 / 60, height: Math.max(2, duration * 68 / 60 - 3), compact: duration <= 30 };
}

function statusLabel(status: Schedule['status']) {
  return status === '已排期' ? '待上课' : status;
}

function statusClass(status: Schedule['status']) {
  return status === '已排期' ? 'scheduled' : status === '已完成' ? 'completed' : 'cancelled';
}

function WeekItem({ item, actions, baseStart }: { item: Schedule; actions: PreviewActions; baseStart: number }) {
  const geometry = scheduleGeometry(item.start, item.end, baseStart);
  const object = scheduleObjectLabel(actions.data, item);
  const location = item.location || '待补充地点';
  return <button type="button" className={`week-item ${geometry.compact ? 'compact' : ''} status-${statusClass(item.status)}`} style={{ top: geometry.top, height: geometry.height }} onClick={() => openScheduleDetails(actions, item)} aria-label={`查看 ${item.start} 至 ${item.end} ${object} ${location} ${statusLabel(item.status)} 排期详情`}><b>{item.start}–{item.end}</b>{!geometry.compact && <><span className="week-object">{object}</span><span>{location}</span></>}<small className="schedule-status">{statusLabel(item.status)}</small></button>;
}

function WeekCalendar({ actions, days, schedules }: { actions: PreviewActions; days: string[]; schedules: Schedule[] }) {
  const today = actions.data.businessDate || fallbackToday;
  const range = weekTimeRange(schedules);
  return <div className="week-scroll"><div className="week-frame"><div className="week-head"><div className="week-corner">时间</div>{days.map((day) => <div className={day === today ? 'week-day is-today' : 'week-day'} key={day}>{weekday(day)}<strong>{Number(day.slice(8))}</strong>{day === today && <small>今天</small>}</div>)}</div><div className="week-body"><div className="week-times" style={{ height: range.height }}>{Array.from({ length: range.lastHour - range.firstHour + 1 }, (_, index) => <span key={index} style={{ top: `${index * 68}px` }}>{String(range.firstHour + index).padStart(2, '0')}:00</span>)}</div>{days.map((day) => <div className={day === today ? 'week-column is-today' : 'week-column'} style={{ height: range.height }} key={day}>{schedules.filter((item) => item.day === day).map((item) => <WeekItem key={item.id} item={item} actions={actions} baseStart={range.firstHour} />)}</div>)}</div></div></div>;
}

function ShortScheduleList({ actions, schedules }: { actions: PreviewActions; schedules: Schedule[] }) {
  const short = schedules.filter((item) => scheduleGeometry(item.start, item.end).compact);
  if (!short.length) return null;
  return <section className="short-schedule-list"><h2>短时课程</h2>{short.map((item) => <button key={item.id} className={`short-schedule-card status-${statusClass(item.status)}`} onClick={() => openScheduleDetails(actions, item)} aria-label={`查看 ${item.start} 至 ${item.end} ${scheduleObjectLabel(actions.data, item)} ${item.location || '待补充地点'} ${statusLabel(item.status)} 排期详情`}><dl><div><dt>时间</dt><dd>{formatDate(item.day)} {item.start}–{item.end}</dd></div><div><dt>地点</dt><dd>{item.location || '待补充'}</dd></div><div><dt>对象</dt><dd>{scheduleObjectLabel(actions.data, item)}</dd></div></dl><span className="schedule-status">{statusLabel(item.status)}</span></button>)}</section>;
}

function ScheduleList({ actions, schedules }: { actions: PreviewActions; schedules: Schedule[] }) {
  if (!schedules.length) return <p className="empty schedule-empty">这个范围没有符合筛选条件的课程。</p>;
  return <div className="schedule-list">{schedules.map((item) => <button className={`schedule-list-card status-${statusClass(item.status)}`} key={item.id} onClick={() => openScheduleDetails(actions, item)} aria-label={`查看 ${formatDate(item.day)} ${item.start} 至 ${item.end} ${scheduleObjectLabel(actions.data, item)} ${item.location || '待补充地点'} ${statusLabel(item.status)} 排期详情`}><dl><div><dt>时间</dt><dd>{formatDate(item.day)}<br /><time>{item.start}–{item.end}</time></dd></div><div><dt>地点</dt><dd>{item.location || '待补充'}</dd></div><div><dt>对象</dt><dd>{scheduleObjectLabel(actions.data, item)}</dd></div></dl><span className="schedule-status">{statusLabel(item.status)}</span><span className="schedule-list-action" aria-hidden="true">查看详情 ›</span></button>)}</div>;
}

function ruleObject(actions: PreviewActions, rule: RecurrenceRule) {
  if (rule.format === '小班') return `小班 · ${rule.participants.length} 人`;
  return actions.data.students.find((student) => student.id === rule.participants[0])?.name || '待补充参与人';
}

function ruleDays(rule: RecurrenceRule) {
  return rule.weekdays.map((day) => ['一', '二', '三', '四', '五', '六', '日'][day - 1]).join('、');
}

function openRuleEditor(actions: PreviewActions, rule: RecurrenceRule) {
  actions.open('编辑重复规则', <RuleEditor actions={actions} rule={rule} />);
}

function RuleDetails({ actions, rule }: { actions: PreviewActions; rule: RecurrenceRule }) {
  const today = actions.data.businessDate || fallbackToday;
  const ended = Boolean(rule.endDate && rule.endDate < today);
  const setEnabled = () => {
    if (!rule.enabled && recurrenceConflict(actions.data, { ...rule, enabled: true }, rule.id)) {
      actions.toast('启用会与未来排期冲突，规则仍保持暂停。', 'warn');
      return;
    }
    commitAction(actions, () => actions.setRuleEnabled(rule.id, !rule.enabled), () => { actions.close(); actions.toast(rule.enabled ? '已暂停自动排期；单次调整及历史记录保留。' : '已启用自动排期'); });
  };
  const people = rule.participants.map((id) => actions.data.students.find((student) => student.id === id)?.name || '待补充').join('、');
  return <><dl className="schedule-detail"><div><dt>状态</dt><dd>{ended ? '已结束' : rule.enabled ? '已启用' : '已暂停'}</dd></div><div><dt>重复日期</dt><dd>每周 {ruleDays(rule)}</dd></div><div><dt>开始与结束</dt><dd>{formatDate(rule.startDate)} 起{rule.endDate ? `，至 ${formatDate(rule.endDate)}` : '，无结束日期'}</dd></div><div><dt>时间</dt><dd>{rule.start}–{rule.end}</dd></div><div><dt>地点</dt><dd>{rule.location || '待补充'}</dd></div><div><dt>{rule.format === '小班' ? '名单' : '参与人'}</dt><dd>{people}</dd></div><div><dt>形式</dt><dd>{rule.format}</dd></div><div><dt>备注</dt><dd>{rule.note || '暂无备注'}</dd></div></dl>{ended ? <p className="dialog-copy">该规则已结束，仅保留查看，不会修改历史排期。</p> : <div className="dialog-actions"><button className="button secondary" onClick={() => openRuleEditor(actions, rule)}>编辑规则</button><button className="button primary" onClick={setEnabled}>{rule.enabled ? '暂停自动排期' : '启用自动排期'}</button></div>}</>;
}

function RuleList({ actions }: { actions: PreviewActions }) {
  const today = actions.data.businessDate || fallbackToday;
  if (!actions.data.recurrenceRules.length) return null;
  const openDetails = (rule: RecurrenceRule) => actions.open('重复规则详情', <RuleDetails actions={actions} rule={rule} />);
  const toggle = (rule: RecurrenceRule) => {
    if (!rule.enabled && recurrenceConflict(actions.data, { ...rule, enabled: true }, rule.id)) {
      actions.toast('启用会与未来排期冲突，规则仍保持暂停。', 'warn');
      return;
    }
    commitAction(actions, () => actions.setRuleEnabled(rule.id, !rule.enabled), () => actions.toast(rule.enabled ? '已暂停自动排期；单次调整及历史记录保留。' : '已启用自动排期'));
  };
  return <section className="recurrence-rules"><h2>重复规则</h2>{actions.data.recurrenceRules.map((rule) => {
    const ended = Boolean(rule.endDate && rule.endDate < today);
    return <article className="white-card" key={rule.id}><button className="rule-summary" onClick={() => openDetails(rule)}><b>{ended ? '已结束' : rule.enabled ? '已启用' : '已暂停'} · 每周 {ruleDays(rule)}</b><span>{rule.start}–{rule.end} · {ruleObject(actions, rule)} · {rule.location || '待补充'}</span><small>{formatDate(rule.startDate)} 起{rule.endDate ? `，至 ${formatDate(rule.endDate)}` : '，无结束日期'}</small></button><div className="rule-actions"><button className="button secondary small" onClick={() => openDetails(rule)}>详情</button><button className="button secondary small" disabled={ended} onClick={() => toggle(rule)}>{ended ? '规则已结束' : rule.enabled ? '暂停规则' : '启用规则'}</button></div></article>;
  })}</section>;
}

function initialView(): ScheduleView {
  return typeof window !== 'undefined' && window.matchMedia?.('(max-width: 720px)').matches ? 'list' : 'week';
}

export function SchedulesPage({ actions }: { actions: PreviewActions }) {
  const today = actions.data.businessDate || fallbackToday;
  const [weekOffset, setWeekOffset] = usePreviewState(actions, 'schedule.weekOffset', 0);
  const [view, setView] = usePreviewState<ScheduleView>(actions, 'schedule.view', initialView());
  const [status, setStatus] = usePreviewState<StatusFilter>(actions, 'schedule.status', '全部');
  const start = mondayFor(today, weekOffset);
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => dateAdd(start, index)), [start]);
  const schedules = schedulesInRange(actions.data, days[0], days[6]);
  const visibleSchedules = status === '全部' ? schedules : schedules.filter((item) => item.status === status);
  const statusOptions: StatusFilter[] = ['全部', '已排期', '已完成', '已取消'];
  return <section className="page preview-page"><header className="page-header"><div><h1>日程安排</h1><p>{dateRangeLabel(days[0], days[6])}</p></div><div className="schedule-head-actions"><div className="schedule-toolbar"><button className="button secondary small" onClick={() => setWeekOffset(weekOffset - 1)}>‹ 上一周</button><button className="button secondary small" onClick={() => setWeekOffset(0)}>本周</button><button className="button secondary small" onClick={() => setWeekOffset(weekOffset + 1)}>下一周 ›</button></div><div className="view-toggle" aria-label="排期视图"><button className={view === 'week' ? 'active' : ''} onClick={() => setView('week')}>周历</button><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>列表</button></div><button className="button primary" onClick={() => actions.open('新增排期', <NewScheduleForm actions={actions} initialDay={days.includes(today) ? today : days[0]} />)}>+ 新增排期</button></div></header><div className="status-filter" aria-label="排期状态">{statusOptions.map((option) => <button key={option} className={status === option ? 'active' : ''} onClick={() => setStatus(option)}>{option === '已排期' ? '待上课' : option}</button>)}</div>{view === 'week' ? <><ShortScheduleList actions={actions} schedules={visibleSchedules} /><WeekCalendar actions={actions} days={days} schedules={visibleSchedules} /></> : <ScheduleList actions={actions} schedules={visibleSchedules} />}<RuleList actions={actions} /></section>;
}
