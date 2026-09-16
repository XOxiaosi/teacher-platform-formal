import { describe, expect, it, vi } from 'vitest';
import { createDshTeachingRuntime, dshTeachingSessionId } from '../../../src/app/teaching-runtime/dsh-runtime-driver.js';
import { DSH_PINNED_COMMIT, DSH_TEACHING_PLUGINS, type DshTeachingHost, type DshUsageRecord } from '../../../src/app/teaching-runtime/dsh-adapter-contract.js';
import type { TeachingRuntimeInput } from '../../../src/app/teaching-runtime/runtime-driver.js';

function setup() {
  const input: TeachingRuntimeInput = {
    teacherId: 'teacher-a', taskId: 'task-a', executionId: 'execution-a', contextEpoch: 1,
    message: '查询余额', checkpoint: null, sessionRef: null, history: [], signal: new AbortController().signal,
    tools: { definitions: [{ name: 'students.balance', description: '余额', sideEffect: 'read', parameters: {} }],
      execute: vi.fn(async () => ({ ok: true, value: { remaining: 8 } })) },
  };
  const result = { sessionId: dshTeachingSessionId(input), lastEventSeq: 12, outcome: 'completed' as const,
    reply: '剩余 8 课时', replayed: false, modelCalls: 1, inputTokens: 10, outputTokens: 5, toolCalls: 0 };
  const run = vi.fn(async () => result);
  const host: DshTeachingHost = { commit: DSH_PINNED_COMMIT, model: 'scripted-test-only', plugins: DSH_TEACHING_PLUGINS, run };
  const onUsage = vi.fn<(record: DshUsageRecord) => Promise<void>>(async () => {});
  return { input, host, run, result, onUsage, driver: createDshTeachingRuntime({ host, onUsage }) };
}

