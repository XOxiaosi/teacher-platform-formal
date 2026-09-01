export { createAiClient } from './ai-client.js';
export {
  createArkAiProvider,
  createArkAiProviderFromEnv,
  createFailClosedAiProvider,
} from './ark-provider.js';
export { createRoutingAiClient, runAsTeacher, currentTeacherId } from './routing-ai-client.js';
export { createProviderConfigRouter } from './provider-router.js';
export type {
  AiClient,
  AiOutput,
  AiProvider,
  AiTask,
  AiTaskType,
  ChatMessage,
  ChatResponse,
  ChatToolDefinition,
  CreateAiClientOptions,
  ToolCall,
} from './types.js';
export type {
  CreateRoutingAiClientOptions,
  ProviderRouter,
  ResolvedProvider,
  UsageRecordInput,
} from './routing-ai-client.js';
export type {
  CreateProviderRouterOptions,
  ProviderConfigRow,
  ProviderRouterImpl,
} from './provider-router.js';
