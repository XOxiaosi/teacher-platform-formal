import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { createMinimalToolRegistry } from '../../src/app/tool-registration.js';

const EXPECTED_SIDE_EFFECTS = {
  'students.get': 'read',
  'students.list': 'read',
  'scheduling.list': 'read',
  'lessons.list': 'read',
  'payments.list': 'read',
  'memos.list': 'read',
  'feedback.list': 'read',
  'students.create': 'create',
  'scheduling.create': 'create',
  'payments.create': 'create',
  'memos.create': 'create',
  'feedback.create': 'create',
  'scheduling.complete': 'update',
  'scheduling.cancel': 'update',
  'lessons.updateStatus': 'update',
  'students.updateStatus': 'update',
  'memos.updateStatus': 'update',
  'feedback.updateStatus': 'update',
  'students.updateProfile': 'update',
  'scheduling.reschedule': 'update',
  'lessons.updateRecord': 'update',
  'payments.update': 'update',
  'memos.update': 'update',
  'feedback.updateContent': 'update',
  'requirements.capture': 'create',
  'students.sources.ingest': 'create',
  'students.records.capture': 'create',
  'students.assessments.create': 'create',
  'students.communications.capture': 'create',
} as const;

describe('Agent 工具副作用分类边界', () => {
  it('29 个注册工具都有显式且准确的 sideEffect', () => {
    const registry = createMinimalToolRegistry({
      prisma: {} as PrismaClient,
      trustedClock: {
        now: async () => ({ ok: true, value: new Date(0) }),
      },
    });

    const actual = Object.fromEntries(
      registry.list().map(({ name, sideEffect }) => [name, sideEffect]),
    );

    expect(actual).toEqual(EXPECTED_SIDE_EFFECTS);
  });
});
