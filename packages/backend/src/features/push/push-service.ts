import type { PrismaClient } from '@prisma/client';
import { err, internalError, notFound, ok, validationError, type CommonError, type Result } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  encryptFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import type {
  CreatePushServiceOptions,
  ListPushRecordsInput,
  PushAdapterMap,
  PushRecordData,
  PushRecipientResolver,
  PushService,
  SendPushInput,
} from './types.js';

export function createPushService(options: CreatePushServiceOptions): PushService {
  const getClient = options.getClient ?? (async () => options.prisma);
  // P8 phase-3 批5：PushRecord.content 加密 cipher（缺省 env 构建）
  const cipher = options.cipher ?? createFieldCipherFromEnv();

  return {
    sendPush: (input) => sendPush(getClient, options.adapters, options.trustedClock, options.resolveRecipient, cipher, input),
    retryPush: (id) => retryPush(getClient, options.adapters, options.trustedClock, options.resolveRecipient, cipher, id),
    listPushRecords: (input) => listPushRecords(getClient, cipher, input),
  };
}

async function resolvePush(
  getClient: () => Promise<PrismaClient>,
  trustedClock: ReturnType<typeof createDatabaseTrustedClock> | undefined,
) {
  const prisma = await getClient();
  return { prisma, trustedClock: trustedClock ?? createDatabaseTrustedClock(prisma) };
}

async function sendPush(
  getClient: () => Promise<PrismaClient>,
  adapters: PushAdapterMap,
  configuredClock: ReturnType<typeof createDatabaseTrustedClock> | undefined,
  resolveRecipient: PushRecipientResolver | undefined,
  cipher: FieldCipher | undefined,
  input: SendPushInput,
) {
  const validation = validateSendInput(adapters, input);
  if (!validation.ok) return validation;

  const { prisma, trustedClock } = await resolvePush(getClient, configuredClock);
  const now = await trustedClock.now();
  if (!now.ok) return err(now.error);
  if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
    return err(internalError('TrustedClock返回无效时间'));
  }

  // S4 收件人解析（D37 §4.3）：wechat 渠道 teacherId → 外部 wxid；无绑定 → 跳过（记录 skipped）
  const recipient = await resolvePushRecipient(resolveRecipient, input.teacherId, input.channel);
  if (!recipient.ok) return recipient;
  try {
    if (recipient.value === null) {
      const record = await prisma.pushRecord.create({
        data: buildSkippedData(input, now.value, cipher),
      });
      return ok(toPushRecordData(record, cipher));
    }

    const result = await adapters[input.channel]!.send({ to: recipient.value, content: input.content });
    const record = await prisma.pushRecord.create({
      data: buildCreateData(input, result.ok, result.ok ? null : result.error.message, now.value, cipher),
    });
    return ok(toPushRecordData(record, cipher));
  } catch (e) {
    return err(internalError(`发送推送失败：${e instanceof Error ? e.message : String(e)}`));
  }
}

async function retryPush(
  getClient: () => Promise<PrismaClient>,
  adapters: PushAdapterMap,
  configuredClock: ReturnType<typeof createDatabaseTrustedClock> | undefined,
  resolveRecipient: PushRecipientResolver | undefined,
  cipher: FieldCipher | undefined,
  pushRecordId: string,
) {
  const { prisma, trustedClock } = await resolvePush(getClient, configuredClock);
  const existing = await prisma.pushRecord.findUnique({ where: { id: pushRecordId } });
  if (!existing) return err(notFound('推送记录不存在'));

  const channel = existing.channel as keyof PushAdapterMap;
  const adapter = adapters[channel];
  if (!adapter) return err(validationError('渠道适配器不可用', 'channel'));

  const now = await trustedClock.now();
  if (!now.ok) return err(now.error);
  if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
    return err(internalError('TrustedClock返回无效时间'));
  }

  // S4 收件人解析同样应用于重试：绑定消失 → 跳过（记录 skipped）
  const recipient = await resolvePushRecipient(resolveRecipient, existing.teacherId, channel);
  if (!recipient.ok) return recipient;
  if (recipient.value === null) {
    const updated = await prisma.pushRecord.update({
      where: { id: existing.id },
      data: buildSkippedUpdateData(now.value),
    });
    return ok(toPushRecordData(updated, cipher));
  }

  // P8 phase-3 批5：content 落库为密文，重试发送前解密
  const result = await adapter.send({ to: recipient.value, content: decryptFieldValue(cipher, existing.content) });
  const updated = await prisma.pushRecord.update({
    where: { id: existing.id },
    data: buildUpdateData(result.ok, result.ok ? null : result.error.message, now.value),
  });
  return ok(toPushRecordData(updated, cipher));
}

