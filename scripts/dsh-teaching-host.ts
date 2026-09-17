import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import type { DshHostRunRequest, DshHostToolCall, DshHostToolResult } from '../packages/backend/src/app/teaching-runtime/dsh-adapter-contract.js';

/**
 * One-shot host for the pinned DSH source tree. The formal backend starts this
 * file with tsx so the teacher-platform checkout does not vendor a second copy
 * of DSH. Stdout is a JSONL protocol; diagnostics stay on stderr.
 */

type HostRequest = DshHostRunRequest;

interface HostResult {
  sessionId: string;
  lastEventSeq: number;
  outcome: 'completed' | 'waiting_input' | 'cancelled' | 'failed' | 'outcome_unknown';
  reply: string | null;
  replayed: boolean;
  modelCalls: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: number;
}

type ModuleLoader = (relativePath: string) => Promise<Record<string, any>>;

const QUERY_NAMES = new Set(['students.get', 'students.list', 'students.balance', 'scheduling.list',
  'lessons.list', 'payments.list', 'feedback.list', 'memos.list']);
const FORBIDDEN_ARGUMENTS = ['teacherId', 'prisma', 'credentials', 'apiKey'];
const MAX_FRAME_BYTES = 1024 * 1024;
/** DeepSeek function names accept only letters, numbers, `_` and `-`; the
 * platform keeps dotted names and translates them only inside the host. */
