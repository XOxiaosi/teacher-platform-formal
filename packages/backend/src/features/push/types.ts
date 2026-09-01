import type { PrismaClient } from '@prisma/client';
import type { CommonError, PaginationParams, Result } from '@teacher-platform/contracts';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';
import type { FieldCipher } from '../../shared/field-encryption/index.js';
import type { MessageAdapter } from '../../adapters/shared/index.js';

export type PushType = 'morning_brief' | 'evening_review';
export type PushStatus = 'pending' | 'sent' | 'failed' | 'read' | 'skipped';
export type PushChannel = 'wechat-bot' | 'wecom' | 'telegram';

export type PushAdapterMap = Partial<Record<PushChannel, MessageAdapter>>;

/**
 * 收件人解析端口（D37 §4.3 缺口收口，P8 S4）：
 * pushService 现把 teacherId 直接当 adapter 收件人——微信不成立，须先经 ChannelIdentity 解析成外部 wxid。
 * - 返回 { externalId } → 发送到该外部 id；
 * - 返回 null → 无绑定教师，跳过（PushRecord 记录 status='skipped'，不调 adapter）；
 * - 未注入端口 → 维持既有行为（to = teacherId，其它渠道不受影响）。
 */
export type PushRecipientResolver = (input: {
  teacherId: string;
  channel: PushChannel;
}) => Promise<Result<{ externalId: string } | null, CommonError>>;

export interface CreatePushServiceOptions {
  prisma: PrismaClient;
  adapters: PushAdapterMap;
  trustedClock?: TrustedClock;
  /** S3 平移：请求期解析 client（数据库路由）；未提供时回退装配期 prisma */
  getClient?: () => Promise<PrismaClient>;
  /** S4：收件人解析端口（wechat 渠道注入 ChannelIdentity 实现；缺省 teacherId 直发） */
  resolveRecipient?: PushRecipientResolver;
  /** P8 phase-3 批5：字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
}

export interface SendPushInput {
  teacherId: string;
  type: PushType;
  scheduledAt: Date;
  channel: PushChannel;
  content: string;
}

export interface ListPushRecordsInput extends PaginationParams {
  teacherId: string;
  type?: PushType;
  status?: PushStatus;
  scheduledFrom?: Date;
  scheduledTo?: Date;
}

export interface PushRecordData {
  id: string;
  teacherId: string;
  type: string;
  scheduledAt: Date;
  sentAt: Date | null;
  channel: string;
  content: string;
  status: string;
  errorMsg: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PushService {
  sendPush(input: SendPushInput): Promise<Result<PushRecordData, CommonError>>;
  retryPush(pushRecordId: string): Promise<Result<PushRecordData, CommonError>>;
  listPushRecords(input: ListPushRecordsInput): Promise<Result<{ items: PushRecordData[]; total: number }, CommonError>>;
}
