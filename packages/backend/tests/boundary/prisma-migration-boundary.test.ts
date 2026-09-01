import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_ROOT = resolve(__dirname, '../../../contracts/prisma/migrations');
const BASELINE_NAME = '00000000000000_current_schema_baseline';
const BASELINE_SQL = resolve(MIGRATIONS_ROOT, BASELINE_NAME, 'migration.sql');
const LOCK_FILE = resolve(MIGRATIONS_ROOT, 'migration_lock.toml');

const EXPECTED_TABLES = [
  'Student',
  'Schedule',
  'Lesson',
  'AINote',
  'Conversation',
  'ConversationTurn',
  'Payment',
  'DailyReview',
  'PushRecord',
  'ChangeLog',
  'Memo',
  'ParentFeedback',
];

const EXPECTED_FOREIGN_KEYS = [
  ['Schedule', 'studentId', 'Student'],
  ['Schedule', 'parentId', 'Schedule'],
  ['Lesson', 'studentId', 'Student'],
  ['Lesson', 'scheduleId', 'Schedule'],
  ['ConversationTurn', 'conversationId', 'Conversation'],
  ['Payment', 'studentId', 'Student'],
  ['ParentFeedback', 'studentId', 'Student'],
  ['ParentFeedback', 'lessonId', 'Lesson'],
] as const;

function migrationSql(): string {
  expect(existsSync(BASELINE_SQL), `缺少 baseline migration: ${BASELINE_SQL}`).toBe(true);
  return readFileSync(BASELINE_SQL, 'utf8');
}

describe('Prisma current schema baseline migration', () => {
  it('存在 PostgreSQL migration lock 和固定名称的 baseline', () => {
    expect(existsSync(MIGRATIONS_ROOT)).toBe(true);
    expect(existsSync(LOCK_FILE)).toBe(true);
    expect(readFileSync(LOCK_FILE, 'utf8')).toContain('provider = "postgresql"');
    expect(existsSync(BASELINE_SQL)).toBe(true);
  });

  it.each(EXPECTED_TABLES)('baseline 创建 %s 表', (table) => {
    expect(migrationSql()).toMatch(new RegExp(`CREATE TABLE \\"${table}\\"`));
  });

  it.each(EXPECTED_FOREIGN_KEYS)(
    '%s.%s 外键指向 %s',
    (table, field, targetTable) => {
      const sql = migrationSql();
      expect(sql).toContain(`ALTER TABLE "${table}"`);
      expect(sql).toContain(`FOREIGN KEY ("${field}") REFERENCES "${targetTable}"("id")`);
    },
  );

  it('baseline 不包含破坏性数据语句', () => {
    const sql = migrationSql();

    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
