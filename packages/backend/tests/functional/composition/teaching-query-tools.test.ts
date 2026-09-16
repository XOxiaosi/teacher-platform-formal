import { describe, expect, it, vi } from 'vitest';
import { createTeachingQueryTools } from '../../../src/app/teaching-runtime/teaching-query-tools.js';
import { createUnavailableTeachingRuntime } from '../../../src/app/teaching-runtime/runtime-driver.js';
import type { ToolDefinition, ToolRegistry } from '../../../src/shared/tool-registry/types.js';

function fixture() {
  const definitions: ToolDefinition[] = [
    { name: 'students.get', description: '查询学生', parameters: {}, sideEffect: 'read' },
    { name: 'scheduling.complete', description: '完课', parameters: {}, sideEffect: 'update', confirmation: 'required' },
    { name: 'shell', description: 'Shell', parameters: {}, sideEffect: 'read' },
  ];
  const execute = vi.fn(async () => ({ ok: true as const, value: { id: 'student-a' } }));
  const registry: ToolRegistry = { list: () => definitions, execute, register: vi.fn() };
  return { definitions, execute, tools: createTeachingQueryTools(registry, 'teacher-a') };
}

describe('A02 teaching query boundary', () => {
  it('exposes only audited reads and blocks legacy confirmation and arbitrary plugins', async () => {
    const { tools, execute } = fixture();
    expect(tools.definitions.map((tool) => tool.name)).toEqual(['students.get']);
    expect((await tools.execute('scheduling.complete', {})).ok).toBe(false);
    expect((await tools.execute('shell', {})).ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('binds queries to authenticated identity and rejects model-provided credentials or identity', async () => {
    const { tools, execute } = fixture();
    expect((await tools.execute('students.get', { studentId: 'student-a' })).ok).toBe(true);
    expect(execute).toHaveBeenCalledWith('students.get', { studentId: 'student-a' }, { teacherId: 'teacher-a' });
    execute.mockClear();
    for (const args of [null, [], 'text', { teacherId: 'teacher-b' }, { apiKey: 'fake' }]) {
      expect((await tools.execute('students.get', args)).ok).toBe(false);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('rechecks side effects at execution and does not trust a mutable tool list', async () => {
    const { tools, definitions, execute } = fixture();
    definitions[0].sideEffect = 'update';
    expect((await tools.execute('students.get', {})).ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('unconfigured runtime fails without invoking a tool or returning a fabricated answer', async () => {
    const { tools, execute } = fixture();
    const result = await createUnavailableTeachingRuntime().run({
      teacherId: 'teacher-a', taskId: 'task-a', executionId: 'execution-a',
      message: '请查询学生', sessionRef: null, contextEpoch: 0, checkpoint: null, history: [], tools,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('AI 服务尚未连接');
    expect(execute).not.toHaveBeenCalled();
  });
});
