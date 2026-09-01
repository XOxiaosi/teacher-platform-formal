import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgendaItem,
  AgendaWeekDocument,
  ObjectReference,
} from '@teacher-platform/contracts';

interface WeekApiLike {
  getWeek(teacherId: string, weekStart?: string): Promise<AgendaWeekDocument>;
}

interface WeekScheduleViewProps {
  teacherId: string;
  weekStart?: string;
  focusScheduleId?: string;
  onNavigate: (path: string) => void;
  api?: WeekApiLike;
}

interface WeekViewModule {
  WeekScheduleView?: ComponentType<WeekScheduleViewProps>;
}

const days = [
  '2030-07-22',
  '2030-07-23',
  '2030-07-24',
  '2030-07-25',
  '2030-07-26',
  '2030-07-27',
  '2030-07-28',
];

function reference(type: ObjectReference['type'], objectId: string, label: string): ObjectReference {
  return { id: `${type}:${objectId}`, type, objectId, label };
}

function lesson(id: string, title: string, startAt: string, endAt: string): AgendaItem {
  const sourceRef = reference('Schedule', id, title);
  return {
    id: `schedule:${id}`,
    kind: 'lesson',
    title,
    startAt,
    endAt,
    allDay: false,
    status: 'planned',
    sourceRef,
    actions: [{
      id: `open:${id}`,
      kind: 'open-reference',
      label: `查看${title}`,
      referenceId: sourceRef.id,
    }],
  };
}

