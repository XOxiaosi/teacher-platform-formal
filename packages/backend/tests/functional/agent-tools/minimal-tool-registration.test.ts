import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

// Phase 1.12-A: 红灯测试
// tool-registration 模块不存在，import 会失败。
// 测试锁定 Phase 1.12 预期契约，实现将在 Phase 1.12-B 完成。
//
// 最小契约：
//   createMinimalToolRegistry({ prisma }): ToolRegistry
//   注册 students.list 和 scheduling.list 两个只读工具

// 尝试 import（当前会失败）
let createMinimalToolRegistry: any;
try {
  const mod = await import('../../../src/app/tool-registration.js');
  createMinimalToolRegistry = mod.createMinimalToolRegistry;
} catch {
  // 模块不存在
}

const prisma = new PrismaClient();
const TEACHER_A = 'test-teacher-tools-a';
const TEACHER_B = 'test-teacher-tools-b';

async function cleanup() {
  await prisma.conversationTurn.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.conversation.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.payment.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('minimalToolRegistry 契约（Phase 1.12-A 红灯）', () => {
  it('模块不存在时 import 失败', () => {
    expect(createMinimalToolRegistry).toBeDefined();
  });

  it('registry.list 包含 students.list 和 scheduling.list', () => {
    if (!createMinimalToolRegistry) return;

    const registry = createMinimalToolRegistry({ prisma });
    const tools = registry.list();

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain('students.list');
    expect(toolNames).toContain('scheduling.list');
  });

  it('students.list 只返回当前 teacher 数据', async () => {
    if (!createMinimalToolRegistry) return;

    // 创建测试数据
    await prisma.student.create({ data: { teacherId: TEACHER_A, name: '张三', grade: '高三' } });
    await prisma.student.create({ data: { teacherId: TEACHER_A, name: '李四', grade: '高二' } });
    await prisma.student.create({ data: { teacherId: TEACHER_B, name: '王五', grade: '高一' } });

    const registry = createMinimalToolRegistry({ prisma });
    const result = await registry.execute('students.list', {}, { teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 应只返回 TEACHER_A 的学生
    const data = result.value as { items: any[]; total: number };
    expect(data.items).toHaveLength(2);
    expect(data.items.every((s: any) => s.teacherId === TEACHER_A)).toBe(true);
  });

  it('scheduling.list 只返回当前 teacher 数据', async () => {
    if (!createMinimalToolRegistry) return;

    // 创建测试数据
    const now = new Date();
    const later = new Date(now.getTime() + 3600000);
    await prisma.schedule.create({
      data: { teacherId: TEACHER_A, type: 'lesson', title: 'A的课', scheduledStartTs: now, scheduledEndTs: later },
    });
    await prisma.schedule.create({
      data: { teacherId: TEACHER_B, type: 'lesson', title: 'B的课', scheduledStartTs: now, scheduledEndTs: later },
    });

    const registry = createMinimalToolRegistry({ prisma });
    const result = await registry.execute('scheduling.list', {}, { teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 应只返回 TEACHER_A 的日程
    const data = result.value as { items: any[]; total: number };
    expect(data.items).toHaveLength(1);
    expect(data.items[0].teacherId).toBe(TEACHER_A);
  });

  it('跨 teacher 数据不可泄露', async () => {
    if (!createMinimalToolRegistry) return;

    // 创建测试数据
    await prisma.student.create({ data: { teacherId: TEACHER_A, name: '张三', grade: '高三' } });
    await prisma.student.create({ data: { teacherId: TEACHER_B, name: '王五', grade: '高一' } });

    const registry = createMinimalToolRegistry({ prisma });

    // TEACHER_A 查询不应看到 TEACHER_B 的数据
    const resultA = await registry.execute('students.list', {}, { teacherId: TEACHER_A });
    expect(resultA.ok).toBe(true);
    if (!resultA.ok) return;
    const dataA = resultA.value as { items: any[]; total: number };
    expect(dataA.items).toHaveLength(1);
    expect(dataA.items.every((s: any) => s.teacherId === TEACHER_A)).toBe(true);
    expect(dataA.items.find((s: any) => s.name === '王五')).toBeUndefined();

    // TEACHER_B 查询不应看到 TEACHER_A 的数据
    const resultB = await registry.execute('students.list', {}, { teacherId: TEACHER_B });
    expect(resultB.ok).toBe(true);
    if (!resultB.ok) return;
    const dataB = resultB.value as { items: any[]; total: number };
    expect(dataB.items).toHaveLength(1);
    expect(dataB.items.every((s: any) => s.teacherId === TEACHER_B)).toBe(true);
    expect(dataB.items.find((s: any) => s.name === '张三')).toBeUndefined();
  });

  it('未注册未设计的回溯修正和删除工具', () => {
    if (!createMinimalToolRegistry) return;

    const registry = createMinimalToolRegistry({ prisma });
    const tools = registry.list();
    const toolNames = tools.map((t: any) => t.name);

    // Phase 4.3 允许受 confirm 保护的状态流转工具，但不应包含未设计的回溯修正和删除工具
    expect(toolNames).not.toContain('students.update');
    expect(toolNames).not.toContain('scheduling.update');
    expect(toolNames).not.toContain('scheduling.missed');
    expect(toolNames).not.toContain('lessons.update');
    expect(toolNames).not.toContain('payments.delete');
  });

  it('composition 默认不再构造旧 agentConverse 或第二套工具运行时', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const compositionPath = path.resolve(
      __dirname,
      '../../../src/app/composition/core-route-dependencies.ts',
    );
    const source = fs.readFileSync(compositionPath, 'utf8');

    expect(source).not.toContain('createAgentConverseUseCase');
    expect(source).not.toContain('createMinimalToolRegistry');
    expect(source).toContain('const legacyAgent = options?.agentConverse');
  });
});
