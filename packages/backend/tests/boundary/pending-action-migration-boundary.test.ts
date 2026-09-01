import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  __dirname,
  '../../../contracts/prisma/migrations/00000000000001_add_pending_action/migration.sql',
);
// D50 §6.1 索引精简：独立库下 teacherId 无区分度，业务表不再建 teacherId 索引，
// 由 20260901000000_drop_teacherid_indexes 迁移 DROP（历史迁移不可变，断言新迁移收口）。
const dropIndexMigrationPath = resolve(
  __dirname,
  '../../../contracts/prisma/migrations/20260901000000_drop_teacherid_indexes/migration.sql',
);

function migrationSql(): string {
  expect(existsSync(migrationPath), `缺少 PendingAction migration: ${migrationPath}`).toBe(true);
  return readFileSync(migrationPath, 'utf8');
}

describe('P5.2 PendingAction additive migration', () => {
  it('创建表、全部契约字段、唯一键、索引与 Conversation 外键', () => {
    const sql = migrationSql();

    expect(sql).toContain('CREATE TABLE "PendingAction"');
    for (const column of [
      'id', 'teacherId', 'conversationId', 'toolCallId', 'actionName', 'targetType', 'targetId',
      'parameters', 'beforeSummary', 'afterSummary', 'status', 'expiresAt', 'consumedAt',
      'cancelledAt', 'createdAt', 'updatedAt',
    ]) {
      expect(sql).toContain(`"${column}"`);
    }
    expect(sql).toContain('CREATE UNIQUE INDEX "PendingAction_teacherId_toolCallId_key"');
    expect(sql).toContain('CREATE INDEX "PendingAction_teacherId_status_expiresAt_idx"');
    expect(sql).toContain('CREATE INDEX "PendingAction_conversationId_idx"');
    expect(sql).toContain('FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")');
  });

  it('migration 纯新增，不包含破坏性数据语句', () => {
    const sql = migrationSql();

    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bALTER\s+COLUMN\b/i);
  });

  it('D50 索引精简：drop_teacherid_indexes 迁移 DROP 低区分度 teacherId 索引，保留幂等唯一键', () => {
    expect(existsSync(dropIndexMigrationPath), `缺少 drop 索引迁移: ${dropIndexMigrationPath}`).toBe(true);
    const sql = readFileSync(dropIndexMigrationPath, 'utf8');
    expect(sql).toContain('DROP INDEX "PendingAction_teacherId_status_expiresAtTs_idx"');
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+COLUMN\b/i);
  });
});
