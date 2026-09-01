import { err, ok, internalError, validationError, budgetExceeded } from '@teacher-platform/contracts';
import type { CommonError } from '@teacher-platform/contracts';
import type { ChatMessage, ChatToolDefinition, ToolCall } from '../../../shared/ai-client/types.js';
import type { ToolDefinition } from '../../../shared/tool-registry/types.js';
import { formatTeacherTimeContext } from '../../../shared/trusted-clock/index.js';
import { estimateTokens, truncateHistory } from '../../../shared/agent-cost/index.js';
import type { AgentExecutionStage, RetryAction } from '../../../features/agent-execution/index.js';
import {
  createAssistantPresentationEnvelope,
  createPresentationBuilder,
  type PresentationToolResult,
} from '../../presentation/index.js';
import type { AgentConverseDependencies, AgentConverseInput, AgentConverseUseCase } from './types.js';

const MAX_TOOL_ROUNDS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function persistedToolCall(toolCall: ToolCall, definition?: ToolDefinition): ToolCall {
  if (definition?.confirmation !== 'required' || !isRecord(toolCall.args)) return toolCall;
  const properties = isRecord(definition.parameters.properties)
    ? definition.parameters.properties
    : {};
  return {
    ...toolCall,
    args: Object.fromEntries(
      Object.entries(toolCall.args).filter(([key]) => Object.hasOwn(properties, key)),
    ),
  };
}

function executionOutput(execution: {
  id: string;
  conversationId: string;
  status: 'running' | 'succeeded' | 'failed' | 'partial' | 'waiting_confirmation';
  reply: string | null;
}, replayed: boolean) {
  return {
    conversationId: execution.conversationId,
    executionId: execution.id,
    status: execution.status,
    reply: execution.reply,
    replayed,
  };
}

