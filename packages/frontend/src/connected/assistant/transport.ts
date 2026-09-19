import type {
  AgentTurnDto,
  ConversationDetailDto,
  ConversationListResponse,
  ConversationResponse,
  ConversationStatus,
  ConversationTurnsResponse,
} from '../../api/conversations';
import type { TeachingTaskEventDto } from '../../api/teaching-tasks';

export type AssistantTaskStatus = 'queued' | 'running' | 'waiting_input' | 'waiting_confirmation' | 'succeeded' | 'failed' | 'partial' | 'unavailable' | 'cancelled';
export interface AssistantTask {
  id: string;
  status: AssistantTaskStatus;
  summary: string;
  /** Server task version. Used only to de-duplicate workspace refresh notices. */
  version?: number;
  /** 服务端根据执行版本和运行时能力判断是否可以继续。 */
  canResume?: boolean;
}
export interface AssistantCapabilities {
  /** Can the connected assistant read the teacher's persisted workspace? */
  canRead: boolean;
  /** Can the connected assistant perform formal workspace writes in this session? */
  canWrite: boolean;
  /** High-impact formal writes still require an explicit teacher confirmation. */
  writeRequiresConfirmation: boolean;
}
export type AssistantTaskEvent = TeachingTaskEventDto & { taskId: string };
export interface AssistantConversationApi {
  list(teacherId: string, params: { status?: ConversationStatus; cursor?: string }): Promise<ConversationListResponse>;
  detail(teacherId: string, conversationId: string): Promise<ConversationResponse>;
  turns(teacherId: string, conversationId: string, params?: { before?: string }): Promise<ConversationTurnsResponse>;
  archive(teacherId: string, conversationId: string): Promise<ConversationResponse>;
}
/** Keeps the visual sample's confirmation controls inside its synthetic store. */
export interface AssistantPendingActionApi {
  confirm(input: { teacherId: string; actionId: string; actionToken: string }): Promise<void>;
  cancel(input: { teacherId: string; actionId: string }): Promise<void>;
}
export interface AssistantTransport {
  readonly runtimeAvailability?: 'available' | 'unavailable' | 'test_only';
  readonly capabilities?: AssistantCapabilities;
  /** Optional synthetic conversation source for the standalone visual sample. */
  readonly conversationApi?: AssistantConversationApi;
  /** Optional synthetic confirmation source for the standalone visual sample. */
  readonly pendingActionApi?: AssistantPendingActionApi;
  createConversation?(input: { teacherId: string }): Promise<string>;
  /** Resolve only after the server has durably accepted this idempotent request. */
  sendMessage(input: { teacherId: string; conversationId: string; message: string; clientRequestId: string }): Promise<{
    accepted: true; task: AssistantTask; turns?: AgentTurnDto[];
  }>;
  getTask?(input: { teacherId: string; conversationId: string; taskId: string }): Promise<AssistantTask>;
  getTasks?(input: { teacherId: string; conversationId: string }): Promise<AssistantTask[]>;
  /** 继续服务端已保存但未完成的任务；不会重新发送原消息。 */
  resumeTask?(input: { teacherId: string; conversationId: string; taskId: string }): Promise<AssistantTask>;
  getTaskEvents?(input: { teacherId: string; conversationId: string; taskId: string; afterSeq?: number }): Promise<{ items: AssistantTaskEvent[]; nextSeq: number | null }>;
}
export const taskLabels: Record<AssistantTaskStatus, string> = {
  queued: '等待处理', running: '正在处理', waiting_input: '待补充信息', waiting_confirmation: '待确认',
  succeeded: '本轮回复已结束', failed: '本轮未完成', partial: '本轮部分完成', unavailable: '已收到，AI 服务尚不可用', cancelled: '已取消',
};
