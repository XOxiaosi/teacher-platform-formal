import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCHEMA_PATH = resolve(__dirname, '../../../contracts/prisma/schema.prisma');
const schema = readFileSync(SCHEMA_PATH, 'utf8');

function modelBody(modelName: string): string {
  const match = schema.match(new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`));
  return match?.[1] ?? '';
}

describe('Phase 2.1 Memo 数据模型边界', () => {
  it('schema 中存在 model Memo', () => {
    expect(schema).toContain('model Memo {');
  });

  it('Memo 包含 teacherId，且无低区分度 teacherId 索引', () => {
    const body = modelBody('Memo');

    expect(body).toMatch(/teacherId\s+String/);
    // D50 §6.1 索引精简：独立库下 teacherId 无区分度，业务表不再建 teacherId 索引
    expect(body).not.toContain('@@index([teacherId');
  });

  it('Memo 包含 title/content/status/dueAt/tags/source', () => {
    const body = modelBody('Memo');

    expect(body).toMatch(/title\s+String/);
    expect(body).toMatch(/content\s+String/);
    expect(body).toMatch(/status\s+String/);
    expect(body).toMatch(/dueAtTs\s+DateTime\?/);
    expect(body).toMatch(/tags\s+Json\?/);
    expect(body).toMatch(/source\s+String\?/);
  });

  it('status 有默认值 active', () => {
    const body = modelBody('Memo');

    expect(body).toMatch(/status\s+String\s+@default\("active"\)/);
  });

  it('dueAt 是可选 DateTime', () => {
    const body = modelBody('Memo');

    expect(body).toMatch(/dueAtTs\s+DateTime\?/);
  });

  it('tags 是可选 Json', () => {
    const body = modelBody('Memo');

    expect(body).toMatch(/tags\s+Json\?/);
  });

  it('createdAt / updatedAt 存在，updatedAt 使用 @updatedAt', () => {
    const body = modelBody('Memo');

    expect(body).toMatch(/createdAtTs\s+DateTime\s+@default\(now\(\)\)/);
    expect(body).toMatch(/updatedAtTs\s+DateTime\s+@updatedAt/);
  });

  it('Memo 是独立业务实体，不与 ConversationTurn 有强耦合 relation', () => {
    const body = modelBody('Memo');

    // Memo 不应引用 ConversationTurn
    expect(body).not.toContain('ConversationTurn');
    // Memo 不应有 conversationId 外键指向 Conversation
    expect(body).not.toMatch(/conversationId\s+String/);
  });
});
