import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createMinimalToolRegistry } from '../../src/app/tool-registration.js';
import { createChangelogService } from '../../src/shared/changelog/changelog-service.js';
import { withChangelog } from '../../src/shared/changelog/prisma-extension.js';

const basePrisma = new PrismaClient();
const changelogService = createChangelogService(basePrisma);
const prisma = withChangelog(basePrisma, changelogService) as unknown as PrismaClient;
const registry = createMinimalToolRegistry({ prisma });
const TEACHER_ID = 'test-teacher-agent-write-changelog';

async function cleanup() {
  await basePrisma.changeLog.deleteMany({ where: { teacherId: TEACHER_ID } });
  await basePrisma.parentFeedback.deleteMany({ where: { teacherId: TEACHER_ID } });
  await basePrisma.memo.deleteMany({ where: { teacherId: TEACHER_ID } });
  await basePrisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
}

beforeEach(cleanup);
afterEach(cleanup);

describe('Agent 新增写工具 changelog workflow', () => {
  it('memo 与 feedback 的 create/updateStatus 均产生 changelog', async () => {
    const memoCreated = await registry.execute(
      'memos.create',
      { title: '审计备忘', content: '检查 ChangeLog' },
      { teacherId: TEACHER_ID },
    );
    expect(memoCreated.ok).toBe(true);
    if (!memoCreated.ok) return;

    const memoUpdated = await registry.execute(
      'memos.updateStatus',
      { memoId: (memoCreated.value as { id: string }).id, status: 'done' },
      { teacherId: TEACHER_ID },
    );
    expect(memoUpdated.ok).toBe(true);

    const student = await basePrisma.student.create({
      data: { teacherId: TEACHER_ID, name: '审计学生', grade: '高三' },
    });
    const feedbackCreated = await registry.execute(
      'feedback.create',
      { studentId: student.id, title: '阶段反馈', content: '本周状态稳定' },
      { teacherId: TEACHER_ID },
    );
    expect(feedbackCreated.ok).toBe(true);
    if (!feedbackCreated.ok) return;

    const feedbackUpdated = await registry.execute(
      'feedback.updateStatus',
      { feedbackId: (feedbackCreated.value as { id: string }).id, status: 'reviewed' },
      { teacherId: TEACHER_ID },
    );
    // P29-W1：feedback.updateStatus 已改为 confirmation:required，direct execute 必须
    // fail-closed（VALIDATION_ERROR/confirmation），不得通过自动审计 extension 写 ChangeLog；
    // 确认后的显式审计语义由 tests/e2e/agent-feedback-status-confirmation-workflow.test.ts
    // 与 tests/functional/feedback/feedback-status-audit-atomicity.test.ts 覆盖。
    expect(feedbackUpdated).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: '该工具必须通过 ConfirmationGateway 创建待确认操作', field: 'confirmation' },
    });
    expect((await basePrisma.parentFeedback.findUniqueOrThrow({
      where: { id: (feedbackCreated.value as { id: string }).id },
    })).status).toBe('draft');

    const logs = await basePrisma.changeLog.findMany({
      where: { teacherId: TEACHER_ID },
      select: { module: true, action: true, targetType: true },
      orderBy: { createdAtTs: 'asc' },
    });

    expect(logs).toEqual([
      { module: 'memos', action: 'create', targetType: 'Memo' },
      { module: 'memos', action: 'update', targetType: 'Memo' },
      { module: 'feedback', action: 'create', targetType: 'ParentFeedback' },
    ]);
  });
});
