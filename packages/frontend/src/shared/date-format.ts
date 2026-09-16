const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

const yearMonthFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: 'numeric',
});

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatDateTime(value: string): string {
  const date = parseDate(value);
  if (!date) return value;
  const [datePart, timePart] = dateTimeFormatter.format(date).split(' ');
  return `${formatDatePart(datePart)} ${timePart}`;
}

export function formatDate(value: string): string {
  const date = parseDate(value);
  if (!date) return value;
  return formatDatePart(dateFormatter.format(date));
}

export function formatYearMonth(value: string): string {
  const date = parseDate(value);
  if (!date) return value;
  const [year, month] = yearMonthFormatter.format(date).split('/');
  return `${year}年${month}月`;
}

export function formatTime(value: string): string {
  const date = parseDate(value);
  if (!date) return value;
  return timeFormatter.format(date);
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDatePart(value: string): string {
  const [year, month, day] = value.split('/');
  return `${year}年${month}月${day}日`;
}
