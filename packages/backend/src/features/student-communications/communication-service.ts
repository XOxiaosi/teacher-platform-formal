import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { ok, err, notFound, validationError, internalError, versionConflict } from '@teacher-platform/contracts';
import {
  createDatabaseTrustedClock,
  type TrustedClock,
} from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  decryptJsonFieldValue,
  encryptJsonFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import { createChangelogService } from '../../shared/changelog/changelog-service.js';
import type { Logger } from '../../shared/logger/index.js';
import type { ModerationAdapter } from '../../shared/platform-services/index.js';
import { moderateCommunicationProjection } from './communication-moderation.js';
import {
  COMMUNICATION_DIRECTIONS,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_PARENT_TYPES,
} from './types.js';
import type {
  CommunicationService,
  CreateCommunicationRecordInput,
  UpdateCommunicationDetailInput,
  GetOwnedDetailInput,
} from './types.js';
import {
  createCommunicationRecordInternal,
  toCommunicationDetailData,
  type CommunicationChangelogFactory,
} from './communication-persistence.js';

type CommunicationPrismaClient = PrismaClient | Prisma.TransactionClient;
type CommunicationTrustedClockFactory = (prisma: CommunicationPrismaClient) => TrustedClock;

class CommunicationCasError extends Error {
  constructor(readonly stillExists: boolean) {
    super('communication optimistic concurrency conflict');
  }
}

async function requireAudit(
  prisma: Prisma.TransactionClient,
  input: Parameters<ReturnType<typeof createChangelogService>['recordChange']>[0],
  changelogFactory: CommunicationChangelogFactory,
): Promise<void> {
  const result = await changelogFactory(prisma).recordChange(input);
  if (!result.ok) throw new Error('AUDIT_WRITE_FAILED');
}

function auditDetail(detail: Record<string, any>) {
  return {
    direction: detail.direction, channel: detail.channel, parentType: detail.parentType,
    parentConcerns: detail.parentConcerns, teacherResponses: detail.teacherResponses,
    agreements: detail.agreements, followUps: detail.followUps,
    nextContactAtTs: detail.nextContactAtTs, moderationFlagged: detail.moderationFlagged,
    moderationReasons: detail.moderationReasons,
  };
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validateCommunicationFields(input: CreateCommunicationRecordInput) {
  // direction 必填且在白名单
  if (!COMMUNICATION_DIRECTIONS.includes(input.direction as any)) {
    return err(validationError('沟通方向不合法', 'direction'));
  }

  // channel 若提供需在白名单
  if (input.channel != null && !COMMUNICATION_CHANNELS.includes(input.channel as any)) {
    return err(validationError('沟通渠道不合法', 'channel'));
  }

  // parentType 若提供需在白名单
  if (input.parentType != null && !COMMUNICATION_PARENT_TYPES.includes(input.parentType as any)) {
    return err(validationError('家长类型不合法', 'parentType'));
  }

  // 四个数组字段：若提供必须是 string[]
  if (input.parentConcerns != null && !isStringArray(input.parentConcerns)) {
    return err(validationError('家长诉求必须是字符串数组', 'parentConcerns'));
  }
  if (input.teacherResponses != null && !isStringArray(input.teacherResponses)) {
    return err(validationError('老师回应必须是字符串数组', 'teacherResponses'));
  }
  if (input.agreements != null && !isStringArray(input.agreements)) {
    return err(validationError('达成共识必须是字符串数组', 'agreements'));
  }
  if (input.followUps != null && !isStringArray(input.followUps)) {
    return err(validationError('后续跟进必须是字符串数组', 'followUps'));
  }

  // summary 非空
  if (!hasText(input.summary)) {
    return err(validationError('沟通摘要不能为空', 'summary'));
  }

  return ok(true);
}

function validateDetailPatch(patch: UpdateCommunicationDetailInput['patch']) {
  if (patch.direction != null && !COMMUNICATION_DIRECTIONS.includes(patch.direction as any)) {
    return err(validationError('沟通方向不合法', 'direction'));
  }
  if (patch.channel != null && patch.channel !== null && !COMMUNICATION_CHANNELS.includes(patch.channel as any)) {
    return err(validationError('沟通渠道不合法', 'channel'));
  }
  if (
    patch.parentType != null &&
    patch.parentType !== null &&
    !COMMUNICATION_PARENT_TYPES.includes(patch.parentType as any)
  ) {
    return err(validationError('家长类型不合法', 'parentType'));
  }
  if (patch.parentConcerns != null && !isStringArray(patch.parentConcerns)) {
    return err(validationError('家长诉求必须是字符串数组', 'parentConcerns'));
  }
  if (patch.teacherResponses != null && !isStringArray(patch.teacherResponses)) {
    return err(validationError('老师回应必须是字符串数组', 'teacherResponses'));
  }
  if (patch.agreements != null && !isStringArray(patch.agreements)) {
    return err(validationError('达成共识必须是字符串数组', 'agreements'));
  }
  if (patch.followUps != null && !isStringArray(patch.followUps)) {
    return err(validationError('后续跟进必须是字符串数组', 'followUps'));
  }
  return ok(true);
}

async function assertOwnedStudent(
  prisma: CommunicationPrismaClient,
  teacherId: string,
  studentId: string,
) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, teacherId },
    select: { id: true },
  });
  return student ? ok(student) : err(notFound('学生不存在'));
}

