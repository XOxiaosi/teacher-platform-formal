import type { Prisma, PrismaClient } from '@prisma/client';
import {
  err,
  internalError,
  notFound,
  ok,
  validationError,
  versionConflict,
  type CommonError,
  type Result,
} from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import type { ModerationAdapter } from '../../shared/platform-services/index.js';
import type { Logger } from '../../shared/logger/index.js';
import {
  REQUIREMENT_CATEGORIES,
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_STATUSES,
  type RequirementCategory,
  type RequirementPriority,
  type RequirementStatus,
} from '../../shared/requirement-domain/index.js';

/**
 * P2 用户发言需求追溯（D50 §5.1）：共享库表 UserRequirement。
 * - owner 隔离：teacherId 可空（平台级需求，仅平台/管理员维护，教师只读）
 * - 写路径仅允许 owner（teacherId = 当前教师）；平台级（teacherId=null）拒绝所有教师写（NOT_FOUND 防探测）
 * - verbatimQuote 不可修改（追溯留证）；PATCH 乐观锁 expectedUpdatedAt（复用 edit 模式）
 * - category/priority/status 白名单校验
 */

export {
  REQUIREMENT_CATEGORIES,
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_STATUSES,
  type RequirementCategory,
  type RequirementPriority,
  type RequirementStatus,
} from '../../shared/requirement-domain/index.js';

export interface CreateRequirementInput {
  teacherId?: string;
  verbatimQuote: string;
  sourceType?: string;
  sourceDbName?: string;
  sourceTurnId?: string;
  contextSummary?: string;
  /** 发言时间；缺省用 TrustedClock（业务时间纪律） */
  occurredAtTs?: Date;
  parsedIntent?: string;
  category: string;
  priority?: string;
  status?: string;
  linkedDesignDoc?: string;
  linkedTaskId?: string;
  linkedCommitSha?: string;
  /** P15 t2（agent 工具路径）：调用方（requirements.capture 工具）写库前预计算审核结果透传——
   *  提供时服务直接落 additive 列（moderationFlagged/moderationReasons），不重复自检；
   *  审计日志由调用方负责（actor=agent，与 HTTP 路径 actor=teacherId 区分）。
   *  缺省 undefined → 走服务自检（composition 注入 moderation adapter，P14 接线）。 */
  moderationFlagged?: boolean;
  moderationReasons?: string[];
}

export interface UpdateRequirementInput {
  requirementId: string;
  teacherId?: string;
  expectedUpdatedAt: string; // RFC3339
  changes: {
    sourceType?: string;
    contextSummary?: string;
    parsedIntent?: string;
    category?: string;
    priority?: string;
    status?: string;
    linkedDesignDoc?: string;
    linkedTaskId?: string;
    linkedCommitSha?: string;
  };
}

export interface ListRequirementsInput {
  teacherId?: string;
  status?: string;
  category?: string;
  page?: number;
  pageSize?: number;
}

export interface RequirementData {
  id: string;
  teacherId: string | null;
  verbatimQuote: string;
  sourceType: string | null;
  sourceDbName: string | null;
  sourceTurnId: string | null;
  contextSummary: string | null;
  occurredAtTs: Date;
  parsedIntent: string | null;
  category: string;
  priority: string;
  status: string;
  linkedDesignDoc: string | null;
  linkedTaskId: string | null;
  linkedCommitSha: string | null;
  /** P14 D 切片：本地审核命中标记（review 心智——不阻断写库；未配置 moderation 时恒为 null） */
  moderationFlagged: boolean | null;
  /** P14 D 切片：命中原因（规则组 id + 中文描述数组）；未命中/未配置 = null */
  moderationReasons: string[] | null;
  createdAtTs: Date;
  updatedAtTs: Date;
}

export interface RequirementService {
  createRequirement(input: CreateRequirementInput): Promise<Result<RequirementData, CommonError>>;
  getRequirement(input: { requirementId: string; teacherId?: string }): Promise<Result<RequirementData, CommonError>>;
  listRequirements(input: ListRequirementsInput): Promise<Result<{ items: RequirementData[]; total: number }, CommonError>>;
  updateRequirement(input: UpdateRequirementInput): Promise<Result<RequirementData, CommonError>>;
}

export interface RequirementServiceOptions {
  getClient: () => Promise<PrismaClient>;
  /** P14 D 切片：可选文本审核 adapter（composition 注入 createPlatformServices(env).moderation；未配置 → 零影响）。 */
  moderation?: ModerationAdapter;
  /** P14 D 切片：审计 logger（msg:'moderation flag' 结构化日志；缺省 undefined → 仅不落日志，不阻断写库）。 */
  logger?: Logger;
}

