import type { PrismaClient } from '@prisma/client';
import { createStudentService } from '../../features/students/index.js';
import {
  createStudentRecordsService,
  createStudentSourceRecordService,
} from '../../features/student-records/index.js';
import { createAssessmentService } from '../../features/assessments/index.js';
import { createStudentTimelineService } from '../../features/student-timeline/index.js';
import { createScheduleService } from '../../features/scheduling/index.js';
import { createLessonService } from '../../features/lessons/index.js';
import { createPaymentService } from '../../features/payments/index.js';
import { createAiNoteService } from '../../features/ai-notes/index.js';
import { createConversationService } from '../../features/conversation/index.js';
import { createAgentExecutionService } from '../../features/agent-execution/index.js';
import { createTeachingTaskService } from '../../features/teaching-tasks/index.js';
import { createMemoService } from '../../features/memos/index.js';
import { createFeedbackService } from '../../features/feedback/index.js';
import {
  createPendingActionAgendaReader,
  createPendingActionService,
} from '../../features/pending-action/index.js';
import {
  createAiClient,
  createRoutingAiClient,
  createProviderConfigRouter,
  createArkAiProviderFromEnv,
  createFailClosedAiProvider,
} from '../../shared/ai-client/index.js';
import type { ProviderConfigRow } from '../../shared/ai-client/provider-router.js';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import { createClientProvider } from '../../shared/database-pool/index.js';
import { createBudgetTracker, budgetConfigFromEnv } from '../../shared/agent-cost/index.js';
import { createLogger } from '../../shared/logger/index.js';
import { createAppStorage } from '../../shared/storage/index.js';
import { createJobStore } from '../../shared/background-jobs/index.js';
import { createPlatformServices } from '../../shared/platform-services/index.js';
import { createBalanceCalcUseCase } from '../use-cases/balance-calc/index.js';
import { createStudentProfileUseCase } from '../use-cases/student-profile/index.js';
import { createPlannedScheduleUseCase } from '../use-cases/create-planned-schedule/index.js';
import { createScheduleCompleteUseCase } from '../use-cases/schedule-complete/index.js';
import { createDailyReviewAssembleUseCase } from '../use-cases/daily-review-assemble/index.js';
import { createSaveRawInputUseCase } from '../use-cases/save-raw-input/index.js';
import { createAgentConverseUseCase } from '../use-cases/agent-converse/index.js';
import { createConfirmPendingActionUseCase } from '../use-cases/confirm-pending-action/index.js';
import { createCancelPendingActionUseCase } from '../use-cases/cancel-pending-action/index.js';
import { createUpdateStudentProfileUseCase } from '../use-cases/update-student-profile/index.js';
import { createRescheduleLessonUseCase } from '../use-cases/reschedule-lesson/index.js';
import { createUpdateLessonRecordUseCase } from '../use-cases/update-lesson-record/index.js';
import { createUpdatePaymentUseCase } from '../use-cases/update-payment/index.js';
import { createUpdateMemoUseCase } from '../use-cases/update-memo/index.js';
import { createUpdateParentFeedbackContentUseCase } from '../use-cases/update-parent-feedback-content/index.js';
import { createGenerateFeedbackDraftUseCase } from '../use-cases/generate-feedback-draft/index.js';
import { createAssembleParentFeedbackContextUseCase } from '../use-cases/assemble-parent-feedback-context/index.js';
import { createCaptureScoreFromTextUseCase } from '../use-cases/capture-score-from-text/index.js';
import { createCommunicationService } from '../../features/student-communications/index.js';
import { createRequirementService } from '../../features/requirements/index.js';
import { createProviderConfigService } from '../../features/provider-configs/index.js';
import { createProviderUsageService } from '../../features/provider-usage/index.js';
import { createMediaAssetService } from '../../features/media/index.js';
import {
  createMediaFileCipherFromEnv,
  createMediaOrphanReaper,
} from '../../features/media/index.js';
import { createCaptureCommunicationFromTextUseCase } from '../use-cases/capture-communication-from-text/index.js';
import { createFieldCipherFromEnv } from '../../shared/field-encryption/index.js';
import {
  createExecutionRunners,
  DEFAULT_MODEL_TIMEOUT_MS,
  DEFAULT_READ_TOOL_TIMEOUT_MS,
} from '../reliability/execution-runners.js';
import {
  createConfirmationGateway,
  createConfirmationTransactionPort,
  createDatabaseConfirmableActionRegistry,
} from '../confirmation/index.js';
import { createMinimalToolRegistry } from '../tool-registration.js';
import { createPresentationBuilder } from '../presentation/index.js';
import { createAgendaQuery } from '../agenda/index.js';
import type {
  CoreRouteDependencies,
  CoreRouterOptions,
  EditRouteDependencies,
  PendingActionDependencies,
} from './types.js';

