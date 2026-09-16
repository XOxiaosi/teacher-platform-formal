import { FormEvent, useEffect, useRef, useState } from 'react';
import type { RecurrenceRule, Schedule } from './data';
import { today as fallbackToday } from './data';
import { commitAction } from './action-result';
import { Confirm, type PreviewActions } from './PreviewApp';
import { changeSummary, isoWeekday, recurrenceConflict, scheduleConflict, schedulesInRange } from './recurrence';
import { replaceRuleFrom as replaceRuleFromMutation } from './schedule-mutations';
import { formatDate } from '../shared/date-format';

const weekdays = [[1, '周一'], [2, '周二'], [3, '周三'], [4, '周四'], [5, '周五'], [6, '周六'], [7, '周日']] as const;
type Scope = 'this' | 'future';

function FormError({ message }: { message: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (message) ref.current?.scrollIntoView?.({ block: 'nearest' }); }, [message]);
  return message ? <p ref={ref} className="form-error" role="alert">{message}</p> : null;
}

export function initialRuleEnd(repeatDraft?: { end: string }, sourceEnd?: string) {
  return repeatDraft?.end ?? sourceEnd ?? '';
}

function validateFields(schedule: Schedule) {
  if (!schedule.location.trim()) return '地点不能为空。';
  if (schedule.end <= schedule.start) return '结束时间必须晚于开始时间。';
  if (schedule.format === '一对一' && schedule.participants.length !== 1) return '一对一需选择 1 位参与人。';
  if (schedule.format === '小班' && schedule.participants.length < 2) return '小班至少选择 2 位参与人。';
  return '';
}

function validateSchedule(actions: PreviewActions, schedule: Schedule) {
  return validateFields(schedule)
    || (scheduleConflict(schedulesInRange(actions.data, schedule.day, schedule.day), schedule) ? '该时段与现有排期冲突，请调整时间。' : '');
}

function ParticipantPicker({ value, set, actions }: {
  value: Schedule;
  set: <K extends keyof Schedule>(key: K, next: Schedule[K]) => void;
  actions: PreviewActions;
}) {
  const chooseFormat = (format: Schedule['format']) => {
    set('format', format);
    if (format === '一对一' && value.participants.length > 1) set('participants', value.participants.slice(0, 1));
  };
  const togglePerson = (id: string) => set('participants', value.participants.includes(id)
    ? value.participants.filter((person) => person !== id)
    : [...value.participants, id]);
  return <>
    <label>形式<select value={value.format} onChange={(event) => chooseFormat(event.target.value as Schedule['format'])}><option>一对一</option><option>小班</option></select></label>
    {value.format === '一对一'
      ? <label>参与人<select value={value.participants[0] || ''} onChange={(event) => set('participants', event.target.value ? [event.target.value] : [])} required><option value="">请选择</option>{actions.data.students.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}</select></label>
      : <fieldset className="participant-picker"><legend>参与人（至少选择 2 位）</legend>{actions.data.students.map((student) => <label key={student.id}><input type="checkbox" checked={value.participants.includes(student.id)} onChange={() => togglePerson(student.id)} />{student.name}</label>)}</fieldset>}
  </>;
}

function Fields({ value, set, actions, includeDay = true }: {
  value: Schedule;
  set: <K extends keyof Schedule>(key: K, next: Schedule[K]) => void;
  actions: PreviewActions;
  includeDay?: boolean;
}) {
  return <div className="form-grid">
    {includeDay && <label>日期<input type="date" value={value.day} onInput={(event) => set('day', event.currentTarget.value)} onChange={(event) => set('day', event.target.value)} required /></label>}
    <label>开始时间<input type="time" value={value.start} onInput={(event) => set('start', event.currentTarget.value)} onChange={(event) => set('start', event.target.value)} required /></label>
    <label>结束时间<input type="time" value={value.end} onInput={(event) => set('end', event.currentTarget.value)} onChange={(event) => set('end', event.target.value)} required /></label>
    <label>地点<input value={value.location} onChange={(event) => set('location', event.target.value)} required /></label>
    <ParticipantPicker value={value} set={set} actions={actions} />
  </div>;
}

