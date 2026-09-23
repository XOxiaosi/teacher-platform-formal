import type { RequestHandler, Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { DatabaseClientPool } from '../../shared/database-pool/index.js';
import type { Logger } from '../../shared/logger/index.js';
import type { StudentService } from '../../features/students/types.js';
import type {
  StudentRecordsService,
  StudentSourceRecordService,
} from '../../features/student-records/types.js';
import type { AssessmentService } from '../../features/assessments/types.js';
import type { StudentTimelineService } from '../../features/student-timeline/types.js';
import type { ScheduleService } from '../../features/scheduling/types.js';
import type { LessonLedgerService, PaymentService } from '../../features/payments/types.js';
import type { ConversationService } from '../../features/conversation/types.js';
import type { AgentExecutionService } from '../../features/agent-execution/types.js';
import type { TeachingTaskService } from '../../features/teaching-tasks/index.js';
import type {
  ActionTokenSigner,
  PendingActionService,
} from '../../features/pending-action/types.js';
import type { TrustedClock } from '../../shared/trusted-clock/types.js';
import type { FeedbackDraftTaskService, FeedbackService } from '../../features/feedback/types.js';
import type { RequirementService } from '../../features/requirements/index.js';
import type { ProviderConfigService } from '../../features/provider-configs/index.js';
import type { ProviderUsageService } from '../../features/provider-usage/index.js';
import type { ProviderRouterImpl } from '../../shared/ai-client/provider-router.js';
import type { AuthService } from '../../features/auth/index.js';
import type { PrivacyRouterOptions } from '../routes/privacy.routes.js';
import type { AgentConverseUseCase } from '../use-cases/agent-converse/types.js';
import type { BalanceCalcUseCase } from '../use-cases/balance-calc/types.js';
import type { StudentProfileUseCase } from '../use-cases/student-profile/types.js';
import type { CreatePlannedScheduleUseCase } from '../use-cases/create-planned-schedule/types.js';
import type { ScheduleCompleteUseCase } from '../use-cases/schedule-complete/types.js';
import type { DailyReviewAssembleUseCase } from '../use-cases/daily-review-assemble/types.js';
import type { SaveRawInputUseCase } from '../use-cases/save-raw-input/types.js';
import type { ConfirmPendingActionUseCase } from '../use-cases/confirm-pending-action/types.js';
import type { CancelPendingActionUseCase } from '../use-cases/cancel-pending-action/types.js';
import type { AgendaQueryPort } from '../agenda/types.js';
import type { UpdateStudentProfileUseCase } from '../use-cases/update-student-profile/types.js';
import type { RescheduleLessonUseCase } from '../use-cases/reschedule-lesson/types.js';
import type { UpdateLessonRecordUseCase } from '../use-cases/update-lesson-record/types.js';
import type { UpdatePaymentUseCase } from '../use-cases/update-payment/types.js';
import type { UpdateMemoUseCase } from '../use-cases/update-memo/types.js';
import type { UpdateParentFeedbackContentUseCase } from '../use-cases/update-parent-feedback-content/types.js';
import type { LessonStatusFixUseCase } from '../use-cases/lesson-status-fix/types.js';
import type { GenerateFeedbackDraftUseCase } from '../use-cases/generate-feedback-draft/types.js';
import type { CaptureService } from '../../features/capture/index.js';
import type { SchedulingWebService } from '../../features/scheduling-web/index.js';
import type { TeachingTaskRuntimeWorker } from '../teaching-runtime/teaching-task-runtime-worker.js';

export interface CoreRouterOptions {
  agentConverse?: AgentConverseUseCase;
  trustedClock?: TrustedClock;
  rawPrisma?: PrismaClient;
  confirmation?: {
    rawPrisma: PrismaClient;
    actionTokenSigner: ActionTokenSigner;
  };
  /** S3：业务路由组前置的数据库路由中间件（requireAuth 之后运行）；缺省不挂载（单库行为） */
  dbRouter?: RequestHandler;
  /** S3：连接池（与 dbRouter 同配）；响应完成后释放请求占用的 client（activeCount 归零） */
  dbPool?: DatabaseClientPool;
  /** L4 装配（t77/t91）：认证服务——provider-configs/usage 路由内部 requireAuth 使用 */
  authService?: AuthService;
  /** P14 D 切片：审计 logger（moderation flag 等结构化日志；缺省 undefined → composition 内部回退 createLogger） */
  logger?: Logger;
  /** P8 隐私自助化（t29）：导出/注销 API 路由选项（缺省不挂载） */
  privacy?: PrivacyRouterOptions;
  /** P8 t20：预构建的核心依赖（index.ts 装配线传入，供 wechat 等共享同一组合；缺省内部构建） */
  dependencies?: CoreRouteDependencies;
  /** L0 本地安全模式：生产核心装配默认 true；只有显式 false 才允许直写工具/外部平台服务。 */
  localSafeMode?: boolean;
  /** 仅兼容旧专项测试；正式装配默认不暴露旧 AI 输入路由。 */
  legacyAiInputRoutesEnabled?: boolean;
  /** 仅兼容旧专项测试；正式装配默认不暴露旧媒体/OCR/ASR 路由。 */
  legacyMediaRoutesEnabled?: boolean;
  /** 仅兼容旧缴费编辑专项测试；正式装配默认关闭，避免绕过不可变课时账本。 */
  legacyPaymentEditEnabled?: boolean;
  /** Optional real DSH worker; omitted keeps the teaching runtime unavailable. */
  teachingRuntimeWorker?: TeachingTaskRuntimeWorker;
}

export interface StudentRouteDependencies {
  students: Pick<StudentService, 'listStudents' | 'createStudent'>;
  studentProfile: StudentProfileUseCase;
  balanceCalc: BalanceCalcUseCase;
}

export interface StudentRecordsRouteDependencies {
  records: StudentRecordsService;
  sources: StudentSourceRecordService;
  assessments: AssessmentService;
  timeline: StudentTimelineService;
  captureScoreFromText: import('../use-cases/capture-score-from-text/types.js').CaptureScoreFromTextUseCase;
  communications: import('../../features/student-communications/types.js').CommunicationService;
  captureCommunicationFromText: import('../use-cases/capture-communication-from-text/types.js').CaptureCommunicationFromTextUseCase;
}

export interface ScheduleRouteDependencies {
  schedules: Pick<ScheduleService, 'listSchedules' | 'cancelSchedule' | 'restoreSchedule'>;
  plannedSchedules: CreatePlannedScheduleUseCase;
  scheduleComplete: ScheduleCompleteUseCase;
}

export interface SchedulingWebRouteDependencies {
  schedulingWeb: SchedulingWebService;
}

export interface PaymentRouteDependencies {
  payments: Pick<PaymentService, 'listPayments' | 'createPayment'>;
  ledger: Pick<LessonLedgerService, 'prepareAdjustment' | 'confirmAdjustment' | 'listEntries'>;
  lessonStatusCorrections: Pick<LessonStatusFixUseCase, 'prepareLessonStatusCorrection' | 'confirmLessonStatusCorrection'>;
}

export interface DailyReviewRouteDependencies {
  dailyReview: DailyReviewAssembleUseCase;
}

export interface AiInputRouteDependencies {
  saveRawInput: SaveRawInputUseCase;
}

export interface CaptureRouteDependencies {
  capture: CaptureService;
}

export interface AgentRouteDependencies {
  agentConverse: AgentConverseUseCase;
  agentExecutions: Pick<AgentExecutionService, 'get' | 'prepareReplay'>;
}

export interface ConversationRouteDependencies {
  conversations: ConversationService;
  pendingActions?: Pick<PendingActionService, 'listForConversationToolCalls'>;
}

export interface PendingActionDependencies {
  pendingActions: PendingActionService;
  confirmPendingAction: ConfirmPendingActionUseCase;
  cancelPendingAction: CancelPendingActionUseCase;
}

export interface AgendaRouteDependencies {
  agenda: AgendaQueryPort;
}

export interface EditRouteDependencies {
  updateStudentProfile: UpdateStudentProfileUseCase;
  rescheduleLesson: RescheduleLessonUseCase;
  updateLessonRecord: UpdateLessonRecordUseCase;
  updatePayment: UpdatePaymentUseCase;
  updateMemo: UpdateMemoUseCase;
  updateParentFeedbackContent: UpdateParentFeedbackContentUseCase;
}

export interface FeedbackGenerateRouteDependencies {
  generateFeedbackDraft: GenerateFeedbackDraftUseCase;
  feedbackService: FeedbackService;
  feedbackDraftTasks: FeedbackDraftTaskService;
}

export interface RequirementRouteDependencies {
  requirements: RequirementService;
}

export interface MediaRouteDependencies {
  media: import('../../features/media/index.js').MediaAssetService;
  /** 媒体孤儿回收器（阶段二 t3）：定时任务可直接调 runOnce()；缺省未注入时 undefined。 */
  orphanReaper?: import('../../features/media/index.js').MediaOrphanReaper;
}

export interface ProviderRouteDependencies {
  /** routing AiClient 的 ProviderConfig 解析器（L4 t77 装配） */
  providerRouter: ProviderRouterImpl;
  /** ProviderUsage 聚合服务（共享库表，装配期共享库 prisma） */
  providerUsageService: ProviderUsageService;
}

/** 配置管理可在本机安全模式下存在；绝不代表 runtime 已启用。 */
export interface ProviderConfigRouteDependencies {
  providerConfigService: ProviderConfigService;
}

export interface CoreRouteDependencies {
  teachingTasks?: TeachingTaskService;
  teachingRuntimeWorker?: TeachingTaskRuntimeWorker;
  agenda: AgendaRouteDependencies;
  edits?: EditRouteDependencies;
  conversations: ConversationRouteDependencies;
  pendingActions?: PendingActionDependencies;
  students: StudentRouteDependencies;
  studentRecords: StudentRecordsRouteDependencies;
  schedules: ScheduleRouteDependencies;
  schedulingWeb: SchedulingWebRouteDependencies;
  /** Prebuilt with the composition's request-scoped client provider. */
  workspaceWeb?: Router;
  payments: PaymentRouteDependencies;
  dailyReview: DailyReviewRouteDependencies;
  aiInput: AiInputRouteDependencies;
  capture: CaptureRouteDependencies;
  agent: AgentRouteDependencies;
  feedback: FeedbackGenerateRouteDependencies;
  requirements: RequirementRouteDependencies;
  media?: MediaRouteDependencies;
  providerConfig?: ProviderConfigRouteDependencies;
  provider?: ProviderRouteDependencies;
}
