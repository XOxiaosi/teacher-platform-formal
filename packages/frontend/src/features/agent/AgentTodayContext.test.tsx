import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AgendaItem, AgendaTodayDocument, ObjectReference } from '@teacher-platform/contracts';

interface TodayApiLike {
  getToday(teacherId: string): Promise<AgendaTodayDocument>;
}

interface AgentTodayContextProps {
  teacherId: string;
  onNavigate?: (path: string) => void;
  api?: TodayApiLike;
}

interface ContextModule {
  AgentTodayContext?: ComponentType<AgentTodayContextProps>;
}

const memoReference: ObjectReference = {
  id: 'Memo:memo-1',
  type: 'Memo',
  objectId: 'memo-1',
  label: '备忘',
};

function item(id: string, kind: AgendaItem['kind'], title: string): AgendaItem {
  return {
    id,
    kind,
    title,
    allDay: kind !== 'lesson',
    status: kind === 'pending_action' ? 'pending' : 'active',
    sourceRef: memoReference,
    actions: [],
  };
}

function document(items: AgendaItem[] = []): AgendaTodayDocument {
  return {
    schemaVersion: 1,
    timeZone: 'Asia/Shanghai',
    businessDate: '2030-07-24',
    generatedAt: '2030-07-24T01:00:00.000Z',
    items,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function loadContext(): Promise<ComponentType<AgentTodayContextProps> | undefined> {
  let module: ContextModule = {};
  try {
    const modulePath = './AgentTodayContext';
    module = await import(/* @vite-ignore */ modulePath) as unknown as ContextModule;
  } catch {
    module = {};
  }
  expect(module.AgentTodayContext).toBeTypeOf('function');
  return module.AgentTodayContext;
}

describe('AgentTodayContext', () => {
  it('展示可信数量、最多3条摘要并受控打开Today', async () => {
    const Component = await loadContext();
    if (!Component) return;
    const api: TodayApiLike = {
      getToday: vi.fn().mockResolvedValue(document([
        item('lesson:1', 'lesson', '第一节课'),
        item('pending:1', 'pending_action', '确认调课'),
        item('memo:1', 'memo', '补发讲义'),
        item('memo:2', 'memo', '整理错题'),
      ])),
    };
    const onNavigate = vi.fn();

    render(<Component teacherId="teacher-a" api={api} onNavigate={onNavigate} />);

    expect(screen.getByText('正在加载今日摘要')).toBeInTheDocument();
    expect(await screen.findByText('第一节课')).toBeInTheDocument();
    expect(screen.getByText('1节课程')).toBeInTheDocument();
    expect(screen.getByText('1项待确认')).toBeInTheDocument();
    expect(screen.getByText('2条到期备忘')).toBeInTheDocument();
    expect(screen.getByText('确认调课')).toBeInTheDocument();
    expect(screen.getByText('补发讲义')).toBeInTheDocument();
    expect(screen.queryByText('整理错题')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: '打开今日' }));
    expect(onNavigate).toHaveBeenCalledWith('/today');
    expect(api.getToday).toHaveBeenCalledWith('teacher-a');
  });

  it('失败只显示局部错误且重试只调用Today API', async () => {
    const Component = await loadContext();
    if (!Component) return;
    const api: TodayApiLike = {
      getToday: vi.fn()
        .mockRejectedValueOnce(new Error('agenda down'))
        .mockResolvedValueOnce(document([item('memo:1', 'memo', '重试成功事项')])),
    };

    render(<Component teacherId="teacher-a" api={api} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('agenda down');
    fireEvent.click(screen.getByRole('button', { name: '重试今日摘要' }));

    expect(await screen.findByText('重试成功事项')).toBeInTheDocument();
    expect(api.getToday).toHaveBeenCalledTimes(2);
  });

  it('teacher切换后忽略较旧Today响应', async () => {
    const Component = await loadContext();
    if (!Component) return;
    const teacherA = deferred<AgendaTodayDocument>();
    const teacherB = deferred<AgendaTodayDocument>();
    const api: TodayApiLike = {
      getToday: vi.fn()
        .mockReturnValueOnce(teacherA.promise)
        .mockReturnValueOnce(teacherB.promise),
    };
    const { rerender } = render(<Component teacherId="teacher-a" api={api} />);

    rerender(<Component teacherId="teacher-b" api={api} />);
    await act(async () => {
      teacherB.resolve(document([item('memo:b', 'memo', 'B老师今日事项')]));
    });
    expect(await screen.findByText('B老师今日事项')).toBeInTheDocument();

    await act(async () => {
      teacherA.resolve(document([item('memo:a', 'memo', 'A老师旧事项')]));
    });
    await waitFor(() => expect(screen.queryByText('A老师旧事项')).not.toBeInTheDocument());
  });

  it('成功空文档显示紧凑空态', async () => {
    const Component = await loadContext();
    if (!Component) return;
    const api: TodayApiLike = { getToday: vi.fn().mockResolvedValue(document()) };

    render(<Component teacherId="teacher-a" api={api} />);

    expect(await screen.findByText('今天没有待办事项')).toBeInTheDocument();
    expect(screen.getByText('0节课程')).toBeInTheDocument();
    expect(screen.getByText('0项待确认')).toBeInTheDocument();
    expect(screen.getByText('0条到期备忘')).toBeInTheDocument();
  });
});
