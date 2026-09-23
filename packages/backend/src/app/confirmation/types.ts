import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type {
  ConfirmableActionName,
  PendingActionData,
  PendingActionExecutionStore,
  PendingActionService,
  PendingActionTargetType,
} from '../../features/pending-action/index.js';
import type { ScheduleService } from '../../features/scheduling/index.js';
import type { LessonService } from '../../features/lessons/index.js';
import type { StudentService } from '../../features/students/index.js';
import type { PaymentData } from '../../features/payments/index.js';
import type { MemoData } from '../../features/memos/index.js';
import type { ParentFeedbackData } from '../../features/feedback/index.js';
import type { StudentData } from '../../features/students/index.js';
import type { ScheduleData } from '../../features/scheduling/index.js';
import type { LessonData } from '../../features/lessons/index.js';

export interface ConfirmationObjectReference {
  // P29-W1（第三最小切片）：创建型确认结果可引用新创建实体（StudentRecord /
  // StudentSourceRecord）。PendingAction 自身 target 仍限于 PendingActionTargetType
  // （运行时 TARGET_TYPES 不变），此扩展仅覆盖确认结果 references 的类型契约。
  type: PendingActionTargetType | 'StudentRecord' | 'StudentSourceRecord';
  id: string;
}

export interface ConfirmableActionExecutionResult {
  summary: string;
  references: ConfirmationObjectReference[];
}

export interface ConfirmableActionExecutorInput {
  /** Stable identity of the claimed confirmation; write executors use it for idempotency. */
  pendingActionId: string;
  teacherId: string;
  target: {
    type: PendingActionTargetType;
    id: string;
  };
  parameters: unknown;
}

export interface ConfirmableActionExecutor {
  execute(input: ConfirmableActionExecutorInput): Promise<Result<ConfirmableActionExecutionResult, CommonError>>;
}

export type ConfirmableActionExecutorMap = Readonly<Record<ConfirmableActionName, ConfirmableActionExecutor>>;

export interface ConfirmableActionRegistry {
  get(actionName: string): Result<ConfirmableActionExecutor, CommonError>;
}

/**
 * payments.create 是唯一会把确认成功回执投影为新 Payment 的确认动作。
 * PendingAction 只存状态，回执丢失后的同 token 重放须由事务内的稳定支付请求键重建，
 * 不能重新执行写入 executor。
 */
export interface PaymentConfirmationReceiptStore {
  findPaymentCreateReceipt(input: {
    teacherId: string;
    pendingActionId: string;
  }): Promise<ConfirmableActionExecutionResult | null>;
}

export interface ConfirmationTransactionContext {
  pendingActions: PendingActionExecutionStore;
  registry: ConfirmableActionRegistry;
  paymentReceipts: PaymentConfirmationReceiptStore;
}

export interface ConfirmationTransactionPort {
  run<T>(
    work: (context: ConfirmationTransactionContext) => Promise<Result<T, CommonError>>,
  ): Promise<Result<T, CommonError>>;
}

export type ConfirmationRegistryFactory = (
  tx: Prisma.TransactionClient,
) => ConfirmableActionRegistry;

export interface CreateConfirmationTransactionPortOptions {
  rawPrisma: PrismaClient;
  registryFactory?: ConfirmationRegistryFactory;
}

export interface ConfirmPendingActionInput {
  teacherId: string;
  pendingActionId: string;
  actionToken: string;
}

export interface ConfirmPendingActionResult {
  pendingAction: PendingActionData;
  result: ConfirmableActionExecutionResult;
}

export interface CancelPendingActionInput {
  teacherId: string;
  pendingActionId: string;
}

export interface CancelPendingActionResult {
  pendingAction: PendingActionData;
}

export interface RequestConfirmationInput {
  teacherId: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ConfirmationGatewayOutput {
  status: 'pending_confirmation';
  pendingActionId: string;
  summary: string;
}

export interface ConfirmationGateway {
  requestConfirmation(
    input: RequestConfirmationInput,
  ): Promise<Result<ConfirmationGatewayOutput, CommonError>>;
}

export interface EditConfirmationOwnerPorts {
  studentProfiles: {
    getOwnedStudentProfile(input: { teacherId: string; studentId: string }): Promise<Result<StudentData, CommonError>>;
  };
  scheduleReschedules: {
    getOwnedSchedule(input: { teacherId: string; scheduleId: string }): Promise<Result<ScheduleData, CommonError>>;
  };
  lessonRecords: {
    getOwnedLesson(input: { teacherId: string; lessonId: string }): Promise<Result<LessonData, CommonError>>;
  };
  payments: {
    getOwnedPayment(input: { teacherId: string; paymentId: string }): Promise<Result<PaymentData, CommonError>>;
  };
  memos: {
    getOwnedMemo(input: { teacherId: string; memoId: string }): Promise<Result<MemoData, CommonError>>;
  };
  feedback: {
    getOwnedFeedback(input: { teacherId: string; feedbackId: string }): Promise<Result<ParentFeedbackData, CommonError>>;
  };
}

export interface CreateConfirmationGatewayOptions {
  pendingActions: Pick<PendingActionService, 'createPendingAction'>;
  schedules: Pick<ScheduleService, 'getSchedule'>;
  /** 保留旧装配兼容；P3-15 起状态更正不再通过该网关执行。 */
  lessons?: Pick<LessonService, 'getLesson'>;
  students: Pick<StudentService, 'getStudent'>;
  editOwners: EditConfirmationOwnerPorts;
}
