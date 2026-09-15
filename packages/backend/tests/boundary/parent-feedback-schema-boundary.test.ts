import { readPrismaSchema } from '../helpers/prisma-schema.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_PATH = resolve(
  __dirname,
  '../../../contracts/prisma/migrations/20260911000000_add_parent_feedback_moderation/migration.sql',
);
const schema = readPrismaSchema();
const migration = readFileSync(MIGRATION_PATH, 'utf8');

function modelBody(modelName: string): string {
  const match = schema.match(new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`));
  return match?.[1] ?? '';
}

describe('Phase 3.1 ParentFeedback 数据模型边界', () => {
  it('schema 中存在 model ParentFeedback', () => {
    expect(schema).toContain('model ParentFeedback {');
  });

  it('ParentFeedback 包含必要字段', () => {
    const body = modelBody('ParentFeedback');

    expect(body).toMatch(/teacherId\s+String/);
    expect(body).toMatch(/studentId\s+String/);
    expect(body).toMatch(/lessonId\s+String\?/);
    expect(body).toMatch(/title\s+String/);
    expect(body).toMatch(/content\s+String/);
    expect(body).toMatch(/status\s+String/);
    expect(body).toMatch(/channel\s+String\?/);
    expect(body).toMatch(/parentName\s+String\?/);
    expect(body).toMatch(/sentAtTs\s+DateTime\?/);
    expect(body).toMatch(/^\s*moderationFlagged\s+Boolean\?\s*$/m);
    expect(body).toMatch(/^\s*moderationReasons\s+Json\?\s*$/m);
  });

  it('第26迁移只加两列 nullable 审核投影，不含破坏性或数据改写 SQL', () => {
    const executableSql = migration.replace(/^\s*--.*$/gm, '').trim();

    expect(executableSql).toMatch(/ALTER TABLE "ParentFeedback"\s+ADD COLUMN\s+"moderationFlagged" BOOLEAN\s*,/);
    expect(executableSql).toMatch(/ADD COLUMN\s+"moderationReasons" JSONB\s*;/);
    expect(executableSql.match(/ADD COLUMN/g)).toHaveLength(2);
    expect(executableSql).not.toMatch(/\b(?:DROP|UPDATE|DELETE|TRUNCATE)\b/i);
    expect(executableSql).not.toMatch(/\bNOT NULL\b/i);
    expect(executableSql).not.toMatch(/\bDEFAULT\b/i);
  });

  it('status 默认 draft', () => {
    const body = modelBody('ParentFeedback');

    expect(body).toMatch(/status\s+String\s+@default\("draft"\)/);
  });

  it('lessonId 是可选 String?', () => {
    const body = modelBody('ParentFeedback');

    expect(body).toMatch(/lessonId\s+String\?/);
  });

  it('student relation 必填，lesson relation 可选', () => {
    const body = modelBody('ParentFeedback');

    // student relation：必填
    expect(body).toContain('student Student @relation(fields: [studentId], references: [id])');
    // lesson relation：可选
    expect(body).toContain('lesson  Lesson? @relation(fields: [lessonId], references: [id])');
  });

  it('createdAt / updatedAt 存在，updatedAt 使用 @updatedAt', () => {
    const body = modelBody('ParentFeedback');

    expect(body).toMatch(/createdAtTs\s+DateTime\s+@default\(now\(\)\)/);
    expect(body).toMatch(/updatedAtTs\s+DateTime\s+@updatedAt/);
  });

  it('索引保留 studentId、lessonId，且无低区分度 teacherId 索引', () => {
    const body = modelBody('ParentFeedback');

    // D50 §6.1 索引精简：独立库下 teacherId 无区分度，业务表不再建 teacherId 索引
    expect(body).not.toContain('@@index([teacherId, status])');
    expect(body).toContain('@@index([studentId])');
    expect(body).toContain('@@index([lessonId])');
    expect(body).not.toContain('@@index([teacherId, createdAtTs])');
  });

  it('Student 模型包含 parentFeedbacks ParentFeedback[] relation', () => {
    const body = modelBody('Student');

    expect(body).toContain('parentFeedbacks ParentFeedback[]');
  });

  it('Lesson 模型包含 parentFeedbacks ParentFeedback[] relation', () => {
    const body = modelBody('Lesson');

    expect(body).toContain('parentFeedbacks ParentFeedback[]');
  });

  it('ParentFeedback 不直接关联 ConversationTurn，也不包含 conversationId', () => {
    const body = modelBody('ParentFeedback');

    expect(body).not.toContain('ConversationTurn');
    expect(body).not.toMatch(/conversationId\s+String/);
  });
});
