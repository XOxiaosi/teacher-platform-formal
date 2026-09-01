import type { PrismaClient } from '@prisma/client';
import {
  createLocalSafeToolRegistry,
  createToolRegistry,
} from '../shared/tool-registry/index.js';
import type { ToolRegistry } from '../shared/tool-registry/types.js';
import { createDatabaseTrustedClock, type TrustedClock } from '../shared/trusted-clock/index.js';
import {
  createAiClient,
  createArkAiProviderFromEnv,
  createFailClosedAiProvider,
  createRoutingAiClient,
  type AiClient,
  type AiProvider,
  type ProviderRouter,
} from '../shared/ai-client/index.js';
import { registerP0ReadTools } from './tools/register-p0-read-tools.js';
import { registerP0WriteTools } from './tools/register-p0-write-tools.js';
import { registerP0StateTools } from './tools/register-p0-state-tools.js';
import { registerMemoTools } from './tools/register-memo-tools.js';
import { registerFeedbackTools } from './tools/register-feedback-tools.js';
import { registerEditTools } from './tools/register-edit-tools.js';
import { registerStudentRecordsTools } from './tools/register-student-records-tools.js';
import { registerRequirementTools } from './tools/register-requirement-tools.js';
import { createCommunicationService } from '../features/student-communications/index.js';
import { createCaptureCommunicationFromTextUseCase } from './use-cases/capture-communication-from-text/index.js';
import type { ModerationAdapter } from '../shared/platform-services/index.js';
import type { Logger } from '../shared/logger/index.js';

/**
 * In local-safe mode, ignore a teacher resolver entirely.  This avoids reading
 * provider rows, decrypting keys, or loading a nearby .env before an agent tool
 * has a chance to execute.
 */
export function createToolAiClientForMode(options: {
  defaultAiProvider?: AiProvider;
  localSafeMode?: boolean;
  providerRouter?: ProviderRouter;
}): AiClient {
  const localSafeMode = options.localSafeMode === true;
  const defaultProvider = options.defaultAiProvider
    ?? (localSafeMode ? createFailClosedAiProvider() : createArkAiProviderFromEnv());
  if (localSafeMode || !options.providerRouter) {
    return createAiClient({ provider: defaultProvider });
  }
  return createRoutingAiClient({ defaultProvider, resolver: options.providerRouter });
}

export function createMinimalToolRegistry(options: {
  prisma: PrismaClient;
  trustedClock?: TrustedClock;
  /** S3 平移：请求期解析 client（数据库路由）；未提供时回退装配期 prisma */
  getClient?: () => Promise<PrismaClient>;
  /** L4 装配（t77）：ProviderConfig 路由 resolver——提供则 AiClient 换 routing client（缺省回退 ark env，零破坏） */
  providerRouter?: ProviderRouter;
  /** Allows composition to supply its already-selected safe or production provider. */
  defaultAiProvider?: AiProvider;
  /** P15 t2（agent 工具路径 moderation 透传）：可选文本审核 adapter——composition 注入
   *  createPlatformServices(env).moderation（本地规则先行）；未配置 → 零影响（requirements.capture 不审核）。
   *  与 service 同款（RequirementServiceOptions.moderation）。 */
  moderation?: ModerationAdapter;
  /** P15 t2：审计 logger（msg:'moderation flag' actor=agent 结构化日志；缺省 undefined → 仅不落日志，不阻断）。 */
  logger?: Logger;
  /** L0 本地安全视图：隐藏并拒绝直写工具；装配层默认开启，直接构造方需显式传入。 */
  localSafeMode?: boolean;
}): ToolRegistry {
  const prisma = options.prisma;
  const getClient = options.getClient ?? (async () => prisma);
  const trustedClock = options.trustedClock ?? createDatabaseTrustedClock(prisma);
  const aiClient = createToolAiClientForMode(options);
  const communicationModeration = options.moderation?.provider === 'local'
    ? options.moderation
    : undefined;
  const communications = createCommunicationService({
    getClient,
    ...(communicationModeration
      ? { moderation: communicationModeration, logger: options.logger }
      : {}),
    auditSource: 'agent',
  });
  const captureCommunicationFromText = createCaptureCommunicationFromTextUseCase({ prisma, aiClient, communications, getClient });
  const registry = createToolRegistry();

  registerP0ReadTools(registry, { getClient });
  registerP0WriteTools(registry, { getClient }, trustedClock);
  registerP0StateTools(registry);
  registerMemoTools(registry, { getClient });
  registerFeedbackTools(registry, prisma, trustedClock, {
    moderation: options.moderation?.provider === 'local' ? options.moderation : undefined,
    logger: options.logger,
  });
  registerEditTools(registry);
  registerStudentRecordsTools(registry, { getClient }, trustedClock, { captureCommunicationFromText });
  // P1 修复（t87）：UserRequirement 是共享库表，工具装配用装配期共享库 prisma（不经 getClient，
  // 否则 databaseRouter 会路由到隔离教师库 → 教师未注册在隔离库 TeacherRegistry → FK 违反）
  // P15 t2：透传可选 moderation + 审计 logger（与 service 同款；未配置零影响）
  registerRequirementTools(registry, prisma, { moderation: options.moderation, logger: options.logger });

  return options.localSafeMode ? createLocalSafeToolRegistry(registry) : registry;
}
