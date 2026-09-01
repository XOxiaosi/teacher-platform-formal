import type { Response } from 'express';
import { err, versionConflict } from '@teacher-platform/contracts';
import { describe, expect, it } from 'vitest';
import { parseScheduleType, sendResult } from '../../../src/app/routes/api-helpers.js';

const VALID_TYPES = ['lesson', 'prep', 'meeting', 'call', 'other'] as const;

describe('sendResult', () => {
  it('maps VERSION_CONFLICT to HTTP 409 with the standard error body', () => {
    let statusCode: number | undefined;
    let body: unknown;
    const response = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    } as Response;

    sendResult(response, err(versionConflict()));

    expect(statusCode).toBe(409);
    expect(body).toEqual({
      ok: false,
      error: {
        code: 'VERSION_CONFLICT',
        message: '记录已被其他操作更新，请刷新后重试',
        field: 'expectedUpdatedAt',
      },
    });
  });
});

describe('parseScheduleType', () => {
  it.each(VALID_TYPES)('接受合法日程类型 %s', (value) => {
    const result = parseScheduleType(value);

    expect(result).toEqual({ ok: true, value });
  });

  it('缺少查询参数时返回 undefined', () => {
    expect(parseScheduleType(undefined)).toEqual({ ok: true, value: undefined });
  });

  it.each(['invalid', '', 1, ['lesson']])('拒绝非法日程类型 %#', (value) => {
    const result = parseScheduleType(value);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: '日程类型不合法',
      field: 'type',
    });
  });
});