/**
 * 直传共享库 PrismaClient 形态（P14 t2 修正 · R8）：共享库表服务（UserRequirement）装配
 * **禁止 getClient 键**（R8 语义：防生产形态路由到隔离教师库 → FK 违反 500）。
 * composition 装配用本形态：{ prisma, moderation?, logger? }——getClient 保留给
 * 非共享库路径/兼容旧调用（register-requirement-tools 等），两种形态功能等价。
 */
export interface RequirementServiceDirectOptions {
  prisma: PrismaClient;
  /** P14 D 切片：可选文本审核 adapter（composition 注入 createPlatformServices(env).moderation；未配置 → 零影响）。 */
  moderation?: ModerationAdapter;
  /** P14 D 切片：审计 logger（msg:'moderation flag' 结构化日志；缺省 undefined → 仅不落日志，不阻断写库）。 */
  logger?: Logger;
}

function isRequirementServiceOptions(
  value: PrismaClient | RequirementServiceOptions | RequirementServiceDirectOptions,
): value is RequirementServiceOptions {
  return typeof value === 'object'
    && value !== null
    && typeof (value as RequirementServiceOptions).getClient === 'function';
}

function isRequirementServiceDirectOptions(
  value: PrismaClient | RequirementServiceOptions | RequirementServiceDirectOptions,
): value is RequirementServiceDirectOptions {
  return typeof value === 'object'
    && value !== null
    && (value as RequirementServiceDirectOptions).prisma !== undefined
    && typeof (value as RequirementServiceOptions).getClient !== 'function';
}

