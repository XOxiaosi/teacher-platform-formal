import { createHash, randomUUID } from 'node:crypto';
import { err, internalError, notFound, validationError, versionConflict, type CommonError } from '@teacher-platform/contracts';
import { Prisma } from '@prisma/client';
import { createChangelogService, requireChangelogWrite, runWithAutomaticChangelogSuppressed } from '../../shared/changelog/index.js';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import { createFieldCipherFromEnv, decryptJsonFieldValue, encryptFieldValue, encryptJsonFieldValue, type FieldCipher } from '../../shared/field-encryption/index.js';
import { parseRfc3339Instant } from './rfc3339-instant.js';
import { toParentFeedbackData } from './feedback-record.js';
import { validateEvidenceArray } from './feedback-evidence-validation.js';
import { resolveFeedbackEvidence } from './feedback-evidence-resolver.js';
import type { CreateFeedbackServiceOptions, FeedbackService, FeedbackEvidenceSnapshotInput, ParentFeedbackData } from './types.js';
import { ok } from '@teacher-platform/contracts';

interface PrismaClientLike {
  $transaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
}

const ENCRYPTION_SAVE_BLOCK = 'SAFETY_BLOCK: 字段加密校验未通过，拒绝保存家长反馈';

function isEncryptionSafetyBlock(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('SAFETY_BLOCK:');
}

class ParentFeedbackCreateTransactionRollback extends Error {
  constructor(readonly encryptionBlocked = false) {
    super(encryptionBlocked ? ENCRYPTION_SAVE_BLOCK : 'parent-feedback-create transaction rollback');
  }
}

class FeedbackEvidenceAdmissionError extends Error {
  constructor(readonly safeError: CommonError) { super('feedback-evidence-admission'); }
}

class FeedbackRequestConflictError extends Error {
  constructor(readonly safeError: CommonError) { super('feedback-request-conflict'); }
}

type CreationReceipt = {
  version: 1;
  feedback: {
    id: string;
    teacherId: string;
    studentId: string;
    lessonId: string | null;
    title: string;
    content: string;
    status: ParentFeedbackData['status'];
    channel: string | null;
    parentName: string | null;
    sentAt: string | null;
    moderationFlagged: boolean | null;
    moderationReasons: string[] | null;
    createdAt: string;
    updatedAt: string;
  };
};

