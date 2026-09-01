import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { createMinimalToolRegistry } from '../../src/app/tool-registration.js';

const EXPECTED_NESTED_FIELDS = {
  'students.updateProfile': ['name', 'grade', 'stageGoal'],
  'scheduling.reschedule': ['scheduledStart', 'scheduledEnd'],
  'lessons.updateRecord': ['progress', 'studentState', 'homework', 'teacherNote'],
  'payments.update': ['amount', 'lessonCount', 'paidAt', 'note'],
  'memos.update': ['title', 'content', 'dueAt', 'tags'],
  'feedback.updateContent': ['title', 'content'],
} as const;

function editTools() {
  const registry = createMinimalToolRegistry({
    prisma: {} as PrismaClient,
    trustedClock: { now: async () => ({ ok: true as const, value: new Date(0) }) },
  });
  return new Map(registry.list().map((tool) => [tool.name, tool]));
}

describe('A5-I9a Agent 编辑 schema 边界', () => {
  it('六工具 nested changes/replacement 只包含既有 typed command 白名单', () => {
    const tools = editTools();

    for (const [name, expectedFields] of Object.entries(EXPECTED_NESTED_FIELDS)) {
      const parameters = tools.get(name)?.parameters as {
        properties?: Record<string, { properties?: Record<string, unknown>; additionalProperties?: boolean }>;
      } | undefined;
      expect(parameters, name).toBeDefined();
      const nestedName = name === 'scheduling.reschedule' ? 'replacement' : 'changes';
      const nested = parameters?.properties?.[nestedName];
      expect(nested?.additionalProperties, name).toBe(false);
      expect(Object.keys(nested?.properties ?? {}).sort()).toEqual([...expectedFields].sort());
    }
  });

  it('工具注册模块不接收 Prisma 或 typed command，handler 只能拒绝直接执行', async () => {
    const tools = editTools();
    for (const name of Object.keys(EXPECTED_NESTED_FIELDS)) {
      const result = await createMinimalToolRegistry({
        prisma: {} as PrismaClient,
        trustedClock: { now: async () => ({ ok: true as const, value: new Date(0) }) },
      }).execute(name, { teacherId: 'forbidden', source: 'system' }, { teacherId: 'teacher-1' });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`${name} unexpectedly executed`);
      expect(result.error.field).toBe('confirmation');
    }
    expect(tools.size).toBeGreaterThan(0);
  });
});
