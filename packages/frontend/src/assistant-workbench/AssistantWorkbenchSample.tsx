import type { AgentTurnDto, ConfirmationTurnDto, ConversationDetailDto } from '../api/conversations';
import { AssistantWorkspace } from '../connected/assistant';
import type { AssistantTask, AssistantTaskEvent, AssistantTransport } from '../connected/assistant/transport';

const createdAt = '2026-09-19T08:30:00Z';
let nextSequence = 9;
const tasks: AssistantTask[] = [
  { id: 'sample-task-students', status: 'succeeded', version: 2, summary: '', canResume: false },
  { id: 'sample-task-schedule', status: 'waiting_confirmation', version: 1, summary: '课程待确认', canResume: false },
  { id: 'sample-task-memo', status: 'failed', version: 2, summary: '备忘未保存，可重试。', canResume: true },
  { id: 'sample-task-capability', status: 'unavailable', version: 1, summary: '班级自动匹配能力尚未接入。', canResume: false },
];
const scheduleProposal: ConfirmationTurnDto = {
  id: 'sample-confirmation-schedule', conversationId: 'sample-conversation', taskId: 'sample-task-schedule', kind: 'confirmation', actionId: 'sample-action-schedule',
  actionName: 'scheduling.create', target: { type: 'Schedule', id: 'sample-proposal-schedule' }, beforeSummary: null,
  afterSummary: '2026年9月23日（周三）19:00–20:00，在合成教室为小明安排一对一课程；仅本次安排，不扣课。', parameterSummary: {}, status: 'pending',
  expiresAt: '2099-09-19T12:00:00Z', actionToken: 'sample-only-confirmation-token', error: null, createdAt: '2026-09-19T08:33:00Z',
};
const turns: AgentTurnDto[] = [
  { id: 'sample-user-1', conversationId: 'sample-conversation', taskId: 'sample-task-students', kind: 'user', inputSource: 'text', content: '登记小明（初二），安排周三晚上的数学课；小班名单稍后补，另外提醒我下次带阅读材料。', createdAt },
  {
    id: 'sample-tool-student', conversationId: 'sample-conversation', taskId: 'sample-task-students', kind: 'tool', toolCallId: 'sample-call-student', toolName: 'students.create',
    displayName: '登记学生', sideEffect: 'create', status: 'success', inputSummary: {}, resultSummary: '学生小明已保存。',
    references: [{ type: 'Student', id: 'sample-student-ming', label: '小明', route: '/students/sample-student-ming' }], error: null, createdAt: '2026-09-19T08:31:00Z',
  },
  {
    id: 'sample-assistant-1', conversationId: 'sample-conversation', taskId: 'sample-task-students', kind: 'assistant', createdAt: '2026-09-19T08:32:00Z', references: [],
    content: '### 已处理一项\n\n小明已经登记。小班参与名单尚待补充，补齐后再安排小班课程；我不会猜测或代填。',
  },
  scheduleProposal,
  {
    id: 'sample-assistant-2', conversationId: 'sample-conversation', taskId: 'sample-task-memo', kind: 'assistant', createdAt: '2026-09-19T08:34:00Z', references: [],
    content: '### 还有两项需要处理\n\n- 上方课程仍待你确认，确认前不会写入课表。\n- “下次带阅读材料”备忘保存失败，当前没有写入；可重试。\n\n班级自动匹配能力尚未接入，因此不能据此补全小班名单。',
  },
  {
    id: 'sample-memo-error', conversationId: 'sample-conversation', taskId: 'sample-task-memo', kind: 'error', executionId: 'sample-execution-memo', stage: 'persistence',
    error: { code: 'INTERNAL_ERROR', message: '备忘保存失败。' }, retryable: true, retryAction: 'retry-tool', completedToolCallIds: ['sample-call-student'], createdAt: '2026-09-19T08:35:00Z',
  },
];
const events: AssistantTaskEvent[] = [
  { taskId: 'sample-task-students', seq: 3, eventKey: 'sample:student:saved', eventKind: 'task_state', executionId: 'sample-execution-student', role: 'assistant', content: '学生小明已保存', createdAt: '2026-09-19T08:31:00Z' },
  { taskId: 'sample-task-schedule', seq: 4, eventKey: 'sample:schedule:pending', eventKind: 'task_state', executionId: 'sample-execution-schedule', role: 'assistant', content: '课程提案待确认', createdAt: '2026-09-19T08:33:00Z' },
  { taskId: 'sample-task-memo', seq: 5, eventKey: 'sample:memo:failed', eventKind: 'task_state', executionId: 'sample-execution-memo', role: 'assistant', content: '备忘未保存', createdAt: '2026-09-19T08:35:00Z' },
];

