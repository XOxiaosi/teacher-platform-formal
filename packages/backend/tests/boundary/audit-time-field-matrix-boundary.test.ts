import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { D47_AUDIT_TIME_FIELD_MATRIX } from '../fixtures/d47-audit-time-field-matrix.js';

const SCHEMA_PATH = resolve(process.cwd(), '../contracts/prisma/schema.prisma');
const SEMANTICS = new Set(['INSTANT', 'BUSINESS_DATE', 'LOCAL_WALL_TIME']);
const CURRENT_SOURCES = new Set([
  'DDL_DEFAULT_PENDING_QUERY_EVIDENCE',
  'PRISMA',
  'TRUSTED_DB',
  'INPUT',
  'APP_CLOCK',
  'MIXED',
]);
const NEW_WRITE_RISKS = new Set(['LOW', 'MEDIUM', 'HIGH', 'SEALED_HIGH']);
const MIGRATION_RISKS = new Set(['LOW', 'MEDIUM', 'HIGH']);

function stripPrismaComments(schema: string): string {
  return schema
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function extractDateTimeFieldKeys(schema: string): string[] {
  const keys: string[] = [];
  let currentModel: string | undefined;

  for (const rawLine of stripPrismaComments(schema).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!currentModel) {
      const modelMatch = line.match(/^model\s+(\w+)\s*\{$/);
      if (modelMatch) currentModel = modelMatch[1];
      continue;
    }
    if (line === '}') {
      currentModel = undefined;
      continue;
    }
    const fieldMatch = line.match(/^(\w+)\s+DateTime(?:\?|\[\])?(?:\s|$)/);
    if (fieldMatch) keys.push(`${currentModel}.${fieldMatch[1]}`);
  }

  if (currentModel) throw new Error(`Prisma model未闭合: ${currentModel}`);
  return keys;
}

describe('D47 audit-time field matrix boundary', () => {
  it('schema扫描器接受缩进结束括号并忽略行注释与块注释', () => {
    const schema = `
      model Probe {
        occurredAt DateTime
        // ignoredAt DateTime
        /* ignoredBlockAt DateTime */
        optionalAt DateTime?
        }
    `;
    expect(extractDateTimeFieldKeys(schema)).toEqual(['Probe.occurredAt', 'Probe.optionalAt']);
  });

  it('手工矩阵与Prisma schema的84个DateTime字段双向完全一致', () => {
    const schemaKeys = extractDateTimeFieldKeys(readFileSync(SCHEMA_PATH, 'utf8'));
    const matrixKeys = D47_AUDIT_TIME_FIELD_MATRIX.map((entry) => entry.key);
    const uniqueMatrixKeys = new Set(matrixKeys);

    expect(schemaKeys).toHaveLength(84);
    expect(matrixKeys).toHaveLength(84);
    expect(uniqueMatrixKeys.size).toBe(matrixKeys.length);
    expect(schemaKeys.filter((key) => !uniqueMatrixKeys.has(key))).toEqual([]);
    expect(matrixKeys.filter((key) => !schemaKeys.includes(key))).toEqual([]);
  });

  it('冻结83个instant、唯一业务日期与零本地墙上时间', () => {
    const instantKeys = D47_AUDIT_TIME_FIELD_MATRIX
      .filter((entry) => entry.semantics === 'INSTANT')
      .map((entry) => entry.key);
    const businessDateKeys = D47_AUDIT_TIME_FIELD_MATRIX
      .filter((entry) => entry.semantics === 'BUSINESS_DATE')
      .map((entry) => entry.key);
    const localWallTimeKeys = D47_AUDIT_TIME_FIELD_MATRIX
      .filter((entry) => entry.semantics === 'LOCAL_WALL_TIME')
      .map((entry) => entry.key);

    expect(instantKeys).toHaveLength(83);
    expect(businessDateKeys).toEqual(['DailyReview.dateTs']);
    expect(localWallTimeKeys).toEqual([]);
  });

  it('每项四维分类均使用冻结枚举，Student创建时刻反映query-event实证', () => {
    for (const entry of D47_AUDIT_TIME_FIELD_MATRIX) {
      expect(SEMANTICS.has(entry.semantics)).toBe(true);
      expect(CURRENT_SOURCES.has(entry.currentSource)).toBe(true);
      expect(NEW_WRITE_RISKS.has(entry.newWriteRisk)).toBe(true);
      expect(MIGRATION_RISKS.has(entry.migrationRisk)).toBe(true);
    }

    expect(D47_AUDIT_TIME_FIELD_MATRIX.find((entry) => entry.key === 'Student.createdAtTs')).toEqual({
      key: 'Student.createdAtTs',
      semantics: 'INSTANT',
      currentSource: 'TRUSTED_DB',
      newWriteRisk: 'LOW',
      migrationRisk: 'HIGH',
    });
  });
});
