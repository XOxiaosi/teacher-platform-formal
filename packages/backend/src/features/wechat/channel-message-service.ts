import type { PrismaClient } from '@prisma/client';
import {
  err,
  internalError,
  notFound,
  ok,
  validationError,
  type CommonError,
  type Result,
} from '@teacher-platform/contracts';
import type { ChannelMessageDto, ChannelMessageService, ChannelMessageStatus } from './types.js';

/**
 * 入站消息持久化服务（P8 t13，设计 p7-wechat-ilink-design.md §4.2/§4.3）。
 *
 * - 持久幂等：@@unique([channel, externalMessageId])——claim 时同消息重投返回 duplicate=true，
 *   不重复落行（重放防护持久层，与 ChannelMessage 唯一约束配套）；
 * - 状态机：new（claim/挂起）→ queued（入队）→ processed（TrustedClock 完成）| failed；
 *   未绑定消息由 worker 回置 new（markPending，S3 恢复扫描再处理）；
 * - processedAtTs 由调用方传入 TrustedClock 时间（业务时间纪律，本服务不取墙钟）。
 */

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'P2002'
  );
}

function toDto(row: {
  id: string;
  teacherId: string | null;
  channel: string;
  externalMessageId: string;
  fromExternalUserId: string;
  toExternalUserId: string | null;
  direction: string;
  contentType: string;
  contentText: string;
  status: string;
  errorMsg: string | null;
  processedAtTs: Date | null;
  createdAtTs: Date;
}): ChannelMessageDto {
  return {
    id: row.id,
    teacherId: row.teacherId,
    channel: row.channel,
    externalMessageId: row.externalMessageId,
    fromExternalUserId: row.fromExternalUserId,
    toExternalUserId: row.toExternalUserId,
    direction: row.direction,
    contentType: row.contentType,
    contentText: row.contentText,
    status: row.status as ChannelMessageStatus,
    errorMsg: row.errorMsg,
    processedAtTs: row.processedAtTs,
    createdAtTs: row.createdAtTs,
  };
}