function conversation(id = 'sample-conversation'): ConversationDetailDto {
  return {
    id, displayTitle: '本周排课与备忘', status: 'active', summary: null, lastMessagePreview: null,
    lastTurnAt: turns.at(-1)?.createdAt ?? createdAt, createdAt, updatedAt: turns.at(-1)?.createdAt ?? createdAt, turnCount: turns.length,
  };
}

function setProposalStatus(status: 'consumed' | 'cancelled') {
  const index = turns.findIndex(turn => turn.kind === 'confirmation' && turn.actionId === scheduleProposal.actionId);
  if (index >= 0) turns[index] = { ...scheduleProposal, status };
  const task = tasks.find(item => item.id === 'sample-task-schedule');
  if (task) Object.assign(task, { status: status === 'consumed' ? 'succeeded' : 'cancelled', version: task.version ? task.version + 1 : 2, summary: '' });
}

const sampleTransport: AssistantTransport = {
  runtimeAvailability: 'test_only',
  capabilities: { canRead: true, canWrite: false, writeRequiresConfirmation: true },
  conversationApi: {
    async list(_teacherId, params) { return { items: params.status === 'archived' ? [] : [conversation()], nextCursor: null }; },
    async detail(_teacherId, conversationId) { return { conversation: conversation(conversationId) }; },
    async turns() { return { items: [...turns], previousCursor: null }; },
    async archive(_teacherId, conversationId) { return { conversation: { ...conversation(conversationId), status: 'archived' } }; },
  },
  pendingActionApi: {
    async confirm({ actionId, actionToken }) { if (actionId === scheduleProposal.actionId && actionToken === scheduleProposal.actionToken) setProposalStatus('consumed'); },
    async cancel({ actionId }) { if (actionId === scheduleProposal.actionId) setProposalStatus('cancelled'); },
  },
  async createConversation() { return 'sample-conversation'; },
  async sendMessage({ conversationId, message }) {
    const sequence = nextSequence++;
    const task: AssistantTask = { id: `sample-task-${sequence}`, status: 'succeeded', version: 1, summary: '' };
    tasks.unshift(task);
    const reply = '### 样板回复\n\n这是只使用合成资料的界面演示，不会读取或修改你的真实教学资料。';
    turns.push(
      { id: `sample-user-${sequence}`, conversationId, taskId: task.id, kind: 'user', inputSource: 'text', content: message, createdAt: new Date().toISOString() },
      { id: `sample-assistant-${sequence}`, conversationId, taskId: task.id, kind: 'assistant', references: [], createdAt: new Date().toISOString(), content: reply },
    );
    events.push({ taskId: task.id, seq: sequence + 10, eventKey: `sample:assistant:${sequence}`, eventKind: 'assistant_message', executionId: `sample-execution-${sequence}`, role: 'assistant', content: reply, createdAt: new Date().toISOString() });
    return { accepted: true, task };
  },
  async getTasks() { return [...tasks]; },
  async getTaskEvents({ taskId, afterSeq }) { return { items: events.filter(event => event.taskId === taskId && event.seq > (afterSeq ?? 0)), nextSeq: null }; },
};

export function AssistantWorkbenchSample() {
  return <main className="assistant-sample-page">
    <header className="assistant-sample-intro">
      <span>视觉样板 · 合成资料</span>
      <strong>教学助手工作台</strong>
      <p>新版对话样板，仅使用合成资料，不连接真实 API。</p>
    </header>
    <AssistantWorkspace teacherId="sample-teacher" transport={sampleTransport} />
  </main>;
}
