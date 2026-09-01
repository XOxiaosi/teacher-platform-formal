import { createHash } from 'node:crypto';
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
import {
  CATEGORIES,
  CONFIDENCES,
  VISIBILITIES,
  IMPORTANCES,
} from '../tools/register-student-records-tools.js';
import type {
  ConfirmableActionExecutionResult,
  ConfirmableActionExecutor,
  ConfirmableActionExecutorInput,
} from './types.js';

export interface CreateRecordsCaptureActionExecutorOptions {
  /** 确认事务内的 raw TransactionClient（raw tx 不经旧自动 changelog extension，避免双审计）。 */
  tx: Prisma.TransactionClient;
  /** TrustedClock（缺省 createDatabaseTrustedClock(tx)；测试可注入替身）。 */
  trustedClock?: TrustedClock;
  /** 字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
}

interface ParsedRecordsCaptureParameters {
  studentId: string;
  category: string;
  summary: string;
  occurredAt: Date | undefined;
  sourceText: string | undefined;
  sourceEntityType: string | undefined;
  sourceEntityId: string | undefined;
  confidence: string | undefined;
  visibility: string | undefined;
  importance: string | undefined;
  expectedUpdatedAt: Date;
}

const ALLOWED_PARAMETER_KEYS = new Set([
  'studentId',
  'category',
  'summary',
  'occurredAt',
  'sourceText',
  'sourceEntityType',
  'sourceEntityId',
  'confidence',
  'visibility',
  'importance',
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

function isCategory(value: unknown): value is string {
  return typeof value === 'string' && (CATEGORIES as string[]).includes(value);
}

function isConfidence(value: unknown): value is string {
  return typeof value === 'string' && (CONFIDENCES as string[]).includes(value);
}

function isVisibility(value: unknown): value is string {
  return typeof value === 'string' && (VISIBILITIES as string[]).includes(value);
}

function isImportance(value: unknown): value is string {
  return typeof value === 'string' && (IMPORTANCES as string[]).includes(value);
}

/**
 * 复检 PendingAction 的 target/parameters：
 * - target 固定 Student，parameters 仅 {studentId, category, summary, occurredAt?,
 *   sourceText?, sourceEntityType?, sourceEntityId?, confidence?, visibility?,
 *   importance?, expectedUpdatedAt}
 * - studentId 必须等于 target.id；category/summary 必填；枚举字段合法；
 *   occurredAt/expectedUpdatedAt 必须是带时区严格 RFC3339
 */
function parseParameters(
  input: ConfirmableActionExecutorInput,
): Result<ParsedRecordsCaptureParameters, CommonError> {
  if (input.target.type !== 'Student' || !isPlainObject(input.parameters)) {
    return invalidParameters('待确认操作 target 或 parameters 不合法');
  }
  const keys = Object.keys(input.parameters);
  if (keys.length < 4 || keys.some((key) => !ALLOWED_PARAMETER_KEYS.has(key))) {
    return invalidParameters('待确认操作 parameters 结构不合法');
  }
  const {
    studentId,
    category,
    summary,
    occurredAt,
    sourceText,
    sourceEntityType,
    sourceEntityId,
    confidence,
    visibility,
    importance,
    expectedUpdatedAt,
  } = input.parameters;

  if (typeof studentId !== 'string' || studentId === '' || studentId !== input.target.id) {
    return invalidParameters('待确认操作 target 与 parameters 不一致');
  }
  if (!isCategory(category)) {
    return invalidParameters('待确认操作 category 不合法');
  }
  if (typeof summary !== 'string' || summary.trim() === '') {
    return invalidParameters('待确认操作 summary 不合法');
  }
  if (confidence !== undefined && !isConfidence(confidence)) {
    return invalidParameters('待确认操作 confidence 不合法');
  }
  if (visibility !== undefined && !isVisibility(visibility)) {
    return invalidParameters('待确认操作 visibility 不合法');
  }
  if (importance !== undefined && !isImportance(importance)) {
    return invalidParameters('待确认操作 importance 不合法');
  }
  if (occurredAt !== undefined && (typeof occurredAt !== 'string' || parseRfc3339Instant(occurredAt) === undefined)) {
    return invalidParameters('待确认操作 occurredAt 不合法');
  }
  if (sourceText !== undefined && typeof sourceText !== 'string') {
    return invalidParameters('待确认操作 sourceText 不合法');
  }
  if (sourceEntityType !== undefined && typeof sourceEntityType !== 'string') {
    return invalidParameters('待确认操作 sourceEntityType 不合法');
  }
  if (sourceEntityId !== undefined && typeof sourceEntityId !== 'string') {
    return invalidParameters('待确认操作 sourceEntityId 不合法');
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
    category,
    summary,
    occurredAt: occurredAt === undefined ? undefined : parseRfc3339Instant(occurredAt),
    sourceText: sourceText === undefined ? undefined : sourceText as string,
    sourceEntityType: sourceEntityType === undefined ? undefined : sourceEntityType as string,
    sourceEntityId: sourceEntityId === undefined ? undefined : sourceEntityId as string,
    confidence: confidence === undefined ? undefined : confidence as string,
    visibility: visibility === undefined ? undefined : visibility as string,
    importance: importance === undefined ? undefined : importance as string,
    expectedUpdatedAt: expectedInstant,
  });
}

