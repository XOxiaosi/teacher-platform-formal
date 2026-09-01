import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgendaItem, AgendaWeekDocument, ObjectReference } from '@teacher-platform/contracts';

interface LessonLayout {
  item: AgendaItem;
  startMinute: number;
  endMinute: number;
  lane: number;
  laneCount: number;
}

interface WeekDayLayout {
  date: string;
  allDayItems: AgendaItem[];
  lessons: LessonLayout[];
  invalidLessons: AgendaItem[];
}

interface WeekScheduleLayout {
  startHour: number;
  endHour: number;
  days: WeekDayLayout[];
}

interface WeekScheduleModule {
  isValidAgendaWeek?: (document: AgendaWeekDocument) => boolean;
  buildWeekScheduleLayout?: (document: AgendaWeekDocument) => WeekScheduleLayout;
  shiftWeekStart?: (weekStart: string, amountWeeks: number) => string;
}

const scheduleReference: ObjectReference = {
  id: 'Schedule:schedule-1',
  type: 'Schedule',
  objectId: 'schedule-1',
  label: '课程',
};

function agendaItem(overrides: Partial<AgendaItem> & Pick<AgendaItem, 'id' | 'kind' | 'title'>): AgendaItem {
  const { id, kind, title, ...optional } = overrides;
  return {
    id,
    kind,
    title,
    allDay: kind !== 'lesson',
    status: kind === 'lesson' ? 'planned' : 'active',
    sourceRef: scheduleReference,
    actions: [],
    ...optional,
  };
}

function weekDocument(): AgendaWeekDocument {
  return {
    schemaVersion: 1,
    timeZone: 'Asia/Shanghai',
    weekStart: '2030-07-22',
    weekEndExclusive: '2030-07-29',
    generatedAt: '2030-07-24T01:00:00.000Z',
    days: [
      '2030-07-22',
      '2030-07-23',
      '2030-07-24',
      '2030-07-25',
      '2030-07-26',
      '2030-07-27',
      '2030-07-28',
    ].map((date) => ({ date, items: [] })),
  };
}

async function loadWeekSchedule(): Promise<Required<WeekScheduleModule> | undefined> {
  let module: WeekScheduleModule = {};
  try {
    const modulePath = './week-schedule';
    module = await import(/* @vite-ignore */ modulePath) as unknown as WeekScheduleModule;
  } catch {
    module = {};
  }
  expect(module).toMatchObject({
    isValidAgendaWeek: expect.any(Function),
    buildWeekScheduleLayout: expect.any(Function),
    shiftWeekStart: expect.any(Function),
  });
  if (!module.isValidAgendaWeek || !module.buildWeekScheduleLayout || !module.shiftWeekStart) {
    return undefined;
  }
  return module as Required<WeekScheduleModule>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Week schedule pure layout', () => {
  it('只接受周一开始、连续7天且与weekEndExclusive闭合的文档', async () => {
    const schedule = await loadWeekSchedule();
    if (!schedule) return;
    const valid = weekDocument();
    const missingDay = { ...valid, days: valid.days.slice(0, 6) };
    const duplicateDay = {
      ...valid,
      days: valid.days.map((day, index) => index === 3 ? { ...day, date: '2030-07-24' } : day),
    };
    const wrongEnd = { ...valid, weekEndExclusive: '2030-07-30' };

    expect(schedule.isValidAgendaWeek(valid)).toBe(true);
    expect(schedule.isValidAgendaWeek(missingDay)).toBe(false);
    expect(schedule.isValidAgendaWeek(duplicateDay)).toBe(false);
    expect(schedule.isValidAgendaWeek(wrongEnd)).toBe(false);
    expect(() => schedule.buildWeekScheduleLayout(missingDay)).toThrow(RangeError);
  });

  it('跨日lesson按每个BusinessDate边界裁剪且派生完整可视范围', async () => {
    const schedule = await loadWeekSchedule();
    if (!schedule) return;
    const document = weekDocument();
    const crossDay = agendaItem({
      id: 'schedule:cross',
      kind: 'lesson',
      title: '跨日课程',
      startAt: '2030-07-22T15:30:00.000Z',
      endAt: '2030-07-23T01:00:00.000Z',
      allDay: false,
    });
    document.days[0]?.items.push(crossDay);
    document.days[1]?.items.push(crossDay);

    const layout = schedule.buildWeekScheduleLayout(document);

    expect(layout.startHour).toBe(0);
    expect(layout.endHour).toBe(24);
    expect(layout.days[0]?.lessons).toEqual([
      expect.objectContaining({ item: crossDay, startMinute: 1410, endMinute: 1440 }),
    ]);
    expect(layout.days[1]?.lessons).toEqual([
      expect.objectContaining({ item: crossDay, startMinute: 0, endMinute: 540 }),
    ]);
  });

  it('重叠课程确定性分lane，相接边界复用lane且不属于前一cluster', async () => {
    const schedule = await loadWeekSchedule();
    if (!schedule) return;
    const document = weekDocument();
    document.days[2]!.items = [
      agendaItem({
        id: 'schedule:a', kind: 'lesson', title: 'A', allDay: false,
        startAt: '2030-07-24T01:00:00.000Z', endAt: '2030-07-24T03:00:00.000Z',
      }),
      agendaItem({
        id: 'schedule:b', kind: 'lesson', title: 'B', allDay: false,
        startAt: '2030-07-24T02:00:00.000Z', endAt: '2030-07-24T04:00:00.000Z',
      }),
      agendaItem({
        id: 'schedule:c', kind: 'lesson', title: 'C', allDay: false,
        startAt: '2030-07-24T04:00:00.000Z', endAt: '2030-07-24T05:00:00.000Z',
      }),
    ];

    const lessons = schedule.buildWeekScheduleLayout(document).days[2]!.lessons;

    expect(lessons.map(({ item, lane, laneCount }) => ({ id: item.id, lane, laneCount }))).toEqual([
      { id: 'schedule:a', lane: 0, laneCount: 2 },
      { id: 'schedule:b', lane: 1, laneCount: 2 },
      { id: 'schedule:c', lane: 0, laneCount: 1 },
    ]);
  });

  it('全日项与无效lesson分别进入allDayItems和invalidLessons', async () => {
    const schedule = await loadWeekSchedule();
    if (!schedule) return;
    const document = weekDocument();
    const memo = agendaItem({ id: 'memo:1', kind: 'memo', title: '备忘' });
    const invalidLesson = agendaItem({
      id: 'schedule:invalid',
      kind: 'lesson',
      title: '时间错误课程',
      startAt: 'invalid',
      endAt: '2030-07-24T04:00:00.000Z',
      allDay: false,
    });
    document.days[2]!.items = [memo, invalidLesson];

    const day = schedule.buildWeekScheduleLayout(document).days[2]!;

    expect(day.allDayItems).toEqual([memo]);
    expect(day.lessons).toEqual([]);
    expect(day.invalidLessons).toEqual([invalidLesson]);
  });

  it('前后周只从显式weekStart加减7天且不读取Date.now', async () => {
    const schedule = await loadWeekSchedule();
    if (!schedule) return;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('local clock must not be read');
    });

    expect(schedule.shiftWeekStart('2030-07-22', -1)).toBe('2030-07-15');
    expect(schedule.shiftWeekStart('2030-07-22', 1)).toBe('2030-07-29');
    expect(schedule.shiftWeekStart('2030-07-22', 3)).toBe('2030-08-12');
    expect(() => schedule.shiftWeekStart('2030-07-23', 1)).toThrow(RangeError);
  });
});
