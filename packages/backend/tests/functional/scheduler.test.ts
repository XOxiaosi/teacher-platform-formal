import { describe, it, expect, vi, afterEach } from 'vitest';
import { createScheduler } from '../../src/shared/scheduler/index.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler', () => {
  it('register 注册任务并按间隔触发', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const handler = vi.fn();

    const result = scheduler.register({ id: 'task-1', intervalMs: 1000, handler });
    expect(result.ok).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('unregister 注销任务后不再触发', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const handler = vi.fn();
    scheduler.register({ id: 'task-1', intervalMs: 1000, handler });

    const removed = scheduler.unregister('task-1');
    expect(removed.ok).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).not.toHaveBeenCalled();
  });

  it('重复注册同一 id 返回 VALIDATION_ERROR', () => {
    const scheduler = createScheduler();
    const handler = vi.fn();
    scheduler.register({ id: 'task-1', intervalMs: 1000, handler });

    const result = scheduler.register({ id: 'task-1', intervalMs: 1000, handler });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('注销不存在任务返回 NOT_FOUND', () => {
    const scheduler = createScheduler();
    const result = scheduler.unregister('missing');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});
