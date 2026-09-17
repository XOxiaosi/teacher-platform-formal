import {
  createTeachingConversation,
  getTeachingTask,
  listTeachingTasks,
  listTeachingTaskEvents,
  resumeTeachingTask,
  sendTeachingTaskMessage,
  type TeachingTaskDto,
  type TeachingTaskEventDto,
} from '../../api/teaching-tasks';
import type { AssistantCapabilities, AssistantTask, AssistantTransport } from './transport';

function summaryOf(task: TeachingTaskDto): string {
  const title = task.title?.trim();
  const genericTitles = new Set(['任务状态已保存，可从当前会话继续。', '任务状态已更新']);
  return title && !genericTitles.has(title) ? title : task.lastError?.message || '未提供任务摘要，请查看会话内容。';
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
 * teacher-scoped reads and student-list writes are handled by the server-side
 * runtime, while model execution remains unavailable until a verified DSH
 * runtime is explicitly configured. */
export function createTeachingTaskTransport(
  options: {
    runtimeAvailability?: AssistantTransport['runtimeAvailability'];
    capabilities?: AssistantCapabilities;
  } = {},
): AssistantTransport {
  return {
    runtimeAvailability: options.runtimeAvailability ?? 'unavailable',
    capabilities: options.capabilities ?? { canRead: true, canWrite: true, writeRequiresConfirmation: false },
    async createConversation({ teacherId }) {
      return (await createTeachingConversation(teacherId)).id;
    },
    async sendMessage({ teacherId, conversationId, message, clientRequestId }) {
      const result = await sendTeachingTaskMessage(teacherId, { conversationId, message, clientRequestId });
      if (!result?.receipt || result.receipt.clientRequestId !== clientRequestId
        || !result.receipt.executionId || !result.receipt.userTurnId
        || !Number.isFinite(Date.parse(result.receipt.receivedAt))
        || !result.task?.id || result.task.conversationId !== conversationId) {
        throw new Error('未取得与本条消息匹配的持久接收回执');
      }
      return { accepted: true, task: toAssistantTask(result.task) };
    },
    async getTasks({ teacherId, conversationId }) {
      const tasks: TeachingTaskDto[] = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      do {
        const result = await listTeachingTasks(teacherId, conversationId, cursor ? { cursor } : {});
        tasks.push(...result.items);
        const nextCursor = result.nextCursor ?? undefined;
        if (!nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor);
      return tasks.map(toAssistantTask);
    },
    async getTask({ teacherId, taskId }) {
      return toAssistantTask((await getTeachingTask(teacherId, taskId)).task);
    },
    async resumeTask({ teacherId, taskId }) {
      const current = (await getTeachingTask(teacherId, taskId)).task;
      return toAssistantTask((await resumeTeachingTask(teacherId, current)).task);
    },
    async getTaskEvents({ teacherId, taskId, afterSeq }) {
      const events: TeachingTaskEventDto[] = [];
      let cursor = afterSeq;
      const seenCursors = new Set<number>();
      for (;;) {
        const result = await listTeachingTaskEvents(teacherId, taskId, cursor);
        for (const event of result.items) {
          if (!events.some(existing => existing.eventKey === event.eventKey)) events.push(event);
        }
        if (result.nextSeq === null || (cursor !== undefined && result.nextSeq <= cursor) || seenCursors.has(result.nextSeq)) {
          return { items: events, nextSeq: result.nextSeq };
        }
        seenCursors.add(result.nextSeq);
        cursor = result.nextSeq;
      }
    },
  };
}