function wireToolName(name: string): string { return name.replaceAll('.', '_'); }
function object(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function protocolError() { return new Error('DSH_TOOL_PROTOCOL_REJECTED'); }

export function parseHostRequest(value: unknown): HostRequest {
  if (!object(value) || ['sessionId', 'executionId', 'message', 'model'].some(key => typeof value[key] !== 'string' || !value[key].trim())
    || !Array.isArray(value.history) || value.history.some(item => !object(item) || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string')
    || typeof value.sessionRoot !== 'string' || !isAbsolute(value.sessionRoot)
    || typeof value.resume !== 'boolean'
    || !Array.isArray(value.tools) || value.tools.length > QUERY_NAMES.size
    || FORBIDDEN_ARGUMENTS.some(key => Object.hasOwn(value, key))) throw protocolError();
  const names = new Set<string>();
  for (const definition of value.tools) {
    if (!object(definition) || !QUERY_NAMES.has(definition.name) || names.has(definition.name)
      || definition.sideEffect !== 'read' || ![undefined, 'none'].includes(definition.confirmation)
      || typeof definition.description !== 'string' || !object(definition.parameters)
      || definition.parameters.type !== 'object' || !object(definition.parameters.properties)
      || FORBIDDEN_ARGUMENTS.some(key => Object.hasOwn(definition.parameters.properties, key))) throw protocolError();
    names.add(definition.name);
  }
  return structuredClone(value) as HostRequest;
}

/** One invocation, no direct database/network/shell access. Parent-side execute
 * is the step-bound runtime query, so successful and denied calls are auditable. */
export function createHostToolBridge(request: HostRequest, write: (frame: DshHostToolCall) => void, timeoutMs = 30_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw protocolError();
  const allowed = new Set(request.tools.map(tool => tool.name));
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void }>();
  let nextCallId = 0;
  let failed = false;
  let closed = false;
  const fail = () => { failed = true; closed = true; for (const item of pending.values()) { item.cleanup(); item.reject(protocolError()); } pending.clear(); };
  return {
    get failed() { return failed; },
    get pendingCount() { return pending.size; },
    execute(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
      if (closed || signal?.aborted || !allowed.has(name) || !object(args) || FORBIDDEN_ARGUMENTS.some(key => Object.hasOwn(args, key)) || nextCallId >= 128) {
        failed = true;
        return Promise.reject(protocolError());
      }
      const frame: DshHostToolCall = { type: 'tool_call', sessionId: request.sessionId, executionId: request.executionId, callId: ++nextCallId, name, args };
      if (Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME_BYTES) { failed = true; return Promise.reject(protocolError()); }
      return new Promise((resolveCall, reject) => {
        const abort = () => fail();
        const timer = setTimeout(abort, timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        pending.set(frame.callId, { resolve: resolveCall, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } });
        try { write(frame); } catch { fail(); }
      });
    },
    receive(value: unknown) {
      if (closed || !object(value) || value.type !== 'tool_result' || value.sessionId !== request.sessionId
        || value.executionId !== request.executionId || !Number.isSafeInteger(value.callId) || !pending.has(value.callId)
        || !object(value.result) || typeof value.result.ok !== 'boolean'
        || (value.result.ok ? !Object.hasOwn(value.result, 'value') : !object(value.result.error))) { fail(); return; }
      const frame = value as DshHostToolResult;
      const item = pending.get(frame.callId)!;
      pending.delete(frame.callId);
      item.cleanup();
      if (frame.result.ok) item.resolve(frame.result.value);
      else { failed = true; item.reject(new Error('TEACHING_QUERY_DENIED')); }
    },
    close() { if (pending.size) fail(); else closed = true; },
    fail,
  };
}

function loadFrom(root: string): ModuleLoader {
  return async (relativePath) => import(pathToFileURL(join(root, relativePath)).href);
}

function textFromMessage(message: any): string {
  if (!message || typeof message !== 'object' || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('');
}

function compatibleHistory(expected: HostRequest['history'], events: any[]) {
  // Compare platform turns, not internal model/tool chatter. A retry appends
  // another DSH attempt for the same execution, but remains one platform turn.
  const executions = new Map<string, Array<{ role: string; content: string }>>();
  const userEvents = events.filter(event => event.type === 'user/message');
  for (const [index, user] of userEvents.entries()) {
    const next = userEvents[index + 1];
    const turn = events.filter(event => event.seq > user.seq && (!next || event.seq < next.seq));
    const end = turn.find(event => event.type === 'turn/end');
    const failed = turn.some(event => event.type === 'tool/result' && (event.data?.error
      || event.data?.message?.content?.some((block: any) => block?.type === 'tool-result' && block.isError)));
    const assistant = turn.findLast(event => event.type === 'assistant/message');
    const items = [{ role: 'user', content: textFromMessage(user.data?.message ?? user.data) }];
    const reply = end?.data?.reason?.kind === 'completed' && !failed ? textFromMessage(assistant?.data?.message) : '';
    if (reply) items.push({ role: 'assistant', content: reply });
    executions.set(user.data?.teachingExecutionId ?? `legacy:${user.seq}`, items);
  }
  const history = [...executions.values()].flat();
  return expected.every((item, index) => item.role === history[index]?.role && item.content === history[index]?.content)
    && (history.length === expected.length || (history.length === expected.length + 1 && history.at(-1)?.role === 'assistant'));
}

export async function runDshHost(root: string, request: HostRequest, bridge: ReturnType<typeof createHostToolBridge>, load: ModuleLoader = loadFrom(root)): Promise<HostResult> {
  const { Context } = await load('vendor/cordis/src/index.ts');
  const llm = await load('packages/llm/llm/src/index.ts');
  const { default: SessionStore } = await load('packages/core/session/src/index.ts');
  const { default: JsonlSessionPersistence } = await load('packages/session/session-persistence-jsonl/src/index.ts');
  const { default: SessionProjectionRegistry } = await load('packages/session/session-projection/src/index.ts');
  const { default: SystemPrompt } = await load('packages/core/system-prompt/src/index.ts');
  const { default: ToolRuntime } = await load('packages/core/tools/src/index.ts');
  const { default: AgentRegistry } = await load('packages/core/agent/src/index.ts');
  const { default: AgentLoop } = await load('packages/core/agent-loop/src/index.ts');
  const deepSeek = await load('packages/llm/llm-deepseek/src/index.ts');

  const ctx = new Context();
  try {
    await ctx.plugin(llm.default);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt, {
      personaPrefix: [
        '你是教师平台的教学助手。',
        '只处理教学记录、学生、课程、课时和家长反馈相关工作。',
        '没有足够事实时先说明缺少哪些信息，不要编造学生或课程数据。',
        '当前运行只允许回答和整理，不执行任何外部写入。',
      ].join('\n'),
    });
    await ctx.plugin(ToolRuntime);
    if (typeof ctx.tools?.register !== 'function') throw protocolError();
    for (const definition of request.tools) {
      ctx.tools.register({
        name: wireToolName(definition.name), description: definition.description, parameters: definition.parameters,
        output: {
          schema: { type: 'object', properties: { result: {} }, required: ['result'], additionalProperties: false },
          render(_args: unknown, value: { result: unknown }) { return [{ type: 'text', text: JSON.stringify(value.result) }]; },
        },
        async execute(args: unknown, exec: { signal: AbortSignal }) { return { result: await bridge.execute(definition.name, args, exec.signal) }; },
      });
    }
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(JsonlSessionPersistence, { root: request.sessionRoot, compression: 'none' });
    await ctx.plugin(AgentLoop, { agents: [] });
    await ctx.plugin(deepSeek, { apiKeyEnv: 'DEEPSEEK_API_KEY' });

    const { createUserMessage } = llm;
    const stored = await ctx.sessionPersistence.stat(request.sessionId);
    const unknown = (seq = 0): HostResult => ({ sessionId: request.sessionId, lastEventSeq: seq, outcome: 'outcome_unknown',
      reply: null, replayed: false, modelCalls: null, inputTokens: null, outputTokens: null, toolCalls: 0 });
    if ((request.resume && !stored) || (!request.resume && stored)) return unknown();
    const agentOptions = { provider: 'deepseek-official', model: request.model };
    const handle = stored
      ? await ctx.agents.resume({ resumeSessionId: request.sessionId, agentOptions })
      : await ctx.agents.create({ sessionId: request.sessionId, meta: { cwd: request.sessionRoot }, agentOptions });
    try {
      const initial = handle.agent.session.snapshotEvents(0);
      const prior = initial.findLast((event: any) => event.type === 'user/message' && event.data?.teachingExecutionId === request.executionId);
      const last = request.history.at(-1);
      // The task runner includes the current accepted user turn. It is not
      // yet in DSH when this execution has never started.
      const expectedHistory = !prior && last?.role === 'user' && last.content === request.message ? request.history.slice(0, -1) : request.history;
      // The platform history is the fence; unverified DSH-only conversation
      // history cannot silently re-enter the model context.
      if (!compatibleHistory(expectedHistory, initial)) return unknown(Math.max(0, initial.length - 1));
      let replayed = false;
      let startSeq = initial.length;
      if (prior) {
        const ending = initial.find((event: any) => event.seq > prior.seq && event.type === 'turn/end');
        const priorEvents = initial.filter((event: any) => event.seq >= prior.seq && (!ending || event.seq <= ending.seq));
        const uncertain = priorEvents.some((event: any) => event.type === 'tool/result' && event.data?.error?.code === 'TOOL_OUTCOME_UNKNOWN');
        const failed = priorEvents.some((event: any) => event.type === 'tool/result' && (event.data?.error
          || event.data?.message?.content?.some((block: any) => block?.type === 'tool-result' && block.isError)));
        if (ending?.data?.reason?.kind === 'completed' && !failed) { replayed = true; startSeq = prior.seq; }
        else if (!ending || uncertain) return unknown(Math.max(0, initial.length - 1));
      }
      if (!replayed) {
        // Persist exactly the platform user turn: prepending rendered history
        // would break the next invocation's history fence and duplicate facts.
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: request.message }], source: { kind: 'user' }, teachingExecutionId: request.executionId,
        }));
        await handle.agent.whenIdle();
      }
      await ctx.sessions.flush(handle.agent.session);
      const pendingEvents = handle.agent.session.snapshotEvents(0).filter((event: any) => event.seq >= startSeq);
      const ending = pendingEvents.find((event: any) => event.type === 'turn/end');
      const events = pendingEvents.filter((event: any) => !ending || event.seq <= ending.seq);
      const assistantEvents = events.filter((event: any) => event.type === 'assistant/message');
      const lastAssistant = assistantEvents.at(-1) as any;
      const end = events.findLast((event: any) => event.type === 'turn/end') as any;
      const reason = end?.data?.reason;
      const attempts = events.filter((event: any) => event.type === 'assistant/attempt');
      const usageKnown = attempts.length === 0 && assistantEvents.every((event: any) =>
        Number.isSafeInteger(event.data?.usage?.inputTokens) && event.data.usage.inputTokens >= 0
        && Number.isSafeInteger(event.data?.usage?.outputTokens) && event.data.usage.outputTokens >= 0);
      const failedTool = bridge.failed || bridge.pendingCount > 0 || events.some((event: any) => event.type === 'tool/result'
        && (event.data?.error || event.data?.message?.content?.some((block: any) => block?.type === 'tool-result' && block.isError)));
      const outcome = failedTool ? 'failed' : reason?.kind === 'completed'
        ? 'completed'
        : reason?.kind === 'cancelled'
          ? 'cancelled'
          : reason?.kind === 'error'
            ? 'failed'
            : 'outcome_unknown';
      return {
        sessionId: request.sessionId,
        lastEventSeq: ending?.seq ?? Math.max(0, handle.agent.session.seq - 1),
        outcome,
        reply: failedTool ? null : textFromMessage(lastAssistant?.data?.message) || null,
        replayed,
        modelCalls: assistantEvents.length + attempts.length,
        inputTokens: usageKnown ? assistantEvents.reduce((sum: number, event: any) => sum + event.data.usage.inputTokens, 0) : null,
        outputTokens: usageKnown ? assistantEvents.reduce((sum: number, event: any) => sum + event.data.usage.outputTokens, 0) : null,
        toolCalls: events.filter((event: any) => event.type === 'tool/call').length,
      };
    } finally {
      await handle.dispose();
    }
  } finally {
    await ctx.fiber.dispose();
  }
}

