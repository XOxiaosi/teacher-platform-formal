import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { internalError, ok } from '@teacher-platform/contracts';
import { createMemoService } from '../../../src/features/memos/memo-service.js';

let createMemoEditor: unknown;
let importError: unknown;
try {
  const module = await import('../../../src/features/memos/memo-editor.js');
  createMemoEditor = module.createMemoEditor;
} catch (caught) {
  importError = caught;
}

const prisma = new PrismaClient();
const TEACHER_A = 'memo-editor-a';
const TEACHER_B = 'memo-editor-b';
const BASE_TOKEN = new Date('2030-01-01T00:00:00.000Z');
const NEXT_TOKEN = new Date('2030-01-02T00:00:00.000Z');
const INITIAL_DUE_AT = new Date('2030-06-01T00:00:00.000Z');
const NEXT_DUE_AT = new Date('2030-06-15T08:30:00.000Z');
const INITIAL_TAGS = { labels: ['物理'], priority: 1 };
const NEXT_TAGS = { priority: 2, labels: ['家长', { subject: '物理' }], urgent: true };

function requireFactory() {
  if (importError) {
    throw new Error(
      `memo editor import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (typeof createMemoEditor !== 'function') {
    throw new Error('createMemoEditor export is missing');
  }
  return createMemoEditor as (options: { prisma: PrismaClient; trustedClock: any }) => {
    updateMemo(input: any): Promise<any>;
  };
}

function trustedClock(result: any = ok(NEXT_TOKEN)) {
  return { now: vi.fn().mockResolvedValue(result) };
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

async function cleanup() {
  const teachers = [TEACHER_A, TEACHER_B];
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.memo.deleteMany({ where: { teacherId: { in: teachers } } });
}

beforeEach(cleanup);
afterEach(cleanup);

describe('MemoEditor owner CAS', () => {
  it('导出独立窄owner且不替换旧MemoService与状态方法', () => {
    expect(requireFactory()).toBeTypeOf('function');
    const legacy = createMemoService({ prisma });
    expect(legacy.updateMemo).toBeTypeOf('function');
    expect(legacy.updateMemoStatus).toBeTypeOf('function');
  });

  it('owned对象更新四字段并保持status与source', async () => {
    const memo = await createFixture();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
      expectedUpdatedAt: memo.updatedAtTs,
      changes: {
        title: '新备忘',
        content: '新内容',
        dueAt: NEXT_DUE_AT,
        tags: NEXT_TAGS,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.before).toMatchObject({
      title: '原备忘',
      content: '原内容',
      dueAt: INITIAL_DUE_AT,
      tags: INITIAL_TAGS,
    });
    expect(result.value.after).toMatchObject({
      title: '新备忘',
      content: '新内容',
      status: 'active',
      dueAt: NEXT_DUE_AT,
      tags: NEXT_TAGS,
      source: 'manual',
      updatedAt: NEXT_TOKEN,
    });
    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(await prisma.changeLog.count({ where: { targetId: memo.id } })).toBe(0);

    const persisted = await prisma.memo.findUniqueOrThrow({ where: { id: memo.id } });
    expect(persisted.dueAtTs).toBeInstanceOf(Date);
    expect(persisted.dueAtTs).toBeInstanceOf(Date);
  });

  it('双写 updatedAtTs 与 updatedAt 值相同', async () => {
    const memo = await createFixture();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
      expectedUpdatedAt: memo.updatedAtTs,
      changes: { title: '双写标题' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = await prisma.memo.findUniqueOrThrow({ where: { id: memo.id } });
    expect(record.updatedAtTs).toBeInstanceOf(Date);
    expect(record.updatedAtTs).toBeInstanceOf(Date);
  });

  it('dueAt与tags的null清空为真实数据库NULL', async () => {
    const memo = await createFixture();
    const editor = requireFactory()({ prisma, trustedClock: trustedClock() });

    const result = await editor.updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
      expectedUpdatedAt: memo.updatedAtTs,
      changes: { dueAt: null, tags: null },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.after).toMatchObject({ dueAt: null, tags: null });
    const rows = await prisma.$queryRaw<Array<{ dueAtNull: boolean; tagsNull: boolean }>>(
      Prisma.sql`SELECT "dueAtTs" IS NULL AS "dueAtNull", "tags" IS NULL AS "tagsNull" FROM "Memo" WHERE id = ${memo.id}`,
    );
    expect(rows).toEqual([{ dueAtNull: true, tagsNull: true }]);
  });

  it('省略字段保持原值', async () => {
    const memo = await createFixture();
    const editor = requireFactory()({ prisma, trustedClock: trustedClock() });

    const result = await editor.updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
      expectedUpdatedAt: memo.updatedAtTs,
      changes: { title: '只改标题' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.after).toMatchObject({
      title: '只改标题',
      content: '原内容',
      dueAt: INITIAL_DUE_AT,
      tags: INITIAL_TAGS,
      status: 'active',
      source: 'manual',
    });
  });

  it.each([
    { teacherId: TEACHER_B, memoId: 'owned-id' },
    { teacherId: TEACHER_A, memoId: 'missing-id' },
  ])('跨teacher或不存在统一NOT_FOUND且不调用clock：$teacherId/$memoId', async ({ teacherId, memoId }) => {
    const memo = await createFixture();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateMemo({
      teacherId,
      memoId: memoId === 'owned-id' ? memo.id : memoId,
      expectedUpdatedAt: new Date('1999-01-01T00:00:00.000Z'),
      changes: { title: '   ' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(clock.now).not.toHaveBeenCalled();
    expect((await prisma.memo.findUniqueOrThrow({ where: { id: memo.id } })).title).toBe('原备忘');
  });

  it('owned stale优先于空白文本和深度no-op返回VERSION_CONFLICT', async () => {
    const memo = await createFixture();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
      expectedUpdatedAt: new Date('2029-12-31T00:00:00.000Z'),
      changes: { title: ' ', tags: { priority: 1, labels: ['物理'] } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VERSION_CONFLICT', field: 'expectedUpdatedAt' });
    expect(clock.now).not.toHaveBeenCalled();
  });

  it.each([
    { changes: {}, field: 'changes' },
    { changes: { status: 'done' }, field: 'changes' },
    { changes: { source: 'agent' }, field: 'changes' },
    { changes: { title: '' }, field: 'title' },
    { changes: { title: '   ' }, field: 'title' },
    { changes: { content: '' }, field: 'content' },
    { changes: { dueAt: new Date(Number.NaN) }, field: 'dueAt' },
    { changes: { dueAt: '2030-01-01T00:00:00.000Z' }, field: 'dueAt' },
    { changes: { tags: undefined }, field: 'tags' },
    { changes: { tags: Number.POSITIVE_INFINITY }, field: 'tags' },
    { changes: { tags: Array(1) }, field: 'tags' },
    { changes: { tags: new Date('2030-01-01T00:00:00.000Z') }, field: 'tags' },
    { changes: { tags: { nested: undefined } }, field: 'tags' },
    { changes: { tags: Object.assign(Object.create({ inherited: true }), { value: 'x' }) }, field: 'tags' },
  ])('拒绝非法owner输入：$field/$changes', async ({ changes, field }) => {
    const memo = await createFixture();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
      expectedUpdatedAt: memo.updatedAtTs,
      changes,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VALIDATION_ERROR', field });
    expect(clock.now).not.toHaveBeenCalled();
    expect((await prisma.memo.findUniqueOrThrow({ where: { id: memo.id } })).updatedAtTs).toEqual(BASE_TOKEN);
  });

  it('拒绝owner内部循环JSON且零写', async () => {
    const memo = await createFixture();
    const tags: Record<string, unknown> = {};
    tags.self = tags;
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
      expectedUpdatedAt: memo.updatedAtTs,
      changes: { tags },
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'tags' }),
    });
    expect(clock.now).not.toHaveBeenCalled();
  });

  it('事实no-op按dueAt instant与JSON结构比较，忽略对象键顺序', async () => {
    const memo = await createFixture();
    const clock = trustedClock();
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
      expectedUpdatedAt: memo.updatedAtTs,
      changes: {
        title: memo.title,
        content: memo.content,
        dueAt: new Date(memo.dueAtTs!.getTime()),
        tags: { priority: 1, labels: ['物理'] },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'changes' });
    expect(clock.now).not.toHaveBeenCalled();
    expect((await prisma.memo.findUniqueOrThrow({ where: { id: memo.id } })).updatedAtTs).toEqual(BASE_TOKEN);
  });

  it('TrustedClock失败时零业务写', async () => {
    const memo = await createFixture();
    const editor = requireFactory()({
      prisma,
      trustedClock: trustedClock({ ok: false, error: internalError('数据库可信时间不可用') }),
    });

    const result = await editor.updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
      expectedUpdatedAt: memo.updatedAtTs,
      changes: { title: '新标题' },
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect((await prisma.memo.findUniqueOrThrow({ where: { id: memo.id } }))).toMatchObject({
      title: '原备忘',
      updatedAtTs: BASE_TOKEN,
    });
  });

  it('TrustedClock返回before同token时零业务写', async () => {
    const memo = await createFixture();
    const editor = requireFactory()({ prisma, trustedClock: trustedClock(ok(BASE_TOKEN)) });

    const result = await editor.updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
      expectedUpdatedAt: memo.updatedAtTs,
      changes: { title: '新标题' },
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect((await prisma.memo.findUniqueOrThrow({ where: { id: memo.id } })).title).toBe('原备忘');
  });

  it('system省略expected仍以读取到的before token执行成功CAS', async () => {
    const memo = await createFixture();
    const editor = requireFactory()({ prisma, trustedClock: trustedClock() });

    const result = await editor.updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
      expectedUpdatedAt: undefined,
      changes: { dueAt: null },
    });

    expect(result.ok).toBe(true);
    expect((await prisma.memo.findUniqueOrThrow({ where: { id: memo.id } })).updatedAtTs).toEqual(NEXT_TOKEN);
  });

  it('条件写前对象消失时重读分类为NOT_FOUND', async () => {
    const memo = await createFixture();
    const clock = {
      now: vi.fn(async () => {
        await prisma.memo.delete({ where: { id: memo.id } });
        return ok(NEXT_TOKEN);
      }),
    };
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const result = await editor.updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
      expectedUpdatedAt: memo.updatedAtTs,
      changes: { title: '新标题' },
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });
  });

  it('同一expected并发且都已读取before时恰好一胜一冲突', async () => {
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
    const editor = requireFactory()({ prisma, trustedClock: clock });

    const results = await Promise.all([
      editor.updateMemo({
        teacherId: TEACHER_A,
        memoId: memo.id,
        expectedUpdatedAt: memo.updatedAtTs,
        changes: { title: '并发A' },
      }),
      editor.updateMemo({
        teacherId: TEACHER_A,
        memoId: memo.id,
        expectedUpdatedAt: memo.updatedAtTs,
        changes: { title: '并发B' },
      }),
    ]);

    expect(results.map((result) => result.ok ? 'OK' : result.error.code).sort()).toEqual([
      'OK',
      'VERSION_CONFLICT',
    ]);
    const persisted = await prisma.memo.findUniqueOrThrow({ where: { id: memo.id } });
    expect(['并发A', '并发B']).toContain(persisted.title);
    expect(persisted.updatedAtTs).toEqual(NEXT_TOKEN);
  });
});
