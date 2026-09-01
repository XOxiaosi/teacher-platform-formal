import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, internalError, ok } from '@teacher-platform/contracts';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';

// P8 phase-3 批4：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);

let createUseCase: unknown;
let importError: unknown;
try {
  const module = await import('../../src/app/use-cases/update-parent-feedback-content/index.js');
  createUseCase = module.createUpdateParentFeedbackContentUseCase;
} catch (caught) {
  importError = caught;
}

const prisma = new PrismaClient();
const TEACHER_A = 'feedback-command-a';
const BASE_TOKEN = new Date('2000-01-01T00:00:00.000Z');
const NEXT_TOKEN = new Date('2030-01-01T00:00:00.000Z');

function requireFactory() {
  if (importError) throw new Error(`production factory import failed: ${importError instanceof Error ? importError.message : String(importError)}`);
  if (typeof createUseCase !== 'function') throw new Error('createUpdateParentFeedbackContentUseCase export is missing');
  return createUseCase as (options: any) => { updateParentFeedbackContent(command: any): Promise<any> };
}

function command(feedbackId: string, patch: Record<string, unknown> = {}) {
  return {
    teacherId: TEACHER_A, feedbackId, expectedUpdatedAt: BASE_TOKEN.toISOString(),
    source: 'manual-web', changes: { title: '新反馈', content: '新内容' }, ...patch,
  };
}

function fixedClock(value = NEXT_TOKEN) {
  return { now: vi.fn().mockResolvedValue(ok(value)) };
}

async function createFixture(teacherId = TEACHER_A) {
  const student = await prisma.student.create({
    data: { teacherId, name: `学生-${teacherId}`, grade: '高一', source: 'test' },
  });
  return prisma.parentFeedback.create({
    data: {
      teacherId, studentId: student.id, title: '原反馈', content: '原内容', status: 'reviewed',
      channel: 'wechat', parentName: '学生家长', sentAtTs: new Date('2029-12-01T00:00:00.000Z'),
      updatedAtTs: BASE_TOKEN,
    },
  });
}

async function databaseNow() {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  return rows[0].now;
}

async function cleanup() {
  const teachers = [TEACHER_A];
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teachers } } });
}

async function expectUnchanged(feedbackId: string) {
  expect(await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedbackId } })).toMatchObject({
    title: '原反馈', content: '原内容', status: 'reviewed', channel: 'wechat',
    parentName: '学生家长', updatedAtTs: BASE_TOKEN,
  });
  expect(await prisma.changeLog.count({ where: { targetId: feedbackId } })).toBe(0);
}

beforeEach(cleanup);
afterEach(cleanup);

describe('ParentFeedback content edit command raw transaction', () => {
  it('默认使用PostgreSQL TrustedClock并写一条白名单快照日志', async () => {
    const feedback = await createFixture();
    const lower = await databaseNow();
    const result = await requireFactory()({ rawPrisma: prisma }).updateParentFeedbackContent(command(feedback.id));
    const upper = await databaseNow();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.value).toMatchObject({
      title: '新反馈', content: '新内容', status: 'reviewed', studentId: feedback.studentId,
      channel: 'wechat', parentName: '学生家长', sentAt: feedback.sentAtTs,
    });
    expect(result.value.value.updatedAt.getTime()).toBeGreaterThanOrEqual(lower.getTime() - 1);
    expect(result.value.value.updatedAt.getTime()).toBeLessThanOrEqual(upper.getTime() + 1);
    const logs = await prisma.changeLog.findMany({ where: { targetId: feedback.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      id: result.value.changeLogId, teacherId: TEACHER_A, module: 'feedback', action: 'update',
      targetType: 'ParentFeedback', source: 'manual-web',
    });
    // P8 phase-3 批4：changelog before/after 整体加密落库，解密后断言
    expect(cipher.decryptJson<unknown>(logs[0].before as unknown as string)).toEqual({ title: '原反馈', content: '原内容', updatedAt: BASE_TOKEN.toISOString() });
    expect(cipher.decryptJson<unknown>(logs[0].after as unknown as string)).toEqual({
      title: '新反馈', content: '新内容', updatedAt: result.value.value.updatedAt.toISOString(),
    });
  });

  it.each(['agent-confirmed', 'wechat-confirmed', 'system'])('日志source准确透传：%s', async (source) => {
    const feedback = await createFixture();
    const result = await requireFactory()({ rawPrisma: prisma }).updateParentFeedbackContent(command(feedback.id, source === 'system' ? { source, expectedUpdatedAt: undefined } : { source }));
    expect(result.ok).toBe(true);
    expect((await prisma.changeLog.findUniqueOrThrow({ where: { id: result.value.changeLogId } })).source).toBe(source);
  });

  it.each([
    { expectedUpdatedAt: undefined },
    { expectedUpdatedAt: '2000-01-01T00:00:00' },
    { changes: { title: ' ' } },
    { changes: { content: '' } },
    { changes: { title: '原反馈', content: '原内容' } },
  ])('结构、字段或no-op失败时完整命令零写', async (patch) => {
    const feedback = await createFixture();
    const result = await requireFactory()({ rawPrisma: prisma }).updateParentFeedbackContent(command(feedback.id, patch));
    expect(result.ok).toBe(false);
    await expectUnchanged(feedback.id);
  });

  it('不存在时统一NOT_FOUND且零写', async () => {
    const feedback = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma });
    const missing = await useCase.updateParentFeedbackContent(command('missing'));
    expect(missing).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });
    await expectUnchanged(feedback.id);
  });

  it('stale优先于空白和no-op并保持零写', async () => {
    const feedback = await createFixture();
    const result = await requireFactory()({ rawPrisma: prisma }).updateParentFeedbackContent(command(feedback.id, {
      expectedUpdatedAt: '1999-12-31T00:00:00.000Z', changes: { title: ' ', content: '原内容' },
    }));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VERSION_CONFLICT' }) });
    await expectUnchanged(feedback.id);
  });

  it('TrustedClock失败或同token时零业务写零日志', async () => {
    const feedback = await createFixture();
    const failed = await requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => ({ now: vi.fn().mockResolvedValue(err(internalError('clock失败'))) }),
    }).updateParentFeedbackContent(command(feedback.id));
    const same = await requireFactory()({ rawPrisma: prisma, trustedClockFactory: () => fixedClock(BASE_TOKEN) })
      .updateParentFeedbackContent(command(feedback.id));
    expect(failed).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect(same).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    await expectUnchanged(feedback.id);
  });

  it('ChangeLog失败时sentinel回滚已完成的条件写', async () => {
    const feedback = await createFixture();
    const result = await requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => fixedClock(),
      changelogFactory: () => ({ recordChange: vi.fn().mockResolvedValue(err(internalError('审计失败'))) }),
    }).updateParentFeedbackContent(command(feedback.id));
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    await expectUnchanged(feedback.id);
  });

  it('同expected完整命令并发恰好一胜一冲突且只写一条日志', async () => {
    const feedback = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma, trustedClockFactory: () => fixedClock() });
    const results = await Promise.all([
      useCase.updateParentFeedbackContent(command(feedback.id)),
      useCase.updateParentFeedbackContent(command(feedback.id)),
    ]);
    expect(results.filter((item) => item.ok)).toHaveLength(1);
    expect(results.filter((item) => !item.ok && item.error.code === 'VERSION_CONFLICT')).toHaveLength(1);
    expect(await prisma.changeLog.count({ where: { targetId: feedback.id } })).toBe(1);
  });
});
