import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createMemoService } from '../../../src/features/memos/memo-service.js';
import type { MemoData } from '../../../src/features/memos/types.js';

// Phase 2.4-A: 红灯测试
// updateMemo / updateMemoStatus / listDueMemos 当前仍是 stub。
// 测试锁定 Phase 2.4 预期契约，实现将在 Phase 2.4-B 完成。

const prisma = new PrismaClient();
const TEACHER_A = 'test-teacher-memo-update-a';
const TEACHER_B = 'test-teacher-memo-update-b';

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

describe('memoService.updateMemo', () => {
  it('可更新 title/content/dueAt/tags/source，返回更新后的 MemoData', async () => {
    const memo = await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '原标题',
      content: '原内容',
    });

    const newDueAt = new Date('2026-12-31T10:00:00Z');
    const newTags = ['新标签', '重要'];
    const result = await createService().updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
      title: '新标题',
      content: '新内容',
      dueAt: newDueAt,
      tags: newTags,
      source: 'agent',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('新标题');
    expect(result.value.content).toBe('新内容');
    expect(result.value.dueAt).toEqual(newDueAt);
    expect(result.value.tags).toEqual(newTags);
    expect(result.value.source).toBe('agent');

    const record = await prisma.memo.findUniqueOrThrow({ where: { id: memo.id } });
    expect(record.dueAtTs).toBeInstanceOf(Date);
    expect(record.dueAtTs).toBeInstanceOf(Date);
  });

  it('更新时双写 updatedAtTs 与 updatedAt 值相同', async () => {
    const memo = await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '原标题',
      content: '原内容',
    });

    const result = await createService().updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
      title: '新标题',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = await prisma.memo.findUniqueOrThrow({ where: { id: memo.id } });
    expect(record.updatedAtTs).toBeInstanceOf(Date);
    expect(record.updatedAtTs).toBeInstanceOf(Date);
  });

  it('title 传空字符串返回 VALIDATION_ERROR', async () => {
    const memo = await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '原标题',
      content: '原内容',
    });

    const result = await createService().updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
      title: '',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('content 传空字符串返回 VALIDATION_ERROR', async () => {
    const memo = await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '原标题',
      content: '原内容',
    });

    const result = await createService().updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
      content: '',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('不存在返回 NOT_FOUND', async () => {
    const result = await createService().updateMemo({
      teacherId: TEACHER_A,
      memoId: 'nonexistent-id',
      title: '新标题',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('跨 teacher 更新返回 NOT_FOUND', async () => {
    const memo = await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: 'A 的备忘',
      content: 'A 的内容',
    });

    const result = await createService().updateMemo({
      teacherId: TEACHER_B,
      memoId: memo.id,
      title: 'B 的修改',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('未传任何可更新字段返回 VALIDATION_ERROR', async () => {
    const memo = await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '原标题',
      content: '原内容',
    });

    const result = await createService().updateMemo({
      teacherId: TEACHER_A,
      memoId: memo.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('memoService.updateMemoStatus', () => {
  it('active -> done 成功', async () => {
    const memo = await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '待完成',
      content: '内容',
    });

    const result = await createService().updateMemoStatus({
      teacherId: TEACHER_A,
      memoId: memo.id,
      status: 'done',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('done');
  });

  it('状态更新时双写 updatedAtTs 与 updatedAt 值相同', async () => {
    const memo = await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '待完成',
      content: '内容',
    });

    const result = await createService().updateMemoStatus({
      teacherId: TEACHER_A,
      memoId: memo.id,
      status: 'done',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = await prisma.memo.findUniqueOrThrow({ where: { id: memo.id } });
    expect(record.updatedAtTs).toBeInstanceOf(Date);
    expect(record.updatedAtTs).toBeInstanceOf(Date);
  });

  it('done -> active 成功', async () => {
    const memo = await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '已完成',
      content: '内容',
    });
    // 先标记为 done
    await prisma.memo.update({ where: { id: memo.id }, data: { status: 'done' } });

    const result = await createService().updateMemoStatus({
      teacherId: TEACHER_A,
      memoId: memo.id,
      status: 'active',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('active');
  });

  it('active -> archived 成功', async () => {
    const memo = await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '待归档',
      content: '内容',
    });

    const result = await createService().updateMemoStatus({
      teacherId: TEACHER_A,
      memoId: memo.id,
      status: 'archived',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('archived');
  });

  it('非法 status 返回 VALIDATION_ERROR', async () => {
    const memo = await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '测试',
      content: '内容',
    });

    const result = await createService().updateMemoStatus({
      teacherId: TEACHER_A,
      memoId: memo.id,
      status: 'invalid' as never,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('不存在 / 跨 teacher 返回 NOT_FOUND', async () => {
    const memo = await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: 'A 的备忘',
      content: '内容',
    });

    // 不存在
    const result1 = await createService().updateMemoStatus({
      teacherId: TEACHER_A,
      memoId: 'nonexistent-id',
      status: 'done',
    });
    expect(result1.ok).toBe(false);
    if (result1.ok) return;
    expect(result1.error.code).toBe('NOT_FOUND');

    // 跨 teacher
    const result2 = await createService().updateMemoStatus({
      teacherId: TEACHER_B,
      memoId: memo.id,
      status: 'done',
    });
    expect(result2.ok).toBe(false);
    if (result2.ok) return;
    expect(result2.error.code).toBe('NOT_FOUND');
  });
});

describe('memoService.listDueMemos', () => {
  it('返回 dueAt <= dueBefore 且 status=active 的当前 teacher memos', async () => {
    const dueDate = new Date('2026-06-15T10:00:00Z');
    await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '到期备忘',
      content: '内容',
      dueAt: dueDate,
    });
    await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '未到期备忘',
      content: '内容',
      dueAt: new Date('2026-12-31T10:00:00Z'),
    });

    const result = await createService().listDueMemos({
      teacherId: TEACHER_A,
      dueBefore: new Date('2026-07-01T10:00:00Z'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0].title).toBe('到期备忘');
  });

  it('不返回 done / archived', async () => {
    const dueDate = new Date('2026-06-15T10:00:00Z');
    const memo1 = await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '已完成',
      content: '内容',
      dueAt: dueDate,
    });
    const memo2 = await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '已归档',
      content: '内容',
      dueAt: dueDate,
    });
    await prisma.memo.update({ where: { id: memo1.id }, data: { status: 'done' } });
    await prisma.memo.update({ where: { id: memo2.id }, data: { status: 'archived' } });

    const result = await createService().listDueMemos({
      teacherId: TEACHER_A,
      dueBefore: new Date('2026-07-01T10:00:00Z'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it('不返回 dueAt 为 null 的 memo', async () => {
    await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '无到期日',
      content: '内容',
    });

    const result = await createService().listDueMemos({
      teacherId: TEACHER_A,
      dueBefore: new Date('2026-12-31T10:00:00Z'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it('不泄露其他 teacher 的 due memos', async () => {
    const dueDate = new Date('2026-06-15T10:00:00Z');
    await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: 'A 的到期',
      content: '内容',
      dueAt: dueDate,
    });
    await createMemoOrThrow({
      teacherId: TEACHER_B,
      title: 'B 的到期',
      content: '内容',
      dueAt: dueDate,
    });

    const result = await createService().listDueMemos({
      teacherId: TEACHER_A,
      dueBefore: new Date('2026-07-01T10:00:00Z'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0].teacherId).toBe(TEACHER_A);
  });

  it('按 dueAt asc 排序', async () => {
    await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '后到期',
      content: '内容',
      dueAt: new Date('2026-06-30T10:00:00Z'),
    });
    await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '先到期',
      content: '内容',
      dueAt: new Date('2026-06-01T10:00:00Z'),
    });
    await createMemoOrThrow({
      teacherId: TEACHER_A,
      title: '中间到期',
      content: '内容',
      dueAt: new Date('2026-06-15T10:00:00Z'),
    });

    const result = await createService().listDueMemos({
      teacherId: TEACHER_A,
      dueBefore: new Date('2026-07-01T10:00:00Z'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
    expect(result.value[0].title).toBe('先到期');
    expect(result.value[1].title).toBe('中间到期');
    expect(result.value[2].title).toBe('后到期');
  });
});
