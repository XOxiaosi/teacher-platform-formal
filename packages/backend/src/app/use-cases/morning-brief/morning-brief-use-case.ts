import { ok } from '@teacher-platform/contracts';
import { createScheduleService } from '../../../features/scheduling/index.js';
import { createPaymentService } from '../../../features/payments/index.js';
import { createPushService } from '../../../features/push/index.js';
import type {
  CreateMorningBriefUseCaseOptions,
  MorningBriefUseCase,
  SendMorningBriefInput,
} from './types.js';

export function createMorningBriefUseCase(options: CreateMorningBriefUseCaseOptions): MorningBriefUseCase {
  const schedules = createScheduleService(options.prisma);
  const payments = createPaymentService(options.prisma);
  const push = createPushService({ prisma: options.prisma, adapters: options.pushAdapters });

  return {
    async sendMorningBrief(input: SendMorningBriefInput) {
      const dayRange = getLocalDayRange(input.date);

      const weather = await options.weather.query({ city: input.city });
      if (!weather.ok) return weather;

      const scheduleList = await schedules.listSchedules({
        teacherId: input.teacherId,
        dateFrom: dayRange.start,
        dateTo: dayRange.end,
        pageSize: 100,
      });
      if (!scheduleList.ok) return scheduleList;

      const paymentList = await payments.listPayments({
        teacherId: input.teacherId,
        paidAtFrom: dayRange.start,
        paidAtTo: dayRange.end,
        pageSize: 100,
      });
      if (!paymentList.ok) return paymentList;

      const content = buildMorningBriefContent({
        date: input.date,
        weather: weather.value,
        schedules: scheduleList.value.items,
        payments: paymentList.value.items.filter((payment) => isInRange(payment.paidAt, dayRange)),
      });

      const pushResult = await push.sendPush({
        teacherId: input.teacherId,
        type: 'morning_brief',
        scheduledAt: input.date,
        channel: input.channel,
        content,
      });
      if (!pushResult.ok) return pushResult;

      return ok({ content, pushRecord: pushResult.value });
    },
  };
}

function getLocalDayRange(date: Date) {
  const dateText = formatDate(date);
  return {
    start: new Date(`${dateText}T00:00:00+08:00`),
    end: new Date(`${dateText}T23:59:59.999+08:00`),
  };
}

function isInRange(date: Date, range: { start: Date; end: Date }) {
  return date >= range.start && date <= range.end;
}

function buildMorningBriefContent(input: {
  date: Date;
  weather: { city: string; weather: string; temperatureC: number };
  schedules: Array<{ title: string; scheduledStart: Date; scheduledEnd: Date }>;
  payments: Array<{ amount: number; lessonCount: number }>;
}) {
  const lines = [
    `早安简报｜${formatDate(input.date)}`,
    `天气：${input.weather.city} ${input.weather.weather} ${input.weather.temperatureC}℃`,
    buildScheduleSection(input.schedules),
    buildPaymentSection(input.payments),
  ];
  return lines.join('\n');
}

function buildScheduleSection(schedules: Array<{ title: string; scheduledStart: Date; scheduledEnd: Date }>) {
  if (schedules.length === 0) return '今日安排（0项）：无';
  const items = schedules.map((schedule) => (
    `${formatTime(schedule.scheduledStart)}-${formatTime(schedule.scheduledEnd)} ${schedule.title}`
  ));
  return [`今日安排（${schedules.length}项）:`, ...items].join('\n');
}

function buildPaymentSection(payments: Array<{ amount: number; lessonCount: number }>) {
  const totalLessons = payments.reduce((sum, payment) => sum + payment.lessonCount, 0);
  const totalAmount = payments.reduce((sum, payment) => sum + payment.amount, 0);
  return `今日缴费：${payments.length} 笔，${totalLessons} 课时，¥${totalAmount}`;
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatTime(date: Date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
