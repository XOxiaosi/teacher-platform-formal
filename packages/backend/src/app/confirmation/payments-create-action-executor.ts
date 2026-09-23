import type { Prisma } from '@prisma/client';
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
import { createChangelogService } from '../../shared/changelog/index.js';
import { createDatabaseTrustedClock, type TrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  encryptFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import { parseRfc3339Instant } from '../../features/feedback/rfc3339-instant.js';
import type {
  ConfirmableActionExecutionResult,
  ConfirmableActionExecutor,
  ConfirmableActionExecutorInput,
} from './types.js';

export interface CreatePaymentsCreateActionExecutorOptions {
  /** 确认事务内的 raw TransactionClient（raw tx 不经旧自动 changelog extension，避免双审计）。 */
  tx: Prisma.TransactionClient;
  /** TrustedClock（缺省 createDatabaseTrustedClock(tx)；测试可注入替身）。 */
  trustedClock?: TrustedClock;
  /** 字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
}

interface ParsedPaymentsCreateParameters {
  studentId: string;
  amount: number;
  lessonCount: number;
  paidAt: Date;
  note: string | undefined;
  expectedUpdatedAt: Date;
}

const ALLOWED_PARAMETER_KEYS = new Set([
  'studentId',
  'amount',
  'lessonCount',
  'paidAt',
  'note',
  'expectedUpdatedAt',
]);

function invalidParameters(message: string) {
  return err(validationError(message, 'parameters'));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 复检 PendingAction 的 target/parameters：
 * - target 固定 Student，parameters 仅 {studentId, amount, lessonCount, paidAt, note?, expectedUpdatedAt}
 * - studentId 必须等于 target.id；amount 正数；lessonCount 正整数；paidAt 严格 RFC3339
 * - expectedUpdatedAt 必须是 RFC3339（学生 updatedAt 版本快照）
 */
function parseParameters(
  input: ConfirmableActionExecutorInput,
): Result<ParsedPaymentsCreateParameters, CommonError> {
  if (input.target.type !== 'Student' || !isPlainObject(input.parameters)) {
    return invalidParameters('待确认操作 target 或 parameters 不合法');
  }
  const keys = Object.keys(input.parameters);
  if (keys.length < 5 || keys.some((key) => !ALLOWED_PARAMETER_KEYS.has(key))) {
    return invalidParameters('待确认操作 parameters 结构不合法');
  }
  const { studentId, amount, lessonCount, paidAt, note, expectedUpdatedAt } = input.parameters;
  if (typeof studentId !== 'string' || studentId === '' || studentId !== input.target.id) {
    return invalidParameters('待确认操作 target 与 parameters 不一致');
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return invalidParameters('待确认操作 amount 不合法');
  }
  if (typeof lessonCount !== 'number' || !Number.isInteger(lessonCount) || lessonCount <= 0) {
    return invalidParameters('待确认操作 lessonCount 不合法');
  }
  const paidAtInstant = parseRfc3339Instant(paidAt);
  if (paidAtInstant === undefined) {
    return invalidParameters('待确认操作 paidAt 不合法');
  }
  if (note !== undefined && typeof note !== 'string') {
    return invalidParameters('待确认操作 note 不合法');
  }
  if (typeof expectedUpdatedAt !== 'string' || expectedUpdatedAt === '') {
    return invalidParameters('待确认操作 expectedUpdatedAt 缺失');
  }
  const expectedInstant = parseRfc3339Instant(expectedUpdatedAt);
  if (expectedInstant === undefined) {
    return invalidParameters('待确认操作 expectedUpdatedAt 不合法');
  }
  return ok({
    studentId,
    amount,
    lessonCount,
    paidAt: paidAtInstant,
    note,
    expectedUpdatedAt: expectedInstant,
  });
}

export function createPaymentsCreateActionExecutor(
  options: CreatePaymentsCreateActionExecutorOptions,
): ConfirmableActionExecutor {
  const { tx } = options;
  const cipher = options.cipher ?? createFieldCipherFromEnv();
  const trustedClock = options.trustedClock ?? createDatabaseTrustedClock(tx);
  const changelog = createChangelogService(tx, cipher);

  return {
    async execute(input) {
      if (typeof input.pendingActionId !== 'string' || !input.pendingActionId.trim()) {
        return err(validationError('待确认操作 ID 缺失', 'pendingActionId'));
      }
      const parsed = parseParameters(input);
      if (!parsed.ok) return parsed;
      const { studentId, amount, lessonCount, paidAt, note, expectedUpdatedAt } = parsed.value;

      // 教师归属复检：只读当前 teacher 的学生；跨 teacher 与不存在统一 NOT_FOUND，不建 Payment。
      const student = await tx.student.findFirst({
        where: { id: studentId, teacherId: input.teacherId },
        select: { id: true, updatedAtTs: true },
      });
      if (!student) return err(notFound('学生不存在'));

      // expectedUpdatedAt CAS：与当前学生版本不一致 → 版本冲突，不创建 Payment。
      if (expectedUpdatedAt.getTime() !== student.updatedAtTs.getTime()) {
        return err(versionConflict());
      }

      const nowResult = await trustedClock.now();
      if (!nowResult.ok) return nowResult;
      const now = nowResult.value;
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      // 同事务 raw create（不经旧自动 changelog extension，避免双审计）；成功后才写唯一一条
      // 显式 agent-confirmed 审计。DB 异常直接抛出，由 ConfirmationTransactionPort 收敛为固定
      // sentinel 并整体回滚（不在此拼接底层细节，避免泄漏）。
      const payment = await tx.payment.create({
        data: {
          teacherId: input.teacherId,
          clientRequestId: `agent-confirmed:${input.pendingActionId.trim()}`,
          studentId,
          amount,
          lessonCount,
          paidAtTs: paidAt,
          note: note === undefined ? null : encryptFieldValue(cipher, note),
          createdAtTs: now,
          updatedAtTs: now,
        },
      });

      // T-017：确认后的购课同时落不可变课时流水；余额不再依赖可编辑 Payment 字段。
      const ledgerEntry = await tx.lessonLedgerEntry.create({
        data: {
          teacherId: input.teacherId,
          studentId,
          entryType: 'purchase',
          lessonDelta: lessonCount,
          amount,
          paymentId: payment.id,
          createdAtTs: now,
        },
      });

      const audit = await changelog.recordChange({
        teacherId: input.teacherId,
        module: 'payments',
        action: 'create',
        targetType: 'Payment',
        targetId: payment.id,
        before: null,
        after: {
          studentId,
          amount,
          lessonCount,
          paidAt: paidAt.toISOString(),
          ...(note !== undefined && { note: '[已加密存储]' }),
        },
        source: 'agent-confirmed',
      });
      if (!audit.ok) return err(internalError('变更记录写入失败'));

      const ledgerAudit = await changelog.recordChange({
        teacherId: input.teacherId,
        module: 'payments',
        action: 'create',
        targetType: 'LessonLedgerEntry',
        targetId: ledgerEntry.id,
        before: null,
        after: { studentId, entryType: 'purchase', lessonDelta: lessonCount, paymentId: payment.id },
        // The teacher confirmed the Payment action; this is the deterministic
        // ledger side effect, not a second independently-confirmed operation.
        source: 'system',
      });
      if (!ledgerAudit.ok) return err(internalError('变更记录写入失败'));

      return ok<ConfirmableActionExecutionResult>({
        summary: `已为学生创建缴费记录：金额 ${amount} 元、课时 ${lessonCount} 节`,
        references: [{ type: 'Payment', id: payment.id }],
      });
    },
  };
}