describe('fixed DSH teaching lifecycle boundary (scripted model only)', () => {
  it('enforces the commit and exact plugin profile before opening a host', () => {
    const s = setup();
    expect(() => createDshTeachingRuntime({ host: { ...s.host, commit: 'other' }, onUsage: s.onUsage })).toThrow('MISMATCH');
    expect(() => createDshTeachingRuntime({ host: { ...s.host, plugins: [...DSH_TEACHING_PLUGINS, 'shell'] }, onUsage: s.onUsage })).toThrow('MISMATCH');
    expect(s.driver.availability).toBe('test');
    expect(s.run).not.toHaveBeenCalled();
  });

  it('runs exactly one upstream lifecycle, returns a bound checkpoint and attributed usage', async () => {
    const s = setup();
    const output = await s.driver.run(s.input);
    expect(s.run).toHaveBeenCalledTimes(1);
    expect(output).toMatchObject({ ok: true, value: { status: 'succeeded', cost: { synthetic: true, usageStatus: 'reported' },
      checkpoint: { contextEpoch: 1, lastEventKey: `${s.result.sessionId}:event:12` } } });
    expect(s.onUsage).toHaveBeenCalledWith(expect.objectContaining({ teacherId: 'teacher-a', taskId: 'task-a', executionId: 'execution-a',
      replayed: false, currencyAmount: null }));
  });

  it('refuses foreign sessions and stale context before any host activity', async () => {
    const s = setup();
    for (const changed of [{ teacherId: 'teacher-b' }, { taskId: 'task-b' }, { contextEpoch: 2 }]) {
      expect(await s.driver.run({ ...s.input, ...changed, sessionRef: s.result.sessionId })).toMatchObject({ ok: false, error: { field: 'DSH_SESSION_MISMATCH' } });
    }
    expect(await s.driver.run({ ...s.input, sessionRef: s.result.sessionId, checkpoint: {
      schemaVersion: 1, runtimeVersion: 'dsh-v1', contextEpoch: 1, lastEventKey: 'foreign:event:12',
    } })).toMatchObject({ ok: false, error: { field: 'DSH_CHECKPOINT_INVALID' } });
    expect(s.run).not.toHaveBeenCalled();
  });

  it('filters shell/write definitions and refuses smuggled identity at execution', async () => {
    const s = setup();
    s.input.tools.definitions = [...s.input.tools.definitions,
      { name: 'Shell', description: 'bad', sideEffect: 'read', parameters: {} },
      { name: 'students.get', description: 'bad', sideEffect: 'update', parameters: {} }];
    s.host.run = async input => {
      expect(input.tools.definitions.map(tool => tool.name)).toEqual(['students.balance']);
      expect(await input.tools.execute('Shell', {})).toMatchObject({ ok: false });
      expect(await input.tools.execute('students.balance', { teacherId: 'teacher-b' })).toMatchObject({ ok: false });
      return s.result;
    };
    expect(await s.driver.run(s.input)).toMatchObject({ ok: false, error: { field: 'DSH_TOOL_DENIED' } });
    expect(s.input.tools.execute).not.toHaveBeenCalled();
  });

  it('passes queries through the platform receipt wrapper and checks definitions again', async () => {
    const s = setup();
    s.host.run = async input => {
      expect(await input.tools.execute('students.balance', { studentId: 'student-a' })).toMatchObject({ ok: true });
      s.input.tools.definitions = [{ ...s.input.tools.definitions[0], sideEffect: 'update' }];
      expect(await input.tools.execute('students.balance', {})).toMatchObject({ ok: false });
      return { ...s.result, toolCalls: 1 };
    };
    expect(await s.driver.run(s.input)).toMatchObject({ ok: false });
    expect(s.input.tools.execute).toHaveBeenCalledTimes(1);
  });

  it('resumes the exact session and reports recovered usage with a stable settlement key', async () => {
    const s = setup();
    s.result.replayed = true;
    await s.driver.run({ ...s.input, sessionRef: s.result.sessionId });
    expect(s.run).toHaveBeenCalledWith(expect.objectContaining({ resume: true, sessionId: s.result.sessionId }));
    expect(s.onUsage).toHaveBeenCalledWith(expect.objectContaining({ replayed: true, eventKey: `${s.result.sessionId}:event:12` }));
  });

  it.each(['failed', 'cancelled', 'outcome_unknown'] as const)('maps %s with honest unknown usage and no fabricated reply', async outcome => {
    const s = setup();
    s.host.run = async () => ({ ...s.result, outcome, inputTokens: null, outputTokens: null });
    const value = await s.driver.run(s.input);
    expect(value).toMatchObject({ ok: false, error: { retryable: outcome !== 'outcome_unknown' } });
    expect(s.onUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome, cost: expect.objectContaining({ usageStatus: 'unknown', inputTokens: null }) }));
  });

  it('maps waiting_input without assuming a write confirmation', async () => {
    const s = setup();
    s.host.run = async () => ({ ...s.result, outcome: 'waiting_input', reply: '是哪位学生？' });
    expect(await s.driver.run(s.input)).toMatchObject({ ok: true, value: { status: 'waiting_input' } });
  });

  it('rejects malformed output, thrown secrets and pre-cancelled input', async () => {
    const s = setup();
    s.host.run = async () => ({ ...s.result, inputTokens: -1 });
    expect(await s.driver.run(s.input)).toMatchObject({ ok: false, error: { field: 'DSH_RESULT_INVALID' } });
    s.host.run = async () => { throw new Error('secret teacher material'); };
    const failed = await s.driver.run(s.input);
    expect(JSON.stringify(failed)).not.toContain('secret');
    expect(failed).toMatchObject({ ok: false, error: { retryable: false } });
    expect(s.onUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'outcome_unknown', cost: expect.objectContaining({ modelCalls: null }) }));
    const controller = new AbortController(); controller.abort();
    expect(await s.driver.run({ ...s.input, signal: controller.signal })).toMatchObject({ ok: false, error: { field: 'DSH_CANCELLED' } });
  });

  it('refuses a checkpoint rollback and a fake replay that actually executes a tool', async () => {
    const s = setup();
    expect(await s.driver.run({ ...s.input, sessionRef: s.result.sessionId, checkpoint: {
      schemaVersion: 1, runtimeVersion: 'dsh-v1', contextEpoch: 1, lastEventKey: `${s.result.sessionId}:event:99`,
    } })).toMatchObject({ ok: false, error: { field: 'DSH_RESULT_INVALID' } });
    s.host.run = async input => {
      await input.tools.execute('students.balance', {});
      return { ...s.result, replayed: true };
    };
    expect(await s.driver.run(s.input)).toMatchObject({ ok: false, error: { field: 'DSH_RESULT_INVALID' } });
  });

  it('does not mark success or call settlement twice when the usage sink rejects', async () => {
    const s = setup();
    s.onUsage.mockRejectedValue(new Error('storage failed'));
    expect(await s.driver.run(s.input)).toMatchObject({ ok: false, error: { retryable: false } });
    expect(s.onUsage).toHaveBeenCalledTimes(1);
  });

  it.each([
    { inputTokens: -1 }, { modelCalls: Number.NaN }, { outputTokens: Number.POSITIVE_INFINITY },
    { lastEventSeq: -2 }, { sessionId: 'sensitive-foreign-session' }, { toolCalls: -1 },
  ])('records malformed host output as unknown using platform identity only: %j', async invalid => {
    const s = setup();
    s.host.run = async input => {
      await input.tools.execute('students.balance', { studentId: 'student-a' });
      return { ...s.result, ...invalid, reply: 'sensitive source material' };
    };
    const result = await s.driver.run(s.input);
    expect(result).toMatchObject({ ok: false, error: { field: 'DSH_RESULT_INVALID', retryable: false } });
    expect(s.onUsage).toHaveBeenCalledTimes(1);
    expect(s.onUsage).toHaveBeenCalledWith({
      teacherId: 'teacher-a', taskId: 'task-a', executionId: 'execution-a', sessionId: s.result.sessionId,
      eventKey: `${s.result.sessionId}:execution:execution-a:unknown`, replayed: false,
      outcome: 'outcome_unknown', currencyAmount: null,
      cost: { modelCalls: null, inputTokens: null, outputTokens: null, toolCalls: 1, synthetic: true, usageStatus: 'unknown' },
    });
    expect(JSON.stringify([result, s.onUsage.mock.calls])).not.toContain('sensitive');
  });

  it('does not retry a rejected unknown-usage write and separates execution settlement keys', async () => {
    const s = setup();
    s.host.run = async () => ({ ...s.result, inputTokens: -1 });
    s.onUsage.mockRejectedValueOnce(new Error('sensitive sink failure'));
    const first = await s.driver.run(s.input);
    expect(first).toMatchObject({ ok: false, error: { retryable: false } });
    expect(s.onUsage).toHaveBeenCalledTimes(1);
    await s.driver.run({ ...s.input, executionId: 'execution-b' });
    expect(s.onUsage).toHaveBeenCalledTimes(2);
    expect(s.onUsage.mock.calls[0][0].eventKey).not.toBe(s.onUsage.mock.calls[1][0].eventKey);
    expect(JSON.stringify(first)).not.toContain('sensitive');
  });
});