export function createChannelMessageService(options: { prisma: PrismaClient }): ChannelMessageService {
  const { prisma } = options;

  async function claim(input: {
    channel: string;
    externalMessageId: string;
    fromExternalUserId: string;
    toExternalUserId?: string;
    contentType?: string;
    contentText: string;
  }): Promise<Result<{ row: ChannelMessageDto; duplicate: boolean }, CommonError>> {
    if (!input.channel.trim()) return err(validationError('渠道平台不能为空', 'channel'));
    if (!input.externalMessageId.trim()) return err(validationError('消息 ID 不能为空', 'externalMessageId'));
    if (!input.fromExternalUserId.trim()) return err(validationError('发送方标识不能为空', 'fromExternalUserId'));
    if (!input.contentText.trim()) return err(validationError('消息内容不能为空', 'contentText'));
    try {
      const created = await prisma.channelMessage.create({
        data: {
          channel: input.channel,
          externalMessageId: input.externalMessageId,
          fromExternalUserId: input.fromExternalUserId,
          ...(input.toExternalUserId ? { toExternalUserId: input.toExternalUserId } : {}),
          contentType: input.contentType ?? 'text',
          contentText: input.contentText,
          status: 'new',
        },
      });
      return ok({ row: toDto(created), duplicate: false });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await prisma.channelMessage.findUnique({
          where: {
            channel_externalMessageId: {
              channel: input.channel,
              externalMessageId: input.externalMessageId,
            },
          },
        });
        if (existing) return ok({ row: toDto(existing), duplicate: true });
        return err(internalError('消息幂等冲突但记录不存在'));
      }
      const message = error instanceof Error ? error.message : String(error);
      return err(internalError(`入站消息落库失败：${message}`));
    }
  }

  async function updateStatus(id: string, data: {
    status: ChannelMessageStatus;
    teacherId?: string;
    processedAtTs?: Date;
    errorMsg?: string | null;
  }): Promise<Result<ChannelMessageDto, CommonError>> {
    try {
      const updated = await prisma.channelMessage.update({
        where: { id },
        data: {
          status: data.status,
          ...(data.teacherId !== undefined ? { teacherId: data.teacherId } : {}),
          ...(data.processedAtTs !== undefined ? { processedAtTs: data.processedAtTs } : {}),
          ...(data.errorMsg !== undefined ? { errorMsg: data.errorMsg } : {}),
        },
      });
      return ok(toDto(updated));
    } catch (error) {
      if (isRecordNotFound(error)) return err(notFound('入站消息不存在'));
      const message = error instanceof Error ? error.message : String(error);
      return err(internalError(`入站消息状态更新失败：${message}`));
    }
  }

  return {
    claim,

    async markQueued(id) {
      return updateStatus(id, { status: 'queued' });
    },

    async markPending(id) {
      return updateStatus(id, { status: 'new' });
    },

    async markProcessed(id, input) {
      return updateStatus(id, {
        status: 'processed',
        teacherId: input.teacherId,
        processedAtTs: input.processedAt,
      });
    },

    async markFailed(id, input) {
      return updateStatus(id, {
        status: 'failed',
        ...(input?.errorMsg !== undefined ? { errorMsg: input.errorMsg } : {}),
      });
    },

    async getByExternalMessageId(channel, externalMessageId) {
      const row = await prisma.channelMessage.findUnique({
        where: { channel_externalMessageId: { channel, externalMessageId } },
      });
      return ok(row ? toDto(row) : null);
    },

    async claimOutbound(input) {
      if (!input.channel.trim()) return err(validationError('渠道平台不能为空', 'channel'));
      if (!input.teacherId.trim()) return err(validationError('教师 ID 不能为空', 'teacherId'));
      if (!input.correlationId.trim()) return err(validationError('关联消息 ID 不能为空', 'correlationId'));
      if (!input.toExternalUserId.trim()) return err(validationError('接收方标识不能为空', 'toExternalUserId'));
      if (!input.contentText.trim()) return err(validationError('消息内容不能为空', 'contentText'));
      const externalMessageId = `out:${input.correlationId}:${input.chunkIndex}`;
      try {
        const created = await prisma.channelMessage.create({
          data: {
            teacherId: input.teacherId,
            channel: input.channel,
            externalMessageId,
            fromExternalUserId: input.fromExternalUserId,
            toExternalUserId: input.toExternalUserId,
            direction: 'outbound',
            contentType: 'text',
            contentText: input.contentText,
            status: 'sending',
          },
        });
        return ok({ row: toDto(created), state: 'claimed' as const });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          const message = error instanceof Error ? error.message : String(error);
          return err(internalError(`出站消息占位失败：${message}`));
        }
        const existing = await prisma.channelMessage.findUnique({
          where: { channel_externalMessageId: { channel: input.channel, externalMessageId } },
        });
        if (!existing) return err(internalError('出站消息幂等冲突但记录不存在'));
        const samePayload = existing.direction === 'outbound'
          && existing.teacherId === input.teacherId
          && existing.fromExternalUserId === input.fromExternalUserId
          && existing.toExternalUserId === input.toExternalUserId
          && existing.contentText === input.contentText;
        if (!samePayload) {
          return err(validationError('出站幂等键已绑定其他消息载荷', 'correlationId'));
        }
        return ok({
          row: toDto(existing),
          state: existing.status === 'sent' ? 'sent' as const : 'uncertain' as const,
        });
      }
    },

    async completeOutbound(input) {
      try {
        const updated = await prisma.channelMessage.updateMany({
          where: { id: input.id, direction: 'outbound', status: 'sending' },
          data: {
            status: input.status,
            errorMsg: input.errorMsg ?? null,
            processedAtTs: input.processedAt,
          },
        });
        if (updated.count !== 1) {
          const existing = await prisma.channelMessage.findUnique({ where: { id: input.id } });
          if (existing?.direction === 'outbound' && existing.status === input.status) return ok(toDto(existing));
          return err(validationError('出站消息不再处于可收口状态', 'status'));
        }
        const row = await prisma.channelMessage.findUnique({ where: { id: input.id } });
        return row ? ok(toDto(row)) : err(notFound('出站消息不存在'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(internalError(`出站消息结果保存失败：${message}`));
      }
    },

    async listPending() {
      const rows = await prisma.channelMessage.findMany({
        where: { status: 'new' },
        orderBy: { createdAtTs: 'asc' },
        take: 100,
      });
      return ok(rows.map(toDto));
    },
  };
}

function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'P2025'
  );
}
