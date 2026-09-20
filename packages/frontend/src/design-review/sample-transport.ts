import type {
  AgentTurnDto,
  AssistantTurnDto,
  ConfirmationTurnDto,
  ConversationDetailDto,
  ConversationSummaryDto,
  ConversationStatus,
  ObjectReferenceDto,
  UserTurnDto,
} from '../api/conversations';
import type { TeachingTaskEventDto } from '../api/teaching-tasks';
import type { AssistantTask, AssistantTaskEvent, AssistantTransport } from '../connected/assistant/transport';

/** The initial conversation used by the standalone UI-003 visual review. */
export const DEFAULT_REVIEW_CONVERSATION = 'review-conversation-main';

const TEACHER_ID = 'review-teacher';
const BASE_TIME = '2026-09-20T09:00:00.000Z';
const DEMO_REPLY = '### 合成演示回复\n\n这是一条合成演示回复，未调用模型，也不会写入真实教学资料。';

type StoredConversation = {
  detail: ConversationDetailDto;
  turns: AgentTurnDto[];
};

type StoredTask = AssistantTask & { conversationId: string; events: AssistantTaskEvent[] };

function reference(type: ObjectReferenceDto['type'], id: string, label: string, route: string): ObjectReferenceDto {
  return { type, id, label, route };
}

function userTurn(id: string, conversationId: string, content: string, createdAt: string, taskId?: string): UserTurnDto {
  return { id, conversationId, kind: 'user', taskId, inputSource: 'text', content, createdAt };
}

function assistantTurn(id: string, conversationId: string, content: string, createdAt: string, taskId?: string): AssistantTurnDto {
  return { id, conversationId, kind: 'assistant', taskId, references: [], content, createdAt };
}

