import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { createTeachingRegistry } from '../../../src/app/teaching-runtime/create-teaching-registry.js';
import { createTeachingQueryTools } from '../../../src/app/teaching-runtime/teaching-query-tools.js';
import { sourceRefsFromQuery } from '../../../src/features/teaching-tasks/teaching-task-sources.js';

function fixture() {
  const findMany = vi.fn(async () => []);
  const count = vi.fn(async () => 0);
  const client = { parentFeedback: { findMany, count } } as unknown as PrismaClient;
  const getClient = vi.fn(async () => client);
  const registry = createTeachingRegistry(getClient);
  return { findMany, count, getClient, registry };
}

describe('A05 feedback context admission', () => {
  it('只将 feedback.list 作为教师范围只读工具接入，不注册反馈写工具', () => {
    const { registry } = fixture();
    const definitions = registry.list();
    expect(definitions.find(tool => tool.name === 'students.create')).toMatchObject({ sideEffect: 'create' });
    expect(definitions.map(tool => tool.name)).toContain('feedback.list');
    expect(definitions.find(tool => tool.name === 'feedback.list')).toMatchObject({ sideEffect: 'read' });
    expect(definitions.map(tool => tool.name)).not.toContain('feedback.create');
    expect(definitions.map(tool => tool.name)).not.toContain('feedback.updateStatus');
  });

  it('feedback.list 固定 teacherId 并透传状态与分页过滤', async () => {
    const { findMany, count, getClient, registry } = fixture();
    const result = await registry.execute('feedback.list', {
      studentId: 'student-a', status: 'draft', page: 2, pageSize: 5,
    }, { teacherId: 'teacher-a' });
    expect(result).toEqual({ ok: true, value: { items: [], total: 0 } });
    expect(getClient).toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { teacherId: 'teacher-a', studentId: 'student-a', status: 'draft' },
      skip: 5, take: 5,
    }));
    expect(count).toHaveBeenCalledWith({ where: { teacherId: 'teacher-a', studentId: 'student-a', status: 'draft' } });
  });

  it('教学工具端口只暴露已审计的反馈读取，不能执行 feedback.create', async () => {
    const { registry } = fixture();
    const tools = createTeachingQueryTools(registry, 'teacher-a');
    expect(tools.definitions.map(tool => tool.name)).toContain('feedback.list');
    expect(tools.definitions.map(tool => tool.name)).not.toContain('feedback.create');
    expect((await tools.execute('feedback.create', { studentId: 'student-a' })).ok).toBe(false);
  });

  it('feedback.list 返回的正式反馈版本进入来源围栏', () => {
    const refs = sourceRefsFromQuery('feedback.list', {}, {
      items: [{ id: 'feedback-a', updatedAt: new Date('2026-09-16T08:00:00.000Z') }], total: 1,
    });
    expect(refs).toEqual([{ type: 'ParentFeedback', id: 'feedback-a', version: '2026-09-16T08:00:00.000Z' }]);
  });
});
