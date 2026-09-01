import type { CommonError, Result } from '@teacher-platform/contracts';
import type { AiClient } from '../../../shared/ai-client/types.js';
import type { ToolRegistry } from '../../../shared/tool-registry/types.js';
import type { ConversationService } from '../../../features/conversation/types.js';
import type { ConfirmationGateway } from '../../confirmation/types.js';
import type { AgentExecutionService, AgentExecutionStatus } from '../../../features/agent-execution/index.js';
import type { ExecutionRunners } from '../../reliability/execution-runners.js';
import type { TrustedClock } from '../../../shared/trusted-clock/index.js';
import type { PresentationBuilder } from '../../presentation/index.js';
import type { BudgetTracker } from '../../../shared/agent-cost/index.js';

export interface AgentConverseInput {
  teacherId: string;
  conversationId: string;
  message: string;
  clientRequestId?: string;
}

export interface AgentConverseOutput {
  conversationId: string;
  reply: string | null;
  executionId?: string;
  status?: AgentExecutionStatus;
  replayed?: boolean;
}

export interface AgentConverseDependencies {
  conversationService: ConversationService;
  aiClient: AiClient;
  toolRegistry: ToolRegistry;
  confirmationGateway?: ConfirmationGateway;
  agentExecutions?: AgentExecutionService;
  executionRunners?: ExecutionRunners;
  trustedClock?: TrustedClock;
  businessTimeZone?: 'Asia/Shanghai';
  presentationBuilder?: PresentationBuilder;
  /** 成本控制（t48 装配交接）：入口按本轮消息记账，超限返回 BUDGET_EXCEEDED；同时用于单轮上下文截断 */
  budgetTracker?: BudgetTracker;
  /** 单轮上下文 token 上限（truncateHistory 截断预算；缺省 8000，与 agent-cost env 默认一致） */
  perTurnTokenLimit?: number;
}

export interface AgentConverseUseCase {
  execute(input: AgentConverseInput): Promise<Result<AgentConverseOutput, CommonError>>;
}
