import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { createMinimalToolRegistry } from '../../src/app/tool-registration.js';
import { CONFIRMABLE_ACTION_NAMES } from '../../src/features/pending-action/index.js';
import { getToolPresentation } from '../../src/app/routes/tool-presentation.js';

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
  'scheduling.cancel': 'update',
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
  it('27 个可供模型调用的注册工具都有显式且准确的 sideEffect；旧确认 action 仅为历史 PendingAction 兼容保留', () => {
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
    // 禁用的是新模型可调用定义，历史 PendingAction 的 action/presentation 仍须可读。
    for (const actionName of ['scheduling.complete', 'lessons.updateStatus'] as const) {
      expect(CONFIRMABLE_ACTION_NAMES).toContain(actionName);
      expect(getToolPresentation(actionName)).toMatchObject({ sideEffect: 'update' });
    }
  });
});
