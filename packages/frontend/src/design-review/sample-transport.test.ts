import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REVIEW_CONVERSATION, createReviewTransport } from './sample-transport';

const teacherId = 'review-teacher';

afterEach(() => vi.restoreAllMocks());

describe('UI-003 review transport', () => {
  it('provides isolated synthetic conversations, turns, confirmation, and failure state', async () => {
    const transport = createReviewTransport();
    const initial = await transport.conversationApi!.list(teacherId, {});
    expect(initial.items.map(item => item.id)).toEqual([DEFAULT_REVIEW_CONVERSATION, 'review-conversation-feedback']);
    expect((await transport.conversationApi!.turns(teacherId, DEFAULT_REVIEW_CONVERSATION)).items.some(turn => turn.kind === 'confirmation')).toBe(true);
    expect((await transport.getTasks!({ teacherId, conversationId: 'review-conversation-feedback' }))[0]?.status).toBe('failed');
    const events = await transport.getTaskEvents!({ teacherId, conversationId: DEFAULT_REVIEW_CONVERSATION, taskId: 'review-task-students' });
    expect(events.items.map(event => event.eventKind)).toEqual(['assistant_message', 'task_state']);
    expect(events.items.at(-1)?.content).toContain('任务已完成');
    const assistantTurn = (await transport.conversationApi!.turns(teacherId, DEFAULT_REVIEW_CONVERSATION)).items.find(turn => turn.id === 'review-assistant-1');
    expect(events.items.find(event => event.eventKind === 'assistant_message')?.content).toBe(assistantTurn && 'content' in assistantTurn ? assistantTurn.content : undefined);
  });

  it('creates an empty conversation and keeps sent messages in that conversation only', async () => {
    const transport = createReviewTransport();
    const first = await transport.createConversation!({ teacherId });
    const second = await transport.createConversation!({ teacherId });
    expect((await transport.conversationApi!.turns(teacherId, first)).items).toHaveLength(0);
    await transport.sendMessage({ teacherId, conversationId: first, message: '只发给第一个会话', clientRequestId: 'request-1' });
    expect((await transport.conversationApi!.turns(teacherId, first)).items).toHaveLength(2);
    expect((await transport.conversationApi!.turns(teacherId, second)).items).toHaveLength(0);
    const sentTurns = (await transport.conversationApi!.turns(teacherId, first)).items;
    expect(sentTurns[0]?.kind).toBe('user');
    expect(sentTurns[1]?.kind).toBe('assistant');
    expect(Date.parse(sentTurns[1]!.createdAt)).toBeGreaterThan(Date.parse(sentTurns[0]!.createdAt));
    const sentTask = (await transport.getTasks!({ teacherId, conversationId: first }))[0]!;
    const sentEvents = await transport.getTaskEvents!({ teacherId, conversationId: first, taskId: sentTask.id });
    expect(sentEvents.items.at(-1)?.eventKind).toBe('task_state');
    expect(sentEvents.items.at(-1)?.content).toContain('任务已完成');
  });

  it('keeps sent turn ids unique when appending to the default review conversation', async () => {
    const transport = createReviewTransport();
    await transport.sendMessage({ teacherId, conversationId: DEFAULT_REVIEW_CONVERSATION, message: '补充一条演示消息', clientRequestId: 'request-main-1' });
    const turns = (await transport.conversationApi!.turns(teacherId, DEFAULT_REVIEW_CONVERSATION)).items;
    expect(new Set(turns.map(turn => turn.id)).size).toBe(turns.length);
  });

  it('keeps every turn strictly ordered across repeated sends and a clock rollback', async () => {
    const transport = createReviewTransport();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-20T09:10:00.000Z'));
    await transport.sendMessage({ teacherId, conversationId: DEFAULT_REVIEW_CONVERSATION, message: '第一条连续演示消息', clientRequestId: 'request-order-1' });
    clock.mockReturnValue(Date.parse('2026-09-20T08:00:00.000Z'));
    await transport.sendMessage({ teacherId, conversationId: DEFAULT_REVIEW_CONVERSATION, message: '第二条时钟回拨演示消息', clientRequestId: 'request-order-2' });
    const turns = (await transport.conversationApi!.turns(teacherId, DEFAULT_REVIEW_CONVERSATION)).items;
    const times = turns.map(turn => Date.parse(turn.createdAt));
    expect(times.every((time, index) => index === 0 || time > times[index - 1]!)).toBe(true);
    expect(turns.at(-1)?.kind).toBe('assistant');
  });

  it('archives a conversation and filters it from active results', async () => {
    const transport = createReviewTransport();
    await transport.conversationApi!.archive(teacherId, DEFAULT_REVIEW_CONVERSATION);
    expect((await transport.conversationApi!.list(teacherId, { status: 'active' })).items.some(item => item.id === DEFAULT_REVIEW_CONVERSATION)).toBe(false);
    expect((await transport.conversationApi!.list(teacherId, { status: 'archived' })).items.some(item => item.id === DEFAULT_REVIEW_CONVERSATION)).toBe(true);
  });

  it('changes only synthetic confirmation state and task state', async () => {
    const transport = createReviewTransport();
    await transport.pendingActionApi!.confirm({ teacherId, actionId: 'review-action-schedule', actionToken: 'review-action-token' });
    const turns = await transport.conversationApi!.turns(teacherId, DEFAULT_REVIEW_CONVERSATION);
    expect(turns.items.find(turn => turn.kind === 'confirmation')?.status).toBe('consumed');
    expect((await transport.getTask!({ teacherId, conversationId: DEFAULT_REVIEW_CONVERSATION, taskId: 'review-task-schedule' })).status).toBe('succeeded');
  });
});