export function createRecordsCaptureActionExecutor(
  options: CreateRecordsCaptureActionExecutorOptions,
): ConfirmableActionExecutor {
  const { tx } = options;
  const cipher = options.cipher ?? createFieldCipherFromEnv();
  const trustedClock = options.trustedClock ?? createDatabaseTrustedClock(tx);
  const changelog = createChangelogService(tx, cipher);

  return {
    async execute(input) {
      const parsed = parseParameters(input);
      if (!parsed.ok) return parsed;
      const {
        studentId,
        category,
        summary,
        occurredAt,
        sourceText,
        sourceEntityType,
        sourceEntityId,
        confidence,
        visibility,
        importance,
        expectedUpdatedAt,
      } = parsed.value;

      // 教师归属复检：只读当前 teacher 的学生；跨 teacher 与不存在统一 NOT_FOUND，不建记录。
      const student = await tx.student.findFirst({
        where: { id: studentId, teacherId: input.teacherId },
        select: { id: true, updatedAtTs: true },
      });
      if (!student) return err(notFound('学生不存在'));

      // expectedUpdatedAt CAS：与当前学生版本不一致 → 版本冲突，不创建记录。
      if (expectedUpdatedAt.getTime() !== student.updatedAtTs.getTime()) {
        return err(versionConflict());
      }

      const nowResult = await trustedClock.now();
      if (!nowResult.ok) return nowResult;
      const now = nowResult.value;
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }
      const occurredAtTs = occurredAt ?? now;

      // 同事务 raw create（不经旧自动 changelog extension，避免双审计）；成功后才写显式
      // agent-confirmed 审计。DB 异常直接抛出，由 ConfirmationTransactionPort 收敛为固定
      // sentinel 并整体回滚（不在此拼接底层细节，避免泄漏）。
      let sourceRecordId: string | undefined;
      if (sourceText !== undefined && sourceText.trim() !== '') {
        const source = await tx.studentSourceRecord.create({
          data: {
            teacherId: input.teacherId,
            studentId,
            sourceType: 'agent_text',
            sourceEntityType: sourceEntityType ?? null,
            sourceEntityId: sourceEntityId ?? null,
            rawText: encryptFieldValue(cipher, sourceText),
            contentHash: createHash('sha256').update(sourceText).digest('hex'),
            captureStatus: 'captured',
            occurredAtTs,
            createdAtTs: now,
            updatedAtTs: now,
          },
        });
        sourceRecordId = source.id;
      }

      const record = await tx.studentRecord.create({
        data: {
          teacherId: input.teacherId,
          studentId,
          sourceRecordId: sourceRecordId ?? null,
          category,
          summary: encryptFieldValue(cipher, summary),
          occurredAtTs,
          confidence: confidence ?? 'medium',
          reviewStatus: 'candidate',
          visibility: visibility ?? 'needs_review',
          importance: importance ?? 'normal',
          createdAtTs: now,
          updatedAtTs: now,
        },
      });

      const auditRecord = await changelog.recordChange({
        teacherId: input.teacherId,
        module: 'student-records',
        action: 'create',
        targetType: 'StudentRecord',
        targetId: record.id,
        before: null,
        after: {
          category: record.category,
          reviewStatus: record.reviewStatus,
          visibility: record.visibility,
          importance: record.importance,
        },
        source: 'agent-confirmed',
      });
      if (!auditRecord.ok) return err(internalError('变更记录写入失败'));

      if (sourceRecordId !== undefined) {
        const auditSource = await changelog.recordChange({
          teacherId: input.teacherId,
          module: 'student-source-record',
          action: 'create',
          targetType: 'StudentSourceRecord',
          targetId: sourceRecordId,
          before: null,
          after: {
            sourceType: 'agent_text',
            captureStatus: 'captured',
          },
          source: 'agent-confirmed',
        });
        if (!auditSource.ok) return err(internalError('变更记录写入失败'));
      }

      return ok<ConfirmableActionExecutionResult>({
        summary: `已为学生创建记录：类别 ${record.category}`,
        references: [{ type: 'StudentRecord', id: record.id }],
      });
    },
  };
}