async function assertOwnedRecord(
  prisma: CommunicationPrismaClient,
  teacherId: string,
  studentId: string,
  recordId: string,
) {
  const record = await prisma.studentRecord.findFirst({
    where: { id: recordId, teacherId, studentId },
    select: { id: true, category: true },
  });
  return record ? ok(record) : err(notFound('沟通记录不存在'));
}

async function requireTrustedNow(
  prisma: CommunicationPrismaClient,
  trustedClockFactory: CommunicationTrustedClockFactory,
) {
  const now = await trustedClockFactory(prisma).now();
  if (!now.ok) return now;
  if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
    return err(internalError('TrustedClock返回无效时间'));
  }
  return ok(now.value);
}

export interface CommunicationServiceOptions {
  getClient: () => Promise<CommunicationPrismaClient>;
  /** P8 phase-3 批1：字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
  moderation?: ModerationAdapter;
  logger?: Logger;
  auditSource?: 'manual' | 'agent';
  changelogFactory?: CommunicationChangelogFactory;
  trustedClockFactory?: CommunicationTrustedClockFactory;
}

function isCommunicationServiceOptions(
  value: CommunicationPrismaClient | CommunicationServiceOptions,
): value is CommunicationServiceOptions {
  return typeof value === 'object'
    && value !== null
    && typeof (value as CommunicationServiceOptions).getClient === 'function';
}

export function createCommunicationService(
  prismaOrOptions: CommunicationPrismaClient | CommunicationServiceOptions,
): CommunicationService {
  const getClient = isCommunicationServiceOptions(prismaOrOptions)
    ? prismaOrOptions.getClient
    : async () => prismaOrOptions;
  const cipher = isCommunicationServiceOptions(prismaOrOptions)
    ? (prismaOrOptions.cipher ?? createFieldCipherFromEnv())
    : createFieldCipherFromEnv();
  const moderation = isCommunicationServiceOptions(prismaOrOptions)
    && prismaOrOptions.moderation?.provider === 'local'
    ? prismaOrOptions.moderation
    : undefined;
  const logger = isCommunicationServiceOptions(prismaOrOptions) ? prismaOrOptions.logger : undefined;
  const auditSource = isCommunicationServiceOptions(prismaOrOptions)
    ? (prismaOrOptions.auditSource ?? 'manual')
    : 'manual';
  const changelogFactory = isCommunicationServiceOptions(prismaOrOptions)
    ? (prismaOrOptions.changelogFactory ?? createChangelogService)
    : createChangelogService;
  const trustedClockFactory = isCommunicationServiceOptions(prismaOrOptions)
    ? (prismaOrOptions.trustedClockFactory ?? createDatabaseTrustedClock)
    : createDatabaseTrustedClock;

  return {
    async createCommunicationRecord(input: CreateCommunicationRecordInput) {
      const prisma = await getClient();
      // 1. owner 校验
      const owned = await assertOwnedStudent(prisma, input.teacherId, input.studentId);
      if (!owned.ok) return owned;

      // 2. 字段校验
      const validation = validateCommunicationFields(input);
      if (!validation.ok) return validation;

      // 3. 可信时间
      const now = await requireTrustedNow(prisma, trustedClockFactory);
      if (!now.ok) return now;

      // 4. 原子事务
      try {
        const created = await (prisma as PrismaClient).$transaction((tx) =>
          createCommunicationRecordInternal(
            tx, input, now.value, cipher, moderation, logger, auditSource, changelogFactory,
          ),
        );
        return ok(created);
      } catch {
        return err(internalError('创建沟通记录失败'));
      }
    },

    async updateDetail(input: UpdateCommunicationDetailInput) {
      const prisma = await getClient();
      // 1. owner 校验 record 属于 teacherId + studentId
      const owned = await assertOwnedRecord(prisma, input.teacherId, input.studentId, input.recordId);
      if (!owned.ok) return owned;

      if (owned.value.category !== 'parent_communication') {
        return err(validationError('只能更新家长沟通类明细', 'recordId'));
      }

      // 2. 字段校验
      const validation = validateDetailPatch(input.patch);
      if (!validation.ok) return validation;

      try {
        const updated = await (prisma as PrismaClient).$transaction(async (tx) => {
          const oldDetail = await tx.communicationDetail.findFirst({ where: {
            studentRecordId: input.recordId, teacherId: input.teacherId,
          } });
          if (!oldDetail) throw new CommunicationCasError(false);
          const nextToken = await requireTrustedNow(tx, trustedClockFactory);
          if (!nextToken.ok) throw new Error('TRUSTED_CLOCK_UNAVAILABLE');
          if (nextToken.value.getTime() === oldDetail.updatedAtTs.getTime()) {
            throw new Error('TRUSTED_CLOCK_TOKEN_NOT_ADVANCED');
          }
          const record = await tx.studentRecord.findFirst({
            where: { id: input.recordId, teacherId: input.teacherId, studentId: input.studentId },
            include: { sourceRecord: true },
          });
          if (!record) throw new CommunicationCasError(false);
          const patch = input.patch;
          const arrays = {
            parentConcerns: patch.parentConcerns ?? decryptJsonFieldValue(cipher, oldDetail.parentConcerns) as string[],
            teacherResponses: patch.teacherResponses ?? decryptJsonFieldValue(cipher, oldDetail.teacherResponses) as string[],
            agreements: patch.agreements ?? decryptJsonFieldValue(cipher, oldDetail.agreements) as string[],
            followUps: patch.followUps ?? decryptJsonFieldValue(cipher, oldDetail.followUps) as string[],
          };
          const textChanged = patch.parentConcerns !== undefined || patch.teacherResponses !== undefined
            || patch.agreements !== undefined || patch.followUps !== undefined;
          const moderationResult = textChanged ? await moderateCommunicationProjection({
            moderation, logger, teacherId: input.teacherId, recordId: input.recordId,
            projection: {
              summary: decryptFieldValue(cipher, record.summary),
              sourceText: record.sourceRecord?.rawText
                ? decryptFieldValue(cipher, record.sourceRecord.rawText) : null,
              ...arrays,
            },
          }) : undefined;
          const data: Prisma.CommunicationDetailUpdateInput = { updatedAtTs: nextToken.value };
          if (patch.direction !== undefined) data.direction = patch.direction;
          if (patch.channel !== undefined) data.channel = patch.channel;
          if (patch.parentType !== undefined) data.parentType = patch.parentType;
          for (const key of ['parentConcerns', 'teacherResponses', 'agreements', 'followUps'] as const) {
            if (patch[key] !== undefined) data[key] = encryptJsonFieldValue(cipher, arrays[key]) as unknown as Prisma.InputJsonValue;
          }
          if (patch.nextContactAtTs !== undefined) data.nextContactAtTs = patch.nextContactAtTs;
          if (textChanged) {
            data.moderationFlagged = moderationResult?.flagged ?? null;
            data.moderationReasons = moderationResult
              ? moderationResult.reasons as Prisma.InputJsonValue : Prisma.DbNull;
          }
          const detail = await tx.communicationDetail.update({
            where: {
              id: oldDetail.id,
              teacherId: input.teacherId,
              studentRecordId: input.recordId,
              updatedAtTs: oldDetail.updatedAtTs,
            },
            data,
          });
          await requireAudit(tx, {
            teacherId: input.teacherId, module: 'student-communications', action: 'update',
            targetType: 'CommunicationDetail', targetId: detail.id,
            before: auditDetail(oldDetail), after: auditDetail(detail), source: auditSource,
          }, changelogFactory);
          return toCommunicationDetailData(detail, cipher);
        });
        return ok(updated);
      } catch (caught) {
        if (caught instanceof CommunicationCasError) {
          return caught.stillExists ? err(versionConflict()) : err(notFound('沟通明细不存在'));
        }
        if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2025') {
          const current = await prisma.communicationDetail.findFirst({ where: {
            studentRecordId: input.recordId, teacherId: input.teacherId,
          }, select: { id: true } });
          return current ? err(versionConflict()) : err(notFound('沟通明细不存在'));
        }
        return err(internalError('更新沟通明细失败'));
      }
    },

    async getOwnedDetail(input: GetOwnedDetailInput) {
      const prisma = await getClient();
      // owner 校验
      const owned = await assertOwnedRecord(prisma, input.teacherId, input.studentId, input.recordId);
      if (!owned.ok) return owned;

      const detail = await prisma.communicationDetail.findFirst({
        where: { studentRecordId: input.recordId, teacherId: input.teacherId },
      });
      if (!detail) return err(notFound('沟通明细不存在'));

      return ok(toCommunicationDetailData(detail, cipher));
    },
  };
}