export function createAgentConverseUseCase(deps: AgentConverseDependencies): AgentConverseUseCase {
  const { conversationService, aiClient, toolRegistry } = deps;
  const presentationBuilder = deps.presentationBuilder ?? createPresentationBuilder();

  return {
    async execute(input: AgentConverseInput) {
      const { teacherId, conversationId, message } = input;
      let executionId: string | undefined;
      const completedToolCallIds: string[] = [];
      const successfulToolResults: PresentationToolResult[] = [];
      let completedWriteTool = false;

      if (deps.agentExecutions) {
        if (!input.clientRequestId) {
          return err(validationError('缺少 clientRequestId', 'clientRequestId'));
        }
        const claim = await deps.agentExecutions.claim({
          teacherId,
          conversationId,
          message,
          clientRequestId: input.clientRequestId,
        });
        if (!claim.ok) return claim;
        if (claim.value.kind === 'existing') {
          return ok(executionOutput(claim.value.execution, true));
        }
        executionId = claim.value.execution.id;
      } else {
        const userTurnResult = await conversationService.appendTurn({
          conversationId,
          teacherId,
          role: 'user',
          content: message,
        });
        if (!userTurnResult.ok) return userTurnResult;
      }

      const failExecution = async (
        error: CommonError,
        stage: AgentExecutionStage,
        retryable: boolean,
        retryAction: RetryAction,
        status: 'failed' | 'partial' = 'failed',
      ) => {
        if (!executionId || !deps.agentExecutions) return err(error);
        const failed = await deps.agentExecutions.fail({
          teacherId,
          executionId,
          stage,
          status,
          error,
          retryable,
          retryAction,
          completedToolCallIds,
        });
        if (!failed.ok) return failed;
        return ok(executionOutput(failed.value, false));
      };

      const completeExecution = async (
        status: 'succeeded' | 'waiting_confirmation',
        stage: AgentExecutionStage,
        reply: string,
      ) => {
        if (!executionId || !deps.agentExecutions) return ok({ conversationId, reply });
        const completed = await deps.agentExecutions.complete({
          teacherId,
          executionId,
          status,
          stage,
          reply,
          completedToolCallIds,
        });
        if (!completed.ok) return completed;
        return ok(executionOutput(completed.value, false));
      };

      // 成本控制（t48 装配交接）：入口按本轮用户消息估算记账；超限收口 execution（防卡 running）并返回 BUDGET_EXCEEDED
      if (deps.budgetTracker) {
        const consumed = deps.budgetTracker.checkAndConsume(teacherId, estimateTokens(message));
        if (!consumed.ok) {
          const budgetError = budgetExceeded(
            consumed.turnExceeded
              ? '本轮请求超出单轮 Token 预算，请精简问题后重试'
              : '今日 Agent Token 预算已用尽，请明日再试',
          );
          if (executionId && deps.agentExecutions) {
            const failed = await deps.agentExecutions.fail({
              teacherId,
              executionId,
              stage: 'model',
              status: 'failed',
              error: budgetError,
              retryable: false,
              retryAction: 'none',
              completedToolCallIds,
            });
            if (!failed.ok) return failed;
          }
          return err(budgetError);
        }
      }

      const contextResult = await conversationService.buildContext({ conversationId, teacherId });
      if (!contextResult.ok) {
        return failExecution(contextResult.error, 'conversation', false, 'none');
      }

      const tools = toolRegistry.list();
      const definitionsByName = new Map(tools.map((tool) => [tool.name, tool]));
      const chatTools: ChatToolDefinition[] = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));

      let toolRound = 0;
      let currentContext = contextResult.value;

      while (true) {
        const messages: ChatMessage[] = currentContext
          .filter((message) => message.role !== 'error')
          .map((contextMessage) => ({
            role: contextMessage.role as ChatMessage['role'],
            content: contextMessage.content,
            toolCalls: contextMessage.toolCalls as ChatMessage['toolCalls'],
            toolCallId: contextMessage.toolCallId,
          }));

        if (deps.trustedClock) {
          const trustedNow = await deps.trustedClock.now();
          if (!trustedNow.ok) {
            const retryable = !completedWriteTool;
            return failExecution(
              trustedNow.error,
              'conversation',
              retryable,
              retryable ? 'retry-model' : 'none',
              completedWriteTool ? 'partial' : 'failed',
            );
          }
          messages.unshift({
            role: 'system',
            content: formatTeacherTimeContext({
              now: trustedNow.value,
              timeZone: deps.businessTimeZone ?? 'Asia/Shanghai',
            }),
          });
        }

        // 成本控制（t48 装配交接）：单轮上下文超预算时截断最旧回合（system 首条恒保留）
        const budgetMessages = deps.budgetTracker && deps.perTurnTokenLimit !== undefined
          ? truncateHistory(messages, deps.perTurnTokenLimit) as ChatMessage[]
          : messages;

        const chatOperation = () => aiClient.chat(budgetMessages, chatTools);
        const chatResult = deps.executionRunners
          ? await deps.executionRunners.runModel(chatOperation, executionId)
          : await chatOperation();
        if (!chatResult.ok) {
          return failExecution(chatResult.error, 'model', true, 'retry-model');
        }

        const response = chatResult.value;
        if (!response.toolCalls || response.toolCalls.length === 0) {
          const presentation = presentationBuilder.build({
            summary: response.content,
            toolResults: successfulToolResults,
          });
          const assistantTurnResult = await conversationService.appendTurn({
            conversationId,
            teacherId,
            role: 'assistant',
            content: response.content,
            toolResults: createAssistantPresentationEnvelope(presentation),
          });
          if (!assistantTurnResult.ok) {
            return failExecution(assistantTurnResult.error, 'persistence', false, 'none');
          }
          return completeExecution('succeeded', 'model', response.content);
        }

        if (toolRound >= MAX_TOOL_ROUNDS) {
          return failExecution(
            internalError('Agent 已达到工具调用上限，请缩小任务范围后重试'),
            'tool',
            false,
            'none',
            completedWriteTool ? 'partial' : 'failed',
          );
        }

        const assistantTurnResult = await conversationService.appendTurn({
          conversationId,
          teacherId,
          role: 'assistant',
          content: response.content || '正在调用工具',
          toolCalls: response.toolCalls.map((toolCall) => (
            persistedToolCall(toolCall, definitionsByName.get(toolCall.name))
          )),
        });
        if (!assistantTurnResult.ok) {
          return failExecution(assistantTurnResult.error, 'persistence', false, 'none');
        }

        for (const toolCall of response.toolCalls) {
          const definition = definitionsByName.get(toolCall.name);
          const sideEffect = definition?.sideEffect ?? 'destructive';
          if (definition?.confirmation === 'required') {
            const confirmationResult = deps.confirmationGateway
              ? await deps.confirmationGateway.requestConfirmation({
                teacherId,
                conversationId,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                args: toolCall.args,
              })
              : err(internalError('ConfirmationGateway 未配置'));
            const toolTurnResult = await conversationService.appendTurn({
              conversationId,
              teacherId,
              role: 'tool',
              content: confirmationResult.ok
                ? JSON.stringify(confirmationResult.value)
                : `Error: ${confirmationResult.error.message}`,
              toolResults: {
                toolCallId: toolCall.id,
                ...(!confirmationResult.ok ? { error: confirmationResult.error } : {}),
              },
            });
            if (!toolTurnResult.ok) {
              return failExecution(toolTurnResult.error, 'persistence', false, 'none');
            }
            if (!confirmationResult.ok) {
              return failExecution(confirmationResult.error, 'confirmation', false, 'none');
            }
            return completeExecution(
              'waiting_confirmation',
              'confirmation',
              '操作待确认，请在确认卡中核对后继续。',
            );
          }

          const toolOperation = () => toolRegistry.execute(
            toolCall.name,
            toolCall.args,
            { teacherId },
          );
          const toolResult = deps.executionRunners && executionId
            ? await deps.executionRunners.runTool({
              executionId,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              sideEffect,
            }, toolOperation)
            : await toolOperation();

          const toolTurnResult = await conversationService.appendTurn({
            conversationId,
            teacherId,
            role: 'tool',
            content: toolResult.ok
              ? JSON.stringify(toolResult.value)
              : `Error: ${toolResult.error.message}`,
            toolResults: {
              toolCallId: toolCall.id,
              ...(!toolResult.ok ? { error: toolResult.error } : {}),
            },
          });
          if (!toolTurnResult.ok) {
            return failExecution(toolTurnResult.error, 'persistence', false, 'none');
          }
          if (!toolResult.ok && executionId) {
            const retryable = sideEffect === 'read' && !completedWriteTool;
            return failExecution(
              toolResult.error,
              'tool',
              retryable,
              retryable ? 'retry-tool' : 'none',
              completedWriteTool ? 'partial' : 'failed',
            );
          }
          if (toolResult.ok) {
            completedToolCallIds.push(toolCall.id);
            successfulToolResults.push({
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              value: toolResult.value,
            });
            if (sideEffect !== 'read') completedWriteTool = true;
          }
        }

        const newContextResult = await conversationService.buildContext({ conversationId, teacherId });
        if (!newContextResult.ok) {
          return failExecution(newContextResult.error, 'conversation', false, 'none');
        }
        currentContext = newContextResult.value;
        toolRound++;
      }
    },
  };
}
