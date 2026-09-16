import {
  createTeachingConversation,
  getTeachingTask,
  listTeachingTasks,
  resumeTeachingTask,
  sendTeachingTaskMessage,
  type TeachingTaskDto,
} from '../../api/teaching-tasks';
import type { AssistantTask, AssistantTransport } from './transport';

function summaryOf(task: TeachingTaskDto): string {
  return task.title || task.lastError?.message || '任务状态已保存，可从当前会话继续。';
}

function toAssistantTask(task: TeachingTaskDto): AssistantTask {
  return {
    id: task.id,
    status: task.status,
    summary: summaryOf(task),
    canResume: task.canResume,
  };
}

/** Formal assistant transport. It only calls the persisted teaching-task API;
 * model execution remains server-side and unavailable until a verified DSH
 * runtime is explicitly configured. */
export function createTeachingTaskTransport(): AssistantTransport {
  return {
    runtimeAvailability: 'unavailable',
    async createConversation({ teacherId }) {
      return (await createTeachingConversation(teacherId)).id;
    },
    async sendMessage({ teacherId, conversationId, message, clientRequestId }) {
      const result = await sendTeachingTaskMessage(teacherId, { conversationId, message, clientRequestId });
      return { accepted: true, task: toAssistantTask(result.task) };
    },
    async getTasks({ teacherId, conversationId }) {
      const result = await listTeachingTasks(teacherId, conversationId);
      return result.items.map(toAssistantTask);
    },
    async getTask({ teacherId, taskId }) {
      return toAssistantTask((await getTeachingTask(teacherId, taskId)).task);
    },
    async resumeTask({ teacherId, taskId }) {
      const current = (await getTeachingTask(teacherId, taskId)).task;
      return toAssistantTask((await resumeTeachingTask(teacherId, current)).task);
    },
  };
}
