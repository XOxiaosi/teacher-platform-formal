import type { PrismaClient } from '@prisma/client';
import {
  err,
  internalError,
  ok,
  validationError,
} from '@teacher-platform/contracts';
import type { ChannelConversationDto, ChannelConversationService } from './types.js';

/**
 * 渠道会话映射服务（P8 t23 S5，设计 p7-wechat-ilink-design.md §4.3）。
 *
 * 一教师多发送方（私聊=发送方 wxid；群聊=群 ID）→ 各自平台 Conversation（教师库）：
 * - findMapping：外部会话 → 平台 Conversation（复用，多会话独立）；
 * - recordMapping：新映射落表（@@unique([channel, teacherId, externalConversationId])）；
 * - touchLastMessage：lastMessageAtTs 更新（TrustedClock 时间由调用方传入）。
 * 共享库表（渠道状态与 ChannelIdentity/ChannelMessage 同库；Conversation 本体在教师库）。
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
  teacherId: string;
  channel: string;
  externalConversationId: string;
  conversationId: string;
  status: string;
  lastMessageAtTs: Date | null;
  createdAtTs: Date;
  updatedAtTs: Date;
}): ChannelConversationDto {
  return {
    id: row.id,
    teacherId: row.teacherId,
    channel: row.channel,
    externalConversationId: row.externalConversationId,
    conversationId: row.conversationId,
    status: row.status,
    lastMessageAtTs: row.lastMessageAtTs,
    createdAtTs: row.createdAtTs,
    updatedAtTs: row.updatedAtTs,
  };
}

export function createChannelConversationService(options: { prisma: PrismaClient }): ChannelConversationService {
  const { prisma } = options;

  return {
    async findMapping(input) {
      if (!input.channel.trim()) return err(validationError('渠道平台不能为空', 'channel'));
      if (!input.teacherId.trim()) return err(validationError('教师 ID 不能为空', 'teacherId'));
      if (!input.externalConversationId.trim()) {
        return err(validationError('外部会话标识不能为空', 'externalConversationId'));
      }
      const row = await prisma.channelConversation.findUnique({
        where: {
          channel_teacherId_externalConversationId: {
            channel: input.channel,
            teacherId: input.teacherId,
            externalConversationId: input.externalConversationId,
          },
        },
      });
      return ok(row ? toDto(row) : null);
    },

    async recordMapping(input) {
      if (!input.channel.trim()) return err(validationError('渠道平台不能为空', 'channel'));
      if (!input.teacherId.trim()) return err(validationError('教师 ID 不能为空', 'teacherId'));
      if (!input.externalConversationId.trim()) {
        return err(validationError('外部会话标识不能为空', 'externalConversationId'));
      }
      if (!input.conversationId.trim()) return err(validationError('会话 ID 不能为空', 'conversationId'));
      try {
        const created = await prisma.channelConversation.create({
          data: {
            teacherId: input.teacherId,
            channel: input.channel,
            externalConversationId: input.externalConversationId,
            conversationId: input.conversationId,
            ...(input.lastMessageAt ? { lastMessageAtTs: input.lastMessageAt } : {}),
          },
        });
        return ok(toDto(created));
      } catch (error) {
        if (isUniqueViolation(error)) {
          // 并发建映射：返回既有行（幂等）
          const existing = await prisma.channelConversation.findUnique({
            where: {
              channel_teacherId_externalConversationId: {
                channel: input.channel,
                teacherId: input.teacherId,
                externalConversationId: input.externalConversationId,
              },
            },
          });
          if (existing) return ok(toDto(existing));
        }
        const message = error instanceof Error ? error.message : String(error);
        return err(internalError(`渠道会话映射落表失败：${message}`));
      }
    },

    async touchLastMessage(input) {
      try {
        const updated = await prisma.channelConversation.update({
          where: { id: input.id },
          data: { lastMessageAtTs: input.lastMessageAt },
        });
        return ok(toDto(updated));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(internalError(`渠道会话最后消息更新失败：${message}`));
      }
    },
  };
}
