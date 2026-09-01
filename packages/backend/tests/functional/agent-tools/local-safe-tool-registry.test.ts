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

const prisma = {} as PrismaClient;
const trustedClock = {
  now: async () => ({ ok: true as const, value: new Date(0) }),
};

describe('L0 Agent local-safe tool registry', () => {
  it('list 只暴露 read 或 confirmation=required，隐藏全部 9 个直写工具', () => {
    const registry = createMinimalToolRegistry({
      prisma,
      trustedClock,
      localSafeMode: true,
    });

    const listed = registry.list();
    expect(listed).toHaveLength(20);
    expect(listed.every((tool) => tool.sideEffect === 'read' || tool.confirmation === 'required')).toBe(true);
    expect(listed.filter((tool) => DIRECT_WRITE_TOOLS.includes(tool.name as typeof DIRECT_WRITE_TOOLS[number]))).toEqual([]);
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

  it('只有显式 opt-out 才恢复完整工具表', () => {
    const registry = createMinimalToolRegistry({
      prisma,
      trustedClock,
      localSafeMode: false,
    });

    expect(registry.list()).toHaveLength(29);
  });
});
