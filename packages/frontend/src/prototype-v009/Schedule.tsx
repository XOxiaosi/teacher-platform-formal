import { DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, Icon } from '../preview/Chrome';
import { formatDate, formatDateTime, formatYearMonth } from '../shared/date-format';
import type { Course, LessonEntry, ScheduleRequest, Studio, StudioProps } from './model';
import { DEMO_DAY } from './model';
import './schedule.css';

type Draft = Pick<Course, 'day' | 'start' | 'end' | 'studentIds' | 'location' | 'format' | 'note'> & { sourceId: string; repeat: boolean; repeatUntil: string };
type Panel = { kind: 'add' | 'confirm-add' | 'detail' | 'move' | 'complete'; courseId?: string } | null;

const DAY_MS = 86400000;
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
const dateOf = (day: string) => new Date(`${day}T12:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (day: string, amount: number) => iso(new Date(dateOf(day).getTime() + amount * DAY_MS));
const monday = (day: string) => addDays(day, -((dateOf(day).getUTCDay() + 6) % 7));
const plusHours = (time: string, hours: number) => {
  const [h, m] = time.split(':').map(Number); const minutes = (h * 60 + m + hours * 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};
const duration = (item: Pick<Course, 'start' | 'end'>) => {
  const [sh, sm] = item.start.split(':').map(Number), [eh, em] = item.end.split(':').map(Number);
  return ((eh * 60 + em) - (sh * 60 + sm) + 1440) % 1440;
};
const timeLabel = (item: Pick<Course, 'start' | 'end'>) => `${item.start}–${item.end}`;
const courseObject = (course: Pick<Course, 'studentIds'>, students: Studio['students']) => course.studentIds.length > 1 ? `小班 · ${course.studentIds.length} 人` : students.find(student => student.id === course.studentIds[0])?.name || '待补充';
const initialAttendance = (course: Course) => Object.fromEntries(course.studentIds.map(id => [id, { attended: true, amount: 1 }]));
const defaultDraft = (day = DEMO_DAY): Draft => ({ day, start: '14:00', end: '16:00', studentIds: [], location: '', format: '一对一', note: '', sourceId: '', repeat: false, repeatUntil: '' });
const asDraft = (course: Course): Draft => ({ ...course, sourceId: course.id, repeat: false, repeatUntil: '' });

function courseConflict(courses: Course[], candidate: Pick<Course, 'id' | 'day' | 'start' | 'end' | 'studentIds'>) {
  const start = candidate.start, end = candidate.end;
  return courses.filter((course) => course.id !== candidate.id && course.status === 'scheduled' && course.day === candidate.day && start < course.end && end > course.start);
}
function courseSummary(course: Course, data: Studio, includeDay = false) { return <><b>{includeDay ? `${formatDate(course.day)} ${timeLabel(course)}` : timeLabel(course)}</b><span>{courseObject(course, data.students)}</span><small>{course.location || '待补充'}</small></>; }

export function SchedulePage({ data, setData, notify, request }: StudioProps & { request?: ScheduleRequest }) {
  const [weekStart, setWeekStart] = useState(monday(DEMO_DAY));
  const [view, setView] = useState<'week' | 'list'>('week');
  const [panel, setPanel] = useState<Panel>(null);
  const [draft, setDraft] = useState<Draft>(defaultDraft());
  const [moveDraft, setMoveDraft] = useState<Draft | null>(null);
  const [pendingNewCourse, setPendingNewCourse] = useState<Course | null>(null);
  const [attendance, setAttendance] = useState<Record<string, { attended: boolean; amount: number }>>({});
  const [error, setError] = useState('');
  const completionLock = useRef(false);
  const addLock = useRef(false);

  useEffect(() => {
    if (!request) return;
    if (request.mode === 'complete' && request.courseId) {
      const target = data.courses.find(course => course.id === request.courseId);
      if (target) setAttendance(initialAttendance(target));
      setPanel({ kind: 'complete', courseId: request.courseId });
    } else { setDraft(defaultDraft(request.mode === 'backfill' ? '2026-09-13' : DEMO_DAY)); setAttendance({}); setPanel({ kind: 'add' }); }
    setError('');
  }, [request?.key]); // requests deliberately reopen the current workflow

  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const visible = useMemo(() => data.courses.filter((course) => view === 'week' ? course.day >= weekStart && course.day <= addDays(weekStart, 6) : true).sort((a, b) => `${a.day}${a.start}`.localeCompare(`${b.day}${b.start}`)), [data.courses, view, weekStart]);
  const current = panel?.courseId ? data.courses.find((course) => course.id === panel.courseId) || (pendingNewCourse?.id === panel.courseId ? pendingNewCourse : undefined) : undefined;

  const close = () => { completionLock.current = false; setPanel(null); setPendingNewCourse(null); setError(''); };
  const openAdd = (backfill = false) => { addLock.current = false; setDraft(defaultDraft(backfill ? '2026-09-13' : DEMO_DAY)); setPendingNewCourse(null); setAttendance({}); setError(''); setPanel({ kind: 'add' }); };
  const openDetail = (courseId: string) => { setError(''); setPanel({ kind: 'detail', courseId }); };
  const chooseExisting = (sourceId: string) => {
    const source = data.courses.find((course) => course.id === sourceId);
    if (!source) return;
    setDraft({ ...asDraft(source), day: draft.day || DEMO_DAY, start: draft.start || source.start, end: plusHours(draft.start || source.start, duration(source) / 60) });
  };
  const validate = (candidate: Draft, except = '') => {
    if (!candidate.day || !candidate.start || !candidate.end || candidate.end <= candidate.start) return '请填写有效的日期、开始和结束时间。';
    if (candidate.repeat && (!candidate.repeatUntil || candidate.repeatUntil < candidate.day)) return '每周重复需要填写不早于开始日期的结束日期。';
    if (!candidate.studentIds.length) return '请选择至少一名学生。';
    if (candidate.format === '一对一' && candidate.studentIds.length !== 1) return '一对一课程只能选择一名学生。';
    if (candidate.format === '小班' && candidate.studentIds.length < 2) return '小班课程至少选择两名学生。';
    if (!candidate.location.trim()) return '请填写上课地点。';
    const conflicts = courseConflict(data.courses, { ...candidate, id: except });
    return conflicts.length ? `与 ${conflicts.map((course) => `${courseObject(course, data.students)}（${formatDate(course.day)} ${timeLabel(course)}）`).join('、')} 冲突；本次所有课程均未保存。` : '';
  };
  const saveDraft = () => {
    const issue = validate(draft); if (issue) { setError(issue); return; }
    setError(''); setPanel({ kind: 'confirm-add' });
  };
  const persistAdd = (completeAfter = false) => {
    const dates = draft.repeat ? Array.from({ length: Math.floor((dateOf(draft.repeatUntil).getTime() - dateOf(draft.day).getTime()) / (7 * DAY_MS)) + 1 }, (_, index) => addDays(draft.day, index * 7)) : [draft.day];
    const ruleId = draft.repeat ? `weekly-${Date.now()}` : undefined;
    const courses = dates.map((day, index): Course => ({ id: `course-${Date.now()}-${index}`, day, start: draft.start, end: draft.end, studentIds: draft.studentIds, location: draft.location.trim(), format: draft.format, note: draft.note.trim(), status: 'scheduled', ruleId, enteredAt: draft.day < DEMO_DAY ? `${DEMO_DAY}T09:00:00+08:00` : undefined }));
    const conflict = courses.flatMap((course) => courseConflict(data.courses, course));
    if (conflict.length) { setError(`保存前发现冲突：${conflict.map(course => `${courseObject(course, data.students)}（${formatDate(course.day)} ${timeLabel(course)}）`).join('、')}；本次所有课程均未保存。`); setPanel({ kind: 'add' }); return; }
    if (completeAfter && courses.length === 1) {
      setPendingNewCourse(courses[0]);
      setAttendance(Object.fromEntries(courses[0].studentIds.map(id => [id, { attended: true, amount: 1 }])));
      setPanel({ kind: 'complete', courseId: courses[0].id });
      return;
    }
    if (addLock.current) return;
    addLock.current = true;
    let finalConflict = false;
    setData((old) => {
      if (courses.some(course => courseConflict(old.courses, course).length)) { finalConflict = true; return old; }
      return { ...old, courses: [...old.courses, ...courses] };
    });
    if (finalConflict) { addLock.current = false; setError('保存时发现与已有课程时间冲突；本次所有课程均未保存。'); setPanel({ kind: 'add' }); return; }
    notify(draft.repeat ? `已保存 ${courses.length} 次每周课程。` : '课程已保存。'); close();
  };
  const startMove = (course: Course, day: string) => { const next = { ...asDraft(course), day }; setMoveDraft(next); setPanel({ kind: 'move', courseId: course.id }); };
  const confirmMove = () => {
    if (!current || !moveDraft) return;
    const issue = validate(moveDraft, current.id); if (issue) { setError(issue); return; }
    const { sourceId: _sourceId, repeat: _repeat, repeatUntil: _repeatUntil, ...changes } = moveDraft;
    setData((old) => ({ ...old, courses: old.courses.map((course) => course.id === current.id ? { ...course, ...changes, location: moveDraft.location.trim(), note: moveDraft.note.trim() } : course) }));
    notify(current.status === 'completed' ? '已修订已完成课程；原扣课流水保持不变。' : '课程时间已调整。'); close();
  };
  const complete = (course: Course) => {
    const records = course.studentIds.map((id) => {
      const selected = attendance[id] || { attended: true, amount: 1 };
      return { studentId: id, attended: selected.attended, amount: selected.attended ? selected.amount : 0 };
    });
    const invalid = records.find(record => !Number.isFinite(record.amount) || record.amount < 0 || Math.round(record.amount * 2) !== record.amount * 2);
    if (invalid) { setError('本次课时只能填写有限的非负 0.5 课时倍数；本次没有保存或扣课。'); return; }
    const short = records.find((record) => record.attended && (data.students.find(student => student.id === record.studentId)?.balance || 0) < record.amount);
    if (short) { setError(`${data.students.find(student => student.id === short.studentId)?.name} 的剩余课时不足；本次没有保存或扣课。`); return; }
    if (completionLock.current) return;
    completionLock.current = true;
    const isPendingNew = pendingNewCourse?.id === course.id;
    const completion = { outcome: 'completed' as 'completed' | 'already-completed' | 'cancelled' | 'insufficient' | 'conflict' };
    setData((old) => {
      const target = old.courses.find(item => item.id === course.id);
      const alreadyRecorded = old.ledger.some(item => item.courseId === course.id);
      if (isPendingNew ? Boolean(target) || alreadyRecorded : !target || target.status === 'completed' || alreadyRecorded) { completion.outcome = 'already-completed'; return old; }
      if (target?.status === 'cancelled') { completion.outcome = 'cancelled'; return old; }
      if (isPendingNew && courseConflict(old.courses, course).length) { completion.outcome = 'conflict'; return old; }
      const exhausted = records.find(record => record.attended && (old.students.find(student => student.id === record.studentId)?.balance || 0) < record.amount);
      if (exhausted) { completion.outcome = 'insufficient'; return old; }
      const entries: LessonEntry[] = records.map((record) => {
        const student = old.students.find(item => item.id === record.studentId)!;
        const after = record.attended ? student.balance - record.amount : student.balance;
        return { id: `ledger-${Date.now()}-${course.id}-${record.studentId}`, courseId: course.id, studentId: record.studentId, attended: record.attended, amount: record.amount, before: student.balance, after, day: (target || course).day };
      });
      return { ...old, courses: isPendingNew ? [...old.courses, { ...course, status: 'completed' }] : old.courses.map(item => item.id === course.id ? { ...item, status: 'completed' } : item), students: old.students.map(student => { const entry = entries.find(item => item.studentId === student.id); return entry ? { ...student, balance: entry.after } : student; }), ledger: [...old.ledger, ...entries] };
    });
    if (completion.outcome === 'already-completed') { completionLock.current = false; setError('该课程已完成或已有出勤记录，不能再次完成或扣课。'); return; }
    if (completion.outcome === 'cancelled') { completionLock.current = false; setError('已取消课程不能完成或扣课。'); return; }
    if (completion.outcome === 'insufficient') { completionLock.current = false; setError('保存时发现学生剩余课时不足；本次没有保存或扣课。'); return; }
    if (completion.outcome === 'conflict') { completionLock.current = false; setError('保存时发现与已有课程时间冲突；本次没有保存或扣课。'); return; }
    notify(records.some(record => record.attended && record.amount > 0) ? '已确认完课并扣除本次课时。' : '已确认完课；已保留本次出勤记录。'); close();
  };
  const backfillDuplicate = () => data.courses.find(course => course.day === draft.day && course.start === draft.start && course.end === draft.end && course.studentIds.length === draft.studentIds.length && course.studentIds.every(id => draft.studentIds.includes(id)));
  const openExistingCompletion = (course: Course) => { setPendingNewCourse(null); setAttendance(initialAttendance(course)); setPanel({ kind: 'complete', courseId: course.id }); setError('已存在同对象、同日期时间的课程；请核对并完成该课程，不会重复建课。'); };

  return <section className="v9-schedule" aria-label="日程安排">
    <header className="v9-schedule__head"><div><p className="v9-schedule__eyebrow">北京时间 · {formatYearMonth(DEMO_DAY)}</p><h1>日程安排</h1></div><button className="v9-button" onClick={() => openAdd()}><Icon name="schedule" />增加课程</button></header>
    <div className="v9-schedule__tools"><div className="v9-schedule__switch" aria-label="视图"><button className={view === 'week' ? 'active' : ''} onClick={() => setView('week')}>周日历</button><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>课程列表</button></div>{view === 'week' && <div className="v9-schedule__navigate"><button className="v9-button secondary" aria-label="上一周" onClick={() => setWeekStart(addDays(weekStart, -7))}>‹ 上一周</button><strong>{formatDate(weekStart)}–{formatDate(addDays(weekStart, 6))}</strong><button className="v9-button secondary" aria-label="下一周" onClick={() => setWeekStart(addDays(weekStart, 7))}>下一周 ›</button></div>}</div>
    {view === 'week' ? <div className="v9-week" aria-label="周日历">{days.map((day) => <div className={`v9-day ${day === DEMO_DAY ? 'is-today' : ''}`} key={day} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const id = event.dataTransfer.getData('course-id'); const course = data.courses.find(item => item.id === id); if (course && course.day !== day) startMove(course, day); }}><header><b>{weekdays[(dateOf(day).getUTCDay() + 6) % 7]}</b><span>{day.slice(8)}</span>{day === DEMO_DAY && <small>今天</small>}</header><div>{data.courses.filter(course => course.day === day).sort((a,b) => a.start.localeCompare(b.start)).map(course => <button draggable onDragStart={(event: DragEvent<HTMLButtonElement>) => event.dataTransfer.setData('course-id', course.id)} onClick={() => openDetail(course.id)} key={course.id} className={`v9-course ${course.status}`} aria-label={`${timeLabel(course)} ${courseObject(course, data.students)} ${course.location || '待补充'}`}>{courseSummary(course, data)}</button>)}</div></div>)}</div> : <div className="v9-list">{visible.map(course => <button className={`v9-list__course ${course.status}`} onClick={() => openDetail(course.id)} key={course.id}>{courseSummary(course, data, true)}</button>)}{!visible.length && <p className="v9-muted">此范围没有课程。</p>}</div>}
    <button className="v9-schedule__backfill" onClick={() => openAdd(true)}>补录过去课程</button>
    {panel?.kind === 'add' && <Dialog title={draft.day < DEMO_DAY ? '补录过去课程' : '增加课程'} onClose={close}><ScheduleForm draft={draft} setDraft={setDraft} data={data} error={error} onExisting={chooseExisting} onSubmit={saveDraft} /><p className="v9-schedule__timezone">相对日期与保存时间按北京时间理解。{draft.day < DEMO_DAY ? `本次默认日期为 ${formatDate(draft.day)}。` : ''}</p></Dialog>}
    {panel?.kind === 'confirm-add' && <Dialog title="确认课程" onClose={() => setPanel({ kind: 'add' })}><Confirmation draft={draft} data={data} /><div className="dialog-actions"><button className="v9-button secondary" onClick={() => setPanel({ kind: 'add' })}>返回修改</button><button className="v9-button" onClick={() => { const duplicate = draft.day < DEMO_DAY && backfillDuplicate(); if (duplicate) openExistingCompletion(duplicate); else persistAdd(); }}>仅保存课程</button>{draft.day < DEMO_DAY && !draft.repeat && <button className="v9-button" onClick={() => { const duplicate = backfillDuplicate(); if (duplicate) openExistingCompletion(duplicate); else persistAdd(true); }}>核对出勤并完课</button>}</div></Dialog>}
    {panel?.kind === 'detail' && current && <Dialog title="课程详情" onClose={close}><CourseDetail course={current} data={data} /><div className="dialog-actions"><button className="v9-button secondary" onClick={() => { setMoveDraft(asDraft(current)); setPanel({ kind: 'move', courseId: current.id }); }}>修改本次</button>{current.status === 'scheduled' && <button className="v9-button" onClick={() => { setAttendance(initialAttendance(current)); setPanel({ kind: 'complete', courseId: current.id }); }}>确认完课</button>}{current.status === 'completed' && <p className="v9-muted">已完成；继续修改课程只修订本次，原扣课流水保持不变。</p>}</div></Dialog>}
    {panel?.kind === 'move' && current && moveDraft && <Dialog title="确认调整课程" onClose={close}><p className="v9-schedule__move-line">旧值：{formatDate(current.day)} {timeLabel(current)} · {courseObject(current, data.students)} · {current.location || '待补充'}</p><EditForm draft={moveDraft} setDraft={setMoveDraft} data={data} originalDuration={duration(current)} /><p className="v9-schedule__move-line">新值：{formatDate(moveDraft.day)} {timeLabel(moveDraft)} · {courseObject(moveDraft, data.students)} · {moveDraft.location || '待补充'}（仅本次）</p>{error && <p role="alert" className="v9-schedule__error">{error}</p>}<div className="dialog-actions"><button className="v9-button secondary" onClick={() => setPanel({ kind: 'detail', courseId: current.id })}>取消</button><button className="v9-button" onClick={confirmMove}>确认调整</button></div></Dialog>}
    {panel?.kind === 'complete' && current && <Dialog title="确认完课与课时" onClose={close}><p className="v9-schedule__timezone">课程按北京时间：{formatDate(current.day)} {timeLabel(current)}</p>{error && <p role="alert" className="v9-schedule__error">{error}</p>}<div className="v9-attendance">{current.studentIds.map(id => { const student = data.students.find(item => item.id === id)!; const value = attendance[id] || { attended: true, amount: 1 }; return <div key={id}><label><input type="checkbox" checked={value.attended} disabled={current.status === 'completed'} onChange={e => setAttendance({ ...attendance, [id]: { ...value, attended: e.target.checked } })} />{student.name} 出勤</label><label className="v9-field">本次课时<input type="number" min="0" step="0.5" disabled={!value.attended || current.status === 'completed'} value={value.amount} onChange={e => setAttendance({ ...attendance, [id]: { ...value, amount: Number(e.target.value) } })} /></label><span>{value.attended ? `余额 ${student.balance} → ${student.balance - value.amount}` : `余额保持 ${student.balance}`}</span></div>; })}</div>{current.status === 'completed' ? <div className="dialog-actions"><button className="v9-button secondary" onClick={() => setPanel({ kind: 'detail', courseId: current.id })}>返回详情</button></div> : <div className="dialog-actions"><button className="v9-button secondary" onClick={() => pendingNewCourse?.id === current.id ? close() : setPanel({ kind: 'detail', courseId: current.id })}>{pendingNewCourse?.id === current.id ? '取消' : '仅保存课程'}</button><button className="v9-button" onClick={() => complete(current)}>保存并完课</button></div>}</Dialog>}
  </section>;
}

function EditForm({ draft, setDraft, data, originalDuration }: { draft: Draft; setDraft: (next: Draft) => void; data: Studio; originalDuration: number }) {
  const toggle = (id: string) => setDraft({ ...draft, studentIds: draft.studentIds.includes(id) ? draft.studentIds.filter(item => item !== id) : [...draft.studentIds, id] });
  return <div className="v9-schedule__form"><div className="v9-row"><label className="v9-field">日期<input type="date" value={draft.day} onChange={e => setDraft({ ...draft, day: e.target.value })} /></label><label className="v9-field">开始<input type="time" value={draft.start} onChange={e => setDraft({ ...draft, start: e.target.value, end: plusHours(e.target.value, originalDuration / 60) })} /></label><label className="v9-field">结束<input type="time" value={draft.end} onChange={e => setDraft({ ...draft, end: e.target.value })} /></label></div><fieldset><legend>上课对象</legend>{data.students.map(student => <label key={student.id}><input type="checkbox" checked={draft.studentIds.includes(student.id)} onChange={() => toggle(student.id)} />{student.name}</label>)}</fieldset><div className="v9-row"><label className="v9-field">地点<input value={draft.location} onChange={e => setDraft({ ...draft, location: e.target.value })} /></label><label className="v9-field">形式<select value={draft.format} onChange={e => setDraft({ ...draft, format: e.target.value as Course['format'] })}><option>一对一</option><option>小班</option></select></label></div><label className="v9-field">备注<textarea value={draft.note} onChange={e => setDraft({ ...draft, note: e.target.value })} /></label></div>;
}
function ScheduleForm({ draft, setDraft, data, error, onExisting, onSubmit }: { draft: Draft; setDraft: (next: Draft) => void; data: Studio; error: string; onExisting: (id: string) => void; onSubmit: () => void }) {
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value });
  const toggleStudent = (id: string) => update('studentIds', draft.studentIds.includes(id) ? draft.studentIds.filter(item => item !== id) : [...draft.studentIds, id]);
  return <form className="v9-schedule__form" onSubmit={(event: FormEvent) => { event.preventDefault(); onSubmit(); }}><fieldset><legend>课程来源</legend><label><input type="radio" checked={!draft.sourceId} onChange={() => setDraft(defaultDraft(draft.day))} />创建全新课程</label><label><input type="radio" checked={!!draft.sourceId} onChange={() => onExisting(data.courses[0]?.id || '')} />选用已有课程</label>{draft.sourceId && <select aria-label="已有课程" value={draft.sourceId} onChange={e => onExisting(e.target.value)}>{data.courses.map(course => <option key={course.id} value={course.id}>{courseObject(course, data.students)} · {course.location || '待补充'} · {timeLabel(course)}</option>)}</select>}</fieldset><div className="v9-row"><label className="v9-field">日期<input required type="date" value={draft.day} onChange={e => update('day', e.target.value)} /></label><label className="v9-field">开始<input required type="time" value={draft.start} onChange={e => setDraft({ ...draft, start: e.target.value, end: plusHours(e.target.value, duration(draft) / 60) })} /></label><label className="v9-field">结束<input required type="time" value={draft.end} onChange={e => update('end', e.target.value)} /></label></div><fieldset><legend>上课对象</legend>{data.students.map(student => <label key={student.id}><input type="checkbox" checked={draft.studentIds.includes(student.id)} onChange={() => toggleStudent(student.id)} />{student.name}</label>)}</fieldset><div className="v9-row"><label className="v9-field">地点<input value={draft.location} onChange={e => update('location', e.target.value)} /></label><label className="v9-field">形式<select value={draft.format} onChange={e => update('format', e.target.value as Course['format'])}><option>一对一</option><option>小班</option></select></label></div><label className="v9-field">备注<textarea value={draft.note} onChange={e => update('note', e.target.value)} /></label><fieldset><legend>排期方式</legend><label><input type="radio" checked={!draft.repeat} onChange={() => update('repeat', false)} />仅一次</label><label><input type="radio" checked={draft.repeat} onChange={() => update('repeat', true)} />每周重复</label>{draft.repeat && <label className="v9-field">结束日期<input required type="date" value={draft.repeatUntil} min={draft.day} onChange={e => update('repeatUntil', e.target.value)} /></label>}{draft.repeat && <p className="v9-muted">将安排 {formatDate(draft.day)} 至 {draft.repeatUntil ? formatDate(draft.repeatUntil) : '请选择结束日期'} 的每周课程。</p>}</fieldset>{error && <p role="alert" className="v9-schedule__error">{error}</p>}<div className="dialog-actions"><button className="v9-button" type="submit">查看确认</button></div></form>;
}
function Confirmation({ draft, data }: { draft: Draft; data: Studio }) { return <><p className="v9-schedule__timezone">北京时间：{formatDate(draft.day)} {timeLabel(draft)}</p><dl className="v9-confirmation"><div><dt>对象</dt><dd>{draft.studentIds.map(id => data.students.find(item => item.id === id)?.name).join('、')}</dd></div><div><dt>地点</dt><dd>{draft.location}</dd></div><div><dt>形式</dt><dd>{draft.format}</dd></div>{draft.note && <div><dt>备注</dt><dd>{draft.note}</dd></div>}<div><dt>安排</dt><dd>{draft.repeat ? `每周重复，至 ${formatDate(draft.repeatUntil)}` : '仅本次'}</dd></div></dl></>; }
function CourseDetail({ course, data }: { course: Course; data: Studio }) { const ledger = data.ledger.filter(item => item.courseId === course.id); return <dl className="v9-confirmation"><div><dt>{course.status === 'completed' ? '实际发生时间' : '安排时间'}</dt><dd>北京时间 {formatDate(course.day)} {timeLabel(course)}</dd></div>{course.enteredAt && <div><dt>补录时间</dt><dd>北京时间 {formatDateTime(course.enteredAt)}</dd></div>}<div><dt>对象</dt><dd>{course.studentIds.map(id => data.students.find(item => item.id === id)?.name).join('、')}</dd></div><div><dt>地点</dt><dd>{course.location || '待补充'}</dd></div><div><dt>形式</dt><dd>{course.format || '待补充'}</dd></div>{course.note && <div><dt>备注</dt><dd>{course.note}</dd></div>}{course.ruleId && <div><dt>重复安排</dt><dd>每周同日</dd></div>}{course.status === 'completed' && <div><dt>本次出勤与课时</dt><dd>{ledger.map(item => `${data.students.find(student => student.id === item.studentId)?.name}：${item.attended ? `出勤 ${item.amount} 课时，${item.before} → ${item.after}` : `缺席，余额保持 ${item.before}`}`).join('；') || '未找到出勤记录'}</dd></div>}</dl>; }
