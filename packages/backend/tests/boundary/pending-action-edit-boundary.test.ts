import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIRMABLE_ACTION_NAMES } from '../../src/features/pending-action/index.js';

const ROOT = resolve(import.meta.dirname, '../..');

function source(path: string) {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('A5-I9c PendingAction 编辑静态边界', () => {
  it('六个新动作只映射到冻结 target type', () => {
    const text = source('src/app/confirmation/database-confirmable-action-registry.ts');
    const expected = {
      'students.updateProfile': 'studentUpdateProfile',
      'scheduling.reschedule': 'scheduleReschedule',
      'lessons.updateRecord': 'lessonUpdateRecord',
      'payments.update': 'paymentUpdate',
      'memos.update': 'memoUpdate',
      'feedback.updateContent': 'feedbackUpdateContent',
    };
    for (const [action, executor] of Object.entries(expected)) {
      expect(CONFIRMABLE_ACTION_NAMES).toContain(action);
      expect(text).toContain(`'${action}': editExecutors.${executor}`);
    }
  });

  it('编辑 executor 不调用 HTTP、不裸用 Prisma model，来源只能固定 agent-confirmed', () => {
    const text = source('src/app/confirmation/edit-action-executors.ts');
    expect(text).not.toMatch(/fetch\(|axios|\.student\.|\.schedule\.|\.lesson\.|\.payment\.|\.memo\.|\.parentFeedback\./);
    expect(text).not.toContain("source: 'system'");
    expect(text).not.toContain("source: 'manual-web'");
    expect(text.match(/source: 'agent-confirmed'/g)?.length).toBeGreaterThanOrEqual(1);
  });

  it('Gateway 与工具注册均不 import Prisma，protected 四动作实现未被替换', () => {
    const gateway = source('src/app/confirmation/confirmation-gateway.ts');
    const tools = source('src/app/tools/register-edit-tools.ts');
    const oldExecutors = source('src/app/confirmation/database-action-executors.ts');
    expect(gateway).not.toContain('@prisma/client');
    expect(tools).not.toContain('@prisma/client');
    expect(oldExecutors).toContain("source: 'system'");
    expect(oldExecutors).toContain('scheduleComplete');
    expect(oldExecutors).toContain('studentUpdateStatus');
  });
});
