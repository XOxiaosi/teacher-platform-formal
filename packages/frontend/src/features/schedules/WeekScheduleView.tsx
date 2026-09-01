import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { CSSProperties, RefObject } from 'react';
import type {
  AgendaItem,
  AgendaWeekDocument,
  ObjectReference,
} from '@teacher-platform/contracts';
import { agendaApi } from '../../api/agenda';
import { formatAgendaTimeRange, formatBusinessDate } from '../../shared/agenda/agenda-time';
import { agendaStatusLabel } from '../../shared/agenda/agenda-view-model';
import { AgendaItemView } from '../../shared/agenda/AgendaItemView';
import { getPresentationActionRoute } from '../../shared/object-reference-routing';
import {
  buildWeekScheduleLayout,
  shiftWeekStart,
} from './week-schedule';
import type {
  LessonLayout,
  WeekDayLayout,
  WeekScheduleLayout,
} from './week-schedule';

export interface WeekAgendaApi {
  getWeek(teacherId: string, weekStart?: string): Promise<AgendaWeekDocument>;
}

interface WeekScheduleViewProps {
  teacherId: string;
  weekStart?: string;
  focusScheduleId?: string;
  onNavigate: (path: string) => void;
  api?: WeekAgendaApi;
}

type LoadMode = 'initial' | 'refresh';

interface ReadyWeek {
  document: AgendaWeekDocument;
  layout: WeekScheduleLayout;
}

/** P2 移动端门控：≤768px 时渲染纵向 agenda（jsdom 无 matchMedia → false，桌面测试零影响）。 */
function useIsMobile(breakpoint = '(max-width: 768px)'): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(breakpoint).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(breakpoint);
    const onChange = () => setMatches(query.matches);
    setMatches(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [breakpoint]);

  return matches;
}