/**
 * 收件人解析（端口缺省 → teacherId 直发，既有行为不变）。
 * 端口实现（如 wechat ChannelIdentity resolver）返回 null 表示无绑定 → 调用方记 skipped。
 */
async function resolvePushRecipient(
  resolveRecipient: PushRecipientResolver | undefined,
  teacherId: string,
  channel: keyof PushAdapterMap,
): Promise<Result<string | null, CommonError>> {
  if (!resolveRecipient) return ok(teacherId);
  const resolved = await resolveRecipient({ teacherId, channel: channel as Parameters<PushRecipientResolver>[0]['channel'] });
  if (!resolved.ok) return resolved;
  return ok(resolved.value ? resolved.value.externalId : null);
}

async function listPushRecords(getClient: () => Promise<PrismaClient>, cipher: FieldCipher | undefined, input: ListPushRecordsInput) {
  const prisma = await getClient();
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const skip = (page - 1) * pageSize;
  const where = buildWhere(input);

  const [items, total] = await Promise.all([
    prisma.pushRecord.findMany({ where, orderBy: { scheduledAtTs: 'desc' }, skip, take: pageSize }),
    prisma.pushRecord.count({ where }),
  ]);
  try {
    return ok({ items: items.map((item) => toPushRecordData(item, cipher)), total });
  } catch (e) {
    return err(internalError(`查询推送记录失败：${e instanceof Error ? e.message : String(e)}`));
  }
}

function validateSendInput(adapters: PushAdapterMap, input: SendPushInput) {
  if (!input.teacherId.trim()) return err(validationError('老师 ID 不能为空', 'teacherId'));
  if (!input.content.trim()) return err(validationError('推送内容不能为空', 'content'));
  if (!adapters[input.channel]) return err(validationError('渠道适配器不可用', 'channel'));
  return ok(true);
}

function buildCreateData(input: SendPushInput, sent: boolean, errorMsg: string | null, now: Date, cipher: FieldCipher | undefined) {
  return {
    teacherId: input.teacherId,
    type: input.type,
    scheduledAtTs: input.scheduledAt,
    sentAtTs: sent ? now : null,
    channel: input.channel,
    content: encryptFieldValue(cipher, input.content),
    status: sent ? 'sent' : 'failed',
    errorMsg,
    createdAtTs: now,
    updatedAtTs: now,
  };
}

/** S4：无绑定教师跳过推送（不调 adapter），记录 status='skipped'。 */
function buildSkippedData(input: SendPushInput, now: Date, cipher: FieldCipher | undefined) {
  return {
    teacherId: input.teacherId,
    type: input.type,
    scheduledAtTs: input.scheduledAt,
    sentAtTs: null,
    channel: input.channel,
    content: encryptFieldValue(cipher, input.content),
    status: 'skipped',
    errorMsg: '未绑定渠道收件人，跳过推送',
    createdAtTs: now,
    updatedAtTs: now,
  };
}

function buildSkippedUpdateData(now: Date) {
  return {
    sentAtTs: null,
    status: 'skipped',
    errorMsg: '未绑定渠道收件人，跳过推送',
    updatedAtTs: now,
  };
}

function buildUpdateData(sent: boolean, errorMsg: string | null, now: Date) {
  return {
    sentAtTs: sent ? now : null,
    status: sent ? 'sent' : 'failed',
    errorMsg,
    updatedAtTs: now,
  };
}

function buildWhere(input: ListPushRecordsInput) {
  return {
    teacherId: input.teacherId,
    ...(input.type && { type: input.type }),
    ...(input.status && { status: input.status }),
    ...(input.scheduledFrom || input.scheduledTo ? { scheduledAt: buildDateRange(input) } : {}),
  };
}

function buildDateRange(input: ListPushRecordsInput) {
  return {
    ...(input.scheduledFrom && { gte: input.scheduledFrom }),
    ...(input.scheduledTo && { lte: input.scheduledTo }),
  };
}

function toPushRecordData(r: any, cipher: FieldCipher | undefined): PushRecordData {
  return {
    id: r.id,
    teacherId: r.teacherId,
    type: r.type,
    scheduledAt: r.scheduledAtTs,
    sentAt: r.sentAtTs,
    channel: r.channel,
    content: decryptFieldValue(cipher, r.content),
    status: r.status,
    errorMsg: r.errorMsg,
    createdAt: r.createdAtTs,
    updatedAt: r.updatedAtTs,
  };
}