function values(actions: PreviewActions, item: Schedule) {
  const people = item.participants.map((id) => actions.data.students.find((student) => student.id === id)?.name || '待补充').join('、');
  return <>{formatDate(item.day)} {item.start}–{item.end}<br />地点：{item.location}<br />参与人：{people}<br />形式：{item.format}<br />备注：{item.note || '暂无备注'}</>;
}

function ConfirmEdit({ before, after, scope, actions, onConfirm, onBack, repeat }: {
  before: Schedule;
  after: Schedule;
  scope: Scope;
  actions: PreviewActions;
  onConfirm: () => void;
  onBack: () => void;
  repeat?: { beforeDays: number[]; afterDays: number[]; beforeEnd?: string; afterEnd?: string };
}) {
  const summary = changeSummary(before, after, scope);
  const days = (items: number[]) => items.map((day) => ['一', '二', '三', '四', '五', '六', '日'][day - 1]).join('、') || '未选择';
  const completed = before.status === '已完成';
  return <><p className="dialog-copy">{completed ? '确认后不会重新扣课；原扣课记录保留。' : '请确认课程编辑范围。'}</p><dl className="schedule-detail"><div><dt>旧值</dt><dd>{values(actions, before)}{repeat && <><br />重复：每周 {days(repeat.beforeDays)} · {repeat.beforeEnd ? `至 ${formatDate(repeat.beforeEnd)}` : '无结束日期'}</>}</dd></div><div><dt>新值</dt><dd>{values(actions, after)}{repeat && <><br />重复：每周 {days(repeat.afterDays)} · {repeat.afterEnd ? `至 ${formatDate(repeat.afterEnd)}` : '无结束日期'}</>}</dd></div><div><dt>作用范围</dt><dd>{completed ? '仅本次' : summary.scope}</dd></div></dl><div className="dialog-actions"><button className="button secondary" onClick={onBack}>返回修改</button><button className="button primary" onClick={onConfirm}>确认{completed ? '保存' : `${summary.scope}修改`}</button></div></>;
}

export function openScheduleEditor(actions: PreviewActions, schedule: Schedule, scope: Scope = 'this') {
  actions.open(scope === 'future' ? '编辑本次及以后重复排期' : '编辑本次排期', <EditScheduleForm actions={actions} schedule={schedule} scope={scope} />);
}

