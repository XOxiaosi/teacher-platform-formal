import { describe, expect, it } from 'vitest';
import { createToolRegistry } from '../../../src/shared/tool-registry/index.js';
import { registerP0StateTools } from '../../../src/app/tools/register-p0-state-tools.js';

const ACTIONS = [
  'scheduling.cancel',
  'students.updateStatus',
] as const;

function registry() {
  const value = createToolRegistry();
  registerP0StateTools(value);
  return value;
}

describe('P0 state tool trusted confirmation registration', () => {
  it('只注册仍可确认的两个 required/update 状态工具', () => {
    const definitions = registry().list();

    expect(definitions.map((tool) => tool.name)).toEqual(ACTIONS);
    for (const definition of definitions) {
      expect(definition.confirmation).toBe('required');
      expect(definition.sideEffect).toBe('update');
    }
  });

  it.each([
    ['scheduling.cancel', ['scheduleId']],
    ['students.updateStatus', ['studentId', 'status']],
  ] as const)('%s schema 只暴露白名单字段', (name, fields) => {
    const definition = registry().list().find((tool) => tool.name === name);
    if (!definition) throw new Error(`${name} missing`);
    const parameters = definition.parameters as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };

    expect(Object.keys(parameters.properties)).toEqual(fields);
    expect(parameters.required).toEqual(fields);
    expect(parameters.additionalProperties).toBe(false);
    expect(JSON.stringify(parameters)).not.toContain('confirm');
    expect(JSON.stringify(parameters)).not.toContain('actionToken');
    expect(JSON.stringify(parameters)).not.toContain('teacherId');
  });

  it.each(['scheduling.complete', 'lessons.updateStatus'] as const)('%s 不再暴露给模型', (name) => {
    expect(registry().list().some((tool) => tool.name === name)).toBe(false);
  });

  it.each(ACTIONS)('%s direct execute 固定 fail-closed', async (name) => {
    const result = await registry().execute(name, {
      confirm: true,
      actionToken: 'forged',
      teacherId: 'other',
    }, { teacherId: 'teacher-1' });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: '该工具必须通过 ConfirmationGateway 创建待确认操作',
        field: 'confirmation',
      },
    });
  });
});
