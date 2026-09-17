/** Offline proof against the pinned DSH APIs. Only a scripted adapter is used.
 * Run from the pinned checkout: node --import tsx/esm <this-file> <checkout> <new-output-dir> */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHostToolBridge, parseHostRequest, runDshHost } from '../dsh-teaching-host.js';

const [root, sessionRoot] = process.argv.slice(2);
assert(root && sessionRoot && isAbsolute(root) && isAbsolute(sessionRoot));
assert(!Object.keys(process.env).some(key => /API_KEY|TOKEN|SECRET|PASSWORD/.test(key)));
globalThis.fetch = async () => { throw new Error('OFFLINE_PROBE_NETWORK_BLOCKED'); };
await mkdir(sessionRoot, { recursive: false });
const { MockAdapter, textResponse, toolCallResponse } = await import(pathToFileURL(join(root, 'packages/core/agent-loop/tests/mock-adapter.ts')).href);
let responses: any[] = [];
let queries = 0;
const load = async (path: string) => path === 'packages/llm/llm-deepseek/src/index.ts'
  ? { inject: ['llm'], apply(ctx: any) { ctx.llm.registerAdapter(['deepseek-official'], new MockAdapter(responses)); } }
  : import(pathToFileURL(join(root, path)).href);
const base = parseHostRequest({ sessionId: 'synthetic-real-host', sessionRoot, executionId: 'exec-1', resume: false,
  message: '查合成余额', model: 'scripted-test-only', history: [{ role: 'user', content: '查合成余额' }],
  tools: [{ name: 'students.balance', description: '合成余额', sideEffect: 'read', parameters: { type: 'object', properties: { studentId: { type: 'string' } }, required: ['studentId'] } }],
});
async function invoke(request: typeof base, deny = false) {
  const bridge = createHostToolBridge(request, frame => {
    queries++;
    bridge.receive({ type: 'tool_result', sessionId: request.sessionId, executionId: request.executionId, callId: frame.callId,
      result: deny ? { ok: false, error: { code: 'NOT_FOUND', message: 'synthetic-only' } } : { ok: true, value: { balance: 8 } } });
  });
  return runDshHost(root, request, bridge, load);
}
responses = [toolCallResponse('query-1', 'students.balance', { studentId: 'student-a' }), textResponse('合成余额为 8。')];
const first = await invoke(base);
assert.equal(first.outcome, 'completed'); assert.equal(first.reply, '合成余额为 8。'); assert.equal(first.toolCalls, 1); assert.equal(queries, 1);
assert.equal(first.modelCalls, 2);
responses = [];
const replay = await invoke({ ...base, resume: true });
assert.equal(replay.outcome, 'completed'); assert.equal(replay.replayed, true); assert.equal(replay.lastEventSeq, first.lastEventSeq); assert.equal(queries, 1);
assert.equal((await invoke(base)).outcome, 'outcome_unknown');
assert.equal((await invoke({ ...base, resume: true, history: [{ role: 'user', content: 'mismatched' }] })).outcome, 'outcome_unknown');
responses = [textResponse('继续核对已有资料。')];
const next = await invoke({ ...base, resume: true, executionId: 'exec-2', message: '继续', history: [...base.history, { role: 'assistant', content: first.reply! }, { role: 'user', content: '继续' }] });
assert.equal(next.outcome, 'completed'); assert.equal(next.replayed, false); assert(next.lastEventSeq > first.lastEventSeq);
responses = [toolCallResponse('query-denied', 'students.balance', { studentId: 'student-b' }), textResponse('不应交付这个兜底回答')];
const denied = await invoke({ ...base, sessionId: 'synthetic-denied', executionId: 'denied-1' }, true);
assert.equal(denied.outcome, 'failed'); assert.equal(denied.reply, null);
responses = [textResponse('已重新核对。')];
const recovered = await invoke({ ...base, sessionId: 'synthetic-denied', executionId: 'denied-1', resume: true });
assert.equal(recovered.outcome, 'completed'); assert.equal(recovered.replayed, false);
responses = [textResponse('恢复后继续。')];
const afterRecovery = await invoke({ ...base, sessionId: 'synthetic-denied', executionId: 'after-recovery', resume: true, message: '继续',
  history: [...base.history, { role: 'assistant', content: recovered.reply! }, { role: 'user', content: '继续' }] });
assert.equal(afterRecovery.outcome, 'completed');
console.log(JSON.stringify({ ok: true, scenarios: ['query-bridge', 'completed-replay', 'missing-resume', 'history-mismatch', 'next-turn', 'denied-fails-closed', 'failed-retry', 'continue-after-retry'], queries }));
