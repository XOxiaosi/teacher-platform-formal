const BUSINESS_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MILLISECONDS = 86_400_000;
const WEEKDAY_LABELS = [
  '星期日',
  '星期一',
  '星期二',
  '星期三',
  '星期四',
  '星期五',
  '星期六',
] as const;

const SHANGHAI_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

interface ParsedBusinessDate {
  year: number;
  month: number;
  day: number;
  epoch: number;
  weekday: number;
}

function parseBusinessDate(value: string): ParsedBusinessDate | null {
  const match = BUSINESS_DATE_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const epoch = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(epoch)) return null;

  const parsed = new Date(epoch);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return null;

  return { year, month, day, epoch, weekday: parsed.getUTCDay() };
}

function requireBusinessDate(value: string): ParsedBusinessDate {
  const parsed = parseBusinessDate(value);
  if (!parsed) throw new RangeError(`Invalid BusinessDate: ${value}`);
  return parsed;
}

function fromEpoch(epoch: number): string {
  const date = new Date(epoch);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatBusinessDate(value: string): string {
  const parsed = requireBusinessDate(value);
  return `${parsed.month}月${parsed.day}日 · ${WEEKDAY_LABELS[parsed.weekday]}`;
}

export function addBusinessDays(value: string, amount: number): string {
  const parsed = requireBusinessDate(value);
  if (!Number.isInteger(amount)) throw new RangeError(`Invalid day amount: ${amount}`);
  return fromEpoch(parsed.epoch + amount * DAY_MILLISECONDS);
}

export function isMondayBusinessDate(value: string): boolean {
  return parseBusinessDate(value)?.weekday === 1;
}

export function formatAgendaTime(instant: string): string | null {
  const epoch = Date.parse(instant);
  if (!Number.isFinite(epoch)) return null;
  return SHANGHAI_TIME_FORMATTER.format(new Date(epoch));
}

export function formatAgendaTimeRange(startAt?: string, endAt?: string): string | null {
  if (!startAt || !endAt) return null;
  const start = formatAgendaTime(startAt);
  const end = formatAgendaTime(endAt);
  return start && end ? `${start}–${end}` : null;
}
