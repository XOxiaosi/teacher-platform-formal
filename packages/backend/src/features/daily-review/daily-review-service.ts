import type { Prisma, PrismaClient } from '@prisma/client';
import { err, notFound, ok, internalError, validationError } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import type {
  CalculateDeviationInput,
  CreateReviewInput,
  DailyReviewData,
  DailyReviewService,
  GenerateTomorrowSuggestionInput,
  GetReviewInput,
  AppendCorrectionInput,
  ListReviewsInput,
} from './types.js';

type DailyReviewPrismaClient = PrismaClient | Prisma.TransactionClient;

export interface DailyReviewServiceOptions {
  getClient: () => Promise<DailyReviewPrismaClient>;
}

function isDailyReviewServiceOptions(
  value: DailyReviewPrismaClient | DailyReviewServiceOptions,
): value is DailyReviewServiceOptions {
  return typeof value === 'object'
    && value !== null
    && typeof (value as DailyReviewServiceOptions).getClient === 'function';
}

export function createDailyReviewService(
  prismaOrOptions: DailyReviewPrismaClient | DailyReviewServiceOptions,
): DailyReviewService {
  const getClient = isDailyReviewServiceOptions(prismaOrOptions)
    ? prismaOrOptions.getClient
    : async () => prismaOrOptions;

  return {
    createReview: (input) => createReview(getClient, input),
    getReview: (input) => getReview(getClient, input),
    listReviews: (input) => listReviews(getClient, input),
    calculateDeviation,
    generateTomorrowSuggestion,
    appendCorrection: (input) => appendCorrection(getClient, input),
  };
}

async function createReview(getClient: () => Promise<DailyReviewPrismaClient>, input: CreateReviewInput) {
  const prisma = await getClient();
  const trustedClock = createDatabaseTrustedClock(prisma);
  const validation = validateReviewInput(input);
  if (!validation.ok) return validation;

  const now = await trustedClock.now();
  if (!now.ok) return now;
  if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
    return err(internalError('TrustedClock返回无效时间'));
  }

  const record = await prisma.dailyReview.create({
    data: { ...buildCreateData(input), createdAtTs: now.value, updatedAtTs: now.value },
  });
  return ok(toDailyReviewData(record));
}

async function getReview(getClient: () => Promise<DailyReviewPrismaClient>, input: GetReviewInput) {
  const prisma = await getClient();
  const record = await prisma.dailyReview.findUnique({
    where: { teacherId_dateTs: { teacherId: input.teacherId, dateTs: input.date } },
  });
  if (!record) return err(notFound('该日期无回顾记录'));
  return ok(toDailyReviewData(record));
}

async function listReviews(getClient: () => Promise<DailyReviewPrismaClient>, input: ListReviewsInput) {
  const prisma = await getClient();
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const skip = (page - 1) * pageSize;
  const where = buildWhere(input);
  const [items, total] = await Promise.all([
    prisma.dailyReview.findMany({ where, orderBy: { dateTs: 'desc' }, skip, take: pageSize }),
    prisma.dailyReview.count({ where }),
  ]);
  return ok({ items: items.map(toDailyReviewData), total });
}

function calculateDeviation(input: CalculateDeviationInput) {
  if (!Array.isArray(input.plannedSchedules) || !Array.isArray(input.actualLessons)) {
    return err(validationError('偏差计算输入格式不正确'));
  }
  return ok(buildDeviationResult(input));
}

function generateTomorrowSuggestion(input: GenerateTomorrowSuggestionInput) {
  const total = input.tomorrowSchedules.length + input.pendingSchedules.length + input.lowBalanceStudents.length;
  if (total === 0) return err(validationError('明日建议数据为空'));
  return ok(buildSuggestion(input));
}

async function appendCorrection(getClient: () => Promise<DailyReviewPrismaClient>, input: AppendCorrectionInput) {
  const prisma = await getClient();
  const trustedClock = createDatabaseTrustedClock(prisma);
  const existing = await prisma.dailyReview.findUnique({
    where: { teacherId_dateTs: { teacherId: input.teacherId, dateTs: input.date } },
  });
  if (!existing) return err(notFound('该日期无回顾记录'));

  const now = await trustedClock.now();
  if (!now.ok) return now;
  if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
    return err(internalError('TrustedClock返回无效时间'));
  }

  const corrections = Array.isArray(existing.corrections) ? existing.corrections : [];
  const updated = await prisma.dailyReview.update({
    where: { teacherId_dateTs: { teacherId: input.teacherId, dateTs: input.date } },
    data: {
      corrections: [...corrections, input.correction] as Prisma.InputJsonValue,
      updatedAtTs: now.value,
    },
  });
  return ok(toDailyReviewData(updated));
}