/** local-safe 复用 platform-services 的默认关闭分支，不向供应商工厂透传真实 env。 */
export function createPlatformServicesForMode(
  localSafeMode: boolean,
  env: NodeJS.ProcessEnv = process.env,
) {
  return createPlatformServices(localSafeMode ? {} : env);
}

/** local-safe 丢弃所有 storage env，复用 createAppStorage 的受控本地默认值。 */
export function createAppStorageForMode(
  localSafeMode: boolean,
  env: NodeJS.ProcessEnv = process.env,
  rootDir = '.data',
) {
  return createAppStorage(localSafeMode ? {} : env, rootDir);
}

export function createCoreRouteDependencies(
  prisma: PrismaClient,
  options?: CoreRouterOptions,
): CoreRouteDependencies {
  const localSafeMode = options?.localSafeMode !== false;
  const defaultAiProvider = localSafeMode
    ? createFailClosedAiProvider()
    : createArkAiProviderFromEnv();
  // S2/S3：业务服务使用请求期 getClient（databaseRouter 注入），单库回退装配期 client
  const clientProvider = createClientProvider(prisma);
  // P8 phase-3 批1：字段加密 cipher 统一装配（ENCRYPTION_KEY env；未配置 → undefined 惰性 SAFETY_BLOCK）
  const fieldCipher = createFieldCipherFromEnv();
  // Persist messages independently; no HTTP/environment flag enables a test executor.
  const teachingTasks = createTeachingTaskService({ prisma, getClient: clientProvider.getClient, cipher: fieldCipher });
  const students = createStudentService({ getClient: clientProvider.getClient });
  const studentRecords = createStudentRecordsService({ getClient: clientProvider.getClient, cipher: fieldCipher });
  const studentSources = createStudentSourceRecordService({ getClient: clientProvider.getClient, cipher: fieldCipher });
  const assessments = createAssessmentService({ getClient: clientProvider.getClient, cipher: fieldCipher });
  const studentTimeline = createStudentTimelineService({ getClient: clientProvider.getClient, cipher: fieldCipher });
  const schedules = createScheduleService({ getClient: clientProvider.getClient });
  const memos = createMemoService({ prisma, getClient: clientProvider.getClient, cipher: fieldCipher });
  const agendaPendingActions = createPendingActionAgendaReader({ getClient: clientProvider.getClient });
  const trustedClock = options?.trustedClock ?? createDatabaseTrustedClock(prisma);
  const agenda = createAgendaQuery({
    schedules,
    memos,
    pendingActions: agendaPendingActions,
    students,
    trustedClock,
  });
  const plannedSchedules = createPlannedScheduleUseCase({ scheduling: schedules, trustedClock });
  const payments = createPaymentService({ getClient: clientProvider.getClient, cipher: fieldCipher });
  const scheduleComplete = createScheduleCompleteUseCase({ getClient: clientProvider.getClient });
  const balanceCalc = createBalanceCalcUseCase({ getClient: clientProvider.getClient });
  const studentProfile = createStudentProfileUseCase({ getClient: clientProvider.getClient });
  const dailyReview = createDailyReviewAssembleUseCase({
    prisma,
    trustedClock,
    getClient: clientProvider.getClient,
    cipher: fieldCipher,
  });
  // Local-safe mode deliberately omits provider resolution and provider
  // management services, leaving stored credentials outside the reachable graph.
  const providerRouter = localSafeMode ? undefined : createProviderConfigRouter({
    loadConfigs: async (teacherId: string): Promise<ProviderConfigRow[]> => {
      const rows = await prisma.providerConfig.findMany({
        where: { teacherId, status: 'active' },
        orderBy: { createdAtTs: 'desc' },
        select: {
          id: true,
          providerKind: true,
          providerName: true,
          baseUrl: true,
          apiKeyEnc: true,
          model: true,
          isPrimary: true,
          status: true,
        },
      });
      return rows as unknown as ProviderConfigRow[];
    },
  });
  const providerUsageService = localSafeMode ? undefined : createProviderUsageService({ prisma });
  const usageLogger = options?.logger ?? createLogger();
  const aiClient = localSafeMode
    ? createAiClient({ provider: defaultAiProvider })
    : createRoutingAiClient({
      defaultProvider: defaultAiProvider,
      resolver: providerRouter!,
      onUsage: (input) => {
        void providerUsageService!.record(input).catch((error: unknown) => {
          usageLogger.warn('provider usage record failed', {
            error: error instanceof Error ? error.message : String(error),
            teacherId: input.teacherId,
          });
        });
      },
    });
  const providerConfigService = localSafeMode ? undefined : createProviderConfigService({ prisma });
  const assembleParentFeedbackContext = createAssembleParentFeedbackContextUseCase({ prisma, getClient: clientProvider.getClient, cipher: fieldCipher });
  const generateFeedbackDraft = createGenerateFeedbackDraftUseCase({ prisma, aiClient, context: assembleParentFeedbackContext, getClient: clientProvider.getClient });
  const captureScoreFromText = createCaptureScoreFromTextUseCase({ prisma, aiClient, assessments, getClient: clientProvider.getClient });
  const platformServices = createPlatformServicesForMode(localSafeMode);
  const communicationModeration = platformServices.moderation?.provider === 'local'
    ? platformServices.moderation
    : undefined;
  const communications = createCommunicationService({
    getClient: clientProvider.getClient,
    cipher: fieldCipher,
    ...(communicationModeration
      ? { moderation: communicationModeration, logger: options?.logger ?? createLogger() }
      : {}),
    auditSource: 'manual',
  });
  const captureCommunicationFromText = createCaptureCommunicationFromTextUseCase({ prisma, aiClient, communications, getClient: clientProvider.getClient });
  // P11 t2（对象存储）：存储装配走 StorageBackend 抽象——STORAGE_BACKEND=local（缺省，零破坏）| s3
  // （S3 模式下媒体原文件/导出/归档对象入桶，fileRef 即对象 key；见 shared/storage createAppStorage）
  const storage = createAppStorageForMode(localSafeMode);
  const aiNotes = createAiNoteService({ prisma, aiClient, storage, getClient: clientProvider.getClient, cipher: fieldCipher });
  // P8 S3 媒体证据链（t8）+ P9 阶段二（t3/t6）：媒体资产服务——教师库表（MediaAsset，走 getClient 路由）
  // + 通用存储（rootDir .data，exactRef=media/<teacherId>/<assetId>/original）+ 证据捕获链注入（幂等）
  // + 文件级加密（MEDIA_ENCRYPTION_KEY 独立 env；未配置 → 上传写路径 SAFETY_BLOCK 拒绝明文落盘）
  // + 异步转写作业存储（t6：内存 job 表，owner 隔离；真实 ASR 阶段三 platform-services 预配线）。
  const mediaCipher = createMediaFileCipherFromEnv();
  const mediaJobs = createJobStore({ jobIdPrefix: 'transc_' });
  // P10 t6（平台预配线 A1）：平台预配服务门面（env 级装配，不进教师配置）——
  // 未启用 → {}（asr 缺省，媒体服务占位降级，基线零破坏）；真实 ASR 供应商待用户确认后启用
  const media = createMediaAssetService({
    getClient: clientProvider.getClient,
    storage,
    sources: studentSources,
    mediaCipher,
    jobs: mediaJobs,
    platformServices,
  });
  // P9 阶段二（t3）：孤儿回收器（引用保护 + 保留期清理；定时任务由调度线接线，默认 30 天保留期）
  const mediaOrphanReaper = createMediaOrphanReaper({
    getClient: clientProvider.getClient,
    storage,
    trustedClock,
  });
  const saveRawInput = createSaveRawInputUseCase({ aiNotes });
  const conversations = createConversationService({ prisma, getClient: clientProvider.getClient, cipher: fieldCipher });
  const agentExecutions = createAgentExecutionService({ prisma, getClient: clientProvider.getClient, cipher: fieldCipher });
  // P1 修复（t87）：UserRequirement 是共享库表（与 TeacherRegistry/SessionStore 同库），
  // 装配必须直传共享库 prisma（禁止 getClient 形态——否则 databaseRouter 解析到隔离教师库，
  // 教师未注册在隔离库 TeacherRegistry → FK 违反 500；R8 gate 强制，qa3 t82 实测）
  // P14 D 切片（moderation 接线）：composition 注入可选 moderation adapter——
  // createPlatformServices(env).moderation（未配置 = undefined → service 零影响跳过）+ 审计 logger
  const requirements = createRequirementService({
    prisma,
    moderation: platformServices.moderation,
    logger: options?.logger ?? createLogger(),
  });
  const editClientProvider = options?.rawPrisma
    ? createClientProvider(options.rawPrisma)
    : undefined;
  const edits: EditRouteDependencies | undefined = options?.rawPrisma && editClientProvider
    ? {
      updateStudentProfile: {
        async updateStudentProfile(command) {
          const rawPrisma = await editClientProvider.getClient();
          return createUpdateStudentProfileUseCase({ rawPrisma }).updateStudentProfile(command);
        },
      },
      rescheduleLesson: {
        async rescheduleLesson(command) {
          const rawPrisma = await editClientProvider.getClient();
          return createRescheduleLessonUseCase({ rawPrisma }).rescheduleLesson(command);
        },
      },
      updateLessonRecord: {
        async updateLessonRecord(command) {
          const rawPrisma = await editClientProvider.getClient();
          return createUpdateLessonRecordUseCase({ rawPrisma, cipher: fieldCipher }).updateLessonRecord(command);
        },
      },
      updatePayment: {
        async updatePayment(command) {
          const rawPrisma = await editClientProvider.getClient();
          return createUpdatePaymentUseCase({ rawPrisma, cipher: fieldCipher }).updatePayment(command);
        },
      },
      updateMemo: {
        async updateMemo(command) {
          const rawPrisma = await editClientProvider.getClient();
          return createUpdateMemoUseCase({ rawPrisma, cipher: fieldCipher }).updateMemo(command);
        },
      },
      updateParentFeedbackContent: {
        async updateParentFeedbackContent(command) {
          const rawPrisma = await editClientProvider.getClient();
          return createUpdateParentFeedbackContentUseCase({
            rawPrisma,
            cipher: fieldCipher,
          }).updateParentFeedbackContent(command);
        },
      },
    }
    : undefined;

  let pendingActionDependencies: PendingActionDependencies | undefined;
  let confirmationGateway;

  if (options?.confirmation) {
    // P29-W1：确认 registry 显式注入 feedback.updateStatus / payments.create executor 所需的
    // cipher/moderation/logger（与 feedback service 路径同款装配；moderation 仅 local 生效）。
    const transaction = createConfirmationTransactionPort({
      rawPrisma: options.confirmation.rawPrisma,
      registryFactory: (tx) => createDatabaseConfirmableActionRegistry(tx, {
        cipher: fieldCipher,
        moderation: platformServices.moderation?.provider === 'local'
          ? platformServices.moderation
          : undefined,
        logger: options?.logger ?? createLogger(),
      }),
    });
    const pendingActions = createPendingActionService({
      prisma: options.confirmation.rawPrisma,
      actionTokenSigner: options.confirmation.actionTokenSigner,
      conversationOwner: {
        async getOwnedConversation(input) {
          return conversations.getConversation(input);
        },
      },
      cipher: fieldCipher,
    });
    const confirmationStudents = createStudentService(options.confirmation.rawPrisma);
    const confirmationSchedules = createScheduleService(options.confirmation.rawPrisma);
    const confirmationRawPrisma = options.confirmation.rawPrisma;
    const confirmationLessons = createLessonService({
      getClient: async () => confirmationRawPrisma,
      cipher: fieldCipher,
    });
    const confirmationPayments = createPaymentService({
      getClient: async () => confirmationRawPrisma,
      cipher: fieldCipher,
    });
    const confirmationMemos = createMemoService({ prisma: options.confirmation.rawPrisma, cipher: fieldCipher });
    const confirmationFeedback = createFeedbackService({ prisma: options.confirmation.rawPrisma, cipher: fieldCipher });
    confirmationGateway = createConfirmationGateway({
      pendingActions,
      schedules: confirmationSchedules,
      lessons: confirmationLessons,
      students: confirmationStudents,
      editOwners: {
        studentProfiles: {
          getOwnedStudentProfile: (input) => confirmationStudents.getOwnedStudent(input),
        },
        scheduleReschedules: confirmationSchedules,
        lessonRecords: confirmationLessons,
        payments: confirmationPayments,
        memos: {
          getOwnedMemo: (input) => confirmationMemos.getMemo(input),
        },
        feedback: {
          getOwnedFeedback: (input) => confirmationFeedback.getFeedback(input),
        },
      },
    });
    pendingActionDependencies = {
      pendingActions,
      confirmPendingAction: createConfirmPendingActionUseCase({
        actionTokenSigner: options.confirmation.actionTokenSigner,
        transaction,
      }),
      cancelPendingAction: createCancelPendingActionUseCase({ transaction }),
    };
  }

  const agentConverse = options?.agentConverse ?? createAgentConverseUseCase({
    conversationService: conversations,
    aiClient: localSafeMode ? createAiClient({ provider: defaultAiProvider }) : createRoutingAiClient({
      defaultProvider: defaultAiProvider,
      resolver: providerRouter!,
      // P16 P1 修复（t69 装配遗漏）：Agent 路径同款用量采集接线——chat 成功后落 ProviderUsage 行
      onUsage: (input) => {
        void providerUsageService!.record(input).catch((error: unknown) => {
          usageLogger.warn('provider usage record failed (agent)', {
            error: error instanceof Error ? error.message : String(error),
            teacherId: input.teacherId,
          });
        });
      },
    }),
    toolRegistry: createMinimalToolRegistry({
      prisma,
      trustedClock,
      getClient: clientProvider.getClient,
      ...(providerRouter ? { providerRouter } : {}),
      defaultAiProvider,
      // P15 t2（agent 工具路径 moderation 透传）：与 requirements service 同款注入——
      // createPlatformServices(env).moderation（未配置 = undefined → 工具路径零影响）+ 审计 logger
      moderation: platformServices.moderation?.provider === 'local' ? platformServices.moderation : undefined,
      logger: options?.logger ?? createLogger(),
      localSafeMode,
    }),
    confirmationGateway,
    agentExecutions,
    trustedClock,
    businessTimeZone: 'Asia/Shanghai',
    presentationBuilder: createPresentationBuilder(),
    // 成本控制（t48 装配交接）：AGENT_DAILY_TOKEN_LIMIT / AGENT_TURN_TOKEN_LIMIT env 读取
    budgetTracker: createBudgetTracker(budgetConfigFromEnv()),
    perTurnTokenLimit: budgetConfigFromEnv().perTurnTokenLimit,
    executionRunners: createExecutionRunners({
      modelTimeoutMs: DEFAULT_MODEL_TIMEOUT_MS,
      readToolTimeoutMs: DEFAULT_READ_TOOL_TIMEOUT_MS,
      log(event) {
        process.stdout.write(`${JSON.stringify({ event: 'agent_execution_step', ...event })}\n`);
      },
    }),
  });

  return {
    agenda: { agenda },
    teachingTasks,
    edits,
    conversations: {
      conversations,
      pendingActions: pendingActionDependencies?.pendingActions,
    },
    pendingActions: pendingActionDependencies,
    students: { students, studentProfile, balanceCalc },
    studentRecords: {
      records: studentRecords,
      sources: studentSources,
      assessments,
      timeline: studentTimeline,
      captureScoreFromText,
      communications,
      captureCommunicationFromText,
    },
    schedules: { schedules, plannedSchedules, scheduleComplete },
    payments: { payments },
    dailyReview: { dailyReview },
    aiInput: { saveRawInput },
    agent: { agentConverse, agentExecutions },
    feedback: {
      generateFeedbackDraft,
      feedbackService: createFeedbackService({
        prisma,
        trustedClock,
        getClient: clientProvider.getClient,
        cipher: fieldCipher,
        moderation: platformServices.moderation?.provider === 'local' ? platformServices.moderation : undefined,
        logger: options?.logger ?? createLogger(),
      }),
    },
    requirements: { requirements },
    media: { media, orphanReaper: mediaOrphanReaper },
    ...(providerRouter && providerConfigService && providerUsageService
      ? { provider: { providerRouter, providerConfigService, providerUsageService } }
      : {}),
  };
}
