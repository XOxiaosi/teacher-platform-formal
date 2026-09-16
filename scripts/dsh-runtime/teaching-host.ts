/** Fixed-upstream binding, loaded only by the isolated offline probe.
 * No profile loader, workspace instructions, shell, network or real provider. */
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import type { MockAdapter } from './packages/core/agent-loop/tests/mock-adapter.ts';
import type { DshTeachingHost, DshHostResult } from '../../packages/backend/src/app/teaching-runtime/dsh-adapter-contract.js';

function textFromEvent(event: any): string {
  const blocks = event?.data?.message?.content ?? event?.data?.content;
  return Array.isArray(blocks) ? blocks.filter((block: any) => block?.type === 'text').map((block: any) => block.text).join('\n') : '';
}

function sessionHistory(events: readonly any[]) {
  return events.filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
    .map((event) => ({ role: event.type === 'user/message' ? 'user' : 'assistant', content: textFromEvent(event) }))
    // Tool-call assistant events carry no textual turn and are not part of the
    // platform's user/assistant history fence.
    .filter((entry) => entry.content.trim().length > 0);
}

function compatibleHistory(expected: readonly { role: string; content: string }[], persisted: readonly { role: string; content: string }[]) {
  if (expected.length > persisted.length) return false;
  const prefixMatches = expected.every((entry, index) => entry.role === persisted[index]?.role && entry.content === persisted[index]?.content);
  if (!prefixMatches) return false;
  // A crash can occur after DSH durably appended the assistant reply but
  // before the platform appended its assistant turn. One trailing assistant
  // event is therefore compatible with the platform snapshot.
  return persisted.length === expected.length || (persisted.length === expected.length + 1 && persisted.at(-1)?.role === 'assistant');
}