function buildInitialState(): { conversations: Map<string, StoredConversation>; tasks: Map<string, StoredTask> } {
  const mainTask: StoredTask = {
    id: 'review-task-students', conversationId: DEFAULT_REVIEW_CONVERSATION, status: 'succeeded', version: 1,
    summary: '已整理学生学习记录', canResume: false, events: [{
      taskId: 'review-task-students', seq: 1, eventKey: 'review:students:done', eventKind: 'assistant_message',
      executionId: 'review-execution-students', role: 'assistant', content: '### 已整理\n\n李雨桐目前剩余 6 课时，最近一次课程已完成。', createdAt: '2026-09-20T09:01:00.000Z',
    }, {
      taskId: 'review-task-students', seq: 2, eventKey: 'review:students:terminal', eventKind: 'task_state',
      executionId: 'review-execution-students', role: 'assistant', content: '任务已完成（合成演示）。', createdAt: '2026-09-20T09:01:01.000Z',
    }],
  };
  const confirmationTask: StoredTask = {
    id: 'review-task-schedule', conversationId: DEFAULT_REVIEW_CONVERSATION, status: 'waiting_confirmation', version: 1,
    summary: '课程安排待确认', canResume: false, events: [{
      taskId: 'review-task-schedule', seq: 1, eventKey: 'review:schedule:pending', eventKind: 'task_state',
      executionId: 'review-execution-schedule', role: 'assistant', content: '课程安排等待教师确认。', createdAt: '2026-09-20T09:03:00.000Z',
    }],
  };
  const failedTask: StoredTask = {
    id: 'review-task-feedback', conversationId: 'review-conversation-feedback', status: 'failed', version: 2,
    summary: '反馈草稿生成失败，可重试', canResume: true, events: [{
      taskId: 'review-task-feedback', seq: 1, eventKey: 'review:feedback:failed', eventKind: 'task_error',
      executionId: 'review-execution-feedback', role: 'error', content: '合成反馈生成失败，可重试。', createdAt: '2026-09-20T08:42:00.000Z',
    }],
  };

  const confirmation: ConfirmationTurnDto = {
    id: 'review-confirmation-schedule', conversationId: DEFAULT_REVIEW_CONVERSATION, taskId: confirmationTask.id,
    kind: 'confirmation', actionId: 'review-action-schedule', actionName: 'scheduling.create',
    target: { type: 'Schedule', id: 'review-schedule-proposal' }, beforeSummary: null,
    afterSummary: '周三 19:00 为李雨桐安排一节数学课，线上会议室，仅本次安排。',
    parameterSummary: { student: '李雨桐', day: '周三', time: '19:00–20:00', location: '线上会议室' },
    status: 'pending', expiresAt: '2099-12-31T23:59:59.000Z', actionToken: 'review-action-token', error: null,
    createdAt: '2026-09-20T09:03:00.000Z',
  };
  const mainTurns: AgentTurnDto[] = [
    userTurn('review-user-1', DEFAULT_REVIEW_CONVERSATION, '整理一下李雨桐最近的学习记录。', '2026-09-20T09:00:00.000Z', mainTask.id),
    {
      ...assistantTurn('review-tool-1', DEFAULT_REVIEW_CONVERSATION, '学生李雨桐：初三，剩余 6 课时。', '2026-09-20T09:01:00.000Z', mainTask.id),
      references: [reference('Student', 's1', '李雨桐', '/students/s1')],
    },
    assistantTurn('review-assistant-1', DEFAULT_REVIEW_CONVERSATION, '### 已整理\n\n李雨桐目前剩余 6 课时，最近一次课程已完成。', '2026-09-20T09:01:30.000Z', mainTask.id),
    userTurn('review-user-2', DEFAULT_REVIEW_CONVERSATION, '那安排周三晚上的数学课。', '2026-09-20T09:02:00.000Z', confirmationTask.id),
    confirmation,
  ];
  const feedbackTurns: AgentTurnDto[] = [
    userTurn('review-feedback-user', failedTask.conversationId, '生成本周家长反馈草稿。', '2026-09-20T08:41:00.000Z', failedTask.id),
    {
      id: 'review-feedback-error', conversationId: failedTask.conversationId, taskId: failedTask.id, kind: 'error',
      executionId: 'review-execution-feedback', stage: 'model',
      error: { code: 'INTERNAL_ERROR', message: '合成演示故意保留的失败状态。' }, retryable: true,
      retryAction: 'retry-model', completedToolCallIds: [], createdAt: '2026-09-20T08:42:00.000Z',
    },
  ];
  const conversations = new Map<string, StoredConversation>();
  conversations.set(DEFAULT_REVIEW_CONVERSATION, {
    turns: mainTurns,
    detail: {
      id: DEFAULT_REVIEW_CONVERSATION, status: 'active', displayTitle: '本周学习记录与排课',
      summary: '整理学生记录，并准备一项待确认课程安排。', lastMessagePreview: '课程安排等待确认',
      lastTurnAt: '2026-09-20T09:03:00.000Z', createdAt: BASE_TIME, updatedAt: '2026-09-20T09:03:00.000Z', turnCount: mainTurns.length,
    },
  });
  conversations.set(failedTask.conversationId, {
    turns: feedbackTurns,
    detail: {
      id: failedTask.conversationId, status: 'active', displayTitle: '家长反馈草稿',
      summary: '保留一条可重试的失败状态。', lastMessagePreview: '合成反馈生成失败',
      lastTurnAt: '2026-09-20T08:42:00.000Z', createdAt: '2026-09-20T08:41:00.000Z', updatedAt: '2026-09-20T08:42:00.000Z', turnCount: feedbackTurns.length,
    },
  });
  return { conversations, tasks: new Map([mainTask, confirmationTask, failedTask].map(task => [task.id, task])) };
}

function cloneTask(task: StoredTask): AssistantTask {
  const { conversationId: _conversationId, events: _events, ...publicTask } = task;
  return { ...publicTask };
}

function cloneConversation(detail: ConversationDetailDto, turns: AgentTurnDto[]): ConversationDetailDto {
  return { ...detail, turnCount: turns.length, lastTurnAt: turns.at(-1)?.createdAt ?? detail.lastTurnAt, updatedAt: turns.at(-1)?.createdAt ?? detail.updatedAt };
}

