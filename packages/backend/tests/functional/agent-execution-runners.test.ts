import { describe, expect, it, vi } from 'vitest';
import { internalError, ok } from '@teacher-platform/contracts';
import {
  createExecutionRunners,
  DEFAULT_MODEL_TIMEOUT_MS,
} from '../../src/app/reliability/execution-runners.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('P5.3 execution runners', () => {
  it('生产默认模型 deadline 为 90 秒', () => {
    expect(DEFAULT_MODEL_TIMEOUT_MS).toBe(90_000);
  });
  it('模型超过 deadline 返回稳定 timeout，不等待迟到结果', async () => {
    const pending = deferred<ReturnType<typeof ok<{ content: string }>>>();
    const log = vi.fn();
    const runners = createExecutionRunners({ modelTimeoutMs: 5, readToolTimeoutMs: 5, log });
    const result = await runners.runModel(() => pending.promise, 'execution-model-1');

    expect(result).toEqual({ ok: false, error: internalError('模型响应超时') });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      executionId: 'execution-model-1', toolName: 'model.chat', status: 'timeout',
    }));
  });

  it('read 工具执行 timeout 并记录结构化耗时状态', async () => {
    const log = vi.fn();
    const pending = deferred<ReturnType<typeof ok<unknown>>>();
    const runners = createExecutionRunners({ modelTimeoutMs: 5, readToolTimeoutMs: 5, log });
    const result = await runners.runTool({
      executionId: 'execution-1', toolCallId: 'call-1', toolName: 'students.search', sideEffect: 'read',
    }, () => pending.promise);

    expect(result).toEqual({ ok: false, error: internalError('工具执行超时') });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      executionId: 'execution-1', toolName: 'students.search', status: 'timeout',
    }));
  });

  it('write 工具不使用 deadline race，等待真实结果', async () => {
    const pending = deferred<ReturnType<typeof ok<{ id: string }>>>();
    const runners = createExecutionRunners({ modelTimeoutMs: 5, readToolTimeoutMs: 5 });
    const running = runners.runTool({
      executionId: 'execution-1', toolCallId: 'call-1', toolName: 'students.create', sideEffect: 'create',
    }, () => pending.promise);
    await new Promise((resolve) => setTimeout(resolve, 12));
    pending.resolve(ok({ id: 'student-1' }));

    await expect(running).resolves.toEqual(ok({ id: 'student-1' }));
  });
});
