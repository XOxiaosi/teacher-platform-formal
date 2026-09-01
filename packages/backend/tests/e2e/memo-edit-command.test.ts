import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { err, internalError, ok } from '@teacher-platform/contracts';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';

// P8 phase-3 批4：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);

let createUpdateMemoUseCase: unknown;
let importError: unknown;
try {
  const module = await import('../../src/app/use-cases/update-memo/index.js');
  createUpdateMemoUseCase = module.createUpdateMemoUseCase;
} catch (caught) {
  importError = caught;
}

const prisma = new PrismaClient();
const TEACHER_A = 'memo-command-a';
const BASE_TOKEN = new Date('2000-01-01T00:00:00.000Z');
const NEXT_TOKEN = new Date('2030-01-01T00:00:00.000Z');
const INITIAL_DUE_AT = new Date('2030-06-01T00:00:00.000Z');
const NEXT_DUE_AT = new Date('2030-06-15T08:30:00.000Z');
const INITIAL_TAGS = { labels: ['物理'], priority: 1 };
const NEXT_TAGS = { priority: 'high', labels: ['家长', { subject: '物理' }], urgent: true };

function requireFactory() {
  if (importError) {
    throw new Error(
      `update-memo production factory import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (typeof createUpdateMemoUseCase !== 'function') {
    throw new Error('createUpdateMemoUseCase export is missing');
  }
  return createUpdateMemoUseCase as (options: any) => {
    updateMemo(command: any): Promise<any>;
  };
}

function command(memoId: string, patch: Record<string, unknown> = {}) {
  return {
    teacherId: TEACHER_A,
    memoId,
    expectedUpdatedAt: BASE_TOKEN.toISOString(),
    source: 'manual-web',
    changes: {
      title: '新备忘',
      content: '新内容',
      dueAt: '2030-06-15T16:30:00+08:00',
      tags: NEXT_TAGS,
    },
    ...patch,
  };
}

function fixedClock(value = NEXT_TOKEN) {
  return { now: vi.fn().mockResolvedValue(ok(value)) };
}

async function createFixture(teacherId = TEACHER_A) {
  return prisma.memo.create({
    data: {
      teacherId,
      title: '原备忘',
      content: '原内容',
      status: 'active',
      dueAtTs: INITIAL_DUE_AT,
      tags: INITIAL_TAGS,
      source: 'manual',
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
  await prisma.memo.deleteMany({ where: { teacherId: { in: teachers } } });
}

async function expectUnchanged(memoId: string) {
  const persisted = await prisma.memo.findUniqueOrThrow({ where: { id: memoId } });
  expect(persisted).toMatchObject({
    title: '原备忘',
    content: '原内容',
    status: 'active',
    dueAtTs: INITIAL_DUE_AT,
    tags: INITIAL_TAGS,
    source: 'manual',
    updatedAtTs: BASE_TOKEN,
  });
  expect(await prisma.changeLog.count({ where: { targetId: memoId } })).toBe(0);
}

beforeEach(cleanup);
afterEach(cleanup);

describe('Memo edit command raw transaction', () => {
  it('导出只接收raw Prisma的production factory', () => {
    expect(requireFactory()).toBeTypeOf('function');
  });

  it('默认使用PostgreSQL TrustedClock，写一条准确manual-web日志并返回receipt', async () => {
    const memo = await createFixture();
    const lowerBound = await databaseNow();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updateMemo(command(memo.id));

    const upperBound = await databaseNow();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value.value;
    expect(value.updatedAt.getTime()).not.toBe(BASE_TOKEN.getTime());
    expect(value.updatedAt.getTime()).toBeGreaterThanOrEqual(lowerBound.getTime() - 1);
    expect(value.updatedAt.getTime()).toBeLessThanOrEqual(upperBound.getTime() + 1);
    expect(value).toMatchObject({
      title: '新备忘',
      content: '新内容',
      status: 'active',
      dueAt: NEXT_DUE_AT,
      tags: NEXT_TAGS,
      source: 'manual',
    });

    const logs = await prisma.changeLog.findMany({ where: { targetId: memo.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      id: result.value.changeLogId,
      teacherId: TEACHER_A,
      module: 'memos',
      action: 'update',
      targetType: 'Memo',
      targetId: memo.id,
      source: 'manual-web',
    });
    // P8 phase-3 批4：changelog before/after 整体加密落库，解密后断言
    expect(cipher.decryptJson<unknown>(logs[0].before as unknown as string)).toEqual({
      title: '原备忘',
      content: '原内容',
      dueAt: INITIAL_DUE_AT.toISOString(),
      tags: INITIAL_TAGS,
      updatedAt: BASE_TOKEN.toISOString(),
    });
    expect(cipher.decryptJson<unknown>(logs[0].after as unknown as string)).toEqual({
      title: '新备忘',
      content: '新内容',
      dueAt: NEXT_DUE_AT.toISOString(),
      tags: NEXT_TAGS,
      updatedAt: value.updatedAt.toISOString(),
    });
  });

  it.each(['agent-confirmed', 'wechat-confirmed', 'system'])('日志source准确透传：%s', async (source) => {
    const memo = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma });
    const patch = source === 'system'
      ? { source, expectedUpdatedAt: undefined }
      : { source };

    const result = await useCase.updateMemo(command(memo.id, patch));

    expect(result.ok).toBe(true);
    const logs = await prisma.changeLog.findMany({ where: { targetId: memo.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].source).toBe(source);
  });

  it.each([
    { expectedUpdatedAt: undefined },
    { expectedUpdatedAt: '2000-01-01T00:00:00' },
    { expectedUpdatedAt: '2000-02-30T00:00:00Z' },
  ])('expected缺失或格式非法时完整命令零写：$expectedUpdatedAt', async ({ expectedUpdatedAt }) => {
    const memo = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updateMemo(command(memo.id, { expectedUpdatedAt }));

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'expectedUpdatedAt' }),
    });
    await expectUnchanged(memo.id);
  });

  it.each([
    { changes: { title: '   ' }, field: 'title' },
    { changes: { content: '' }, field: 'content' },
    { changes: { dueAt: '2030-06-15T16:30:00' }, field: 'dueAt' },
    { changes: { tags: Number.POSITIVE_INFINITY }, field: 'tags' },
    { changes: { tags: { nested: undefined } }, field: 'tags' },
    { changes: { title: '原备忘', tags: { priority: 1, labels: ['物理'] } }, field: 'changes' },
  ])('字段校验或事实no-op时完整命令零写：$field/$changes', async ({ changes, field }) => {
    const memo = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updateMemo(command(memo.id, { changes }));

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }),
    });
    await expectUnchanged(memo.id);
  });

  it('不存在时完整命令返回NOT_FOUND且零写', async () => {
    const memo = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updateMemo(command('missing-memo'));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });
    await expectUnchanged(memo.id);
  });

  it('stale优先于空白文本和深度no-op返回VERSION_CONFLICT', async () => {
    const memo = await createFixture();
    const useCase = requireFactory()({ rawPrisma: prisma });

    const result = await useCase.updateMemo(command(memo.id, {
      expectedUpdatedAt: '1999-12-31T00:00:00.000Z',
      changes: { title: ' ', tags: { priority: 1, labels: ['物理'] } },
    }));

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VERSION_CONFLICT', field: 'expectedUpdatedAt' }),
    });
    await expectUnchanged(memo.id);
  });

  it('完整命令以null清空dueAt与tags并写数据库NULL和审计null', async () => {
    const memo = await createFixture();
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => fixedClock(),
    });

    const result = await useCase.updateMemo(command(memo.id, {
      changes: { dueAt: null, tags: null },
    }));

    expect(result.ok).toBe(true);
    const rows = await prisma.$queryRaw<Array<{ dueAtNull: boolean; tagsNull: boolean }>>(
      Prisma.sql`SELECT "dueAtTs" IS NULL AS "dueAtNull", "tags" IS NULL AS "tagsNull" FROM "Memo" WHERE id = ${memo.id}`,
    );
    expect(rows).toEqual([{ dueAtNull: true, tagsNull: true }]);
    const logs = await prisma.changeLog.findMany({ where: { targetId: memo.id } });
    expect(logs).toHaveLength(1);
    expect(cipher.decryptJson<unknown>(logs[0].after as unknown as string)).toEqual({
      title: '原备忘',
      content: '原内容',
      dueAt: null,
      tags: null,
      updatedAt: NEXT_TOKEN.toISOString(),
    });
  });

  it('TrustedClock失败时返回INTERNAL_ERROR且零Memo写零日志', async () => {
    const memo = await createFixture();
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => ({
        now: vi.fn().mockResolvedValue(err(internalError('数据库可信时间不可用'))),
      }),
    });

    const result = await useCase.updateMemo(command(memo.id));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    await expectUnchanged(memo.id);
  });

  it('TrustedClock返回before同token时零Memo写零日志', async () => {
    const memo = await createFixture();
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => fixedClock(BASE_TOKEN),
    });

    const result = await useCase.updateMemo(command(memo.id));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    await expectUnchanged(memo.id);
  });

  it('ChangeLog失败时通过sentinel回滚已完成的Memo条件写', async () => {
    const memo = await createFixture();
    const recordChange = vi.fn().mockResolvedValue(err(internalError('审计写入失败')));
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => fixedClock(),
      changelogFactory: () => ({ recordChange }),
    });

    const result = await useCase.updateMemo(command(memo.id));

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect(recordChange).toHaveBeenCalledTimes(1);
    await expectUnchanged(memo.id);
  });

  it('完整命令同一expected并发恰好一胜一冲突且只留一条日志', async () => {
    const memo = await createFixture();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const clock = {
      now: vi.fn(async () => {
        calls += 1;
        if (calls === 2) release();
        await gate;
        return ok(NEXT_TOKEN);
      }),
    };
    const useCase = requireFactory()({
      rawPrisma: prisma,
      trustedClockFactory: () => clock,
    });

    const results = await Promise.all([
      useCase.updateMemo(command(memo.id, { changes: { title: '并发A' } })),
      useCase.updateMemo(command(memo.id, { changes: { title: '并发B' } })),
    ]);

    expect(results.map((result) => result.ok ? 'OK' : result.error.code).sort()).toEqual([
      'OK',
      'VERSION_CONFLICT',
    ]);
    expect(await prisma.changeLog.count({ where: { targetId: memo.id } })).toBe(1);
    const persisted = await prisma.memo.findUniqueOrThrow({ where: { id: memo.id } });
    expect(['并发A', '并发B']).toContain(persisted.title);
    expect(persisted.status).toBe('active');
    expect(persisted.source).toBe('manual');
    expect(persisted.updatedAtTs).toEqual(NEXT_TOKEN);
  });
});
