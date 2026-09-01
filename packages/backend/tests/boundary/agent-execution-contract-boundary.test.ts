import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schemaPath = resolve(__dirname, '../../../contracts/prisma/schema.prisma');
const migrationPath = resolve(
  __dirname,
  '../../../contracts/prisma/migrations/00000000000002_add_agent_execution/migration.sql',
);
const servicePath = resolve(__dirname, '../../src/features/agent-execution/agent-execution-service.ts');

describe('P5.3 AgentExecution schema/migration boundary', () => {
  it('schema 声明执行账本、teacher 幂等键与 Conversation relation', () => {
    const schema = readFileSync(schemaPath, 'utf8');
    expect(schema).toContain('model AgentExecution');
    expect(schema).toMatch(/executions\s+AgentExecution\[\]/);
    expect(schema).toContain('@@unique([teacherId, clientRequestId])');
    expect(schema).toContain('@@index([conversationId, createdAtTs])');
    // D50 §6.1 索引精简：独立库下 teacherId 无区分度，业务表不再建 teacherId 复合索引
    expect(schema).not.toContain('@@index([teacherId, status, updatedAtTs])');
  });

  it('additive migration 创建表、索引和外键且无破坏性语句', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const sql = readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('CREATE TABLE "AgentExecution"');
    expect(sql).toContain('CREATE UNIQUE INDEX "AgentExecution_teacherId_clientRequestId_key"');
    expect(sql).toContain('REFERENCES "Conversation"("id")');
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i);
  });

  it('生命周期写入使用 TrustedClock，不把 session-sensitive CURRENT_TIMESTAMP 直接赋给时间列', () => {
    const source = readFileSync(servicePath, 'utf8');
    expect(source).toContain('createDatabaseTrustedClock(prisma)');
    expect(source).toContain('agentExecution.updateMany({');
    expect(source).not.toMatch(/"(?:finishedAtTs|updatedAtTs)"\s*=\s*CURRENT_TIMESTAMP/);
  });
});
