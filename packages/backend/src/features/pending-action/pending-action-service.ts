import { Prisma } from '@prisma/client';
import {
  err,
  internalError,
  notFound,
  ok,
  validationError,
} from '@teacher-platform/contracts';
import {
  createFieldCipherFromEnv,
  encryptFieldValue,
  encryptJsonFieldValue,
} from '../../shared/field-encryption/index.js';
import type {
  CreatePendingActionInput,
  CreatePendingActionServiceOptions,
  PendingActionData,
  PendingActionService,
  PendingActionTargetType,
  PendingActionWithToken,
} from './types.js';
import { CONFIRMABLE_ACTION_NAMES } from './types.js';
import { toPendingActionData } from './pending-action-mapper.js';

const DEFAULT_TTL_SECONDS = 900;
const MAX_TTL_SECONDS = 86_400;
const MAX_ID_LENGTH = 128;
const MAX_SUMMARY_LENGTH = 1_000;
const MAX_PARAMETERS_LENGTH = 16_384;
const AGENDA_SOURCE_LIMIT = 500;
const TARGET_TYPES = new Set<PendingActionTargetType>([
  'Student',
  'Schedule',
  'Lesson',
  'Payment',
  'Memo',
  'ParentFeedback',
]);

function nonEmptyString(value: unknown, maxLength = MAX_ID_LENGTH): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function normalizeJson(value: unknown, seen = new Set<object>()): Prisma.InputJsonValue | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    if (seen.has(value)) return null;
    seen.add(value);
    const normalized = value.map((item) => normalizeJson(item, seen));
    seen.delete(value);
    return normalized.some((item, index) => item === null && value[index] !== null) ? null : normalized as Prisma.InputJsonArray;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return null;
    seen.add(value);
    const output: { [key: string]: Prisma.InputJsonValue | null } = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = normalizeJson(item, seen);
      if (normalized === null && item !== null) {
        seen.delete(value);
        return null;
      }
      output[key] = normalized;
    }
    seen.delete(value);
    return output;
  }
  return null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateInput(input: CreatePendingActionInput) {
  if (!nonEmptyString(input.teacherId)) return validationError('teacherId 无效', 'teacherId');
  if (!nonEmptyString(input.conversationId)) return validationError('conversationId 无效', 'conversationId');
  if (!nonEmptyString(input.toolCallId)) return validationError('toolCallId 无效', 'toolCallId');
  if (!CONFIRMABLE_ACTION_NAMES.includes(input.actionName)) return validationError('actionName 不可确认执行', 'actionName');
  if (!TARGET_TYPES.has(input.target.type)) return validationError('targetType 无效', 'targetType');
  if (!nonEmptyString(input.target.id)) return validationError('targetId 无效', 'targetId');
  if (input.beforeSummary !== null && !nonEmptyString(input.beforeSummary, MAX_SUMMARY_LENGTH)) {
    return validationError('beforeSummary 无效', 'beforeSummary');
  }
  if (!nonEmptyString(input.afterSummary, MAX_SUMMARY_LENGTH)) {
    return validationError('afterSummary 无效', 'afterSummary');
  }
  if (!input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters)) {
    return validationError('parameters 必须是对象', 'parameters');
  }
  return null;
}

function sameIntent(existing: PendingActionData, input: CreatePendingActionInput, normalizedParameters: unknown): boolean {
  return existing.conversationId === input.conversationId
    && existing.actionName === input.actionName
    && existing.targetType === input.target.type
    && existing.targetId === input.target.id
    && existing.beforeSummary === input.beforeSummary
    && existing.afterSummary === input.afterSummary
    && canonicalJson(existing.parameters) === canonicalJson(normalizedParameters);
}

