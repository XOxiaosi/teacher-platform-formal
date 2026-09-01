/**
 * 日期格式化（packages/admin，镜像自 packages/frontend/src/shared/date-format.ts）。
 * 纯函数：固定 Asia/Shanghai 时区，避免显示随浏览器时区漂移。
 */

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
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

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDatePart(value: string): string {
  const [year, month, day] = value.split('/');
  return `${year}年${month}月${day}日`;
}
