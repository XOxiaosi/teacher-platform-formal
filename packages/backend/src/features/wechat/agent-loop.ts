import { ok, err, internalError, type CommonError, type Result } from '@teacher-platform/contracts';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';
interface ConversationCreator {
  createConversation(input: { teacherId: string }): Promise<Result<{ id: string }, CommonError>>;
}

interface AgentConversePort {
  execute(input: {
    teacherId: string;
    conversationId: string;
    message: string;
    clientRequestId?: string;
  }): Promise<Result<{ reply: string | null }, CommonError>>;
}

import type {
  ChannelConversationService,
  NormalizedInboundMessage,
  WechatAgentLoop,
  WechatConversationResolver,
} from './types.js';

/**
 * S3 Agent 闭环（P8 t16 S3 + t23 S5，设计 p7-wechat-ilink-design.md §5/§10）。
 *
 * - 会话解析（S5 多会话）：按外部会话（私聊=发送方 wxid；群聊=群 ID）经 ChannelConversation 映射
 *   解析平台 Conversation——查映射复用；无则创建平台 Conversation + 记录映射；touch lastMessageAtTs；
 * - 幂等：clientRequestId = `wechat:<botId>:<externalMessageId>`（无 botId 时 `wechat:<externalMessageId>`），
 *   agent-converse 内建 AgentExecution claim（unique(teacherId, clientRequestId)）——同消息重放返回既有结果
 *   （replayed=true），不重复执行工具/不追加 turn；
 * - runInTeacherContext：worker 在 HTTP 请求外运行，装配线注入教师库上下文（runWithRequestDb + pool.acquire）；
 *   缺省透传（单库测试形态）。
 */

export function deriveClientRequestId(externalMessageId: string, botId?: string | null): string {
  return botId ? `wechat:${botId}:${externalMessageId}` : `wechat:${externalMessageId}`;
}

export function createWechatConversationResolver(options: {
  conversationService: ConversationCreator;
  channelConversations: ChannelConversationService;
  clock: TrustedClock;
}): WechatConversationResolver {
  const { conversationService, channelConversations, clock } = options;

  async function resolveForMessage(input: {
    teacherId: string;
    externalConversationId: string;
  }) {
    // 1. 查映射：外部会话 → 平台 Conversation（复用；多发送方各自独立会话）
    const found = await channelConversations.findMapping({
      channel: 'wechat',
      teacherId: input.teacherId,
      externalConversationId: input.externalConversationId,
    });
    if (!found.ok) return found;
    if (found.value) {
      // 2a. 命中：touch lastMessageAtTs（TrustedClock）
      const now = await clock.now();
      if (now.ok && now.value instanceof Date && !Number.isNaN(now.value.getTime())) {
        await channelConversations.touchLastMessage({ id: found.value.id, lastMessageAt: now.value });
      }
      return ok(found.value.conversationId);
    }
    // 2b. 未命中：创建平台 Conversation（教师库）→ 记录映射（共享库）
    const created = await conversationService.createConversation({
      teacherId: input.teacherId,
    });
    if (!created.ok) return created;
    const now = await clock.now();
    if (!now.ok) return err(now.error);
    if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
      return err(internalError('TrustedClock 返回无效时间'));
    }
    const recorded = await channelConversations.recordMapping({
      channel: 'wechat',
      teacherId: input.teacherId,
      externalConversationId: input.externalConversationId,
      conversationId: created.value.id,
      lastMessageAt: now.value,
    });
    if (!recorded.ok) return recorded;
    return ok(created.value.id);
  }

  return { resolveForMessage };
}

export interface CreateWechatAgentLoopOptions {
  agentConverse: AgentConversePort;
  conversationResolver: WechatConversationResolver;
  /** worker 在 HTTP 请求外运行：装配线注入教师库上下文（缺省透传）。 */
  runInTeacherContext?: <T>(teacherId: string, fn: () => Promise<T>) => Promise<T>;
}

export function createWechatAgentLoop(options: CreateWechatAgentLoopOptions): WechatAgentLoop {
  const runInTeacherContext = options.runInTeacherContext
    ?? (async <T>(_teacherId: string, fn: () => Promise<T>): Promise<T> => fn());

  return {
    async execute(input) {
      const { teacherId, message, botId } = input;
      return runInTeacherContext(teacherId, async () => {
        // S5 多会话：外部会话标识 = 私聊发送方 wxid（群聊=群 ID，S6）
        const conversation = await options.conversationResolver.resolveForMessage({
          teacherId,
          externalConversationId: message.fromExternalUserId,
        });
        if (!conversation.ok) return conversation;
        const clientRequestId = deriveClientRequestId(message.externalMessageId, botId);
        const agentResult = await options.agentConverse.execute({
          teacherId,
          conversationId: conversation.value,
          message: message.text,
          clientRequestId,
        });
        if (!agentResult.ok) return agentResult;
        return ok({ reply: agentResult.value.reply });
      });
    },
  };
}

/** 供恢复扫描/测试使用的消息重建（行 → 标准化入站消息）。 */
export function channelMessageRowToInbound(row: {
  channel: string;
  externalMessageId: string;
  fromExternalUserId: string;
  toExternalUserId: string | null;
  contentText: string;
}): NormalizedInboundMessage {
  return {
    channel: 'wechat',
    externalMessageId: row.externalMessageId,
    fromExternalUserId: row.fromExternalUserId,
    ...(row.toExternalUserId ? { toExternalUserId: row.toExternalUserId } : {}),
    conversationType: 'private',
    messageType: 'text',
    text: row.contentText,
  };
}
