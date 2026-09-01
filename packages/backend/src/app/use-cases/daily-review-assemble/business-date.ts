import { err, internalError, ok, validationError, type CommonError, type Result } from '@teacher-platform/contracts';

const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
const MIN_BUSINESS_DATE = '1992-01-01';
const MAX_BUSINESS_DATE = '9998-12-31';
const BUSINESS_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BusinessDateValue {
  text: string;
  windowStart: Date;
  windowEndExclusive: Date;
  reviewDate: Date;
}

export function parseBusinessDate(value: unknown): Result<BusinessDateValue, CommonError> {
  if (typeof value !== 'string') {
    return err(validationError('date 必须是 YYYY-MM-DD 格式', 'date'));
  }
  return parseBusinessDateText(value, 'validation');
}

export function projectShanghaiBusinessDate(instant: Date): Result<BusinessDateValue, CommonError> {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    return err(internalError('可信时间返回无效日期'));
  }

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      calendar: 'gregory',
      numberingSystem: 'latn',
      timeZone: BUSINESS_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
    const year = part('year');
    const month = part('month');
    const day = part('day');
    if (!year || !month || !day) return err(internalError('可信时间无法投影为业务日期'));
    return parseBusinessDateText(`${year.padStart(4, '0')}-${month}-${day}`, 'internal');
  } catch {
    return err(internalError('可信时间无法投影为业务日期'));
  }
}

function parseBusinessDateText(
  value: string,
  failure: 'validation' | 'internal',
): Result<BusinessDateValue, CommonError> {
  const match = BUSINESS_DATE_PATTERN.exec(value);
  if (!match || value < MIN_BUSINESS_DATE || value > MAX_BUSINESS_DATE) {
    return dateFailure(failure);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcMidnightMs = Date.UTC(year, month - 1, day);
  const candidate = new Date(utcMidnightMs);
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
  ) {
    return dateFailure(failure);
  }

  const windowStartMs = utcMidnightMs - SHANGHAI_UTC_OFFSET_MS;
  return ok({
    text: value,
    windowStart: new Date(windowStartMs),
    windowEndExclusive: new Date(windowStartMs + DAY_MS),
    reviewDate: candidate,
  });
}

function dateFailure(failure: 'validation' | 'internal'): Result<never, CommonError> {
  return failure === 'validation'
    ? err(validationError('date 必须是 1992-01-01 至 9998-12-31 范围内的真实 YYYY-MM-DD 日期', 'date'))
    : err(internalError('可信时间投影超出支持的业务日期范围'));
}
