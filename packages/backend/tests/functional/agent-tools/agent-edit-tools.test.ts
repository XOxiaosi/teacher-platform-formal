import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { createMinimalToolRegistry } from '../../../src/app/tool-registration.js';

const EDIT_TOOL_NAMES = [
  'students.updateProfile',
  'scheduling.reschedule',
  'lessons.updateRecord',
  'payments.update',
  'memos.update',
  'feedback.updateContent',
] as const;

const EXPECTED_PROPERTIES = {
  'students.updateProfile': ['studentId', 'changes'],
  'scheduling.reschedule': ['scheduleId', 'replacement'],
  'lessons.updateRecord': ['lessonId', 'changes'],
  'payments.update': ['paymentId', 'changes'],
  'memos.update': ['memoId', 'changes'],
  'feedback.updateContent': ['feedbackId', 'changes'],
} as const;

function createRegistry() {
  return createMinimalToolRegistry({
    prisma: {} as PrismaClient,
    trustedClock: { now: async () => ({ ok: true as const, value: new Date(0) }) },
  });
}

describe('A5-I9a Agent 普通编辑工具', () => {
  it('注册六个 required update 工具并提供 exact 顶层 schema', () => {
    const tools = new Map(createRegistry().list().map((tool) => [tool.name, tool]));

    for (const name of EDIT_TOOL_NAMES) {
      const tool = tools.get(name);
      expect(tool, name).toBeDefined();
      expect(tool?.sideEffect).toBe('update');
      expect(tool?.confirmation).toBe('required');
      expect(tool?.parameters.type).toBe('object');
      expect(tool?.parameters.additionalProperties).toBe(false);
      expect(tool?.parameters.required).toEqual(EXPECTED_PROPERTIES[name]);
      expect(Object.keys(tool?.parameters.properties as object).sort()).toEqual(
        [...EXPECTED_PROPERTIES[name]].sort(),
      );
    }
  });

  it('模型 schema 不暴露身份、来源、版本、确认或 token 字段', () => {
    const forbidden = [
      'teacherId',
      'source',
      'expectedUpdatedAt',
      'confirm',
      'actionToken',
      'table',
      'model',
      'field',
      'path',
    ];
    const tools = createRegistry().list().filter((tool) => (
      EDIT_TOOL_NAMES.includes(tool.name as (typeof EDIT_TOOL_NAMES)[number])
    ));

    for (const tool of tools) {
      const serialized = JSON.stringify(tool.parameters);
      for (const field of forbidden) expect(serialized).not.toContain(`\"${field}\"`);
    }
  });

  it.each(EDIT_TOOL_NAMES)('%s handler 直接调用 fail-closed', async (name) => {
    const result = await createRegistry().execute(name, {}, { teacherId: 'teacher-1' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error(`${name} unexpectedly executed`);
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('confirmation');
  });
});
