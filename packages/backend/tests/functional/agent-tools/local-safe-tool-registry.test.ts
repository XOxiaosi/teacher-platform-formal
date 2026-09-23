import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { createMinimalToolRegistry } from '../../../src/app/tool-registration.js';

const DIRECT_WRITE_TOOLS = [
  'students.create',
  'scheduling.create',
  'memos.create',
  'memos.updateStatus',
  'feedback.create',
  'requirements.capture',
  'students.sources.ingest',
  'students.assessments.create',
  'students.communications.capture',
] as const;

const INCOMPLETE_CONFIRMATION_TOOLS = [
  'scheduling.complete',
  'lessons.updateStatus',
] as const;

const prisma = {} as PrismaClient;
const trustedClock = {
  now: async () => ({ ok: true as const, value: new Date(0) }),
};

describe('L0 Agent local-safe tool registry', () => {
  it('list 只暴露 read 或 confirmation=required，隐藏直写与未完成确认工具', () => {
    const registry = createMinimalToolRegistry({
      prisma,
      trustedClock,
      localSafeMode: true,
    });

    const listed = registry.list();
    expect(listed).toHaveLength(18);
    expect(listed.every((tool) => tool.sideEffect === 'read' || tool.confirmation === 'required')).toBe(true);
    expect(listed.filter((tool) => DIRECT_WRITE_TOOLS.includes(tool.name as typeof DIRECT_WRITE_TOOLS[number]))).toEqual([]);
    expect(listed.filter((tool) => INCOMPLETE_CONFIRMATION_TOOLS.includes(tool.name as typeof INCOMPLETE_CONFIRMATION_TOOLS[number]))).toEqual([]);
  });

  it.each(DIRECT_WRITE_TOOLS)('%s 即使按名称直接 execute 也 fail-closed', async (name) => {
    const registry = createMinimalToolRegistry({
      prisma,
      trustedClock,
      localSafeMode: true,
    });

    const result = await registry.execute(name, {}, { teacherId: 'teacher-local-safe' });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        field: 'localSafeMode',
      },
    });
  });

  it('显式 opt-out 恢复直写工具，但仍不暴露未完成确认工具', () => {
    const registry = createMinimalToolRegistry({
      prisma,
      trustedClock,
      localSafeMode: false,
    });

    const listed = registry.list();
    expect(listed).toHaveLength(27);
    expect(listed.filter((tool) => INCOMPLETE_CONFIRMATION_TOOLS.includes(tool.name as typeof INCOMPLETE_CONFIRMATION_TOOLS[number]))).toEqual([]);
  });
});