function weekDocument(overrides: Partial<AgendaWeekDocument> = {}): AgendaWeekDocument {
  const memoRef = reference('Memo', 'memo-1', '补发讲义');
  return {
    schemaVersion: 1,
    timeZone: 'Asia/Shanghai',
    weekStart: '2030-07-22',
    weekEndExclusive: '2030-07-29',
    generatedAt: '2030-07-22T01:00:00.000Z',
    days: days.map((date, index) => ({
      date,
      items: index === 0 ? [{
        id: 'memo:memo-1',
        kind: 'memo',
        title: '补发讲义',
        startAt: '2030-07-22T02:00:00.000Z',
        allDay: true,
        status: 'active',
        sourceRef: memoRef,
        actions: [],
      }] : index === 2 ? [
        lesson('schedule-a', '课程A', '2030-07-24T01:00:00.000Z', '2030-07-24T03:00:00.000Z'),
        lesson('schedule-b', '课程B', '2030-07-24T02:00:00.000Z', '2030-07-24T04:00:00.000Z'),
      ] : [],
    })),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function loadWeekView(): Promise<ComponentType<WeekScheduleViewProps> | undefined> {
  let module: WeekViewModule = {};
  try {
    const modulePath = './WeekScheduleView';
    module = await import(/* @vite-ignore */ modulePath) as unknown as WeekViewModule;
  } catch {
    module = {};
  }
  expect(module.WeekScheduleView).toBeTypeOf('function');
  return module.WeekScheduleView;
}

function defineScrollIntoView() {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
}

describe('WeekScheduleView', () => {
  it('默认读取可信周并渲染七天、全日项、真实课程位置与安全动作', async () => {
    const Component = await loadWeekView();
    if (!Component) return;
    const api: WeekApiLike = { getWeek: vi.fn().mockResolvedValue(weekDocument()) };
    const onNavigate = vi.fn();

    render(<Component teacherId="teacher-a" api={api} onNavigate={onNavigate} />);

    expect(screen.getByText('正在加载周课程表')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '周课程表' })).toBeInTheDocument();
    for (const label of ['星期一 7月22日', '星期二 7月23日', '星期三 7月24日', '星期四 7月25日', '星期五 7月26日', '星期六 7月27日', '星期日 7月28日']) {
      expect(screen.getByRole('heading', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText('补发讲义')).toBeInTheDocument();

    const courseA = screen.getByRole('article', { name: /星期三 09:00至11:00 课程A 计划中/ });
    expect(courseA).toHaveAttribute('data-start-minute', '540');
    expect(courseA).toHaveAttribute('data-end-minute', '660');
    expect(courseA).toHaveAttribute('data-lane', '0');
    expect(courseA).toHaveAttribute('data-lane-count', '2');
    expect(courseA).toHaveStyle({
      top: '7.142857142857142%',
      height: '14.285714285714285%',
    });

    fireEvent.click(screen.getByRole('link', { name: '查看课程A' }));
    expect(onNavigate).toHaveBeenCalledWith('/schedules?focus=schedule-a');
    expect(api.getWeek).toHaveBeenCalledWith('teacher-a');
  });

  it('显式周查询准确，前后周和本周只生成受控route', async () => {
    const Component = await loadWeekView();
    if (!Component) return;
    const api: WeekApiLike = { getWeek: vi.fn().mockResolvedValue(weekDocument()) };
    const onNavigate = vi.fn();

    render(
      <Component
        teacherId="teacher-a"
        weekStart="2030-07-22"
        api={api}
        onNavigate={onNavigate}
      />,
    );
    await screen.findByRole('heading', { name: '周课程表' });

    expect(api.getWeek).toHaveBeenCalledWith('teacher-a', '2030-07-22');
    fireEvent.click(screen.getByRole('button', { name: '上一周' }));
    fireEvent.click(screen.getByRole('button', { name: '下一周' }));
    fireEvent.click(screen.getByRole('button', { name: '返回本周' }));
    expect(onNavigate.mock.calls).toEqual([
      ['/schedules?weekStart=2030-07-15'],
      ['/schedules?weekStart=2030-07-29'],
      ['/schedules'],
    ]);
  });

  it('首次失败显示局部错误并可重试同一周', async () => {
    const Component = await loadWeekView();
    if (!Component) return;
    const api: WeekApiLike = {
      getWeek: vi.fn()
        .mockRejectedValueOnce(new Error('week down'))
        .mockResolvedValueOnce(weekDocument()),
    };

    render(<Component teacherId="teacher-a" api={api} onNavigate={() => undefined} />);

    expect(await screen.findByRole('heading', { name: '周课程表加载失败' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('week down');
    fireEvent.click(screen.getByRole('button', { name: '重试周课程表' }));

    expect(await screen.findByText('课程A')).toBeInTheDocument();
    expect(api.getWeek).toHaveBeenCalledTimes(2);
  });

  it('刷新失败保留上一份成功周文档', async () => {
    const Component = await loadWeekView();
    if (!Component) return;
    const api: WeekApiLike = { getWeek: vi.fn().mockResolvedValue(weekDocument()) };

    render(<Component teacherId="teacher-a" api={api} onNavigate={() => undefined} />);
    await screen.findByText('课程A');
    vi.mocked(api.getWeek).mockRejectedValueOnce(new Error('refresh week down'));

    fireEvent.click(screen.getByRole('button', { name: '刷新课表' }));

    expect(await screen.findByText('刷新失败：refresh week down')).toBeInTheDocument();
    expect(screen.getByText('课程A')).toBeInTheDocument();
  });

  it('weekStart切换后忽略较旧周响应', async () => {
    const Component = await loadWeekView();
    if (!Component) return;
    const oldWeek = deferred<AgendaWeekDocument>();
    const newWeek = deferred<AgendaWeekDocument>();
    const api: WeekApiLike = {
      getWeek: vi.fn()
        .mockReturnValueOnce(oldWeek.promise)
        .mockReturnValueOnce(newWeek.promise),
    };
    const { rerender } = render(
      <Component teacherId="teacher-a" weekStart="2030-07-22" api={api} onNavigate={() => undefined} />,
    );
    rerender(
      <Component teacherId="teacher-a" weekStart="2030-07-29" api={api} onNavigate={() => undefined} />,
    );

    await act(async () => {
      newWeek.resolve(weekDocument({
        weekStart: '2030-07-29',
        weekEndExclusive: '2030-08-05',
        days: ['2030-07-29', '2030-07-30', '2030-07-31', '2030-08-01', '2030-08-02', '2030-08-03', '2030-08-04']
          .map((date, index) => ({ date, items: index === 0 ? [lesson('new-week', '新周课程', '2030-07-29T01:00:00.000Z', '2030-07-29T02:00:00.000Z')] : [] })),
      }));
    });
    expect(await screen.findByText('新周课程')).toBeInTheDocument();

    await act(async () => {
      oldWeek.resolve(weekDocument());
    });
    await waitFor(() => expect(screen.queryByText('课程A')).not.toBeInTheDocument());
  });

  it('非法Week文档进入稳定协议错误态', async () => {
    const Component = await loadWeekView();
    if (!Component) return;
    const invalid = weekDocument();
    invalid.days = invalid.days.slice(0, 6);
    const api: WeekApiLike = { getWeek: vi.fn().mockResolvedValue(invalid) };

    render(<Component teacherId="teacher-a" api={api} onNavigate={() => undefined} />);

    expect(await screen.findByRole('heading', { name: '周课程表数据错误' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('服务端返回的周范围不完整');
  });

  it('focus Schedule命中时高亮并无动画滚动', async () => {
    const Component = await loadWeekView();
    if (!Component) return;
    defineScrollIntoView();
    const api: WeekApiLike = { getWeek: vi.fn().mockResolvedValue(weekDocument()) };

    render(
      <Component
        teacherId="teacher-a"
        focusScheduleId="schedule-a"
        api={api}
        onNavigate={() => undefined}
      />,
    );

    const focused = await screen.findByRole('article', { name: /课程A/ });
    expect(focused).toHaveAttribute('aria-current', 'true');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  });
});