function buildCreateData(input: CreateReviewInput) {
  return {
    teacherId: input.teacherId,
    dateTs: input.date,
    plannedCount: input.plannedCount,
    actualCount: input.actualCount,
    cancelledCount: input.cancelledCount,
    missedCount: input.missedCount,
    rescheduledCount: input.rescheduledCount,
    pendingCount: input.pendingCount,
    deviations: input.deviations as Prisma.InputJsonValue,
    corrections: input.corrections as Prisma.InputJsonValue,
    tomorrowSuggestion: input.tomorrowSuggestion ?? null,
  };
}

function validateReviewInput(input: CreateReviewInput) {
  if (!input.teacherId.trim()) return err(validationError('老师 ID 不能为空', 'teacherId'));
  if (!isUtcMidnight(input.date)) {
    return err(validationError('日期必须是有效的 UTC 午夜', 'date'));
  }
  return ok(true);
}

function isUtcMidnight(value: Date): boolean {
  return value instanceof Date
    && !Number.isNaN(value.getTime())
    && value.getUTCHours() === 0
    && value.getUTCMinutes() === 0
    && value.getUTCSeconds() === 0
    && value.getUTCMilliseconds() === 0;
}

function buildWhere(input: ListReviewsInput) {
  return {
    teacherId: input.teacherId,
    ...(input.dateFrom || input.dateTo ? { date: buildDateRange(input) } : {}),
  };
}

function buildDateRange(input: ListReviewsInput) {
  return {
    ...(input.dateFrom && { gte: input.dateFrom }),
    ...(input.dateTo && { lte: input.dateTo }),
  };
}

function buildDeviationResult(input: CalculateDeviationInput) {
  const cancelledCount = input.plannedSchedules.filter((x) => x.status === 'cancelled').length;
  const rescheduledCount = input.plannedSchedules.filter((x) => x.status === 'rescheduled').length;
  const pendingCount = input.memoTasks.filter((x) => x.status === 'pending').length;
  const actualCount = input.actualLessons.filter((x) => x.status === 'attended').length;
  const missedCount = input.actualLessons.filter((x) => x.status === 'absent').length;

  return {
    plannedCount: input.plannedSchedules.length,
    actualCount,
    cancelledCount,
    missedCount,
    rescheduledCount,
    pendingCount,
    deviations: buildDeviationDetails(cancelledCount, missedCount, rescheduledCount, pendingCount),
  };
}

function buildDeviationDetails(cancelled: number, missed: number, rescheduled: number, pending: number) {
  return [
    { type: 'cancelled', count: cancelled },
    { type: 'missed', count: missed },
    { type: 'rescheduled', count: rescheduled },
    { type: 'pending', count: pending },
  ].filter((x) => x.count > 0);
}

function buildSuggestion(input: GenerateTomorrowSuggestionInput): string {
  const lowNames = input.lowBalanceStudents.map((x) => x.name).join('、') || '无';
  return [
    `明日安排：${input.tomorrowSchedules.length} 项`,
    `待补全：${input.pendingSchedules.length} 项`,
    `低课时预警：${lowNames}`,
  ].join('\n');
}

function toDailyReviewData(r: any): DailyReviewData {
  return {
    id: r.id,
    teacherId: r.teacherId,
    date: r.dateTs,
    plannedCount: r.plannedCount,
    actualCount: r.actualCount,
    cancelledCount: r.cancelledCount,
    missedCount: r.missedCount,
    rescheduledCount: r.rescheduledCount,
    pendingCount: r.pendingCount,
    deviations: Array.isArray(r.deviations) ? r.deviations : [],
    corrections: Array.isArray(r.corrections) ? r.corrections : [],
    tomorrowSuggestion: r.tomorrowSuggestion ?? undefined,
    createdAt: r.createdAtTs,
    updatedAt: r.updatedAtTs,
  };
}
