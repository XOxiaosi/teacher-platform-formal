import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createMemoService } from '../../../src/features/memos/memo-service.js';
import type { MemoData } from '../../../src/features/memos/types.js';

const prisma = new PrismaClient();
const TEACHER_A = 'test-teacher-memo-a';
const TEACHER_B = 'test-teacher-memo-b';

function createService() {
  return createMemoService({ prisma });
}

async function createMemoOrThrow(input: {
  teacherId: string;
  title: string;
  content: string;
  dueAt?: Date;
  tags?: unknown;
  source?: string;
}): Promise<MemoData> {
  const result = await createService().createMemo(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function cleanup() {
  await prisma.memo.deleteMany({
    where: { teacherId: { in: [TEACHER_A, TEACHER_B] } },
  });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('memoService.createMemo', () => {
  it('创建 active memo，保存全部字段，返回 MemoData', async () => {
    const dueAt = new Date('2026-08-01T10:00:00Z');
    const tags = ['重要', '物理'];
    const result = await createService().createMemo({
      teacherId: TEACHER_A,
      title: '期中考试复习计划',
      content: '需要准备力学和电学两部分',
      dueAt,
      tags,
      source: 'manual',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.id).toBeTypeOf('string');
    expect(result.value.teacherId).toBe(TEACHER_A);
    expect(result.value.title).toBe('期中考试复习计划');
    expect(result.value.content).toBe('需要准备力学和电学两部分');
    expect(result.value.status).toBe('active');
    expect(result.value.dueAt).toEqual(dueAt);
    expect(result.value.tags).toEqual(tags);
    expect(result.value.source).toBe('manual');
    expect(result.value.createdAt).toBeInstanceOf(Date);
    expect(result.value.updatedAt).toBeInstanceOf(Date);

    const persisted = await prisma.memo.findUniqueOrThrow({ where: { id: result.value.id } });
    expect(persisted.dueAtTs).toBeInstanceOf(Date);
    expect(persisted.dueAtTs).toBeInstanceOf(Date);
  });

  it('title 为空返回 VALIDATION_ERROR', async () => {
    const result = await createService().createMemo({
      teacherId: TEACHER_A,
      title: '',
      content: '内容',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('content 为空返回 VALIDATION_ERROR', async () => {
    const result = await createService().createMemo({
      teacherId: TEACHER_A,
      title: '标题',
      content: '',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('tags 能保存 JSON 数组或对象', async () => {
    const arrayTags = ['语文', '数学'];
    const result1 = await createService().createMemo({
      teacherId: TEACHER_A,
      title: '数组标签',
      content: '内容',
      tags: arrayTags,
    });

    expect(result1.ok).toBe(true);
    if (!result1.ok) return;
    expect(result1.value.tags).toEqual(arrayTags);

    const objectTags = { priority: 'high', category: 'exam' };
    const result2 = await createService().createMemo({
      teacherId: TEACHER_A,
      title: '对象标签',
      content: '内容',
      tags: objectTags,
    });

    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect(result2.value.tags).toEqual(objectTags);
  });
});

describe('memoService.getMemo', () => {
  it('按 teacherId + memoId 查询自己的 memo', async () => {
    const created = await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '查询测试',
      content: '查询内容',
    });

    const result = await createService().getMemo({
      teacherId: TEACHER_A,
      memoId: created.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(created.id);
    expect(result.value.title).toBe('查询测试');
  });

  it('不存在返回 NOT_FOUND', async () => {
    const result = await createService().getMemo({
      teacherId: TEACHER_A,
      memoId: 'nonexistent-id',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('跨 teacher 访问返回 NOT_FOUND', async () => {
    const created = await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: 'A 的备忘',
      content: 'A 的内容',
    });

    const result = await createService().getMemo({
      teacherId: TEACHER_B,
      memoId: created.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('memoService.listMemos', () => {
  it('只返回当前 teacher 的 memos，不泄露其他 teacher', async () => {
    await createMemoOrThrow({ teacherId: TEACHER_A, title: 'A1', content: '内容A1' });
    await createMemoOrThrow({ teacherId: TEACHER_A, title: 'A2', content: '内容A2' });
    await createMemoOrThrow({ teacherId: TEACHER_B, title: 'B1', content: '内容B1' });

    const result = await createService().listMemos({ teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(2);
    expect(result.value.total).toBe(2);
    expect(result.value.items.every((m) => m.teacherId === TEACHER_A)).toBe(true);
  });

  it('支持 status 过滤', async () => {
    const memo1 = await createMemoOrThrow({ teacherId: TEACHER_A, title: '活跃', content: '内容' });
    // 直接通过 prisma 创建一个 done 状态的 memo
    await prisma.memo.update({
      where: { id: memo1.id },
      data: { status: 'done' },
    });
    await createMemoOrThrow({ teacherId: TEACHER_A, title: '活跃2', content: '内容' });

    const result = await createService().listMemos({
      teacherId: TEACHER_A,
      status: 'active',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0].title).toBe('活跃2');
    expect(result.value.total).toBe(1);
  });

  it('支持 dueBefore 过滤', async () => {
    const pastDate = new Date('2026-01-01T10:00:00Z');
    const futureDate = new Date('2026-12-31T10:00:00Z');

    await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '已过期',
      content: '内容',
      dueAt: pastDate,
    });
    await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '未到期',
      content: '内容',
      dueAt: futureDate,
    });

    const result = await createService().listMemos({
      teacherId: TEACHER_A,
      dueBefore: new Date('2026-06-01T10:00:00Z'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0].title).toBe('已过期');
  });

  it('支持分页 page/pageSize，返回 { items, total }', async () => {
    for (let i = 0; i < 5; i++) {
      await createMemoOrThrow({
        teacherId: TEACHER_A,
        title: `备忘${i}`,
        content: `内容${i}`,
      });
    }

    const result = await createService().listMemos({
      teacherId: TEACHER_A,
      page: 2,
      pageSize: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(2);
    expect(result.value.total).toBe(5);
  });
});
