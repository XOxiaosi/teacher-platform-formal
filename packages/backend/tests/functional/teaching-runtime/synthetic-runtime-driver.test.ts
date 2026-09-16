import { describe, expect, it, vi } from 'vitest';
import { createSyntheticTeachingRuntime } from '../../../src/app/teaching-runtime/synthetic-runtime-driver.js';
import { createUnavailableTeachingRuntime, toTaskRuntimeAvailability, type TeachingRuntimeInput } from '../../../src/app/teaching-runtime/runtime-driver.js';

function input() {
  const execute = vi.fn(async () => ({ ok: true as const, value: { remaining: 8 } }));
  return {
    teacherId: 'teacher-a', taskId: 'task-a', executionId: 'execution-a', message: '核对课时',
    sessionRef: null, contextEpoch: 2, checkpoint: null, history: [], signal: new AbortController().signal,
    tools: { definitions: [{ name: 'students.balance', description: 'query', parameters: {}, sideEffect: 'read' }], execute },
    execute,
  } satisfies TeachingRuntimeInput & { execute: ReturnType<typeof vi.fn> };
}

describe('A02 local synthetic teaching runtime', () => {
  it('executes only query tools and reports explicitly synthetic zero model cost', async () => {
    const value = input();
    const driver = createSyntheticTeachingRuntime({ actions: [
      { type: 'query', tool: 'students.balance', args: { studentId: 'student-a' } },
      { type: 'reply', content: '当前剩余 8 课时。' },
    ] });
    const result = await driver.run(value);
    expect(result).toMatchObject({ ok: true, value: { status: 'succeeded', sessionRef: 'synthetic:task-a', cost: { synthetic: true, modelCalls: 0, toolCalls: 1 }, checkpoint: { contextEpoch: 2 } } });
    expect(value.execute).toHaveBeenCalledWith('students.balance', { studentId: 'student-a' });
  });

  it('returns a checkpoint token for the platform to persist and pass back', async () => {
    const paused = await createSyntheticTeachingRuntime({ actions: [{ type: 'pause' }] }).run(input());
    expect(paused).toMatchObject({ ok: true, value: { status: 'waiting_input', sessionRef: 'synthetic:task-a' } });
    const resumed = await createSyntheticTeachingRuntime({ actions: [{ type: 'reply', content: '已补齐信息。' }] }).run({ ...input(), sessionRef: paused.ok ? paused.value.sessionRef : null });
    expect(resumed).toMatchObject({ ok: true, value: { status: 'succeeded', sessionRef: 'synthetic:task-a' } });
  });

  it('maps tool, cancellation, and planned failures without pretending a result exists', async () => {
    const toolFailure = input();
    toolFailure.execute.mockResolvedValueOnce({ ok: false, error: { code: 'NOT_FOUND', message: '不属于该教师' } });
    await expect(createSyntheticTeachingRuntime({ actions: [{ type: 'query', tool: 'shell', args: {} }] }).run(toolFailure)).resolves.toMatchObject({ ok: false });
    const controller = new AbortController(); controller.abort();
    await expect(createSyntheticTeachingRuntime({ actions: [{ type: 'reply', content: '不可达' }] }).run({ ...input(), signal: controller.signal })).resolves.toMatchObject({ ok: false, error: { field: 'RUNTIME_CANCELLED' } });
    await expect(createSyntheticTeachingRuntime({ actions: [{ type: 'fail', code: 'UPSTREAM_TIMEOUT', message: '超时', retryable: true }] }).run(input())).resolves.toMatchObject({ ok: false, error: { field: 'UPSTREAM_TIMEOUT' } });
  });

  it('rejects a successful fake shell tool before execute is called', async () => {
    const value = input();
    value.tools.definitions = [{ name: 'shell', description: 'forbidden', parameters: {}, sideEffect: 'read' }];
    await expect(createSyntheticTeachingRuntime({ actions: [{ type: 'query', tool: 'shell', args: {} }] }).run(value)).resolves.toMatchObject({ ok: false, error: { field: 'tool' } });
    expect(value.execute).not.toHaveBeenCalled();
  });

  it('production default remains unavailable and has no synthetic fallback', async () => {
    const value = input();
    const result = await createUnavailableTeachingRuntime().run(value);
    expect(result).toMatchObject({ ok: false, error: { field: 'runtime' } });
    expect(value.execute).not.toHaveBeenCalled();
  });

  it('maps adapter availability explicitly to persisted task availability', () => {
    expect(toTaskRuntimeAvailability('ready')).toBe('available');
    expect(toTaskRuntimeAvailability('test')).toBe('test_only');
    expect(toTaskRuntimeAvailability('unavailable')).toBe('unavailable');
  });
});
