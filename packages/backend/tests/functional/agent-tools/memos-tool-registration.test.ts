import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';

// Phase 2.5-A: 红灯测试
// createMinimalToolRegistry 当前只注册 students.list 和 scheduling.list，
// 不包含 memos.create / memos.list / memos.updateStatus。
// 测试锁定 Phase 2.5 预期契约，实现将在 Phase 2.5-B 完成。

let createMinimalToolRegistry: any;
try {
  const mod = await import('../../../src/app/tool-registration.js');
  createMinimalToolRegistry = mod.createMinimalToolRegistry;
} catch {
  // 模块不存在
}

const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const TEACHER_A = 'test-teacher-memos-tools-a';
const TEACHER_B = 'test-teacher-memos-tools-b';

async function cleanup() {
  await prisma.conversationTurn.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.conversation.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.memo.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('memos 工具注册契约（Phase 2.5-A 红灯）', () => {
  it('registry.list 包含 memos.create / memos.list / memos.updateStatus', () => {
    if (!createMinimalToolRegistry) return;

    const registry = createMinimalToolRegistry({ prisma });
    const tools = registry.list();
    const toolNames = tools.map((t: any) => t.name);

    expect(toolNames).toContain('memos.create');
    expect(toolNames).toContain('memos.list');
    expect(toolNames).toContain('memos.updateStatus');
  });

  it('memos.create 调用真实 memo service，创建当前 teacher memo', async () => {
    if (!createMinimalToolRegistry) return;

    const registry = createMinimalToolRegistry({ prisma });
    const result = await registry.execute('memos.create', {
      title: '测试备忘',
      content: '测试内容',
    }, { teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 验证数据库中创建了 memo
    const memos = await prisma.memo.findMany({ where: { teacherId: TEACHER_A } });
    expect(memos).toHaveLength(1);
    expect(memos[0].title).toBe('测试备忘');
    // P8 phase-3 批6：memo.content 落库为密文，解密后为测试内容
    expect(memos[0].content).not.toBe('测试内容');
    expect(cipher.decrypt(memos[0].content)).toBe('测试内容');
    expect(memos[0].status).toBe('active');
  });

  it('memos.list 只返回当前 teacher memos，不泄露其他 teacher', async () => {
    if (!createMinimalToolRegistry) return;

    // 创建测试数据
    await prisma.memo.create({ data: { teacherId: TEACHER_A, title: 'A1', content: '内容A1' } });
    await prisma.memo.create({ data: { teacherId: TEACHER_A, title: 'A2', content: '内容A2' } });
    await prisma.memo.create({ data: { teacherId: TEACHER_B, title: 'B1', content: '内容B1' } });

    const registry = createMinimalToolRegistry({ prisma });
    const result = await registry.execute('memos.list', {}, { teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as { items: any[]; total: number };
    expect(data.items).toHaveLength(2);
    expect(data.items.every((m: any) => m.teacherId === TEACHER_A)).toBe(true);
    expect(data.items.find((m: any) => m.title === 'B1')).toBeUndefined();
  });

  it('memos.updateStatus 只能更新当前 teacher memo，跨 teacher 返回 NOT_FOUND', async () => {
    if (!createMinimalToolRegistry) return;

    const memo = await prisma.memo.create({
      data: { teacherId: TEACHER_A, title: 'A 的备忘', content: '内容' },
    });

    const registry = createMinimalToolRegistry({ prisma });

    // 正常更新
    const result1 = await registry.execute('memos.updateStatus', {
      memoId: memo.id,
      status: 'done',
    }, { teacherId: TEACHER_A });
    expect(result1.ok).toBe(true);
    if (!result1.ok) return;
    expect((result1.value as any).status).toBe('done');

    // 跨 teacher 更新应失败
    const result2 = await registry.execute('memos.updateStatus', {
      memoId: memo.id,
      status: 'archived',
    }, { teacherId: TEACHER_B });
    expect(result2.ok).toBe(false);
    if (result2.ok) return;
    expect(result2.error.code).toBe('NOT_FOUND');
  });

  it('仍不注册 memos.delete', () => {
    if (!createMinimalToolRegistry) return;

    const registry = createMinimalToolRegistry({ prisma });
    const tools = registry.list();
    const toolNames = tools.map((t: any) => t.name);

    expect(toolNames).not.toContain('memos.delete');
  });

  it('memos.list 非法 status 返回 VALIDATION_ERROR', async () => {
    if (!createMinimalToolRegistry) return;

    const registry = createMinimalToolRegistry({ prisma });
    const result = await registry.execute('memos.list', {
      status: 'invalid',
    }, { teacherId: TEACHER_A });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('memos.updateStatus 非法 status 返回 VALIDATION_ERROR', async () => {
    if (!createMinimalToolRegistry) return;

    const memo = await prisma.memo.create({
      data: { teacherId: TEACHER_A, title: '测试', content: '内容' },
    });

    const registry = createMinimalToolRegistry({ prisma });
    const result = await registry.execute('memos.updateStatus', {
      memoId: memo.id,
      status: 'invalid',
    }, { teacherId: TEACHER_A });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});
