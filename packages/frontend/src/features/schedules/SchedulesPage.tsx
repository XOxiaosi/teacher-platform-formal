import {
  FormEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { RefObject } from 'react';
import { cancelSchedule, completeSchedule, createSchedule, listSchedules, restoreSchedule } from '../../api/schedules';
import type { CreateScheduleRequest } from '../../api/schedules';
import { listStudents } from '../../api/students';
import type { ScheduleData, StudentData } from '../../api/types';
import { formatDateTime } from '../../shared/date-format';
import { scheduleStatusLabel, scheduleTypeLabel } from '../../shared/display-labels';
import { WeekScheduleView } from './WeekScheduleView';
import './schedules.css';

interface SchedulesPageProps {
  teacherId: string;
  weekStart?: string;
  focusScheduleId?: string;
  invalidWeekStart?: boolean;
  onNavigate?: (path: string) => void;
}

interface ScheduleFormState {
  title: string;
  type: CreateScheduleRequest['type'];
  scheduledStart: string;
  scheduledEnd: string;
  studentId: string;
}

const initialForm: ScheduleFormState = {
  title: '',
  type: 'lesson',
  scheduledStart: '',
  scheduledEnd: '',
  studentId: '',
};

const scheduleTypes: CreateScheduleRequest['type'][] = ['lesson', 'prep', 'meeting', 'call', 'other'];

function toBusinessRfc3339(localDateTime: string): string {
  return `${localDateTime}:00+08:00`;
}

export function SchedulesPage({
  teacherId,
  weekStart,
  focusScheduleId,
  invalidWeekStart = false,
  onNavigate = ignoreNavigation,
}: SchedulesPageProps) {
  const [schedules, setSchedules] = useState<ScheduleData[]>([]);
  const [students, setStudents] = useState<StudentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ScheduleFormState>(initialForm);
  const [creating, setCreating] = useState(false);
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const focusedScheduleRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([listSchedules(teacherId), listStudents(teacherId)])
      .then(([scheduleResult, studentResult]) => {
        if (!active) return;
        setSchedules(scheduleResult.items);
        setStudents(studentResult.items);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(messageOf(loadError));
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => { active = false; };
  }, [teacherId]);

  const hasFocusedSchedule = Boolean(
    focusScheduleId && schedules.some((schedule) => schedule.id === focusScheduleId),
  );

  useLayoutEffect(() => {
    if (hasFocusedSchedule) focusedScheduleRef.current?.scrollIntoView({ block: 'center' });
  }, [focusScheduleId, hasFocusedSchedule, schedules]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = form.title.trim();
    if (!title || !form.scheduledStart || !form.scheduledEnd) return;

    setCreating(true);
    setFormMessage(null);
    try {
      const request: CreateScheduleRequest = {
        title,
        type: form.type,
        scheduledStart: toBusinessRfc3339(form.scheduledStart),
        scheduledEnd: toBusinessRfc3339(form.scheduledEnd),
      };
      const studentId = form.studentId.trim();
      if (studentId) request.studentId = studentId;

      const result = await createSchedule(teacherId, request);
      setSchedules((current) => [...current, result.schedule]);
      setForm(initialForm);
    } catch (createError) {
      setFormMessage(`新增失败：${messageOf(createError)}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleComplete(scheduleId: string) {
    setCompletingId(scheduleId);
    try {
      const result = await completeSchedule(teacherId, scheduleId);
      setSchedules((current) => current.map((schedule) => (schedule.id === scheduleId ? result.schedule : schedule)));
    } catch (completeError) {
      setFormMessage(`完成课程失败：${messageOf(completeError)}`);
    } finally {
      setCompletingId(null);
    }
  }

  async function handleCancel(scheduleId: string) {
    if (!window.confirm('确定取消这门课程？')) return;
    setTogglingId(scheduleId);
    try {
      const schedule = await cancelSchedule(teacherId, scheduleId);
      setSchedules((current) => current.map((item) => (item.id === scheduleId ? schedule : item)));
    } catch (cancelError) {
      setFormMessage(`取消课程失败：${messageOf(cancelError)}`);
    } finally {
      setTogglingId(null);
    }
  }

  async function handleRestore(scheduleId: string) {
    setTogglingId(scheduleId);
    try {
      const schedule = await restoreSchedule(teacherId, scheduleId);
      setSchedules((current) => current.map((item) => (item.id === scheduleId ? schedule : item)));
    } catch (restoreError) {
      setFormMessage(`恢复课程失败：${messageOf(restoreError)}`);
    } finally {
      setTogglingId(null);
    }
  }

  if (loading) {
    return <section className="page-card schedules-page">正在加载日程课表</section>;
  }

  if (error) {
    return (
      <section className="page-card schedules-page schedules-error" role="alert">
        <p className="eyebrow">Error</p>
        <h2>日程课表加载失败</h2>
        <p>{error}</p>
      </section>
    );
  }

  return (
    <section className="schedules-page">
      <header className="page-hero">
        <p className="eyebrow">课程安排</p>
        <h2>日程课表</h2>
        <p>维护课程、备课、沟通等时间安排，并在课程结束后及时完成记录。</p>
      </header>

      {invalidWeekStart ? (
        <section className="page-card week-load-state" role="alert">
          <h3>周课程表参数错误</h3>
          <p>weekStart必须是合法周一日期</p>
          <button type="button" onClick={() => onNavigate('/schedules')}>返回本周</button>
        </section>
      ) : (
        <WeekScheduleView
          teacherId={teacherId}
          weekStart={weekStart}
          focusScheduleId={focusScheduleId}
          onNavigate={onNavigate}
        />
      )}
      <ScheduleCreateForm form={form} students={students} creating={creating} message={formMessage} onChange={setForm} onSubmit={handleCreate} />
      <ScheduleList
        schedules={schedules}
        completingId={completingId}
        togglingId={togglingId}
        focusScheduleId={focusScheduleId}
        focusedScheduleRef={focusedScheduleRef}
        onComplete={handleComplete}
        onCancel={handleCancel}
        onRestore={handleRestore}
      />
    </section>
  );
}

function ScheduleCreateForm({ form, students, creating, message, onChange, onSubmit }: {
  form: ScheduleFormState;
  students: StudentData[];
  creating: boolean;
  message: string | null;
  onChange: (form: ScheduleFormState) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="page-card schedules-form" onSubmit={onSubmit}>
      <h3>新增日程</h3>
      <label htmlFor="schedule-title">标题</label>
      <input id="schedule-title" value={form.title} onChange={(event) => onChange({ ...form, title: event.target.value })} />

      <label htmlFor="schedule-type">类型</label>
      <select id="schedule-type" value={form.type} onChange={(event) => onChange({ ...form, type: event.target.value as CreateScheduleRequest['type'] })}>
        {scheduleTypes.map((type) => <option key={type} value={type}>{scheduleTypeLabel(type)}</option>)}
      </select>

      <label htmlFor="schedule-start">开始时间</label>
      <input id="schedule-start" type="datetime-local" value={form.scheduledStart} onChange={(event) => onChange({ ...form, scheduledStart: event.target.value })} />

      <label htmlFor="schedule-end">结束时间</label>
      <input id="schedule-end" type="datetime-local" value={form.scheduledEnd} onChange={(event) => onChange({ ...form, scheduledEnd: event.target.value })} />

      <label htmlFor="schedule-student">学生</label>
      <select id="schedule-student" value={form.studentId} onChange={(event) => onChange({ ...form, studentId: event.target.value })}>
        <option value="">不关联学生</option>
        {students.map((student) => <option key={student.id} value={student.id}>{student.name} · {student.grade}</option>)}
      </select>

      <button className="primary-action" type="submit" disabled={creating || !form.title.trim() || !form.scheduledStart || !form.scheduledEnd}>{creating ? '新增中' : '新增日程'}</button>
      {message ? <p className="muted">{message}</p> : null}
    </form>
  );
}

function ScheduleList({
  schedules,
  completingId,
  togglingId,
  focusScheduleId,
  focusedScheduleRef,
  onComplete,
  onCancel,
  onRestore,
}: {
  schedules: ScheduleData[];
  completingId: string | null;
  togglingId: string | null;
  focusScheduleId?: string;
  focusedScheduleRef: RefObject<HTMLLIElement | null>;
  onComplete: (scheduleId: string) => void;
  onCancel: (scheduleId: string) => void;
  onRestore: (scheduleId: string) => void;
}) {
  return (
    <article className="page-card schedules-list-card">
      <h3>日程列表</h3>
      {schedules.length === 0 ? <p className="muted">暂无日程安排。</p> : (
        <ul className="schedules-list">
          {schedules.map((schedule) => {
            const focused = schedule.id === focusScheduleId;
            return (
              <li
                ref={focused ? focusedScheduleRef : undefined}
                className={`schedule-item${focused ? ' schedule-item--focused' : ''}`}
                key={schedule.id}
                aria-label={`${schedule.title} ${schedule.status} ${schedule.scheduledStart}`}
                aria-current={focused ? 'true' : undefined}
              >
                <div>
                  <strong>{schedule.title}</strong>
                  <span className={`status-badge status-badge--${schedule.status}`}>{scheduleStatusLabel(schedule.status)}</span>
                  <time dateTime={schedule.scheduledStart}>{formatDateTime(schedule.scheduledStart)}</time>
                </div>
                <button type="button" disabled={completingId === schedule.id || schedule.status === 'completed' || schedule.status === 'cancelled'} onClick={() => onComplete(schedule.id)}>
                  {completingId === schedule.id ? '完成中' : '完成课程'}
                </button>
                {schedule.status === 'planned' ? (
                  <button type="button" disabled={togglingId === schedule.id} onClick={() => onCancel(schedule.id)}>
                    {togglingId === schedule.id ? '取消中' : '取消课程'}
                  </button>
                ) : null}
                {schedule.status === 'cancelled' ? (
                  <button type="button" disabled={togglingId === schedule.id} onClick={() => onRestore(schedule.id)}>
                    {togglingId === schedule.id ? '恢复中' : '恢复课程'}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

function ignoreNavigation() {
  // App injects SPA navigation; direct feature rendering keeps links inert.
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
