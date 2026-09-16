/** A02: real upstream DSH lifecycle, scripted model, synthetic teaching tools. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { MockAdapter, textResponse, toolCallResponse } from './packages/core/agent-loop/tests/mock-adapter.ts';

const [mode, root] = process.argv.slice(2);
assert(root && mode, 'mode and isolated root required');
assert(!Object.keys(process.env).some(key => /API_KEY|TOKEN|SECRET|PASSWORD/.test(key)));
globalThis.fetch = async () => { throw new Error('A02 external network prohibited'); };
await mkdir(root, { recursive: true });
const receiptFile = join(root, 'synthetic-receipt.json');
const sessionId = SessionId(mode.includes('crash') ? 'synthetic-teacher-a-crash' : `synthetic-teacher-a-${['create', 'resume', 'lock'].includes(mode) ? 'main' : mode}`);
const adapter = new MockAdapter(
  mode === 'create' ? [toolCallResponse('query-1', 'TeachingBalance', { studentId: 'synthetic-student-a' }), textResponse('合成学生剩余 8 课时；仅查询，未扣课。')]
  : mode === 'resume' ? [textResponse('继续上次任务：合成学生剩余 8 课时。')]
  : mode === 'crash' ? [toolCallResponse('save-1', 'SaveSyntheticReceipt', { confirmation: 'synthetic-confirmed' })]
  : mode === 'resume-crash' ? [toolCallResponse('receipt-1', 'ReadSyntheticReceipt', {}), textResponse('记录此前已保存；本次读取回执，没有重复保存。')]
  : mode === 'deny' ? [toolCallResponse('forbidden-1', 'Shell', { command: 'must-never-execute' }), textResponse('不支持该工具。')]
  : mode === 'isolation' ? [toolCallResponse('query-b', 'TeachingBalance', { studentId: 'synthetic-student-b' }), textResponse('无法访问其他教师学生。')]
  : mode === 'failure' ? []
  : mode === 'cancel' ? ['hang'] : [],
);
const ctx = new Context();
await ctx.plugin(LlmRuntime);
await ctx.plugin(SessionStore);
await ctx.plugin(SessionProjectionRegistry);
await ctx.plugin(SystemPrompt, { personaPrefix: '你是合成教学验证助手。只用已注册教学工具，不推断用户已确认。' });
await ctx.plugin(ToolRuntime);
await ctx.plugin(AgentRegistry);
await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' });
await ctx.plugin(AgentLoop, { agents: [] });
ctx.llm.registerAdapter(['mock'], adapter);
let queried = 0;
ctx.tools.register(defineContentToolFixture({
  name: 'TeachingBalance', description: '合成教师绑定的只读余额查询',
  parameters: { studentId: { type: 'string', required: true } },
  async execute(args) {
    if (args.studentId !== 'synthetic-student-a') throw new Error('SYNTHETIC_OWNER_DENIED');
    queried++;
    return [{ type: 'text', text: JSON.stringify({ studentId: args.studentId, remaining: 8, sourceVersion: 1 }) }];
  },
}));
let agent: Agent;
if (mode.includes('crash')) {
  ctx.tools.register(defineContentToolFixture({
    name: 'SaveSyntheticReceipt', description: '仅验证用：保存合成回执并注入中断',
    parameters: { confirmation: { type: 'string', required: true } },
    async execute(args) {
      assert.equal(args.confirmation, 'synthetic-confirmed');
      // Exclusive create is the synthetic business idempotency boundary.
      const receipt = await open(receiptFile, 'wx');
      await receipt.writeFile(JSON.stringify({ receiptId: 'synthetic-receipt-1', taskId: sessionId, writes: 1, status: 'saved' }));
      await receipt.sync();
      await receipt.close();
      await ctx.sessions.flush(agent.session);
      console.log('A02_FAULT: receipt durable; tool result absent; SIGKILL');
      process.kill(process.pid, 'SIGKILL');
      throw new Error('unreachable after SIGKILL');
    },
  }));
  ctx.tools.register(defineContentToolFixture({
    name: 'ReadSyntheticReceipt', description: '查询合成任务已有回执', parameters: {},
    async execute() { return [{ type: 'text', text: await readFile(receiptFile, 'utf8') }]; },
  }));
}
assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), mode.includes('crash')
  ? ['ReadSyntheticReceipt', 'SaveSyntheticReceipt', 'TeachingBalance'] : ['TeachingBalance']);

function idle(subject: Agent): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('real DSH loop did not settle')); }, 10000);
    const off = ctx.on('agent/status', ({ agent: observed, status }) => {
      if (observed === subject && status === 'idle') { clearTimeout(timer); off(); resolve(); }
    });
  });
}
try {
  const handle = mode.startsWith('resume') || mode === 'lock'
    ? await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    : await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: root } });
  agent = handle.agent;
  const initialEvents = agent.session.snapshotEvents();
  if (mode === 'resume') {
    assert(JSON.stringify(agent.session.deriveMessages()).includes('剩余 8'));
    assert.equal(initialEvents.filter(event => event.type === 'tool/call').length, 1);
  }
  if (mode === 'resume-crash') {
    assert(initialEvents.some(event => event.type === 'tool/result' && event.data.error?.code === TOOL_OUTCOME_UNKNOWN));
    assert(initialEvents.some(event => event.type === 'turn/end' && event.data.reason.kind === 'interrupted'));
  }
  if (mode === 'lock') {
    // A second independently mounted persistence owner must not take the live writer.
    const second = new Context();
    await second.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' });
    try {
      await assert.rejects(() => second.sessionPersistence.open(sessionId, 'write'), /owned|lock/i);
    } finally { await second.fiber.dispose(); }
  } else {
    const settled = idle(agent);
    agent.followup(createUserMessage({ content: [{ type: 'text', text: mode === 'resume-crash' ? '先查已有回执，再继续未完成工作。' : '核对合成学生课时，继续教学任务。' }], source: { kind: 'user' } }));
    if (mode === 'cancel') setTimeout(() => agent.cancel({ kind: 'user' }), 30);
    await settled;
    await agent.whenIdle();
  }
  await ctx.sessions.flush(agent.session);
  const events = agent.session.snapshotEvents();
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index));
  if (mode === 'create') { assert.equal(queried, 1); assert.equal(adapter.requests.length, 2); }
  if (mode === 'resume') { assert.equal(queried, 0); assert.equal(events.filter(event => event.type === 'tool/call').length, 1); }
  if (mode === 'resume-crash') {
    assert.equal(JSON.parse(await readFile(receiptFile, 'utf8')).writes, 1);
    assert.equal(events.filter(event => event.type === 'tool/call' && event.data.name === 'SaveSyntheticReceipt').length, 1);
    assert.equal(events.filter(event => event.type === 'tool/call' && event.data.name === 'ReadSyntheticReceipt').length, 1);
  }
  if (mode === 'deny' || mode === 'isolation') {
    assert.equal(queried, 0);
    assert(events.some(event => event.type === 'tool/result' && event.data.message.content.some(block => block.type === 'tool-result' && block.isError)));
    assert(JSON.stringify(events).includes(mode === 'deny' ? 'UNKNOWN_TOOL' : 'SYNTHETIC_OWNER_DENIED'));
  }
  if (mode === 'failure') assert(events.some(event => event.type === 'turn/end' && event.data.reason.kind !== 'completed'));
  if (mode === 'cancel') assert(events.some(event => event.type === 'turn/end' && event.data.reason.kind !== 'completed'));
  await writeFile(join(root, `${mode}-events.json`), JSON.stringify(events, null, 2));
  const result = { mode, sessionId, realLoop: true, model: 'scripted-test-only', eventCount: events.length,
    modelCalls: adapter.requests.length, toolCalls: events.filter(event => event.type === 'tool/call').length,
    contiguous: true, queryCount: queried, plugins: ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'session-persistence-jsonl', 'agent-loop'],
    finished: events.filter(event => event.type === 'turn/end').map(event => event.data.reason) };
  console.log(JSON.stringify(result));
  await writeFile(join(root, `${mode}-result.json`), JSON.stringify(result, null, 2));
  await handle.dispose();
} finally { await ctx.fiber.dispose(); }
