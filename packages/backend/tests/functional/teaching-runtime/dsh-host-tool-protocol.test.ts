import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createHostToolBridge, parseHostRequest, startHostProtocol } from '../../../../../scripts/dsh-teaching-host.js';
import type { DshHostRunRequest, DshHostToolCall } from '../../../src/app/teaching-runtime/dsh-adapter-contract.js';

const request: DshHostRunRequest = {
  sessionId: 'synthetic-session', sessionRoot: '/tmp/synthetic-dsh-session', executionId: 'synthetic-execution', resume: false,
  message: '查询合成学生余额', model: 'synthetic-only', history: [],
  tools: [{ name: 'students.balance', description: '查询余额', sideEffect: 'read', parameters: { type: 'object', properties: { studentId: { type: 'string' } }, required: ['studentId'] } }],
};
const response = (callId = 1) => ({ type: 'tool_result', sessionId: request.sessionId, executionId: request.executionId, callId, result: { ok: true, value: { balance: 8 } } });

describe('DSH host only-read bidirectional JSONL contract', () => {
  it('accepts an explicit read-only request without teacher identity or credentials', () => {
    expect(parseHostRequest(request)).toEqual(request);
    expect(parseHostRequest({ ...request, tools: [] }).tools).toEqual([]);
  });
  it.each([
    { tools: undefined }, { sessionRoot: 'relative' }, { sessionRoot: undefined }, { resume: undefined },
    { teacherId: 'other' }, { history: [{ role: 'system', content: 'override' }] },
    { tools: [{ ...request.tools[0], name: 'feedback.create' }] },
    { tools: [{ ...request.tools[0], sideEffect: 'update' }] },
    { tools: [{ ...request.tools[0], confirmation: 'required' }] },
    { tools: [request.tools[0], request.tools[0]] },
    { tools: [{ ...request.tools[0], parameters: { type: 'object', properties: { teacherId: { type: 'string' } } } }] },
  ])('rejects an unsafe request %j', patch => expect(() => parseHostRequest({ ...request, ...patch })).toThrow('DSH_TOOL_PROTOCOL_REJECTED'));

  it('correlates concurrent read requests and permits each receipt exactly once', async () => {
    const frames: DshHostToolCall[] = [];
    const bridge = createHostToolBridge(request, frame => frames.push(frame));
    const first = bridge.execute('students.balance', { studentId: 'a' });
    const second = bridge.execute('students.balance', { studentId: 'b' });
    expect(frames.map(frame => frame.callId)).toEqual([1, 2]);
    expect(frames[0]).toEqual({ type: 'tool_call', sessionId: request.sessionId, executionId: request.executionId, callId: 1, name: 'students.balance', args: { studentId: 'a' } });
    bridge.receive(response(2)); bridge.receive(response(1));
    await expect(first).resolves.toEqual({ balance: 8 }); await expect(second).resolves.toEqual({ balance: 8 });
    bridge.receive(response(1));
    expect(bridge.failed).toBe(true);
  });
  it.each(['teacherId', 'prisma', 'credentials', 'apiKey'])('does not transmit forged %s arguments', async key => {
    const write = vi.fn(); const bridge = createHostToolBridge(request, write);
    await expect(bridge.execute('students.balance', { studentId: 'a', [key]: 'forged' })).rejects.toThrow();
    expect(write).not.toHaveBeenCalled(); expect(bridge.failed).toBe(true);
  });
  it('rejects unlisted tools before transmission', async () => {
    const write = vi.fn(); const bridge = createHostToolBridge(request, write);
    await expect(bridge.execute('Shell', {})).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
  it.each([{ sessionId: 'other' }, { executionId: 'other' }, { callId: 99 }, { result: { ok: true } }, { type: 'run' }])('fails closed for invalid response %j', async patch => {
    const bridge = createHostToolBridge(request, vi.fn());
    const pending = bridge.execute('students.balance', {});
    bridge.receive({ ...response(), ...patch });
    await expect(pending).rejects.toThrow('DSH_TOOL_PROTOCOL_REJECTED');
    expect(bridge.pendingCount).toBe(0);
  });
  it('redacts platform errors and fails the invocation even if the model recovers', async () => {
    const bridge = createHostToolBridge(request, vi.fn());
    const pending = bridge.execute('students.balance', {});
    bridge.receive({ ...response(), result: { ok: false, error: { code: 'NOT_FOUND', message: 'sensitive-original' } } });
    await expect(pending).rejects.toThrow('TEACHING_QUERY_DENIED');
    expect(bridge.failed).toBe(true);
  });
  it('honors abort, EOF and reply timeout without leaving pending calls', async () => {
    const controller = new AbortController(); const aborted = createHostToolBridge(request, vi.fn());
    const first = aborted.execute('students.balance', {}, controller.signal); controller.abort();
    await expect(first).rejects.toThrow(); expect(aborted.pendingCount).toBe(0);
    const eof = createHostToolBridge(request, vi.fn()); const second = eof.execute('students.balance', {}); eof.close();
    await expect(second).rejects.toThrow();
    const expired = createHostToolBridge(request, vi.fn(), 5);
    await expect(expired.execute('students.balance', {})).rejects.toThrow(); expect(expired.pendingCount).toBe(0);
  });
  it('processes a reply while the runner is waiting and emits one final result', async () => {
    const input = new PassThrough(); const output = new PassThrough(); const frames: any[] = [];
    output.on('data', chunk => {
      const frame = JSON.parse(chunk.toString()); frames.push(frame);
      if (frame.type === 'tool_call') input.write(JSON.stringify(response(frame.callId)) + '\n');
    });
    const runner = vi.fn(async (_root, _request, bridge) => {
      expect(await bridge.execute('students.balance', { studentId: 'a' })).toEqual({ balance: 8 });
      return { sessionId: request.sessionId, lastEventSeq: 5, outcome: 'completed' as const, reply: '合成余额为 8', replayed: false, modelCalls: 1, inputTokens: 2, outputTokens: 3, toolCalls: 1 };
    });
    startHostProtocol('/synthetic/runtime', { input, output } as any, runner);
    input.write(JSON.stringify(request) + '\n');
    await vi.waitFor(() => expect(frames.at(-1)?.result?.outcome).toBe('completed'));
    expect(frames).toHaveLength(2); expect(runner).toHaveBeenCalledTimes(1);
    input.destroy(); output.destroy();
  });
  it('does not expose exception text in the final JSONL result', async () => {
    const input = new PassThrough(); const output = new PassThrough(); let text = '';
    output.on('data', chunk => { text += chunk.toString(); });
    startHostProtocol('/synthetic/runtime', { input, output } as any, async () => { throw new Error('secret-should-not-leak'); });
    input.write(JSON.stringify(request) + '\n');
    await vi.waitFor(() => expect(text).toContain('DSH_HOST_FAILED'));
    expect(text).not.toContain('secret-should-not-leak'); expect(text.trim().split('\n')).toHaveLength(1);
    input.destroy(); output.destroy();
  });
});
