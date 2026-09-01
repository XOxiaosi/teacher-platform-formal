import type { PrismaClient } from '@prisma/client';
import { validationError } from '@teacher-platform/contracts';
import type { ToolRegistry } from '../../shared/tool-registry/types.js';
import type { ModerationAdapter } from '../../shared/platform-services/index.js';
import type { Logger } from '../../shared/logger/index.js';
import { createRequirementService } from '../../features/requirements/index.js';
import { parseDateArg } from './tool-arg-parsers.js';

type RequirementToolsClientProvider = PrismaClient | { getClient: () => Promise<PrismaClient> };

function requirementToolsGetClient(provider: RequirementToolsClientProvider): () => Promise<PrismaClient> {
  return typeof provider === 'object'
    && provider !== null
    && typeof (provider as { getClient?: unknown }).getClient === 'function'
    ? (provider as { getClient: () => Promise<PrismaClient> }).getClient
    : async () => provider as PrismaClient;
}

/** P15 t2（agent 工具路径 moderation 透传）：可选文本审核 adapter + 审计 logger（与 service 同款——
 *  未配置 → 零影响：不审核、不落 additive 列、不写审计日志）。 */
export interface RegisterRequirementToolsOptions {
  moderation?: ModerationAdapter;
  logger?: Logger;
}

/**
 * P2 需求追溯 Agent 工具（D51 §九，登记附录 A.2）：
 * - requirements.capture：Agent 在对话中识别需求信号后创建 UserRequirement（副作用 create）。
 *
 * P15 t2（moderation 透传，P14 t2 遗留）：capture 写库前调 moderation adapter
 * （本地规则先行，即 moderateWithLocalRules 引擎）→ flagged 时同 review 心智——
 * 不阻断写库 + 审计日志 msg:'moderation flag' actor=agent（与 HTTP 路径 actor=teacherId 区分）
 * + 预计算结果透传 service 落 additive 列（moderationFlagged/moderationReasons）。
 */
export function registerRequirementTools(
  registry: ToolRegistry,
  prismaOrGetClient: RequirementToolsClientProvider,
  options: RegisterRequirementToolsOptions = {},
): void {
  const getClient = requirementToolsGetClient(prismaOrGetClient);
  const { moderation, logger } = options;
  const requirements = createRequirementService({ getClient });

  registry.register(
    {
      name: 'requirements.capture',
      description: '记录一条用户发言需求（原话+来源+分类），供需求追溯与评审',
      sideEffect: 'create',
      parameters: {
        type: 'object',
        properties: {
          verbatimQuote: { type: 'string', description: '用户原话（必填，不可修改）' },
          category: {
            type: 'string',
            enum: ['feature', 'improvement', 'bug_report', 'ux', 'performance', 'privacy', 'other'],
            description: '需求分类',
          },
          occurredAt: { type: 'string', description: '发言时间（ISO 8601，缺省用当前时间）' },
          contextSummary: { type: 'string', description: '上下文摘要' },
          parsedIntent: { type: 'string', description: '解析意图' },
          priority: {
            type: 'string',
            enum: ['low', 'normal', 'high', 'urgent'],
            description: '优先级（缺省 normal）',
          },
          sourceType: { type: 'string', description: '来源类型（agent_conversation/wechat/manual/import 等）' },
        },
        required: ['verbatimQuote', 'category'],
      },
    },
    async (args, context) => {
      const a = args as Record<string, unknown>;
      if (typeof a.verbatimQuote !== 'string' || a.verbatimQuote.trim() === '') {
        return { ok: false, error: validationError('verbatimQuote 必须是非空字符串', 'verbatimQuote') };
      }
      if (typeof a.category !== 'string' || a.category.trim() === '') {
        return { ok: false, error: validationError('category 必须是非空字符串', 'category') };
      }
      const occurredAt = a.occurredAt === undefined ? undefined : parseDateArg(a.occurredAt);
      if (occurredAt === null || (typeof occurredAt === 'object' && 'error' in occurredAt)) {
        return { ok: false, error: validationError('occurredAt 格式无效', 'occurredAt') };
      }

      // P15 t2（moderation 透传）：写库前可选文本审核——composition 注入
      // createPlatformServices(env).moderation（本地规则先行，moderateWithLocalRules 引擎）。
      // review 心智（同 service）：命中**不阻断写库**，只预计算结果透传 service 落 additive 列
      // + 审计日志（msg:'moderation flag', actor='agent', requirementId, reasons）；
      // 未配置 moderation → 零影响（跳过）；adapter 异常同样不阻断（仅 warn，同 admin audit 纪律）。
      let moderationFlagged = false;
      let moderationReasons: string[] = [];
      if (moderation) {
        try {
          const moderationResult = await moderation.moderateText({
            text: a.verbatimQuote,
            scene: 'student_source',
          });
          moderationFlagged = moderationResult.flagged === true;
          moderationReasons = moderationResult.reasons ?? [];
        } catch (moderationError) {
          logger?.warn('moderation check failed', {
            error: moderationError instanceof Error ? moderationError.message : String(moderationError),
            actor: 'agent',
          });
        }
      }

      const result = await requirements.createRequirement({
        teacherId: context.teacherId,
        verbatimQuote: a.verbatimQuote,
        category: a.category,
        // 缺省发言时间由 service 用 TrustedClock（业务时间纪律；工具不直接 new Date）
        occurredAtTs: occurredAt instanceof Date ? occurredAt : undefined,
        contextSummary: typeof a.contextSummary === 'string' ? a.contextSummary : undefined,
        parsedIntent: typeof a.parsedIntent === 'string' ? a.parsedIntent : undefined,
        priority: typeof a.priority === 'string' ? a.priority : undefined,
        sourceType: typeof a.sourceType === 'string' ? a.sourceType : 'agent_conversation',
        // 预计算审核结果透传（仅 flagged 时携带；service 直接落 additive 列，不重复自检/审计）
        ...(moderationFlagged
          ? { moderationFlagged: true as const, moderationReasons }
          : {}),
      });
      if (!result.ok) return result;
      // flagged → 审计（actor=agent：agent 工具路径标记；留痕供人工复核，不阻断已完成的写库）
      if (moderationFlagged) {
        logger?.info('moderation flag', {
          actor: 'agent',
          requirementId: result.value.id,
          reasons: moderationReasons,
        });
      }
      return { ok: true, value: { requirementId: result.value.id, category: result.value.category } };
    },
  );
}
