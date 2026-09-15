import { describe, expect, it } from 'vitest';
import { D47_AUDIT_TIME_FIELD_MATRIX } from '../fixtures/d47-audit-time-field-matrix.js';
import {
  D48_HISTORICAL_TIME_SOURCE_MATRIX,
  LA_WALL_FIELDS,
  UTC_WALL_FIELDS,
  ANOMALOUS_FIELDS,
  UNKNOWN_FIELDS,
} from '../fixtures/d48-historical-time-source-matrix.js';

describe('D48 historical time source matrix boundary', () => {
  it('分群矩阵覆盖 D47 全部时间字段，无遗漏无多余', () => {
    const d47Keys = new Set(D47_AUDIT_TIME_FIELD_MATRIX.map((e) => e.key));
    const d48Keys = new Set(D48_HISTORICAL_TIME_SOURCE_MATRIX.map((e) => e.key));

    // D47 的每个字段在 D48 中必须存在
    for (const key of d47Keys) {
      expect(d48Keys.has(key)).toBe(true);
    }

    // D48 不能有 D47 之外的字段
    for (const key of d48Keys) {
      expect(d47Keys.has(key)).toBe(true);
    }

    expect(D48_HISTORICAL_TIME_SOURCE_MATRIX).toHaveLength(D47_AUDIT_TIME_FIELD_MATRIX.length);
  });

  it('每个来源分类使用冻结枚举', () => {
    const VALID_SOURCES = new Set([
      'UTC_WALL',
      'LOS_ANGELES_WALL',
      'SHANGHAI_WALL',
      'BUSINESS_DATE',
      'UNKNOWN',
      'N_A',
    ]);
    const VALID_INVARIANTS = new Set(['PASS', 'FAIL', 'N_A']);
    const VALID_CONVERSIONS = new Set([
      'AT_TIME_ZONE_UTC',
      'AT_TIME_ZONE_LA',
      'DIRECT_COPY',
      'NONE',
    ]);

    for (const entry of D48_HISTORICAL_TIME_SOURCE_MATRIX) {
      expect(VALID_SOURCES.has(entry.source)).toBe(true);
      expect(VALID_INVARIANTS.has(entry.invariant)).toBe(true);
      expect(VALID_CONVERSIONS.has(entry.migrationConversion)).toBe(true);
    }
  });

  it('LOS_ANGELES_WALL 字段全部存在异常标注', () => {
    const laFields = D48_HISTORICAL_TIME_SOURCE_MATRIX.filter(
      (e) => e.source === 'LOS_ANGELES_WALL',
    );

    for (const entry of laFields) {
      expect(entry.anomaly).not.toBeNull();
      expect(entry.invariant).toBe('FAIL');
      expect(entry.migrationConversion).toBe('AT_TIME_ZONE_LA');
    }

    // 当前仅 AgentExecution.finishedAt 和 updatedAt
    expect(LA_WALL_FIELDS).toEqual([
      'AgentExecution.finishedAtTs',
      'AgentExecution.updatedAtTs',
    ]);
  });

  it('UTC_WALL 字段不变量全部 PASS 且迁移方式为 AT_TIME_ZONE_UTC', () => {
    for (const key of UTC_WALL_FIELDS) {
      const entry = D48_HISTORICAL_TIME_SOURCE_MATRIX.find((e) => e.key === key)!;
      expect(entry.invariant).toBe('PASS');
      expect(entry.anomaly).toBeNull();
      expect(entry.migrationConversion).toBe('AT_TIME_ZONE_UTC');
    }
  });

  it('SHANGHAI_WALL 字段值已是正确 UTC，迁移方式为 DIRECT_COPY', () => {
    const shFields = D48_HISTORICAL_TIME_SOURCE_MATRIX.filter(
      (e) => e.source === 'SHANGHAI_WALL',
    );

    for (const entry of shFields) {
      expect(entry.invariant).toBe('PASS');
      expect(entry.anomaly).toBeNull();
      expect(entry.migrationConversion).toBe('DIRECT_COPY');
    }
  });

  it('空表字段标记为 N_A 且迁移方式为 NONE', () => {
    const naFields = D48_HISTORICAL_TIME_SOURCE_MATRIX.filter(
      (e) => e.source === 'N_A',
    );

    for (const entry of naFields) {
      expect(entry.rowCount).toBe(0);
      expect(entry.invariant).toBe('N_A');
      expect(entry.anomaly).toBeNull();
      expect(entry.migrationConversion).toBe('NONE');
    }
  });

  it('新增字段的历史范围与业务日期语义保持严格登记', () => {
    const recurrenceDay = D48_HISTORICAL_TIME_SOURCE_MATRIX.find(
      (e) => e.key === 'Schedule.recurrenceDay',
    )!;
    expect(recurrenceDay).toEqual({
      key: 'Schedule.recurrenceDay',
      rowCount: 0,
      source: 'BUSINESS_DATE',
      invariant: 'N_A',
      anomaly: null,
      migrationConversion: 'NONE',
    });

    const newTableFields = [
      'RecurrenceRule.startDate',
      'RecurrenceRule.endDate',
      'RecurrenceRule.createdAtTs',
      'RecurrenceRule.updatedAtTs',
      'RecurrenceRuleParticipant.createdAtTs',
      'ScheduleRevision.createdAtTs',
      'ScheduleCompletionSnapshot.createdAtTs',
      'TeacherWorkspacePreference.updatedAtTs',
      'WebMutationReceipt.createdAtTs',
      'SchedulingWebMutationReceipt.createdAtTs',
    ];
    for (const key of newTableFields) {
      const entry = D48_HISTORICAL_TIME_SOURCE_MATRIX.find((e) => e.key === key)!;
      expect(entry).toEqual({
        key,
        rowCount: 0,
        source: 'N_A',
        invariant: 'N_A',
        anomaly: null,
        migrationConversion: 'NONE',
      });
    }
  });

  it('UNKNOWN 字段数为 0', () => {
    expect(UNKNOWN_FIELDS).toHaveLength(0);
  });

  it('异常字段恰好为 AgentExecution.finishedAt 和 updatedAt', () => {
    expect(ANOMALOUS_FIELDS).toEqual([
      'AgentExecution.finishedAtTs',
      'AgentExecution.updatedAtTs',
    ]);
  });

  it('有数据的字段总行数等于生产数据按字段计行总数 181', () => {
    const totalRows = D48_HISTORICAL_TIME_SOURCE_MATRIX
      .filter((e) => e.source !== 'N_A')
      .reduce((sum, e) => sum + e.rowCount, 0);

    // Student 19*2=38 + Schedule 12*4=48 + AINote 2*2=4 + Conv 2*2=4 + Turn 27*1=27 + AgentExec 6*4=24 + ChangeLog 16*2=32 + Memo 2*2=4 = 181
    expect(totalRows).toBe(181);
  });

  it('AgentExecution 异常偏移标注为 ~-7h (PDT)', () => {
    const finishedAt = D48_HISTORICAL_TIME_SOURCE_MATRIX.find(
      (e) => e.key === 'AgentExecution.finishedAtTs',
    )!;
    const updatedAt = D48_HISTORICAL_TIME_SOURCE_MATRIX.find(
      (e) => e.key === 'AgentExecution.updatedAtTs',
    )!;

    expect(finishedAt.source).toBe('LOS_ANGELES_WALL');
    expect(finishedAt.anomaly).toContain('-7h');
    expect(finishedAt.anomaly).toContain('PDT');

    expect(updatedAt.source).toBe('LOS_ANGELES_WALL');
    expect(updatedAt.anomaly).toContain('-7h');
    expect(updatedAt.anomaly).toContain('PDT');
  });
});
