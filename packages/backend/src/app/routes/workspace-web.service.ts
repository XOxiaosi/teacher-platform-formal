import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { err, ok, internalError, validationError, versionConflict, type CommonError, type Result } from '@teacher-platform/contracts';
import { createMemoService } from '../../features/memos/index.js';
import { createStudentService } from '../../features/students/index.js';
import { createFeedbackService } from '../../features/feedback/index.js';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import { createFieldCipherFromEnv, decryptFieldValue, encryptFieldValue } from '../../shared/field-encryption/index.js';

class Rejected extends Error { constructor(readonly detail: CommonError) { super(detail.message); } }
function unwrap<T>(result: Result<T, CommonError>): T { if (!result.ok) throw new Rejected(result.error); return result.value; }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Rejected(validationError('请求格式不正确'));
  return value as Record<string, unknown>;
}
function text(body: Record<string, unknown>, key: string, max = 10000) {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Rejected(validationError(`${key} 不能为空或超过长度限制`, key));
  return value.trim();
}
function fail(error: unknown) { return err(error instanceof Rejected ? error.detail : internalError('操作未完成，请刷新核对后重试。')); }
function dateLabel(value: Date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const p = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${p('year')}-${p('month')}-${p('day')}`;
}

export function createWorkspaceWebService(options: { getClient: () => Promise<PrismaClient> }) {
  const cipher = createFieldCipherFromEnv();
  async function execute(tx: Prisma.TransactionClient, teacherId: string, operation: string, body: Record<string, unknown>): Promise<unknown> {
    if (operation === 'students') return unwrap(await createStudentService(tx).createStudent({ teacherId, name: text(body, 'name', 120), grade: text(body, 'grade', 120) }));
    if (operation === 'feedback') return unwrap(await createFeedbackService({ prisma: tx, cipher }).createFeedback({ teacherId, studentId: text(body, 'studentId', 128), title: text(body, 'title', 300), content: text(body, 'content') }));
    if (operation === 'memos') return unwrap(await createMemoService({ prisma: tx, cipher }).createMemo({ teacherId, title: text(body, 'text', 1000), content: text(body, 'text', 1000), source: 'manual' }));
    if (operation === 'memo-status') {
      const memoId = text(body, 'id', 128);
      const service = createMemoService({ prisma: tx, cipher });
      const current = unwrap(await service.getMemo({ teacherId, memoId }));
      if (typeof body.done !== 'boolean') throw new Rejected(validationError('完成状态不正确'));
      if (body.expectedUpdatedAt !== current.updatedAt.toISOString()) throw new Rejected({ ...versionConflict(), message: '备忘已变化，请刷新后重试' });
      return unwrap(await service.updateMemoStatus({ teacherId, memoId, status: body.done ? 'done' : 'active' }));
    }
    if (operation === 'preferences') {
      const changes = object(body.changes);
      if (Object.keys(changes).some((key) => !['studioName', 'modelChoice', 'wechatChannel'].includes(key))) throw new Rejected(validationError('不支持的设置项'));
      const data: Record<string, string> = {};
      if (changes.studioName !== undefined) data.studioName = text(changes, 'studioName', 120);
      if (changes.modelChoice !== undefined) {
        if (!['default', 'fast', 'deep'].includes(String(changes.modelChoice))) throw new Rejected(validationError('响应偏好不正确'));
        data.modelChoice = String(changes.modelChoice);
      }
      if (changes.wechatChannel !== undefined) {
        if (!['personal', 'official'].includes(String(changes.wechatChannel))) throw new Rejected(validationError('入口偏好不正确'));
        data.wechatChannel = String(changes.wechatChannel);
      }
      if (!Object.keys(data).length) throw new Rejected(validationError('没有需要保存的设置'));
      const current = await tx.teacherWorkspacePreference.findUnique({ where: { teacherId } });
      if ((current?.updatedAtTs.toISOString() ?? null) !== (body.expectedUpdatedAt ?? null)) throw new Rejected({ ...versionConflict(), message: '设置已变化，请刷新后重试' });
      const now = unwrap(await createDatabaseTrustedClock(tx).now());
      return tx.teacherWorkspacePreference.upsert({ where: { teacherId }, create: { teacherId, ...data, updatedAtTs: now }, update: { ...data, updatedAtTs: now } });
    }
    throw new Rejected(validationError('不支持的操作'));
  }
  return {
    async state(teacherId: string) {
      try {
        const prisma = await options.getClient();
        const now = unwrap(await createDatabaseTrustedClock(prisma).now());
        const preferences = await prisma.teacherWorkspacePreference.findUnique({ where: { teacherId } });
        const memos = unwrap(await createMemoService({ prisma, cipher }).listMemos({ teacherId, page: 1, pageSize: 10000 }));
        if (memos.total > memos.items.length) throw new Rejected(validationError('备忘数量超过本次加载上限，请联系维护人员。'));
        return ok({ businessDate: dateLabel(now), preferences, memos: memos.items });
      } catch (error) { return fail(error); }
    },
    async mutate(teacherId: string, operation: string, input: unknown) {
      try {
        const body = object(input);
        const clientRequestId = text(body, 'clientRequestId', 128);
        const fingerprint = createHash('sha256').update(JSON.stringify({ operation, body })).digest('hex');
        const prisma = await options.getClient();
        const value = await prisma.$transaction(async (tx) => {
          // One teacher's submission and receipt commit together; duplicate requests cannot race.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`workspace-web:${teacherId}`}))`;
          const existing = await tx.webMutationReceipt.findUnique({ where: { teacherId_clientRequestId: { teacherId, clientRequestId } } });
          if (existing) {
            if (existing.fingerprint !== fingerprint) throw new Rejected({ ...versionConflict(), message: '请求编号已用于另一项操作' });
            return JSON.parse(decryptFieldValue(cipher, existing.ciphertext)) as unknown;
          }
          const response = await execute(tx, teacherId, operation, body);
          await tx.webMutationReceipt.create({ data: { teacherId, clientRequestId, fingerprint, ciphertext: encryptFieldValue(cipher, JSON.stringify(response)) } });
          return response;
        });
        return ok(value);
      } catch (error) { return fail(error); }
    },
  };
}