export function EditScheduleForm({ actions, schedule, scope, draft, repeatDraft }: {
  actions: PreviewActions;
  schedule: Schedule;
  scope: Scope;
  draft?: Schedule;
  repeatDraft?: { days: number[]; end: string };
}) {
  const today = actions.data.businessDate || fallbackToday;
  const [form, setForm] = useState<Schedule>({ ...(draft || schedule), participants: [...(draft || schedule).participants] });
  const sourceRule = schedule.recurrenceRuleId ? actions.data.recurrenceRules.find((rule) => rule.id === schedule.recurrenceRuleId) : undefined;
  const [ruleDays, setRuleDays] = useState(repeatDraft?.days || sourceRule?.weekdays || [] as number[]);
  const [ruleEnd, setRuleEnd] = useState(initialRuleEnd(repeatDraft, sourceRule?.endDate));
  const [error, setError] = useState('');
  const set = <K extends keyof Schedule>(key: K, value: Schedule[K]) => setForm((old) => ({ ...old, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = { ...form, location: form.location.trim(), note: form.note.trim() };
    if (schedule.status === '已完成') {
      const validation = validateSchedule(actions, next);
      if (validation) return setError(validation);
      return actions.open('确认编辑已完成课程', <ConfirmEdit before={schedule} after={next} scope="this" actions={actions} onBack={() => actions.open('编辑已完成课程', <EditScheduleForm actions={actions} schedule={schedule} scope="this" draft={next} />)} onConfirm={() => commitAction(actions, () => actions.editCompletedSchedule?.(schedule, next), () => { actions.close(); actions.toast('已保存课程修订；未重新扣课。'); })} />);
    }
    const validation = scope === 'future' ? validateFields(next) : validateSchedule(actions, next);
    if (validation) return setError(validation);
    if (scope === 'future' && sourceRule) {
      if (next.day < today) return setError('本次及以后的修改日期不能早于今天。');
      if (!ruleDays.length) return setError('每周重复请至少选择一个星期。');
      if (ruleEnd && ruleEnd < next.day) return setError('结束日期不能早于新的开始日期。');
      if (!ruleDays.includes(isoWeekday(next.day))) return setError('修改后的日期须包含在重复星期中，请调整日期或重复星期。');
    }
    const repeat = scope === 'future' && sourceRule ? { beforeDays: sourceRule.weekdays, afterDays: ruleDays, beforeEnd: sourceRule.endDate, afterEnd: ruleEnd || undefined } : undefined;
    actions.open('确认课程编辑', <ConfirmEdit before={schedule} after={next} scope={scope} actions={actions} repeat={repeat} onBack={() => actions.open(scope === 'future' ? '编辑本次及以后重复排期' : '编辑本次排期', <EditScheduleForm actions={actions} schedule={schedule} scope={scope} draft={next} repeatDraft={{ days: ruleDays, end: ruleEnd }} />)} onConfirm={() => {
      if (scope === 'future' && schedule.recurrenceRuleId) {
        const old = actions.data.recurrenceRules.find((rule) => rule.id === schedule.recurrenceRuleId);
        if (!old) return;
        const replacement: RecurrenceRule = { ...old, id: `rr-${Date.now()}`, startDate: next.day, endDate: ruleEnd || undefined, weekdays: ruleDays, start: next.start, end: next.end, location: next.location, participants: next.participants, format: next.format, note: next.note, enabled: true };
        const proposed = replaceRuleFromMutation(actions.data, old.id, schedule.recurrenceDay || schedule.day, replacement);
        if (recurrenceConflict(proposed, replacement, replacement.id)) { actions.toast('该修改会与未来排期冲突，未保存。', 'warn'); actions.open('编辑本次及以后重复排期', <EditScheduleForm actions={actions} schedule={schedule} scope="future" draft={next} repeatDraft={{ days: ruleDays, end: ruleEnd }} />); return; }
        commitAction(actions, () => actions.replaceRuleFrom(old.id, schedule.recurrenceDay || schedule.day, replacement), () => { actions.close(); actions.toast('已修改本次及以后的重复规则'); });
      } else commitAction(actions, () => actions.saveSchedule(next), () => { actions.close(); actions.toast('已保存课程修改'); });
    }} />);
  };
  return <form onSubmit={submit} className="schedule-form"><Fields value={form} set={set} actions={actions} />{scope === 'future' && schedule.status !== '已完成' && <WeekdayPicker days={ruleDays} setDays={setRuleDays} end={ruleEnd} setEnd={setRuleEnd} min={form.day} legend="本次及以后每周哪几天" />}<label>备注<textarea value={form.note} onChange={(event) => set('note', event.target.value)} /></label><FormError message={error} /><div className="dialog-actions"><button type="button" className="button secondary" onClick={actions.close}>取消</button><button className="button primary">查看修改确认</button></div></form>;
}

function WeekdayPicker({ days, setDays, end, setEnd, min, legend = '每周哪几天' }: { days: number[]; setDays: (next: number[]) => void; end: string; setEnd: (next: string) => void; min: string; legend?: string }) {
  const toggle = (day: number) => setDays(days.includes(day) ? days.filter((item) => item !== day) : [...days, day]);
  return <fieldset className="weekday-picker"><legend>{legend}</legend>{weekdays.map(([day, label]) => <label key={day}><input type="checkbox" checked={days.includes(day)} onChange={() => toggle(day)} />{label}</label>)}<label>可选结束日期<input type="date" value={end} min={min} onInput={(event) => setEnd(event.currentTarget.value)} onChange={(event) => setEnd(event.target.value)} /></label></fieldset>;
}

export function NewScheduleForm({ actions, initialStudentId, initialDay }: { actions: PreviewActions; initialStudentId?: string; initialDay?: string }) {
  const today = actions.data.businessDate || fallbackToday;
  const [kind, setKind] = useState<'once' | 'weekly'>('once');
  const [form, setForm] = useState<Schedule>({ id: `sc-${Date.now()}`, day: initialDay || today, start: '10:00', end: '11:00', location: '', participants: initialStudentId ? [initialStudentId] : [], format: '一对一', note: '', status: '已排期' });
  const [repeat, setRepeat] = useState({ weekdays: [] as number[], endDate: '' });
  const [error, setError] = useState('');
  const set = <K extends keyof Schedule>(key: K, value: Schedule[K]) => setForm((old) => ({ ...old, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = { ...form, location: form.location.trim(), note: form.note.trim() };
    const fieldsError = validateFields(next);
    if (fieldsError) return setError(fieldsError);
    if (kind === 'once') {
      if (scheduleConflict(schedulesInRange(actions.data, next.day, next.day), next)) return setError('该时段与现有排期冲突，请调整时间。');
      return commitAction(actions, () => actions.saveSchedule(next), () => { actions.close(); actions.toast('排期已保存'); });
    }
    if (!repeat.weekdays.length) return setError('每周重复请至少选择一个星期。');
    if (repeat.endDate && repeat.endDate < next.day) return setError('结束日期不能早于开始日期。');
    const rule: RecurrenceRule = { id: `rr-${Date.now()}`, startDate: next.day, endDate: repeat.endDate || undefined, weekdays: repeat.weekdays, enabled: true, start: next.start, end: next.end, location: next.location, participants: next.participants, format: next.format, note: next.note };
    if (recurrenceConflict(actions.data, rule)) return setError('该重复规则会与未来排期发生时间冲突；请调整后再保存。');
    commitAction(actions, () => actions.saveRule(rule), () => { actions.close(); actions.toast('每周重复排期已保存。'); });
  };
  return <form onSubmit={submit} className="schedule-form"><fieldset className="recurrence-kind"><legend>排期方式</legend><label><input type="radio" checked={kind === 'once'} onChange={() => setKind('once')} />仅一次</label><label><input type="radio" checked={kind === 'weekly'} onChange={() => setKind('weekly')} />每周重复</label></fieldset><Fields value={form} set={set} actions={actions} />{kind === 'weekly' && <WeekdayPicker days={repeat.weekdays} setDays={(weekdays) => setRepeat((old) => ({ ...old, weekdays }))} end={repeat.endDate} setEnd={(endDate) => setRepeat((old) => ({ ...old, endDate }))} min={form.day} />}<label>备注<textarea value={form.note} onChange={(event) => set('note', event.target.value)} /></label><FormError message={error} /><div className="dialog-actions"><button type="button" className="button secondary" onClick={actions.close}>取消</button><button className="button primary">保存排期</button></div></form>;
}

function ruleSchedule(rule: RecurrenceRule): Schedule {
  return { id: rule.id, day: rule.startDate, start: rule.start, end: rule.end, location: rule.location, participants: rule.participants, format: rule.format, note: rule.note, status: '已排期' };
}

function RuleChangeConfirm({ actions, before, after, effectiveDate, onBack, onConfirm }: { actions: PreviewActions; before: RecurrenceRule; after: RecurrenceRule; effectiveDate: string; onBack: () => void; onConfirm: () => void }) {
  const days = (items: number[]) => items.map((day) => ['一', '二', '三', '四', '五', '六', '日'][day - 1]).join('、') || '未选择';
  return <><p className="dialog-copy">确认后从 {formatDate(effectiveDate)} 起使用新规则；此前自动排期、单次调整和历史记录保留。</p><dl className="schedule-detail"><div><dt>旧规则</dt><dd>{values(actions, ruleSchedule(before))}<br />重复：每周 {days(before.weekdays)} · {before.endDate ? `至 ${formatDate(before.endDate)}` : '无结束日期'}</dd></div><div><dt>新规则</dt><dd>{values(actions, ruleSchedule(after))}<br />重复：每周 {days(after.weekdays)} · {after.endDate ? `至 ${formatDate(after.endDate)}` : '无结束日期'}</dd></div><div><dt>生效日期</dt><dd>{formatDate(effectiveDate)}</dd></div></dl><div className="dialog-actions"><button className="button secondary" onClick={onBack}>返回修改</button><button className="button primary" onClick={onConfirm}>确认更新</button></div></>;
}

export function RuleEditor({ actions, rule, draft, effectiveDraft }: { actions: PreviewActions; rule: RecurrenceRule; draft?: RecurrenceRule; effectiveDraft?: string }) {
  const today = actions.data.businessDate || fallbackToday;
  const source = draft || rule;
  const defaultEffective = rule.startDate > today ? rule.startDate : today;
  const [effectiveDate, setEffectiveDate] = useState(effectiveDraft || defaultEffective);
  const [form, setForm] = useState<Schedule>({ id: rule.id, day: source.startDate, start: source.start, end: source.end, location: source.location, participants: [...source.participants], format: source.format, note: source.note, status: '已排期' });
  const [days, setDays] = useState([...source.weekdays]);
  const [end, setEnd] = useState(source.endDate || '');
  const [error, setError] = useState('');
  const set = <K extends keyof Schedule>(key: K, value: Schedule[K]) => setForm((old) => ({ ...old, [key]: value }));
  const save = (event: FormEvent) => {
    event.preventDefault();
    const next = { ...form, location: form.location.trim(), note: form.note.trim() };
    const validation = validateFields(next);
    if (validation) return setError(validation);
    if (!days.length) return setError('每周重复请至少选择一个星期。');
    if (effectiveDate < today) return setError('生效日期不能早于今天。');
    if (end && end < effectiveDate) return setError('结束日期不能早于生效日期。');
    const replacement: RecurrenceRule = { ...rule, id: draft?.id || `rr-${Date.now()}`, startDate: effectiveDate, start: next.start, end: next.end, location: next.location, participants: next.participants, format: next.format, note: next.note, weekdays: days, endDate: end || undefined };
    const proposed = replaceRuleFromMutation(actions.data, rule.id, effectiveDate, replacement);
    if (recurrenceConflict(proposed, replacement, replacement.id)) return setError('该重复规则会与未来排期发生时间冲突；请调整后再保存。');
    actions.open('确认修改重复规则', <RuleChangeConfirm actions={actions} before={rule} after={replacement} effectiveDate={effectiveDate} onBack={() => actions.open('编辑重复规则', <RuleEditor actions={actions} rule={rule} draft={replacement} effectiveDraft={effectiveDate} />)} onConfirm={() => commitAction(actions, () => actions.replaceRuleFrom(rule.id, effectiveDate, replacement), () => { actions.close(); actions.toast('重复规则已更新'); })} />);
  };
  return <form onSubmit={save} className="schedule-form"><label>生效日期<input type="date" value={effectiveDate} min={today} onInput={(event) => setEffectiveDate(event.currentTarget.value)} onChange={(event) => setEffectiveDate(event.target.value)} required /></label><Fields value={form} set={set} actions={actions} includeDay={false} /><WeekdayPicker days={days} setDays={setDays} end={end} setEnd={setEnd} min={effectiveDate} /><label>备注<textarea value={form.note} onChange={(event) => set('note', event.target.value)} /></label><FormError message={error} /><div className="dialog-actions"><button type="button" className="button secondary" onClick={actions.close}>取消</button><button className="button primary">查看更新确认</button></div></form>;
}
