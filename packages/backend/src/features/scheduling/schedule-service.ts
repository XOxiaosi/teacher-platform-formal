import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { ok, err, internalError, notFound, validationError, versionConflict } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  encryptFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import {
  defaultChangelogFactory,
  requireChangelogWrite,
  runWithAutomaticChangelogSuppressed,
  type ChangelogFactory,
} from '../../shared/changelog/index.js';
import type { ScheduleService } from './types.js';
import { validateTransition, type ScheduleStatus } from './state-machine.js';
import { sameScheduleRequest, scheduleInclude, toScheduleData } from './schedule-data.js';
import { hasLessonOccurrenceConflict } from '../../shared/lesson-occurrence-conflict/index.js';
import { isValidDate, runFormalLessonTransaction, validateDailyReviewWindow } from './schedule-create-helpers.js';
type SchedulePrismaClient = PrismaClient | Prisma.TransactionClient;
const SCHEDULE_TYPES = ['lesson', 'prep', 'meeting', 'call', 'other'];
const SCHEDULE_STATUSES = ['planned', 'completed', 'cancelled', 'missed', 'rescheduled', 'extra'];
const AGENDA_SOURCE_LIMIT = 500;
const DAILY_REVIEW_SOURCE_LIMIT = 500;
const CLASS_FORMATS = ['one_to_one', 'small_group'] as const;

export interface ScheduleServiceOptions {
  getClient: () => Promise<SchedulePrismaClient>;
  changelogFactory?: ChangelogFactory;
  cipher?: FieldCipher;
  /** Internal guard for the recursive service bound to an existing transaction. */
  insideTransaction?: boolean;
}

function isScheduleServiceOptions(
  value: SchedulePrismaClient | ScheduleServiceOptions,
): value is ScheduleServiceOptions {
  return typeof value === 'object'
    && value !== null
    && typeof (value as ScheduleServiceOptions).getClient === 'function';
}

function canOpenTransaction(value: SchedulePrismaClient): value is PrismaClient {
  return '$transaction' in value && typeof (value as PrismaClient).$transaction === 'function';
}

