import { ok } from '@teacher-platform/contracts';
import { createScheduleService } from '../../../features/scheduling/index.js';
import { createLessonService } from '../../../features/lessons/index.js';
import { createDailyReviewService } from '../../../features/daily-review/index.js';
import { createPushService } from '../../../features/push/index.js';
import type { ScheduleData } from '../../../features/scheduling/index.js';
import type { LessonData } from '../../../features/lessons/index.js';
import type { DeviationResult } from '../../../features/daily-review/index.js';
import type {
  CreateEveningReviewUseCaseOptions,
  EveningReviewUseCase,
  SendEveningReviewInput,
} from './types.js';

function pendingFieldNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function createEveningReviewUseCase(options: CreateEveningReviewUseCaseOptions): EveningReviewUseCase {
  const schedules = createScheduleService(options.prisma);
  const lessons = createLessonService(options.prisma);
  const dailyReview = createDailyReviewService(options.prisma);
  const push = createPushService({ prisma: options.prisma, adapters: options.pushAdapters });

  return {
    async sendEveningReview(input: SendEveningReviewInput) {
      const dayRange = getLocalDayRange(input.date);

      const scheduleList = await schedules.listSchedules({
        teacherId: input.teacherId,
        dateFrom: dayRange.start,
        dateTo: dayRange.end,
        pageSize: 100,
      });
      if (!scheduleList.ok) return scheduleList;

      const lessonList = await lessons.listLessons({
        teacherId: input.teacherId,
        dateFrom: dayRange.start,
        dateTo: dayRange.end,
        pageSize: 100,
      });
      if (!lessonList.ok) return lessonList;

      const todaySchedules = scheduleList.value.items.filter((schedule) => isInRange(schedule.scheduledStart, dayRange));
      const todayLessons = lessonList.value.items.filter((lesson) => isInRange(lesson.date, dayRange));
      const deviation = dailyReview.calculateDeviation({
        plannedSchedules: todaySchedules.map((schedule) => ({
          id: schedule.id,
          title: schedule.title,
          status: schedule.status,
          pendingFields: pendingFieldNames(schedule.pendingFields),
        })),
        actualLessons: todayLessons.map((lesson) => ({ id: lesson.id, status: lesson.status })),
        memoTasks: todaySchedules
          .filter((schedule) => pendingFieldNames(schedule.pendingFields).length > 0)
          .map((schedule) => ({ id: schedule.id, title: schedule.title, status: 'pending', pendingFields: pendingFieldNames(schedule.pendingFields) })),
      });
      if (!deviation.ok) return deviation;

      const content = buildEveningReviewContent({
        date: input.date,
        schedules: todaySchedules,
        lessons: todayLessons,
        deviation: deviation.value,
      });

      const pushResult = await push.sendPush({
        teacherId: input.teacherId,
        type: 'evening_review',
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

function buildEveningReviewContent(input: {
  date: Date;
  schedules: ScheduleData[];
  lessons: LessonData[];
  deviation: DeviationResult;
}) {
  return [
    `晚间复盘提醒｜${formatDate(input.date)}`,
    buildDeviationSection(input.deviation),
    buildScheduleSection(input.schedules),
    buildLessonSection(input.lessons, input.schedules),
  ].join('\n');
}

function buildDeviationSection(deviation: DeviationResult) {
  return [
    `计划日程：${deviation.plannedCount} 项`,
    `实际上课：${deviation.actualCount} 次`,
    `取消：${deviation.cancelledCount} 项`,
    `缺席：${deviation.missedCount} 次`,
    `改期：${deviation.rescheduledCount} 项`,
    `待确认：${deviation.pendingCount} 项`,
  ].join('\n');
}

function buildScheduleSection(schedules: ScheduleData[]) {
  if (schedules.length === 0) return '今日日程：无';
  const items = schedules.map((schedule) => (
    `${formatTime(schedule.scheduledStart)}-${formatTime(schedule.scheduledEnd)} ${schedule.title}（${schedule.status}）`
  ));
  return [`今日日程：${schedules.length} 项`, ...items].join('\n');
}

function buildLessonSection(lessons: LessonData[], schedules: ScheduleData[]) {
  if (lessons.length === 0) return '今日课次：0 条';
  const scheduleTitleById = new Map(schedules.map((schedule) => [schedule.id, schedule.title]));
  const items = lessons.map((lesson) => `${formatTime(lesson.date)} ${scheduleTitleById.get(lesson.scheduleId) ?? lesson.scheduleId}（${lesson.status}）`);
  return [`今日课次：${lessons.length} 条`, ...items].join('\n');
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