export function WeekScheduleView({
  teacherId,
  weekStart,
  focusScheduleId,
  onNavigate,
  api = agendaApi,
}: WeekScheduleViewProps) {
  const [ready, setReady] = useState<ReadyWeek | null>(null);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [protocolError, setProtocolError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  const pendingGeneration = useRef<number | null>(null);
  const focusedLessonRef = useRef<HTMLElement>(null);
  const isMobile = useIsMobile();

  const load = useCallback((mode: LoadMode) => {
    if (pendingGeneration.current !== null) return;
    const requestGeneration = ++generation.current;
    pendingGeneration.current = requestGeneration;

    if (mode === 'initial') {
      setReady(null);
      setInitialError(null);
      setProtocolError(null);
      setRefreshError(null);
      setRefreshing(false);
    } else {
      setRefreshError(null);
      setRefreshing(true);
    }

    const request = weekStart === undefined
      ? api.getWeek(teacherId)
      : api.getWeek(teacherId, weekStart);
    void request
      .then((document) => {
        if (generation.current !== requestGeneration) return;
        try {
          const layout = buildWeekScheduleLayout(document);
          setReady({ document, layout });
          setInitialError(null);
          setProtocolError(null);
          setRefreshError(null);
        } catch {
          if (mode === 'refresh') setRefreshError('服务端返回的周范围不完整');
          else setProtocolError('服务端返回的周范围不完整');
        }
      })
      .catch((error: unknown) => {
        if (generation.current !== requestGeneration) return;
        if (mode === 'refresh') setRefreshError(messageOf(error));
        else setInitialError(messageOf(error));
      })
      .finally(() => {
        if (generation.current !== requestGeneration) return;
        pendingGeneration.current = null;
        if (mode === 'refresh') setRefreshing(false);
      });
  }, [api, teacherId, weekStart]);

  useEffect(() => {
    load('initial');
    return () => {
      generation.current += 1;
      pendingGeneration.current = null;
    };
  }, [load]);

  const hasFocusedLesson = Boolean(
    focusScheduleId
    && ready?.layout.days.some((day) => day.lessons.some(
      ({ item }) => item.sourceRef.type === 'Schedule'
        && item.sourceRef.objectId === focusScheduleId,
    )),
  );

  useLayoutEffect(() => {
    if (hasFocusedLesson) focusedLessonRef.current?.scrollIntoView({ block: 'center' });
  }, [focusScheduleId, hasFocusedLesson, ready]);

  if (!ready && protocolError) {
    return (
      <section className="page-card week-load-state" role="alert">
        <h3>周课程表数据错误</h3>
        <p>{protocolError}</p>
        <button type="button" onClick={() => onNavigate('/schedules')}>返回本周</button>
      </section>
    );
  }

  if (!ready && initialError) {
    return (
      <section className="page-card week-load-state" role="alert">
        <h3>周课程表加载失败</h3>
        <p>{initialError}</p>
        <button type="button" onClick={() => load('initial')}>重试周课程表</button>
      </section>
    );
  }

  if (!ready) {
    return <section className="page-card week-load-state" aria-live="polite">正在加载周课程表</section>;
  }

  const { document, layout } = ready;
  return (
    <section className="page-card week-schedule-view" aria-labelledby="week-schedule-heading">
      <header className="week-schedule-header">
        <div>
          <p className="eyebrow">Week Agenda</p>
          <h3 id="week-schedule-heading">周课程表</h3>
          <p>{document.weekStart} 至 {previousBusinessDate(document.weekEndExclusive)}</p>
        </div>
        <div className="week-schedule-actions">
          <button
            type="button"
            disabled={refreshing}
            onClick={() => onNavigate(`/schedules?weekStart=${shiftWeekStart(document.weekStart, -1)}`)}
          >上一周</button>
          <button type="button" disabled={refreshing} onClick={() => onNavigate('/schedules')}>返回本周</button>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => onNavigate(`/schedules?weekStart=${shiftWeekStart(document.weekStart, 1)}`)}
          >下一周</button>
          <button
            type="button"
            disabled={refreshing}
            aria-busy={refreshing}
            onClick={() => load('refresh')}
          >{refreshing ? '更新中' : '刷新课表'}</button>
        </div>
      </header>

      {refreshError ? <p className="week-refresh-error" role="alert">刷新失败：{refreshError}</p> : null}

      <div className="week-days" style={{ '--week-column-count': document.days.length } as CSSProperties}>
        {layout.days.map((day, index) => (
          <WeekDay
            key={day.date}
            day={day}
            dayLabel={dayHeading(day.date)}
            startHour={layout.startHour}
            endHour={layout.endHour}
            onNavigate={onNavigate}
            focusScheduleId={focusScheduleId}
            focusedLessonRef={focusedLessonRef}
            showHourLabels={index === 0}
          />
        ))}
      </div>

      {/* P2 移动端（≤768px）：周网格由 CSS 隐藏，纵向 agenda 由 matchMedia 门控渲染（复用 AgendaItemView） */}
      {isMobile ? (
        <div className="week-mobile-agenda" aria-label="移动端周日程列表">
          {document.days.map((day) => (
            <section key={day.date} className="week-mobile-day" aria-labelledby={`week-mobile-day-${day.date}`}>
              <h4 id={`week-mobile-day-${day.date}`}>{dayHeading(day.date)}</h4>
              {day.items.length === 0 ? (
                <p className="week-mobile-day__empty">无安排</p>
              ) : (
                <ul className="week-mobile-day__list">
                  {day.items.map((item) => (
                    <li key={item.id}>
                      <AgendaItemView
                        item={item}
                        onNavigate={onNavigate}
                        focused={item.sourceRef.type === 'Schedule' && item.sourceRef.objectId === focusScheduleId}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      ) : null}
    </section>
  );
}

interface WeekDayProps {
  day: WeekDayLayout;
  dayLabel: string;
  startHour: number;
  endHour: number;
  onNavigate: (path: string) => void;
  focusScheduleId?: string;
  focusedLessonRef: RefObject<HTMLElement | null>;
  showHourLabels: boolean;
}

function WeekDay({
  day,
  dayLabel,
  startHour,
  endHour,
  onNavigate,
  focusScheduleId,
  focusedLessonRef,
  showHourLabels,
}: WeekDayProps) {
  const totalMinutes = (endHour - startHour) * 60;
  const hours = Array.from({ length: endHour - startHour + 1 }, (_, index) => startHour + index);
  return (
    <article className="week-day" aria-labelledby={`week-day-${day.date}`}>
      <h4 id={`week-day-${day.date}`}>{dayLabel}</h4>
      <div className="week-all-day">
        <span className="week-all-day__label">全日</span>
        {day.allDayItems.length === 0 ? <span className="week-all-day__empty">无</span> : (
          <ul>
            {day.allDayItems.map((item) => (
              <li key={item.id}><WeekAllDayItem item={item} onNavigate={onNavigate} /></li>
            ))}
          </ul>
        )}
      </div>
      <div className="week-time-column" style={{ height: `${totalMinutes}px` }}>
        {hours.map((hour) => (
          <span
            key={hour}
            className="week-hour-line"
            style={{ top: `${((hour - startHour) * 60 / totalMinutes) * 100}%` }}
            aria-hidden="true"
          >{showHourLabels ? `${String(hour).padStart(2, '0')}:00` : ''}</span>
        ))}
        {day.lessons.map((lesson) => {
          const focused = lesson.item.sourceRef.type === 'Schedule'
            && lesson.item.sourceRef.objectId === focusScheduleId;
          return (
            <WeekLesson
              key={`${day.date}:${lesson.item.id}`}
              dayLabel={dayLabel}
              lesson={lesson}
              startHour={startHour}
              totalMinutes={totalMinutes}
              focused={focused}
              elementRef={focused ? focusedLessonRef : undefined}
              onNavigate={onNavigate}
            />
          );
        })}
      </div>
      {day.invalidLessons.length > 0 ? (
        <ul className="week-invalid-lessons">
          {day.invalidLessons.map((item) => <li key={item.id}>{item.title} · 时间不可用</li>)}
        </ul>
      ) : null}
    </article>
  );
}

function WeekAllDayItem({ item, onNavigate }: { item: AgendaItem; onNavigate: (path: string) => void }) {
  const actions = safeActions(item);
  return (
    <div className={`week-all-day-item week-all-day-item--${item.kind}`}>
      <span>{item.title}</span>
      <small>{agendaStatusLabel(item.status)}</small>
      {actions.map(({ action, route }) => (
        <a key={action.id} href={route} onClick={(event) => navigate(event, route, onNavigate)}>{action.label}</a>
      ))}
    </div>
  );
}

interface WeekLessonProps {
  dayLabel: string;
  lesson: LessonLayout;
  startHour: number;
  totalMinutes: number;
  focused: boolean;
  elementRef?: RefObject<HTMLElement | null>;
  onNavigate: (path: string) => void;
}

function WeekLesson({
  dayLabel,
  lesson,
  startHour,
  totalMinutes,
  focused,
  elementRef,
  onNavigate,
}: WeekLessonProps) {
  const timeLabel = formatAgendaTimeRange(lesson.item.startAt, lesson.item.endAt) ?? '时间不可用';
  const top = ((lesson.startMinute - startHour * 60) / totalMinutes) * 100;
  const height = ((lesson.endMinute - lesson.startMinute) / totalMinutes) * 100;
  const laneWidth = 100 / lesson.laneCount;
  const style: CSSProperties = {
    top: `${top}%`,
    height: `${height}%`,
    left: `calc(${lesson.lane * laneWidth}% + ${lesson.lane === 0 ? 0 : 2}px)`,
    width: `calc(${laneWidth}% - 2px)`,
  };
  const status = agendaStatusLabel(lesson.item.status);
  const accessibleTime = timeLabel.replace('–', '至');
  const actions = safeActions(lesson.item);

  return (
    <article
      ref={elementRef}
      className={`week-lesson${focused ? ' week-lesson--focused' : ''}`}
      style={style}
      aria-label={`${weekdayOf(dayLabel)} ${accessibleTime} ${lesson.item.title} ${status}`}
      aria-current={focused ? 'true' : undefined}
      data-start-minute={lesson.startMinute}
      data-end-minute={lesson.endMinute}
      data-lane={lesson.lane}
      data-lane-count={lesson.laneCount}
    >
      <time dateTime={lesson.item.startAt}>{timeLabel}</time>
      <strong>{lesson.item.title}</strong>
      {lesson.item.studentRef ? <span>{lesson.item.studentRef.label}</span> : null}
      <small>{status}</small>
      {actions.map(({ action, route }) => (
        <a key={action.id} href={route} onClick={(event) => navigate(event, route, onNavigate)}>{action.label}</a>
      ))}
    </article>
  );
}

function safeActions(item: AgendaItem) {
  const references: ObjectReference[] = [
    item.sourceRef,
    ...(item.studentRef ? [item.studentRef] : []),
  ];
  return item.actions.flatMap((action) => {
    const route = getPresentationActionRoute(action, references);
    return route ? [{ action, route }] : [];
  });
}

function navigate(
  event: React.MouseEvent<HTMLAnchorElement>,
  route: string,
  onNavigate: (path: string) => void,
) {
  event.preventDefault();
  onNavigate(route);
}

function dayHeading(date: string): string {
  try {
    const [dateLabel, weekday] = formatBusinessDate(date).split(' · ');
    return `${weekday} ${dateLabel}`;
  } catch {
    return `日期不可用 ${date}`;
  }
}

function weekdayOf(dayLabel: string): string {
  return dayLabel.split(' ')[0] ?? dayLabel;
}

function previousBusinessDate(endExclusive: string): string {
  const epoch = Date.parse(`${endExclusive}T00:00:00.000Z`);
  if (!Number.isFinite(epoch)) return '日期不可用';
  const date = new Date(epoch - 86_400_000);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
