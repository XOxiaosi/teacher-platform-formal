import { readPrismaSchema } from '../helpers/prisma-schema.js';
import { describe, expect, it } from 'vitest';

const schema = readPrismaSchema();

function modelBody(modelName: string): string {
  const match = schema.match(new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`));
  return match?.[1] ?? '';
}

describe('D8 Phase 1.1 Agent 对话数据模型边界', () => {
  it('Conversation 模型包含 teacherId 隔离、状态机注释、turns 关系且无低区分度 teacherId 索引', () => {
    const body = modelBody('Conversation');

    expect(body).toMatch(/id\s+String\s+@id\s+@default\(cuid\(\)\)/);
    expect(body).toMatch(/teacherId\s+String/);
    expect(body).toMatch(/status\s+String\s+@default\("active"\)/);
    expect(body).toMatch(/summary\s+String\?/);
    expect(body).toMatch(/createdAtTs\s+DateTime\s+@default\(now\(\)\)/);
    expect(body).toMatch(/updatedAtTs\s+DateTime\s+@updatedAt/);
    expect(body).toMatch(/turns\s+ConversationTurn\[\]/);
    expect(body).toContain('active -> archived');
    // D50 §6.1 索引精简：独立库下 teacherId 无区分度，业务表不再建 teacherId 索引
    expect(body).not.toContain('@@index([teacherId])');
    expect(body).not.toContain('@@index([teacherId, status])');
  });

  it('ConversationTurn 模型是不可修改追加日志，包含 relation 且无低区分度 teacherId 索引', () => {
    const body = modelBody('ConversationTurn');

    expect(body).toMatch(/id\s+String\s+@id\s+@default\(cuid\(\)\)/);
    expect(body).toMatch(/conversationId\s+String/);
    expect(body).toMatch(/teacherId\s+String/);
    expect(body).toMatch(/role\s+String/);
    expect(body).toMatch(/content\s+String/);
    expect(body).toMatch(/toolCalls\s+Json\?/);
    expect(body).toMatch(/toolResults\s+Json\?/);
    expect(body).toMatch(/audioFileRef\s+String\?/);
    expect(body).toMatch(/createdAtTs\s+DateTime\s+@default\(now\(\)\)/);
    expect(body).toContain('conversation Conversation @relation(fields: [conversationId], references: [id])');
    expect(body).toContain('ConversationTurn 无 updatedAt');
    expect(body).toContain('@@index([conversationId])');
    // D50 §6.1 索引精简：独立库下 teacherId 无区分度，业务表不再建 teacherId 索引
    expect(body).not.toContain('@@index([teacherId])');
  });
});