export function createRequirementService(
  prismaOrOptions: PrismaClient | RequirementServiceOptions | RequirementServiceDirectOptions,
): RequirementService {
  // 三种形态归一为 getClient：直传 PrismaClient / { getClient } / { prisma }（R8 直传共享库形态）
  let getClient: () => Promise<PrismaClient>;
  let moderation: ModerationAdapter | undefined;
  let logger: Logger | undefined;
  if (isRequirementServiceOptions(prismaOrOptions)) {
    getClient = prismaOrOptions.getClient;
    moderation = prismaOrOptions.moderation;
    logger = prismaOrOptions.logger;
  } else if (isRequirementServiceDirectOptions(prismaOrOptions)) {
    const direct = prismaOrOptions;
    getClient = async () => direct.prisma;
    moderation = direct.moderation;
    logger = direct.logger;
  } else {
    const client = prismaOrOptions as PrismaClient;
    getClient = async () => client;
  }

  async function resolve(): Promise<{ prisma: PrismaClient; trustedClock: ReturnType<typeof createDatabaseTrustedClock> }> {
    const prisma = await getClient();
    return { prisma, trustedClock: createDatabaseTrustedClock(prisma) };
  }

  return {
    async createRequirement(input) {
      // 写路径强制 owner：教师创建的需求必须归属当前教师，不允许创建平台级记录（平台级由平台/管理员维护）
      if (!input.teacherId || input.teacherId.trim() === '') {
        return err(validationError('缺少归属教师', 'teacherId'));
      }
      if (!input.verbatimQuote || input.verbatimQuote.trim() === '') {
        return err(validationError('原话不能为空', 'verbatimQuote'));
      }
      if (!REQUIREMENT_CATEGORIES.includes(input.category as RequirementCategory)) {
        return err(validationError('分类不合法', 'category'));
      }
      if (input.priority !== undefined && !REQUIREMENT_PRIORITIES.includes(input.priority as RequirementPriority)) {
        return err(validationError('优先级不合法', 'priority'));
      }
      if (input.status !== undefined && !REQUIREMENT_STATUSES.includes(input.status as RequirementStatus)) {
        return err(validationError('状态不合法', 'status'));
      }
      if (input.occurredAtTs !== undefined
        && (!(input.occurredAtTs instanceof Date) || Number.isNaN(input.occurredAtTs.getTime()))) {
        return err(validationError('发言时间无效', 'occurredAtTs'));
      }

      const { prisma, trustedClock } = await resolve();
      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      // P14 D 切片（moderation 接线）：写库前可选文本审核——composition 注入
      // createPlatformServices(env).moderation（本地规则先行）。review 心智：命中**不阻断写库**，
      // 只落 additive 列（moderationFlagged/moderationReasons）+ 结构化日志审计
      // （msg:'moderation flag', actor, requirementId, reasons）；未配置 moderation → 零影响（跳过）。
      // adapter 异常同样不阻断写库（审核是旁路，同 admin audit 纪律），仅 warn。
      // P15 t2（agent 工具路径）：调用方（requirements.capture 工具）预计算审核结果透传——
      // input.moderationFlagged !== undefined 时直接采用（不重复自检、不重复审计，
      // 审计由调用方负责 actor=agent）；缺省 undefined → 服务自检（actor=teacherId）。
      const precomputedModeration = input.moderationFlagged !== undefined;
      let moderationFlagged = false;
      let moderationReasons: string[] = [];
      if (precomputedModeration) {
        moderationFlagged = input.moderationFlagged === true;
        moderationReasons = input.moderationReasons ?? [];
      } else if (moderation) {
        try {
          const moderationResult = await moderation.moderateText({
            text: input.verbatimQuote,
            scene: 'student_source',
          });
          moderationFlagged = moderationResult.flagged === true;
          moderationReasons = moderationResult.reasons ?? [];
        } catch (moderationError) {
          logger?.warn('moderation check failed', {
            error: moderationError instanceof Error ? moderationError.message : String(moderationError),
            actor: input.teacherId,
          });
        }
      }

      try {
        const record = await prisma.userRequirement.create({
          data: {
            teacherId: input.teacherId,
            verbatimQuote: input.verbatimQuote.trim(),
            sourceType: input.sourceType ?? null,
            sourceDbName: input.sourceDbName ?? null,
            sourceTurnId: input.sourceTurnId ?? null,
            contextSummary: input.contextSummary ?? null,
            occurredAtTs: input.occurredAtTs ?? now.value,
            parsedIntent: input.parsedIntent ?? null,
            category: input.category,
            priority: input.priority ?? 'normal',
            status: input.status ?? 'new',
            linkedDesignDoc: input.linkedDesignDoc ?? null,
            linkedTaskId: input.linkedTaskId ?? null,
            linkedCommitSha: input.linkedCommitSha ?? null,
            // 仅 flagged 时写入 additive 审核列（未命中/未配置 → 不写 = SQL NULL，零破坏）
            ...(moderationFlagged
              ? { moderationFlagged: true, moderationReasons: moderationReasons as Prisma.InputJsonValue }
              : {}),
            createdAtTs: now.value,
            updatedAtTs: now.value,
          },
        });
        // flagged → 结构化日志审计（review 心智：留痕供人工复核，不阻断已完成的写库）
        // P15 t2：预计算透传（agent 工具路径）时审计由调用方负责（actor=agent），服务不再重复落
        if (moderationFlagged && !precomputedModeration) {
          logger?.info('moderation flag', {
            actor: input.teacherId,
            requirementId: record.id,
            reasons: moderationReasons,
          });
        }
        return ok(toRequirementData(record));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`创建需求记录失败：${message}`));
      }
    },

    async getRequirement(input) {
      const prisma = await getClient();
      const where = { id: input.requirementId } satisfies Prisma.UserRequirementWhereUniqueInput;
      const record = await prisma.userRequirement.findFirst({
        where: {
          id: where.id,
          ...(input.teacherId !== undefined && {
            OR: [{ teacherId: input.teacherId }, { teacherId: null }],
          }),
        },
      });
      if (!record) return err(notFound('需求记录不存在'));
      return ok(toRequirementData(record));
    },

    async listRequirements(input) {
      const prisma = await getClient();
      const page = input.page ?? 1;
      const pageSize = input.pageSize ?? 20;
      if (page < 1) return err(validationError('页码必须大于等于 1', 'page'));
      if (pageSize < 1) return err(validationError('每页数量必须大于等于 1', 'pageSize'));
      if (input.status !== undefined && !REQUIREMENT_STATUSES.includes(input.status as RequirementStatus)) {
        return err(validationError('状态不合法', 'status'));
      }
      if (input.category !== undefined && !REQUIREMENT_CATEGORIES.includes(input.category as RequirementCategory)) {
        return err(validationError('分类不合法', 'category'));
      }
      const skip = (page - 1) * pageSize;
      const where: Prisma.UserRequirementWhereInput = {
        ...(input.teacherId !== undefined && {
          OR: [{ teacherId: input.teacherId }, { teacherId: null }],
        }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.category !== undefined && { category: input.category }),
      };
      const [items, total] = await Promise.all([
        prisma.userRequirement.findMany({ where, orderBy: { occurredAtTs: 'desc' }, skip, take: pageSize }),
        prisma.userRequirement.count({ where }),
      ]);
      return ok({ items: items.map(toRequirementData), total });
    },

    async updateRequirement(input) {
      const trimmed = input.expectedUpdatedAt.trim();
      const parsed = Date.parse(trimmed);
      if (!/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/.test(trimmed) || Number.isNaN(parsed)) {
        return err(validationError('expectedUpdatedAt 必须是带时区的 RFC3339 时间', 'expectedUpdatedAt'));
      }

      const { prisma, trustedClock } = await resolve();
      // 写路径仅允许 owner：teacherId 缺失或平台级（null）记录一律 NOT_FOUND（防探测，跨 teacher 惯例）
      if (input.teacherId === undefined || input.teacherId.trim() === '') {
        return err(notFound('需求记录不存在'));
      }
      const existing = await prisma.userRequirement.findFirst({
        where: {
          id: input.requirementId,
          teacherId: input.teacherId,
        },
      });
      if (!existing) return err(notFound('需求记录不存在'));
      if (parsed !== existing.updatedAtTs.getTime()) {
        return err(versionConflict());
      }

      const changes = input.changes;
      if (changes.category !== undefined && !REQUIREMENT_CATEGORIES.includes(changes.category as RequirementCategory)) {
        return err(validationError('分类不合法', 'category'));
      }
      if (changes.priority !== undefined && !REQUIREMENT_PRIORITIES.includes(changes.priority as RequirementPriority)) {
        return err(validationError('优先级不合法', 'priority'));
      }
      if (changes.status !== undefined && !REQUIREMENT_STATUSES.includes(changes.status as RequirementStatus)) {
        return err(validationError('状态不合法', 'status'));
      }

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      try {
        const updated = await prisma.userRequirement.update({
          where: { id: input.requirementId },
          data: {
            ...(changes.sourceType !== undefined && { sourceType: changes.sourceType }),
            ...(changes.contextSummary !== undefined && { contextSummary: changes.contextSummary }),
            ...(changes.parsedIntent !== undefined && { parsedIntent: changes.parsedIntent }),
            ...(changes.category !== undefined && { category: changes.category }),
            ...(changes.priority !== undefined && { priority: changes.priority }),
            ...(changes.status !== undefined && { status: changes.status }),
            ...(changes.linkedDesignDoc !== undefined && { linkedDesignDoc: changes.linkedDesignDoc }),
            ...(changes.linkedTaskId !== undefined && { linkedTaskId: changes.linkedTaskId }),
            ...(changes.linkedCommitSha !== undefined && { linkedCommitSha: changes.linkedCommitSha }),
            updatedAtTs: now.value,
          },
        });
        return ok(toRequirementData(updated));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`更新需求记录失败：${message}`));
      }
    },
  };
}