function canonicalFingerprint(input: Parameters<FeedbackService['createFeedback']>[0]): string {
  const evidence = input.evidence?.map((item) => ({
    id: item.id ?? null,
    type: item.type,
    sourceVersion: item.sourceVersion ?? null,
  })) ?? null;
  const canonical = {
    studentId: input.studentId,
    lessonId: input.lessonId ?? null,
    title: input.title,
    content: input.content,
    channel: input.channel ?? null,
    parentName: input.parentName ?? null,
    evidence,
    windowStart: input.windowStart ?? null,
    windowEnd: input.windowEnd ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function receiptPayload(data: ParentFeedbackData): CreationReceipt {
  return {
    version: 1,
    feedback: {
      id: data.id,
      teacherId: data.teacherId,
      studentId: data.studentId,
      lessonId: data.lessonId,
      title: data.title,
      content: data.content,
      status: data.status,
      channel: data.channel,
      parentName: data.parentName,
      sentAt: data.sentAt?.toISOString() ?? null,
      moderationFlagged: data.moderationFlagged,
      moderationReasons: data.moderationReasons,
      createdAt: data.createdAt.toISOString(),
      updatedAt: data.updatedAt.toISOString(),
    },
  };
}

function replayFromReceipt(cipher: FieldCipher | undefined, ciphertext: string): ParentFeedbackData {
  if (!cipher || !cipher.isEncrypted(ciphertext)) {
    throw new Error('SAFETY_BLOCK: 保存回执缺少可验证的加密格式');
  }
  let decoded: unknown;
  try {
    decoded = decryptJsonFieldValue(cipher, ciphertext);
  } catch {
    throw new Error('SAFETY_BLOCK: 保存回执解密失败');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('SAFETY_BLOCK: 保存回执结构无效');
  }
  const payload = decoded as Partial<CreationReceipt>;
  const feedback = payload.feedback;
  if (payload.version !== 1 || !feedback || typeof feedback !== 'object' || Array.isArray(feedback)) {
    throw new Error('SAFETY_BLOCK: 保存回执版本无效');
  }
  const row = feedback as Record<string, unknown>;
  const date = (key: string, nullable = false): Date | null | undefined => {
    const value = row[key];
    if (nullable && value === null) return null;
    if (typeof value !== 'string') return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  };
  const createdAt = date('createdAt');
  const updatedAt = date('updatedAt');
  const sentAt = date('sentAt', true);
  const strings = ['id', 'teacherId', 'studentId', 'title', 'content', 'status'] as const;
  if (strings.some((key) => typeof row[key] !== 'string')
    || !['draft', 'reviewed', 'sent', 'archived'].includes(String(row.status))
    || createdAt === undefined || updatedAt === undefined || sentAt === undefined
    || (row.lessonId !== null && typeof row.lessonId !== 'string')
    || (row.channel !== null && typeof row.channel !== 'string')
    || (row.parentName !== null && typeof row.parentName !== 'string')
    || (row.moderationFlagged !== null && typeof row.moderationFlagged !== 'boolean')
    || (row.moderationReasons !== null && (!Array.isArray(row.moderationReasons)
      || row.moderationReasons.some((reason) => typeof reason !== 'string')))) {
    throw new Error('SAFETY_BLOCK: 保存回执字段无效');
  }
  return {
    id: row.id as string,
    teacherId: row.teacherId as string,
    studentId: row.studentId as string,
    lessonId: row.lessonId as string | null,
    title: row.title as string,
    content: row.content as string,
    status: row.status as ParentFeedbackData['status'],
    channel: row.channel as string | null,
    parentName: row.parentName as string | null,
    sentAt: sentAt as Date | null,
    moderationFlagged: row.moderationFlagged as boolean | null,
    moderationReasons: row.moderationReasons as string[] | null,
    createdAt: createdAt as Date,
    updatedAt: updatedAt as Date,
    replayed: true,
  };
}

export function createFeedbackWriter(options: CreateFeedbackServiceOptions): FeedbackService['createFeedback'] {
  const getClient = options.getClient ?? (async () => options.prisma);
  const cipher = options.cipher ?? createFieldCipherFromEnv();
  const changelogFactory = options.changelogFactory ?? ((client: Prisma.TransactionClient) => createChangelogService(client, cipher));

  async function resolve() {
    const prisma = await getClient();
    return { prisma, trustedClock: options.trustedClock ?? createDatabaseTrustedClock(prisma) };
  }

  return {
    async createFeedback(input: Parameters<FeedbackService['createFeedback']>[0]) {
      const { prisma, trustedClock } = await resolve();
      const opensTransaction = '$transaction' in prisma
        && typeof (prisma as { $transaction?: unknown }).$transaction === 'function';
      const clientRequestId = input.clientRequestId?.trim();
      if (input.clientRequestId !== undefined && (!clientRequestId || clientRequestId.length > 128)) {
        return err(validationError('clientRequestId 必须是 1-128 个字符的非空字符串', 'clientRequestId'));
      }
      if (!input.title || input.title.trim() === '') return err(validationError('title 不能为空', 'title'));
      if (!input.content || input.content.trim() === '') return err(validationError('content 不能为空', 'content'));

      let validatedEvidence: FeedbackEvidenceSnapshotInput[] | undefined;
      if (input.evidence !== undefined) {
        const ev = validateEvidenceArray(input.evidence);
        if (!ev.ok) return err(validationError(ev.message, ev.field));
        validatedEvidence = ev.value;
      }

      let windowStartDate: Date | null = null;
      let windowEndDate: Date | null = null;
      if (input.windowStart !== undefined) {
        const parsed = parseRfc3339Instant(input.windowStart);
        if (parsed === undefined) return err(validationError('windowStart 必须是带时区的严格 RFC3339 时间', 'windowStart'));
        windowStartDate = parsed;
      }
      if (input.windowEnd !== undefined) {
        const parsed = parseRfc3339Instant(input.windowEnd);
        if (parsed === undefined) return err(validationError('windowEnd 必须是带时区的严格 RFC3339 时间', 'windowEnd'));
        windowEndDate = parsed;
      }

      const requestFingerprint = clientRequestId ? canonicalFingerprint({ ...input, clientRequestId }) : undefined;
      try {
        const txFn = async (tx: Prisma.TransactionClient) => {
          if (clientRequestId) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`feedback-create:${input.teacherId}:${clientRequestId}`}))`;
            const existing = await tx.parentFeedback.findUnique({
              where: { teacherId_clientRequestId: { teacherId: input.teacherId, clientRequestId } },
              select: { requestFingerprint: true, creationReceiptCiphertext: true },
            });
            if (existing) {
              if (existing.requestFingerprint !== requestFingerprint) {
                throw new FeedbackRequestConflictError({ ...versionConflict(), message: '请求编号已用于另一份家长反馈' });
              }
              if (!existing.creationReceiptCiphertext) throw new ParentFeedbackCreateTransactionRollback(true);
              return { kind: 'replayed' as const, data: replayFromReceipt(cipher, existing.creationReceiptCiphertext) };
            }
          }

          // Replay lookup intentionally precedes clock, ownership and evidence checks.
          const now = await trustedClock.now();
          if (!now.ok) return { kind: 'error' as const, error: now.error };
          if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
            return { kind: 'error' as const, error: internalError('TrustedClock返回无效时间') };
          }
          const student = await tx.student.findFirst({ where: { id: input.studentId, teacherId: input.teacherId }, select: { id: true } });
          if (!student) return { kind: 'error' as const, error: notFound('学生不存在') };
          if (input.lessonId !== undefined) {
            const lesson = await tx.lesson.findFirst({ where: { id: input.lessonId, teacherId: input.teacherId, studentId: input.studentId }, select: { id: true } });
            if (!lesson) return { kind: 'error' as const, error: notFound('课次不存在') };
          }

          let admittedEvidence = validatedEvidence;
          if (admittedEvidence !== undefined) {
            const resolved = await resolveFeedbackEvidence({ client: tx, teacherId: input.teacherId, studentId: input.studentId,
              references: admittedEvidence, cipher, lock: true });
            if (!resolved.ok) throw new FeedbackEvidenceAdmissionError(resolved.error);
            admittedEvidence = resolved.value;
          }

          const id = clientRequestId ? randomUUID() : undefined;
          const creationData: ParentFeedbackData = {
            id: id ?? '', teacherId: input.teacherId, studentId: input.studentId, lessonId: input.lessonId ?? null,
            title: input.title, content: input.content, status: 'draft', channel: input.channel ?? null, parentName: input.parentName ?? null,
            sentAt: null, moderationFlagged: null, moderationReasons: null, createdAt: now.value, updatedAt: now.value,
          };
          const feedbackData = {
            ...(id ? { id } : {}), teacherId: input.teacherId, studentId: input.studentId, lessonId: input.lessonId ?? null,
            ...(clientRequestId ? {
              clientRequestId, requestFingerprint,
              creationReceiptCiphertext: encryptJsonFieldValue(cipher, receiptPayload(creationData)),
            } : {}),
            title: encryptFieldValue(cipher, input.title), content: encryptFieldValue(cipher, input.content), status: 'draft' as const,
            channel: input.channel ?? null,
            parentName: input.parentName === undefined || input.parentName === null ? null : encryptFieldValue(cipher, input.parentName),
            createdAtTs: now.value, updatedAtTs: now.value,
          };
          const feedback = await tx.parentFeedback.create({ data: feedbackData });
          await requireChangelogWrite(changelogFactory(tx).recordChange({
            teacherId: input.teacherId, module: 'feedback', action: 'create', targetType: 'ParentFeedback', targetId: feedback.id,
            before: null,
            after: {
              id: feedback.id, teacherId: input.teacherId, studentId: input.studentId, lessonId: input.lessonId ?? null,
              title: input.title, content: input.content, status: 'draft', channel: input.channel ?? null, parentName: input.parentName ?? null,
              sentAtTs: null, moderationFlagged: null, moderationReasons: null, createdAtTs: now.value, updatedAtTs: now.value,
            },
            source: 'system',
          }));

          if (admittedEvidence !== undefined) {
            const snapshot = await tx.feedbackContextSnapshot.create({ data: {
              teacherId: input.teacherId, feedbackId: feedback.id, windowStartTs: windowStartDate, windowEndTs: windowEndDate, assembledAtTs: now.value,
            } });
            if (admittedEvidence.length > 0) {
              await tx.feedbackEvidence.createMany({ data: admittedEvidence.map((item, index) => ({
                teacherId: input.teacherId, snapshotId: snapshot.id, recordId: item.id ?? null, sourceVersion: item.sourceVersion ?? null,
                originalDeletedAtSave: item.originalDeleted ?? null, type: item.type, occurredAtTs: parseRfc3339Instant(item.occurredAt) as Date,
                category: item.category ?? null, summary: item.summary === undefined || item.summary === null ? null : encryptFieldValue(cipher, item.summary),
                examName: item.examName ?? null, subject: item.subject ?? null, score: item.score ?? null, fullScore: item.fullScore ?? null,
                previousScore: item.previousScore ?? null,
                parentConcerns: (item.parentConcerns ?? []).length > 0 ? (encryptJsonFieldValue(cipher, item.parentConcerns ?? []) as unknown as Prisma.JsonArray) : [],
                followUps: (item.followUps ?? []).length > 0 ? (encryptJsonFieldValue(cipher, item.followUps ?? []) as unknown as Prisma.JsonArray) : [],
                sortOrder: index,
              })) });
            }
          }
          return { kind: 'created' as const, data: toParentFeedbackData(feedback, cipher) };
        };

        const rollbackTxFn = async (tx: Prisma.TransactionClient) => {
          try {
            return await txFn(tx);
          } catch (error) {
            if (error instanceof FeedbackEvidenceAdmissionError || error instanceof FeedbackRequestConflictError) throw error;
            throw new ParentFeedbackCreateTransactionRollback(isEncryptionSafetyBlock(error));
          }
        };
        const outcome = await runWithAutomaticChangelogSuppressed(() => (
          opensTransaction
            ? (prisma as PrismaClientLike).$transaction(rollbackTxFn)
            : rollbackTxFn(prisma as unknown as Prisma.TransactionClient)
        ));
        if (outcome.kind === 'error') return err(outcome.error);
        if (outcome.kind === 'replayed') return ok(outcome.data);
        return ok(clientRequestId ? { ...outcome.data, replayed: false } : outcome.data);
      } catch (e) {
        if (e instanceof FeedbackEvidenceAdmissionError || e instanceof FeedbackRequestConflictError) return err(e.safeError);
        if (e instanceof ParentFeedbackCreateTransactionRollback) {
          if (!opensTransaction) throw e;
          return err(internalError(e.encryptionBlocked ? ENCRYPTION_SAVE_BLOCK : '创建家长反馈失败'));
        }
        return err(internalError(isEncryptionSafetyBlock(e) ? ENCRYPTION_SAVE_BLOCK : '创建家长反馈失败'));
      }
    },
  }.createFeedback;
}
