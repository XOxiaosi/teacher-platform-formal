export type TeacherBusinessTimeZone = 'Asia/Shanghai';

export interface TeacherTimeContextInput {
  now: Date;
  timeZone: TeacherBusinessTimeZone;
}

function value(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? '';
}

export function formatTeacherTimeContext(input: TeacherTimeContextInput): string {
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: input.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(input.now);
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    timeZone: input.timeZone,
    weekday: 'long',
  }).format(input.now);
  const date = `${value(dateParts, 'year')}-${value(dateParts, 'month')}-${value(dateParts, 'day')}`;
  const time = `${value(dateParts, 'hour')}:${value(dateParts, 'minute')}:${value(dateParts, 'second')}`;

  return [
    '【教师平台可信时间】',
    `可信 instant（UTC）：${input.now.toISOString()}`,
    `教师业务时区：${input.timeZone}`,
    `当前日期：${date}`,
    `当前时间：${time}`,
    `当前星期：${weekday}`,
    '“今天、明天、下周”等相对日期必须以本段可信时间为基准。',
    '业务对象的 createdAt、updatedAt 只是记录元数据，不得据此推断当前日期。',
    '创建日程时，scheduledStart 和 scheduledEnd 必须包含 Z 或 ±HH:MM 时区。',
  ].join('\n');
}