async function databaseNow(prisma: CreatePendingActionServiceOptions['prisma']): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT CURRENT_TIMESTAMP AS "now"`);
  if (!rows[0]?.now) throw new Error('database time unavailable');
  return rows[0].now;
}

export function createPendingActionAgendaReader(
  prismaOrOptions: CreatePendingActionServiceOptions['prisma'] | { getClient: () => Promise<CreatePendingActionServiceOptions['prisma']> },
): Pick<PendingActionService, 'listActivePendingActions'> {
  const getClient = typeof prismaOrOptions === 'object'
    && prismaOrOptions !== null
    && typeof (prismaOrOptions as { getClient?: unknown }).getClient === 'function'
    ? (prismaOrOptions as { getClient: () => Promise<CreatePendingActionServiceOptions['prisma']> }).getClient
    : async () => prismaOrOptions as CreatePendingActionServiceOptions['prisma'];

  return {
    async listActivePendingActions(input) {
      const prisma = await getClient();
      if (!nonEmptyString(input.teacherId)) {
        return err(validationError('teacherId 无效', 'teacherId'));
      }
      if (!(input.activeAt instanceof Date) || Number.isNaN(input.activeAt.getTime())) {
        return err(validationError('activeAt 无效', 'activeAt'));
      }
      const where = {
        teacherId: input.teacherId,
        status: 'pending',
        expiresAtTs: { gt: input.activeAt },
      };
      const [records, total] = await Promise.all([
        prisma.pendingAction.findMany({
          where,
          orderBy: [{ expiresAtTs: 'asc' }, { id: 'asc' }],
          take: AGENDA_SOURCE_LIMIT,
        }),
        prisma.pendingAction.count({ where }),
      ]);
      return ok({ items: records.map((record) => toPendingActionData(record)), total });
    },
  };
}

export function createPendingActionService(options: CreatePendingActionServiceOptions): PendingActionService {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error('ttlSeconds 必须在 1 到 86400 之间');
  }
  // P8 phase-3 批5：parameters/beforeSummary/afterSummary 加密 cipher（缺省 env 构建）
  const cipher = options.cipher ?? createFieldCipherFromEnv();

  function withToken(record: PendingActionData) {
    const token = options.actionTokenSigner.sign(record.id);
    if (!token.ok) return token;
    return ok<PendingActionWithToken>({ pendingAction: record, actionToken: token.value });
  }

  async function findByIdempotencyKey(teacherId: string, toolCallId: string) {
    const record = await options.prisma.pendingAction.findUnique({
      where: { teacherId_toolCallId: { teacherId, toolCallId } },
    });
    return record ? toPendingActionData(record, cipher) : null;
  }

  async function returnExistingOrConflict(existing: PendingActionData, input: CreatePendingActionInput, parameters: unknown) {
    if (!sameIntent(existing, input, parameters)) {
      return err(validationError('toolCallId 已绑定其他待确认操作', 'toolCallId'));
    }
    return withToken(existing);
  }

  const agendaReader = createPendingActionAgendaReader(options.prisma);

  return {
    async createPendingAction(input) {
      const inputError = validateInput(input);
      if (inputError) return err(inputError);
      const normalizedParameters = normalizeJson(input.parameters);
      if (!normalizedParameters || canonicalJson(normalizedParameters).length > MAX_PARAMETERS_LENGTH) {
        return err(validationError('parameters 不是有效 JSON 或超过长度限制', 'parameters'));
      }

      const conversation = await options.conversationOwner.getOwnedConversation({
        teacherId: input.teacherId,
        conversationId: input.conversationId,
      });
      if (!conversation.ok) return conversation;
      if (conversation.value.status !== 'active') {
        return err(validationError('已归档会话不能创建待确认操作', 'conversationId'));
      }

      const existing = await findByIdempotencyKey(input.teacherId, input.toolCallId);
      if (existing) return returnExistingOrConflict(existing, input, normalizedParameters);

      try {
        const trustedNow = await databaseNow(options.prisma);
        const expiresAt = new Date(trustedNow.getTime() + ttlSeconds * 1_000);
        const created = await options.prisma.pendingAction.create({
          data: {
            teacherId: input.teacherId,
            conversationId: input.conversationId,
            toolCallId: input.toolCallId,
            actionName: input.actionName,
            targetType: input.target.type,
            targetId: input.target.id,
            parameters: (encryptJsonFieldValue(cipher, normalizedParameters) as unknown) as Prisma.InputJsonValue,
            beforeSummary: input.beforeSummary === null
              ? null
              : encryptFieldValue(cipher, input.beforeSummary),
            afterSummary: encryptFieldValue(cipher, input.afterSummary),
            expiresAtTs: expiresAt,
            createdAtTs: trustedNow,
            updatedAtTs: trustedNow,
          },
        });
        return withToken(toPendingActionData(created, cipher));
      } catch (caught) {
        if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2002') {
          const raced = await findByIdempotencyKey(input.teacherId, input.toolCallId);
          if (raced) return returnExistingOrConflict(raced, input, normalizedParameters);
        }
        return err(internalError('待确认操作保存失败'));
      }
    },

    async getPendingAction(input) {
      if (!nonEmptyString(input.pendingActionId)) {
        return err(validationError('pendingActionId 无效', 'pendingActionId'));
      }
      if (!nonEmptyString(input.teacherId)) return err(validationError('teacherId 无效', 'teacherId'));
      const record = await options.prisma.pendingAction.findFirst({
        where: { id: input.pendingActionId, teacherId: input.teacherId },
      });
      if (!record) return err(notFound('待确认操作不存在'));
      return withToken(toPendingActionData(record, cipher));
    },

    async listForConversationToolCalls(input) {
      if (!nonEmptyString(input.teacherId)) return err(validationError('teacherId 无效', 'teacherId'));
      if (!nonEmptyString(input.conversationId)) {
        return err(validationError('conversationId 无效', 'conversationId'));
      }
      const toolCallIds = [...new Set(input.toolCallIds.filter((id) => nonEmptyString(id)))];
      if (toolCallIds.length === 0) return ok([]);
      if (toolCallIds.length > 100) return err(validationError('toolCallIds 数量超过限制', 'toolCallIds'));
      const records = await options.prisma.pendingAction.findMany({
        where: {
          teacherId: input.teacherId,
          conversationId: input.conversationId,
          toolCallId: { in: toolCallIds },
        },
        orderBy: { toolCallId: 'asc' },
      });
      const result: PendingActionWithToken[] = [];
      for (const record of records) {
        const projected = withToken(toPendingActionData(record, cipher));
        if (!projected.ok) return projected;
        result.push(projected.value);
      }
      return ok(result);
    },

    listActivePendingActions: agendaReader.listActivePendingActions,
  };
}