export function createScheduleService(
  prismaOrOptions: SchedulePrismaClient | ScheduleServiceOptions,
): ScheduleService {
  const getClient = isScheduleServiceOptions(prismaOrOptions)
    ? prismaOrOptions.getClient
    : async () => prismaOrOptions;
  const changelogFactory = isScheduleServiceOptions(prismaOrOptions)
    ? (prismaOrOptions.changelogFactory ?? defaultChangelogFactory)
    : defaultChangelogFactory;
  const cipher = isScheduleServiceOptions(prismaOrOptions)
    ? (prismaOrOptions.cipher ?? createFieldCipherFromEnv())
    : createFieldCipherFromEnv();
  const insideTransaction = isScheduleServiceOptions(prismaOrOptions)
    && prismaOrOptions.insideTransaction === true;

  async function resolve(): Promise<{ prisma: SchedulePrismaClient; trustedClock: ReturnType<typeof createDatabaseTrustedClock> }> {
    const prisma = await getClient();
    return { prisma, trustedClock: createDatabaseTrustedClock(prisma) };
  }

  return {
    async createSchedule(input) {
      const { prisma, trustedClock } = await resolve();
      const title = input.title?.trim() ?? '';
      const formalLesson = input.type === 'lesson';
      if (formalLesson && input.title !== undefined) {
        return err(validationError('课程排期不接受课程名称', 'title'));
      }
      if (!isValidDate(input.scheduledStart)) {
        return err(validationError('开始时间不合法', 'scheduledStart'));
      }
      if (!isValidDate(input.scheduledEnd)) {
        return err(validationError('结束时间不合法', 'scheduledEnd'));
      }
      if (formalLesson && (!input.clientRequestId || !/^[A-Za-z0-9._:-]{8,128}$/.test(input.clientRequestId))) {
        return err(validationError('课程必须提供合法的 clientRequestId', 'clientRequestId'));
      }
      if (formalLesson && input.studentId !== undefined) {
        return err(validationError('正式课程请使用 participantIds', 'studentId'));
      }
      if (formalLesson && !insideTransaction && canOpenTransaction(prisma)) {
        return runFormalLessonTransaction({
          prisma,
          input,
          cipher,
          createInTransaction: async (tx) => createScheduleService({
              getClient: async () => tx,
              changelogFactory,
              cipher,
              insideTransaction: true,
            }).createSchedule(input),
        });
      }
      if (!formalLesson && !title) {
        return err(validationError('日程标题不能为空', 'title'));
      }
      if (!SCHEDULE_TYPES.includes(input.type)) {
        return err(validationError('日程类型不合法', 'type'));
      }
      if (input.clientRequestId !== undefined && !/^[A-Za-z0-9._:-]{8,128}$/.test(input.clientRequestId)) {
        return err(validationError('clientRequestId 格式不合法', 'clientRequestId'));
      }
      if (input.clientRequestId) {
        const replay = await prisma.schedule.findFirst({
          where: { teacherId: input.teacherId, clientRequestId: input.clientRequestId },
          include: scheduleInclude,
        });
        if (replay) {
          const same = sameScheduleRequest(replay, input, cipher);
          return same ? ok({ schedule: toScheduleData(replay, cipher), conflicts: [] }) : err(versionConflict());
        }
      }
      if (input.scheduledEnd <= input.scheduledStart) {
        return err(validationError('结束时间必须晚于开始时间', 'scheduledEnd'));
      }
      if (formalLesson && input.participantIds
        && new Set(input.participantIds).size !== input.participantIds.length) {
        return err(validationError('participantIds 不能包含重复学生', 'participantIds'));
      }
      const participantIds = [...new Set(input.participantIds ?? (input.studentId ? [input.studentId] : []))];
      if (formalLesson) {
        if (!input.location?.trim()) return err(validationError('课程地点不能为空', 'location'));
        if (!input.classFormat || !CLASS_FORMATS.includes(input.classFormat)) {
          return err(validationError('课程形式必须是 one_to_one 或 small_group', 'classFormat'));
        }
        if (participantIds.length === 0) return err(validationError('课程必须至少选择一名参与人', 'participantIds'));
        if (input.classFormat === 'one_to_one' && participantIds.length !== 1) {
          return err(validationError('一对一课程必须且只能有一名参与人', 'participantIds'));
        }
        if (input.classFormat === 'small_group' && participantIds.length < 2) {
          return err(validationError('小班课程至少需要两名参与人', 'participantIds'));
        }
      } else if (input.studentId !== undefined) {
        const participant = await prisma.student.findFirst({ where: { id: input.studentId, teacherId: input.teacherId }, select: { id: true } });
        if (!participant) return err(notFound('学生不存在'));
      }
      if (participantIds.length > 0) {
        const ownedCount = await prisma.student.count({ where: { teacherId: input.teacherId, id: { in: participantIds } } });
        if (ownedCount !== participantIds.length) return err(notFound('学生不存在'));
      }

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      if (formalLesson) {
        if (await hasLessonOccurrenceConflict(prisma, input.teacherId, {
          start: input.scheduledStart,
          end: input.scheduledEnd,
        })) return err(validationError('该时段与现有排期冲突', 'scheduledStart'));
      }

      let schedule;
      try {
        schedule = await prisma.schedule.create({
        data: {
          teacherId: input.teacherId,
          // First participant supports the legacy Student -> Schedule relation only.
          studentId: participantIds[0] ?? input.studentId ?? null,
          type: input.type,
          title: formalLesson ? '' : title,
          locationCiphertext: formalLesson ? encryptFieldValue(cipher, input.location!.trim()) : null,
          classFormat: formalLesson ? input.classFormat! : null,
          operationalNoteCiphertext: formalLesson && input.operationalNote?.trim()
            ? encryptFieldValue(cipher, input.operationalNote.trim())
            : null,
          clientRequestId: input.clientRequestId ?? null,
          scheduledStartTs: input.scheduledStart,
          scheduledEndTs: input.scheduledEnd,
          confidence: input.confidence ?? null,
          pendingFields: input.pendingFields ? input.pendingFields as unknown as Prisma.InputJsonValue : Prisma.JsonNull,
          sourceInput: input.sourceInput ?? null,
          createdAtTs: now.value,
          updatedAtTs: now.value,
          ...(participantIds.length > 0 ? { participants: { create: participantIds.map((studentId) => ({ teacherId: input.teacherId, studentId })) } } : {}),
        },
        include: scheduleInclude,
        });
      } catch (caught) {
        // A PostgreSQL uniqueness failure aborts the transaction.  Formal
        // replay must happen only after the outer transaction has rolled back,
        // using the root Prisma client in the catch above.
        if (formalLesson && caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2002') {
          throw caught;
        }
        if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2002' && input.clientRequestId) {
          const replay = await prisma.schedule.findFirst({ where: { teacherId: input.teacherId, clientRequestId: input.clientRequestId }, include: scheduleInclude });
          if (replay && sameScheduleRequest(replay, input, cipher)) {
            return ok({ schedule: toScheduleData(replay, cipher), conflicts: [] });
          }
          if (replay) return err(versionConflict());
        }
        throw caught;
      }

      if (formalLesson) {
        return ok({ schedule: toScheduleData(schedule, cipher), conflicts: [] });
      }

      // 检测冲突：查询同老师同时间段附近的日程
      const nearby = await prisma.schedule.findMany({
        where: {
          teacherId: input.teacherId,
          status: { in: ['planned', 'extra'] },
          scheduledStartTs: { lt: input.scheduledEnd },
          scheduledEndTs: { gt: input.scheduledStart },
        },
      });

      const conflictSchedules = nearby.filter((s) => s.id !== schedule.id);
      const conflicts = conflictSchedules.map((item) => toScheduleData(item, cipher));

      return ok({ schedule: toScheduleData(schedule, cipher), conflicts });
    },

    async getSchedule(scheduleId) {
      const { prisma } = await resolve();
      const schedule = await prisma.schedule.findUnique({
        where: { id: scheduleId },
        include: scheduleInclude,
      });

      if (!schedule) {
        return err(notFound('日程不存在'));
      }

      return ok(toScheduleData(schedule, cipher));
    },

    async getOwnedSchedule(input) {
      const { prisma } = await resolve();
      const schedule = await prisma.schedule.findFirst({
        where: { id: input.scheduleId, teacherId: input.teacherId },
        include: scheduleInclude,
      });
      return schedule ? ok(toScheduleData(schedule, cipher)) : err(notFound('日程不存在'));
    },

    async listSchedules(input) {
      const { prisma } = await resolve();
      const page = input.page ?? 1;
      const pageSize = input.pageSize ?? 20;
      if (page < 1) return err(validationError('页码必须大于等于 1', 'page'));
      if (pageSize < 1) return err(validationError('每页数量必须大于等于 1', 'pageSize'));
      if (input.type && !SCHEDULE_TYPES.includes(input.type)) return err(validationError('日程类型不合法', 'type'));
      if (input.status && !SCHEDULE_STATUSES.includes(input.status)) return err(validationError('日程状态不合法', 'status'));
      if (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo) {
        return err(validationError('开始日期不能晚于结束日期', 'dateFrom'));
      }
      const skip = (page - 1) * pageSize;

      const where = {
        teacherId: input.teacherId,
        ...(input.studentId && { studentId: input.studentId }),
        ...(input.type && { type: input.type }),
        ...(input.status && { status: input.status }),
        ...(input.dateFrom && { scheduledStartTs: { gte: input.dateFrom } }),
        ...(input.dateTo && { scheduledEndTs: { lte: input.dateTo } }),
      };

      const [items, total] = await Promise.all([
        prisma.schedule.findMany({
          where,
          include: scheduleInclude,
          orderBy: { scheduledStartTs: 'asc' },
          skip,
          take: pageSize,
        }),
        prisma.schedule.count({ where }),
      ]);

      return ok({ items: items.map((item) => toScheduleData(item, cipher)), total });
    },

    async listSchedulesStartingInWindow(input) {
      const { prisma } = await resolve();
      const validation = validateDailyReviewWindow(input);
      if (!validation.ok) return validation;

      const items = await prisma.schedule.findMany({
        where: {
          teacherId: input.teacherId,
          scheduledStartTs: {
            gte: input.windowStart,
            lt: input.windowEndExclusive,
          },
        },
        orderBy: [
          { scheduledStartTs: 'asc' },
          { scheduledEndTs: 'asc' },
          { id: 'asc' },
        ],
        take: DAILY_REVIEW_SOURCE_LIMIT + 1,
        include: scheduleInclude,
      });
      if (items.length > DAILY_REVIEW_SOURCE_LIMIT) {
        return err(internalError('每日回顾日程来源超过 500 条'));
      }
      return ok({ items: items.map((item) => toScheduleData(item, cipher)), total: items.length });
    },

    async listOverlappingSchedules(input) {
      const { prisma } = await resolve();
      if (!input.teacherId.trim()) {
        return err(validationError('teacherId 无效', 'teacherId'));
      }
      if (!isValidDate(input.windowStart) || !isValidDate(input.windowEndExclusive)) {
        return err(validationError('Agenda 时间窗口无效', 'windowStart'));
      }
      if (input.windowEndExclusive <= input.windowStart) {
        return err(validationError('Agenda 结束时间必须晚于开始时间', 'windowEndExclusive'));
      }
      if (input.type !== 'lesson') {
        return err(validationError('Agenda 首期只支持 lesson', 'type'));
      }

      const where = {
        teacherId: input.teacherId,
        type: input.type,
        scheduledStartTs: { lt: input.windowEndExclusive },
        scheduledEndTs: { gt: input.windowStart },
      };
      const [items, total] = await Promise.all([
        prisma.schedule.findMany({
          where,
          orderBy: [
            { scheduledStartTs: 'asc' },
            { scheduledEndTs: 'asc' },
            { id: 'asc' },
          ],
          take: AGENDA_SOURCE_LIMIT,
          include: scheduleInclude,
        }),
        prisma.schedule.count({ where }),
      ]);
      return ok({ items: items.map((item) => toScheduleData(item, cipher)), total });
    },

    async updateScheduleStatus(input) {
      const { prisma, trustedClock } = await resolve();
      const existing = await prisma.schedule.findUnique({
        where: { id: input.scheduleId },
      });

      if (!existing || (input.teacherId !== undefined && existing.teacherId !== input.teacherId)) {
        return err(notFound('日程不存在'));
      }

      const transition = validateTransition(
        existing.status as ScheduleStatus,
        input.targetStatus,
      );

      if (!transition.ok) {
        return transition;
      }

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      const updatedCount = await prisma.schedule.updateMany({
        where: {
          id: input.scheduleId,
          ...(input.teacherId !== undefined ? { teacherId: input.teacherId } : {}),
          status: existing.status,
        },
        data: {
          status: input.targetStatus,
          ...(input.newScheduleId && { parentId: input.newScheduleId }),
          updatedAtTs: now.value,
        },
      });
      if (updatedCount.count !== 1) return err(versionConflict());
      const updated = await prisma.schedule.findFirst({ where: { id: input.scheduleId, ...(input.teacherId !== undefined ? { teacherId: input.teacherId } : {}) }, include: scheduleInclude });
      return updated ? ok(toScheduleData(updated, cipher)) : err(notFound('日程不存在'));
    },

    async cancelSchedule(input) {
      const { prisma, trustedClock } = await resolve();
      const existing = await prisma.schedule.findFirst({
        where: { id: input.scheduleId, teacherId: input.teacherId },
      });
      if (!existing) return err(notFound('日程不存在'));

      // D49: 手动删除仅限 planned；已完成日程的纠错走课次回溯（attended/absent）
      const transition = validateTransition(existing.status as ScheduleStatus, 'cancelled');
      if (!transition.ok) return transition;

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      try {
        const updated = await runWithAutomaticChangelogSuppressed(() =>
          (prisma as PrismaClient).$transaction(async (tx) => {
            const changed = await tx.schedule.updateMany({
              where: { id: input.scheduleId, teacherId: input.teacherId, status: existing.status },
              data: { status: 'cancelled', updatedAtTs: now.value },
            });
            if (changed.count !== 1) throw new Error('schedule state changed');
            const record = await tx.schedule.findFirstOrThrow({ where: { id: input.scheduleId, teacherId: input.teacherId } });
            await requireChangelogWrite(changelogFactory(tx).recordChange({
              teacherId: input.teacherId,
              module: 'schedule',
              action: 'cancel',
              targetType: 'Schedule',
              targetId: input.scheduleId,
              before: { status: existing.status },
              after: { status: 'cancelled' },
              source: 'manual',
            }));
            return record;
          }),
        );

        return ok(toScheduleData(updated, cipher));
      } catch {
        return err(internalError('取消日程失败'));
      }
    },

    async restoreSchedule(input) {
      const { prisma, trustedClock } = await resolve();
      const existing = await prisma.schedule.findFirst({
        where: { id: input.scheduleId, teacherId: input.teacherId },
      });
      if (!existing) return err(notFound('日程不存在'));

      // D49: 恢复仅限 cancelled
      const transition = validateTransition(existing.status as ScheduleStatus, 'planned');
      if (!transition.ok) return transition;

      // 冲突检查：同教师非 cancelled/missed 日程不得与该日程时间窗重叠
      const conflict = await prisma.schedule.findFirst({
        where: {
          teacherId: input.teacherId,
          id: { not: input.scheduleId },
          status: { notIn: ['cancelled', 'missed'] },
          scheduledStartTs: { lt: existing.scheduledEndTs },
          scheduledEndTs: { gt: existing.scheduledStartTs },
        },
      });
      if (conflict) {
        return err(validationError(
          '恢复失败：与另一项日程时间重叠',
          'scheduledStart',
        ));
      }

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      try {
        const updated = await runWithAutomaticChangelogSuppressed(() =>
          (prisma as PrismaClient).$transaction(async (tx) => {
            const changed = await tx.schedule.updateMany({
              where: { id: input.scheduleId, teacherId: input.teacherId, status: existing.status },
              data: { status: 'planned', updatedAtTs: now.value },
            });
            if (changed.count !== 1) throw new Error('schedule state changed');
            const record = await tx.schedule.findFirstOrThrow({ where: { id: input.scheduleId, teacherId: input.teacherId } });
            await requireChangelogWrite(changelogFactory(tx).recordChange({
              teacherId: input.teacherId,
              module: 'schedule',
              action: 'restore',
              targetType: 'Schedule',
              targetId: input.scheduleId,
              before: { status: 'cancelled' },
              after: { status: 'planned' },
              source: 'manual',
            }));
            return record;
          }),
        );

        return ok(toScheduleData(updated, cipher));
      } catch {
        return err(internalError('恢复日程失败'));
      }
    },
  };
}
