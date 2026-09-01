import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgendaItem, AgendaWeekDocument, ObjectReference } from '@teacher-platform/contracts';
import { WeekScheduleView } from './WeekScheduleView';

/**
 * P2 移动端：周视图降级为纵向 agenda（复用 AgendaItemView）。
 * 组件用 matchMedia('(max-width: 768px)') 门控移动列表渲染；
 * 桌面测试环境无 matchMedia → 不渲染；本文件显式 mock 为匹配。
 * 注：matchMedia 是 defineProperty 注入（非 spy），跨测试会残留，afterEach 需删除。
 */
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

function weekDocument(): AgendaWeekDocument {
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
  };
}

/** 模拟移动端视口：matchMedia('(max-width: 768px)') → matches: true；并补齐 jsdom 缺失的 scrollIntoView。 */
function mockMobileViewport() {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  const query = {
    matches: true,
    media: '(max-width: 768px)',
    addEventListener: (_type: string, _listener: () => void) => undefined,
    removeEventListener: (_type: string, _listener: () => void) => undefined,
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue(query),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as { matchMedia?: unknown }).matchMedia; // 还原 jsdom“无 matchMedia”默认
});

describe('WeekScheduleView 移动端纵向 agenda', () => {
  it('渲染按天纵向列表：天标题 + 条目（全日备忘与课程），空天显示无安排', async () => {
    mockMobileViewport();
    const api = { getWeek: vi.fn().mockResolvedValue(weekDocument()) };
    render(<WeekScheduleView teacherId="teacher-a" api={api} onNavigate={() => undefined} />);

    expect(await screen.findByRole('heading', { name: '周课程表' })).toBeInTheDocument();

    const mobileAgenda = document.querySelector('.week-mobile-agenda');
    expect(mobileAgenda).not.toBeNull();
    expect(mobileAgenda!.getAttribute('aria-label')).toBe('移动端周日程列表');

    const withinAgenda = within(mobileAgenda as HTMLElement);
    expect(withinAgenda.getByText('补发讲义')).toBeInTheDocument();
    expect(withinAgenda.getByText('课程A')).toBeInTheDocument();
    expect(withinAgenda.getByText('课程B')).toBeInTheDocument();

    const daySections = mobileAgenda!.querySelectorAll('.week-mobile-day');
    expect(daySections.length).toBe(7);
    expect(daySections[0].textContent).toContain('补发讲义');
    expect(daySections[2].textContent).toContain('课程A');
    expect(daySections[2].textContent).toContain('课程B');
    expect(daySections[1].textContent).toContain('无安排');
  });

  it('焦点日程在移动列表上带 focused 标记', async () => {
    mockMobileViewport();
    const api = { getWeek: vi.fn().mockResolvedValue(weekDocument()) };
    render(
      <WeekScheduleView
        teacherId="teacher-a"
        api={api}
        focusScheduleId="schedule-a"
        onNavigate={() => undefined}
      />,
    );

    await screen.findByRole('heading', { name: '周课程表' });

    const focusedItem = document.querySelector('.week-mobile-agenda .agenda-item--focused');
    expect(focusedItem).not.toBeNull();
    expect(focusedItem!.textContent).toContain('课程A');
  });

  it('移动列表条目可触发 onNavigate（复用 AgendaItemView 动作链接）', async () => {
    mockMobileViewport();
    const api = { getWeek: vi.fn().mockResolvedValue(weekDocument()) };
    const onNavigate = vi.fn();
    render(<WeekScheduleView teacherId="teacher-a" api={api} onNavigate={onNavigate} />);

    await screen.findByRole('heading', { name: '周课程表' });

    const mobileAgenda = document.querySelector('.week-mobile-agenda') as HTMLElement;
    const link = within(mobileAgenda).getByRole('link', { name: '查看课程A' });
    link.click();

    expect(onNavigate).toHaveBeenCalled();
  });

  it('桌面视口（无 matchMedia）不渲染移动列表', async () => {
    const api = { getWeek: vi.fn().mockResolvedValue(weekDocument()) };
    render(<WeekScheduleView teacherId="teacher-a" api={api} onNavigate={() => undefined} />);

    await screen.findByRole('heading', { name: '周课程表' });
    expect(document.querySelector('.week-mobile-agenda')).toBeNull();
  });
});
