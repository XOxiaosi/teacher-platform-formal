import type { AgentTurnDto } from '../../api/conversations';

export type AssistantTaskStatus = 'queued' | 'running' | 'waiting_input' | 'waiting_confirmation' | 'succeeded' | 'failed' | 'partial' | 'unavailable' | 'cancelled';
export interface AssistantTask {
  id: string;
  status: AssistantTaskStatus;
  summary: string;
  /** 服务端根据执行版本和运行时能力判断是否可以继续。 */
  canResume?: boolean;
}
export interface AssistantTransport {
  readonly runtimeAvailability?: 'available' | 'unavailable' | 'test_only';
  createConversation?(input: { teacherId: string }): Promise<string>;
  /** Resolve only after the server has durably accepted this idempotent request. */
  sendMessage(input: { teacherId: string; conversationId: string; message: string; clientRequestId: string }): Promise<{
    accepted: true; task: AssistantTask; turns?: AgentTurnDto[];
  }>;
  getTask?(input: { teacherId: string; conversationId: string; taskId: string }): Promise<AssistantTask>;
  getTasks?(input: { teacherId: string; conversationId: string }): Promise<AssistantTask[]>;
  /** 继续服务端已保存但未完成的任务；不会重新发送原消息。 */
  resumeTask?(input: { teacherId: string; conversationId: string; taskId: string }): Promise<AssistantTask>;
}
export const taskLabels: Record<AssistantTaskStatus, string> = {
  queued: '等待处理', running: '正在处理', waiting_input: '待补充信息', waiting_confirmation: '待确认',
  succeeded: '已完成', failed: '未完成', partial: '部分完成', unavailable: '已收到，AI 服务尚不可用', cancelled: '已取消',
};
