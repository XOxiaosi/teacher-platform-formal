import type { AgendaItem, AgendaWeekDocument } from '@teacher-platform/contracts';

const BUSINESS_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MILLISECONDS = 86_400_000;
const SHANGHAI_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1_000;

interface ParsedBusinessDate {
  epoch: number;
  weekday: number;
}

export interface LessonLayout {
  item: AgendaItem;
  startMinute: number;
  endMinute: number;
  lane: number;
  laneCount: number;
}

export interface WeekDayLayout {
  date: string;
  allDayItems: AgendaItem[];
  lessons: LessonLayout[];
  invalidLessons: AgendaItem[];
}

export interface WeekScheduleLayout {
  startHour: number;
  endHour: number;
  days: WeekDayLayout[];
}

function parseBusinessDate(value: string): ParsedBusinessDate | null {
  const match = BUSINESS_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const epoch = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(epoch)) return null;
  const parsed = new Date(epoch);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return null;
  return { epoch, weekday: parsed.getUTCDay() };
}

function addDays(value: string, amount: number): string | null {
  const parsed = parseBusinessDate(value);
  if (!parsed || !Number.isInteger(amount)) return null;
  const result = new Date(parsed.epoch + amount * DAY_MILLISECONDS);
  const year = String(result.getUTCFullYear()).padStart(4, '0');
  const month = String(result.getUTCMonth() + 1).padStart(2, '0');
  const day = String(result.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isValidAgendaWeek(document: AgendaWeekDocument): boolean {
  const start = parseBusinessDate(document.weekStart);
  if (
    document.schemaVersion !== 1
    || document.timeZone !== 'Asia/Shanghai'
    || !start
    || start.weekday !== 1
    || document.days.length !== 7
    || document.weekEndExclusive !== addDays(document.weekStart, 7)
  ) return false;

  return document.days.every(
    (day, index) => day.date === addDays(document.weekStart, index),
  );
}

export function shiftWeekStart(weekStart: string, amountWeeks: number): string {
  const parsed = parseBusinessDate(weekStart);
  if (!parsed || parsed.weekday !== 1 || !Number.isInteger(amountWeeks)) {
    throw new RangeError(`Invalid week offset: ${weekStart}, ${amountWeeks}`);
  }
  const shifted = addDays(weekStart, amountWeeks * 7);
  if (!shifted) throw new RangeError(`Invalid week offset: ${weekStart}, ${amountWeeks}`);
  return shifted;
}

function shanghaiDayStart(date: string): number {
  const parsed = parseBusinessDate(date);
  if (!parsed) throw new RangeError(`Invalid BusinessDate: ${date}`);
  return parsed.epoch - SHANGHAI_OFFSET_MILLISECONDS;
}

function toLessonLayout(item: AgendaItem, date: string): LessonLayout | null {
  if (!item.startAt || !item.endAt) return null;
  const start = Date.parse(item.startAt);
  const end = Date.parse(item.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const dayStart = shanghaiDayStart(date);
  const dayEnd = dayStart + DAY_MILLISECONDS;
  const clippedStart = Math.max(start, dayStart);
  const clippedEnd = Math.min(end, dayEnd);
  if (clippedEnd <= clippedStart) return null;

  return {
    item,
    startMinute: (clippedStart - dayStart) / 60_000,
    endMinute: (clippedEnd - dayStart) / 60_000,
    lane: 0,
    laneCount: 1,
  };
}

function compareLessons(left: LessonLayout, right: LessonLayout): number {
  return left.startMinute - right.startMinute
    || left.endMinute - right.endMinute
    || left.item.id.localeCompare(right.item.id);
}

function assignClusterLanes(cluster: readonly LessonLayout[]): LessonLayout[] {
  const laneEnds: number[] = [];
  const assigned = cluster.map((lesson) => {
    const reusableLane = laneEnds.findIndex((endMinute) => endMinute <= lesson.startMinute);
    const lane = reusableLane === -1 ? laneEnds.length : reusableLane;
    laneEnds[lane] = lesson.endMinute;
    return { ...lesson, lane };
  });
  const laneCount = laneEnds.length;
  return assigned.map((lesson) => ({ ...lesson, laneCount }));
}

function assignLanes(lessons: readonly LessonLayout[]): LessonLayout[] {
  const result: LessonLayout[] = [];
  let cluster: LessonLayout[] = [];
  let clusterEnd = -1;

  const flush = () => {
    result.push(...assignClusterLanes(cluster));
    cluster = [];
    clusterEnd = -1;
  };

  for (const lesson of lessons) {
    if (cluster.length > 0 && lesson.startMinute >= clusterEnd) flush();
    cluster.push(lesson);
    clusterEnd = Math.max(clusterEnd, lesson.endMinute);
  }
  if (cluster.length > 0) flush();
  return result;
}

function buildDayLayout(date: string, items: readonly AgendaItem[]): WeekDayLayout {
  const allDayItems: AgendaItem[] = [];
  const invalidLessons: AgendaItem[] = [];
  const lessonCandidates: LessonLayout[] = [];

  for (const item of items) {
    if (item.allDay) {
      allDayItems.push(item);
    } else if (item.kind === 'lesson') {
      const lesson = toLessonLayout(item, date);
      if (lesson) lessonCandidates.push(lesson);
      else invalidLessons.push(item);
    }
  }

  return {
    date,
    allDayItems,
    invalidLessons,
    lessons: assignLanes(lessonCandidates.sort(compareLessons)),
  };
}

function visibleRange(days: readonly WeekDayLayout[]): Pick<WeekScheduleLayout, 'startHour' | 'endHour'> {
  const lessons = days.flatMap((day) => day.lessons);
  if (lessons.length === 0) return { startHour: 8, endHour: 22 };
  const earliest = Math.min(...lessons.map(({ startMinute }) => startMinute));
  const latest = Math.max(...lessons.map(({ endMinute }) => endMinute));
  return {
    startHour: Math.max(0, Math.min(8, Math.floor(earliest / 60))),
    endHour: Math.min(24, Math.max(22, Math.ceil(latest / 60))),
  };
}

export function buildWeekScheduleLayout(document: AgendaWeekDocument): WeekScheduleLayout {
  if (!isValidAgendaWeek(document)) throw new RangeError('Invalid AgendaWeekDocument');
  const days = document.days.map((day) => buildDayLayout(day.date, day.items));
  return { ...visibleRange(days), days };
}