/**
 * Pure in-memory transport for UI-003. All replies explicitly describe the
 * synthetic demo and no method reaches an HTTP API, model, or persisted store.
 */
export function createReviewTransport(): AssistantTransport {
  const { conversations, tasks } = buildInitialState();
  let sequence = 0;

  const assertTeacher = (teacherId: string) => { if (teacherId !== TEACHER_ID) throw new Error('合成教师不存在'); };
  const getConversation = (id: string) => conversations.get(id);
  const makeSummary = (entry: StoredConversation): ConversationSummaryDto => {
    const detail = cloneConversation(entry.detail, entry.turns);
    return { ...detail };
  };
  const setConfirmationStatus = (status: 'consumed' | 'cancelled') => {
    const entry = getConversation(DEFAULT_REVIEW_CONVERSATION);
    const index = entry?.turns.findIndex(turn => turn.kind === 'confirmation' && turn.actionId === 'review-action-schedule') ?? -1;
    if (!entry || index < 0) return;
    const turn = entry.turns[index];
    if (turn.kind === 'confirmation' && turn.status === 'pending') entry.turns[index] = { ...turn, status, actionToken: null };
    const task = tasks.get('review-task-schedule');
    if (task && task.status === 'waiting_confirmation') Object.assign(task, { status: status === 'consumed' ? 'succeeded' : 'cancelled', version: task.version! + 1, summary: '' });
  };

  const transport: AssistantTransport = {
    runtimeAvailability: 'test_only',
    capabilities: { canRead: true, canWrite: false, writeRequiresConfirmation: true },
    conversationApi: {
      async list(teacherId, params) {
        assertTeacher(teacherId);
        const items = [...conversations.values()]
          .filter(entry => !params.status || entry.detail.status === params.status)
          .map(makeSummary);
        return { items, nextCursor: null };
      },
      async detail(teacherId, conversationId) {
        assertTeacher(teacherId);
        const entry = getConversation(conversationId);
        if (!entry) throw new Error('合成会话不存在');
        return { conversation: cloneConversation(entry.detail, entry.turns) };
      },
      async turns(teacherId, conversationId) {
        assertTeacher(teacherId);
        const entry = getConversation(conversationId);
        if (!entry) throw new Error('合成会话不存在');
        return { items: [...entry.turns], previousCursor: null };
      },
      async archive(teacherId, conversationId) {
        assertTeacher(teacherId);
        const entry = getConversation(conversationId);
        if (!entry) throw new Error('合成会话不存在');
        entry.detail = { ...entry.detail, status: 'archived' };
        return { conversation: cloneConversation(entry.detail, entry.turns) };
      },
    },
    pendingActionApi: {
      async confirm({ teacherId, actionId, actionToken }) {
        if (teacherId !== TEACHER_ID || actionId !== 'review-action-schedule' || actionToken !== 'review-action-token') throw new Error('合成确认参数无效');
        setConfirmationStatus('consumed');
      },
      async cancel({ teacherId, actionId }) {
        if (teacherId !== TEACHER_ID || actionId !== 'review-action-schedule') throw new Error('合成取消参数无效');
        setConfirmationStatus('cancelled');
      },
    },
    async createConversation({ teacherId }) {
      assertTeacher(teacherId);
      sequence += 1;
      const id = `review-conversation-new-${sequence}`;
      conversations.set(id, { detail: {
        id, status: 'active', displayTitle: '新的教学助手会话', summary: null, lastMessagePreview: null,
        lastTurnAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), turnCount: 0,
      }, turns: [] });
      return id;
    },
    async sendMessage({ teacherId, conversationId, message, clientRequestId }) {
      assertTeacher(teacherId);
      const entry = getConversation(conversationId);
      if (!entry) throw new Error('合成会话不存在');
      sequence += 1;
      const previousTimes = entry.turns
        .map(turn => Date.parse(turn.createdAt))
        .filter(Number.isFinite);
      const userAt = Math.max(Date.now(), ...previousTimes.map(time => time + 1));
      const now = new Date(userAt).toISOString();
      const task: StoredTask = {
        id: `review-task-message-${sequence}`, conversationId, status: 'succeeded', version: 1,
        summary: '', canResume: false, events: [],
      };
      const assistantAt = new Date(userAt + 1).toISOString();
      entry.turns.push(userTurn(`review-sent-user-${sequence}`, conversationId, message, now, task.id), assistantTurn(`review-sent-assistant-${sequence}`, conversationId, DEMO_REPLY, assistantAt, task.id));
      entry.detail = { ...entry.detail, lastMessagePreview: DEMO_REPLY, lastTurnAt: assistantAt, updatedAt: assistantAt, turnCount: entry.turns.length };
      task.events.push(
        { taskId: task.id, seq: 1, eventKey: `review:message:${clientRequestId}`, eventKind: 'assistant_message', executionId: `review-execution-${sequence}`, role: 'assistant', content: DEMO_REPLY, createdAt: assistantAt },
        { taskId: task.id, seq: 2, eventKey: `review:message:${clientRequestId}:terminal`, eventKind: 'task_state', executionId: `review-execution-${sequence}`, role: 'assistant', content: '任务已完成（合成演示）。', createdAt: assistantAt },
      );
      tasks.set(task.id, task);
      return { accepted: true, task: cloneTask(task) };
    },
    async resumeTask({ teacherId, conversationId, taskId }) {
      const task = tasks.get(taskId);
      const entry = getConversation(conversationId);
      if (teacherId !== TEACHER_ID || !task || task.conversationId !== conversationId || !entry) throw new Error('合成任务不存在');
      if (!task.canResume) return cloneTask(task);
      const timestamp = Math.max(Date.now(), ...entry.turns.map(turn => Date.parse(turn.createdAt) + 1));
      const createdAt = new Date(timestamp).toISOString();
      const content = '### 演示恢复完成\n\n这里展示失败后继续处理的回复效果，未调用真实模型，也未写入教学资料。';
      entry.turns.push(assistantTurn(`review-resumed-${taskId}`, conversationId, content, createdAt, taskId));
      task.events.push(
        { taskId, seq: 2, eventKey: `review:${taskId}:resumed`, eventKind: 'assistant_message', executionId: 'review-execution-resumed', role: 'assistant', content, createdAt },
        { taskId, seq: 3, eventKey: `review:${taskId}:resumed:terminal`, eventKind: 'task_state', executionId: 'review-execution-resumed', role: 'assistant', content: '演示回复已结束。', createdAt },
      );
      Object.assign(task, { status: 'succeeded', canResume: false, version: (task.version ?? 0) + 1, summary: '演示恢复完成，未调用真实模型。' });
      return cloneTask(task);
    },
    async getTask({ teacherId, conversationId, taskId }) {
      if (teacherId !== TEACHER_ID) throw new Error('合成教师不存在');
      const task = tasks.get(taskId);
      if (!task || task.conversationId !== conversationId) throw new Error('合成任务不存在');
      return cloneTask(task);
    },
    async getTasks({ teacherId, conversationId }) {
      if (teacherId !== TEACHER_ID) throw new Error('合成教师不存在');
      return [...tasks.values()].filter(task => task.conversationId === conversationId).map(cloneTask);
    },
    async getTaskEvents({ teacherId, conversationId, taskId, afterSeq }) {
      if (teacherId !== TEACHER_ID) throw new Error('合成教师不存在');
      const task = tasks.get(taskId);
      if (!task || task.conversationId !== conversationId) throw new Error('合成任务不存在');
      const items = task.events.filter(event => event.seq > (afterSeq ?? 0));
      return { items, nextSeq: items.at(-1)?.seq ?? null };
    },
  };
  return transport;
}
