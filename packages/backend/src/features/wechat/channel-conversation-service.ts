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
 * - replaceMappingRuntime：CAS 切换旧运行时映射，保留上一会话引用并收敛并发创建；
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
  runtimeOwner: string;
  previousConversationId: string | null;
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
    runtimeOwner: row.runtimeOwner,
    previousConversationId: row.previousConversationId,
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
            runtimeOwner: input.runtimeOwner ?? 'legacy',
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

    async replaceMappingRuntime(input) {
      if (!input.id.trim()) return err(validationError('映射 ID 不能为空', 'id'));
      if (!input.channel.trim()) return err(validationError('渠道平台不能为空', 'channel'));
      if (!input.teacherId.trim()) return err(validationError('教师 ID 不能为空', 'teacherId'));
      if (!input.externalConversationId.trim()) {
        return err(validationError('外部会话标识不能为空', 'externalConversationId'));
      }
      if (!input.conversationId.trim()) return err(validationError('新会话 ID 不能为空', 'conversationId'));
      try {
        const changed = await prisma.channelConversation.updateMany({
          where: {
            id: input.id,
            channel: input.channel,
            teacherId: input.teacherId,
            externalConversationId: input.externalConversationId,
            conversationId: input.expectedConversationId,
            runtimeOwner: input.expectedRuntimeOwner,
          },
          data: {
            previousConversationId: input.expectedConversationId,
            conversationId: input.conversationId,
            runtimeOwner: input.runtimeOwner,
            lastMessageAtTs: input.lastMessageAt,
          },
        });
        const current = await prisma.channelConversation.findFirst({
          where: {
            id: input.id,
            channel: input.channel,
            teacherId: input.teacherId,
            externalConversationId: input.externalConversationId,
          },
        });
        if (!current) return err(internalError('渠道会话映射不存在'));
        if (changed.count === 1 || current.runtimeOwner === input.runtimeOwner) return ok(toDto(current));
        return err(validationError('渠道会话映射已变化，请重试当前消息', 'conversationId'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(internalError(`渠道会话运行时切换失败：${message}`));
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