export function createPinnedTestHost(root: string, makeAdapter: () => MockAdapter): DshTeachingHost {
  return {
    commit: 'c291e7961a515f6d7af9304e7fd1d257929aef26', model: 'scripted-test-only',
    plugins: ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'session-persistence-jsonl', 'agent-loop'],
    async run(input) {
      const ctx = new Context();
      let disposeHandle: (() => Promise<void>) | undefined;
      let offAbort = () => {};
      try {
        await ctx.plugin(LlmRuntime);
        await ctx.plugin(SessionStore);
        await ctx.plugin(SessionProjectionRegistry);
        await ctx.plugin(SystemPrompt, { personaPrefix: '你是合成教学验证助手。只查询授权工具。' });
        await ctx.plugin(ToolRuntime);
        await ctx.plugin(AgentRegistry);
        await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' });
        await ctx.plugin(AgentLoop, { agents: [] });
        ctx.llm.registerAdapter(['mock'], makeAdapter());
        for (const definition of input.tools.definitions) {
          const schema = definition.parameters;
          const required = Array.isArray(schema.required) ? schema.required : [];
          const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
          const parameters = Object.fromEntries(Object.entries(properties).map(([name, shape]) => [name,
            { ...(shape as object), required: required.includes(name) }]));
          ctx.tools.register(defineContentToolFixture({ name: definition.name, description: definition.description, parameters,
            async execute(args) {
              const result = await input.tools.execute(definition.name, args);
              if (!result.ok) throw new Error('TEACHING_QUERY_DENIED');
              return [{ type: 'text', text: JSON.stringify(result.value) }];
            },
          }));
        }
        const sessionId = SessionId(input.sessionId);
        const stored = await ctx.sessionPersistence.stat(sessionId);
        if (input.resume && !stored) throw new Error('DSH_SAVED_SESSION_MISSING');
        const handle = stored
          ? await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
          : await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: root } });
        disposeHandle = () => handle.dispose();
        const agent: Agent = handle.agent;
        const initial = agent.session.snapshotEvents();
        if (stored && input.resume && !compatibleHistory(input.history, sessionHistory(initial))) {
          return { sessionId: input.sessionId, lastEventSeq: initial.length - 1, outcome: 'outcome_unknown', reply: null,
            replayed: false, modelCalls: null, inputTokens: null, outputTokens: null, toolCalls: 0 };
        }
        const priorInput = initial.findLast(event => event.type === 'user/message'
          && 'teachingExecutionId' in event.data && event.data.teachingExecutionId === input.executionId);
        let replayed = false;
        let startSeq = initial.length;
        if (priorInput) {
          startSeq = priorInput.seq;
          const priorEnd = initial.find(event => event.seq > startSeq && event.type === 'turn/end');
          const priorEvents = initial.filter(event => event.seq >= startSeq && (!priorEnd || event.seq <= priorEnd.seq));
          const priorUnknown = priorEvents.some(event => event.type === 'tool/result'
            && event.data.error?.code === TOOL_OUTCOME_UNKNOWN);
          const priorFailedTool = priorEvents.some(event => event.type === 'tool/result' && (event.data.error
            || event.data.message.content.some(block => block.type === 'tool-result' && block.isError)));
          if (priorEnd?.type === 'turn/end' && priorEnd.data.reason.kind === 'completed' && !priorFailedTool) {
            // Without the platform's resume fence, a completed persisted turn
            // cannot be distinguished from a duplicate request. Do not replay
            // its answer; an explicit resume may replay it deterministically.
            if (!input.resume) return { sessionId: input.sessionId, lastEventSeq: initial.length - 1, outcome: 'outcome_unknown', reply: null,
              replayed: false, modelCalls: null, inputTokens: null, outputTokens: null, toolCalls: 0 };
            replayed = true;
          }
          else if (priorEnd && !priorUnknown) startSeq = initial.length;
          else return { sessionId: input.sessionId, lastEventSeq: initial.length - 1, outcome: 'outcome_unknown', reply: null,
            replayed: false, modelCalls: null, inputTokens: null, outputTokens: null, toolCalls: 0 };
        }
        if (!replayed) {
          if (input.signal.aborted) return { sessionId: input.sessionId, lastEventSeq: initial.length - 1,
            outcome: 'cancelled', reply: null, replayed: false, modelCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 };
          const settled = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { off(); agent.cancel({ kind: 'user' }); reject(new Error('DSH_TIMEOUT')); }, 10000);
            const off = ctx.on('agent/status', ({ agent: observed, status }) => {
              if (observed === agent && status === 'idle') { clearTimeout(timer); off(); resolve(); }
            });
          });
          const abort = () => agent.cancel({ kind: 'user' });
          input.signal.addEventListener('abort', abort, { once: true });
          offAbort = () => input.signal.removeEventListener('abort', abort);
          agent.followup(createUserMessage({ content: [{ type: 'text', text: input.message }],
            source: { kind: 'user' }, teachingExecutionId: input.executionId }));
          await settled;
          await agent.whenIdle();
        }
        await ctx.sessions.flush(agent.session);
        const pendingEvents = agent.session.snapshotEvents().filter(event => event.seq >= startSeq);
        const ending = pendingEvents.find(event => event.type === 'turn/end');
        const events = pendingEvents.filter(event => !ending || event.seq <= ending.seq);
        const messages = events.filter(event => event.type === 'assistant/message');
        const attempts = events.filter(event => event.type === 'assistant/attempt');
        const usageKnown = attempts.length === 0 && messages.every(event =>
          Number.isSafeInteger(event.data.usage?.inputTokens) && Number.isSafeInteger(event.data.usage?.outputTokens));
        const reply = messages.flatMap(event => event.data.message.content)
          .filter(block => block.type === 'text').map(block => block.text).join('\n');
        const unknown = events.some(event => event.type === 'tool/result' && event.data.error?.code === TOOL_OUTCOME_UNKNOWN);
        const failedTool = events.some(event => event.type === 'tool/result' && (event.data.error
          || event.data.message.content.some(block => block.type === 'tool-result' && block.isError)));
        const outcome: DshHostResult['outcome'] = unknown ? 'outcome_unknown' : input.signal.aborted ? 'cancelled'
          : ending?.type === 'turn/end' && ending.data.reason.kind === 'completed' && !failedTool ? 'completed' : 'failed';
        return { sessionId: input.sessionId, lastEventSeq: ending?.seq ?? agent.session.snapshotEvents().length - 1,
          outcome, reply: reply || null, replayed, modelCalls: messages.length + attempts.length,
          inputTokens: usageKnown ? messages.reduce((sum, event) => sum + (event.data.usage?.inputTokens ?? 0), 0) : null,
          outputTokens: usageKnown ? messages.reduce((sum, event) => sum + (event.data.usage?.outputTokens ?? 0), 0) : null,
          toolCalls: events.filter(event => event.type === 'tool/call').length };
      } finally {
        offAbort();
        try { await disposeHandle?.(); } finally { await ctx.fiber.dispose(); }
      }
    },
  };
}