export function startHostProtocol(root: string, streams = { input: process.stdin, output: process.stdout }, runner = runDshHost) {
  const input = createInterface({ input: streams.input, crlfDelay: Infinity });
  let bridge: ReturnType<typeof createHostToolBridge> | undefined;
  let started = false;
  let finished = false;
  const write = (frame: unknown) => streams.output.write(`${JSON.stringify(frame)}\n`);
  const finish = (frame: unknown) => {
    if (finished) return;
    finished = true; bridge?.close(); write(frame); input.close(); streams.input.pause();
  };
  input.on('line', (line) => {
    if (finished || !line.trim()) return;
    try {
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw protocolError();
      const frame: unknown = JSON.parse(line);
      if (started) { bridge!.receive(frame); return; }
      started = true;
      const request = parseHostRequest(frame);
      bridge = createHostToolBridge(request, write);
      void runner(root, request, bridge).then(result => {
        finish({ ok: true, result: bridge!.failed ? { ...result, outcome: 'failed', reply: null } : result });
      }, () => finish({ ok: false, error: 'DSH_HOST_FAILED' }));
    } catch {
      bridge?.fail();
      if (!started || !bridge) finish({ ok: false, error: 'DSH_HOST_PROTOCOL_REJECTED' });
    }
  });
  input.on('close', () => { bridge?.close(); });
  input.on('error', () => { bridge?.fail(); finish({ ok: false, error: 'DSH_HOST_PROTOCOL_REJECTED' }); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.DSH_RUNTIME_ROOT;
  if (!root) process.stdout.write(`${JSON.stringify({ ok: false, error: 'DSH_HOST_CONFIG_REQUIRED' })}\n`);
  else startHostProtocol(root);
}