function toRequirementData(record: {
  id: string;
  teacherId: string | null;
  verbatimQuote: string;
  sourceType: string | null;
  sourceDbName: string | null;
  sourceTurnId: string | null;
  contextSummary: string | null;
  occurredAtTs: Date;
  parsedIntent: string | null;
  category: string;
  priority: string;
  status: string;
  linkedDesignDoc: string | null;
  linkedTaskId: string | null;
  linkedCommitSha: string | null;
  moderationFlagged: boolean | null;
  moderationReasons: unknown;
  createdAtTs: Date;
  updatedAtTs: Date;
}): RequirementData {
  return {
    id: record.id,
    teacherId: record.teacherId,
    verbatimQuote: record.verbatimQuote,
    sourceType: record.sourceType,
    sourceDbName: record.sourceDbName,
    sourceTurnId: record.sourceTurnId,
    contextSummary: record.contextSummary,
    occurredAtTs: record.occurredAtTs,
    parsedIntent: record.parsedIntent,
    category: record.category,
    priority: record.priority,
    status: record.status,
    linkedDesignDoc: record.linkedDesignDoc,
    linkedTaskId: record.linkedTaskId,
    linkedCommitSha: record.linkedCommitSha,
    moderationFlagged: record.moderationFlagged,
    moderationReasons: Array.isArray(record.moderationReasons)
      ? (record.moderationReasons as string[])
      : null,
    createdAtTs: record.createdAtTs,
    updatedAtTs: record.updatedAtTs,
  };
}
