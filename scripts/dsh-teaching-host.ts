import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

/**
 * One-shot host for the pinned DSH source tree. The formal backend starts this
 * file with tsx so the teacher-platform checkout does not vendor a second copy
 * of DSH. Stdout is a JSONL protocol; diagnostics stay on stderr.
 */

interface HostRequest {
  sessionId: string;
  executionId: string;
  message: string;
  model: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}

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

function contextMessage(request: HostRequest): string {
  const history = request.history
    .filter((item) => item.content.trim() !== '')
    .slice(-20)
    .map((item) => `${item.role === 'user' ? '教师' : '助手'}：${item.content}`)
    .join('\n');
  if (!history) return request.message;
  return `此前会话记录（仅作上下文，不要重复输出记录本身）：\n${history}\n\n当前教师请求：\n${request.message}`;
}

async function run(root: string, request: HostRequest): Promise<HostResult> {
  const load = loadFrom(root);
  const { Context } = await load('vendor/cordis/src/index.ts');
  const llm = await load('packages/llm/llm/src/index.ts');
  const { default: SessionStore } = await load('packages/core/session/src/index.ts');
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
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [] });
    await ctx.plugin(deepSeek, { apiKeyEnv: 'DEEPSEEK_API_KEY' });

    const { createUserMessage } = llm;
    const handle = await ctx.agents.create({
      sessionId: request.sessionId,
      agentOptions: { provider: 'deepseek-official', model: request.model },
    });
    try {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: contextMessage(request) }],
        source: { kind: 'user' },
      }));
      await handle.agent.whenIdle();
      await ctx.sessions.flush(handle.agent.session);
      const events = handle.agent.session.snapshotEvents(0);
      const assistantEvents = events.filter((event: any) => event.type === 'assistant/message');
      const lastAssistant = assistantEvents.at(-1) as any;
      const end = events.findLast((event: any) => event.type === 'turn/end') as any;
      const reason = end?.data?.reason;
      const usage = lastAssistant?.data?.usage;
      const outcome = reason?.kind === 'completed'
        ? 'completed'
        : reason?.kind === 'cancelled'
          ? 'cancelled'
          : reason?.kind === 'error'
            ? 'failed'
            : 'outcome_unknown';
      return {
        sessionId: request.sessionId,
        lastEventSeq: Math.max(-1, handle.agent.session.seq - 1),
        outcome,
        reply: textFromMessage(lastAssistant?.data?.message) || null,
        replayed: false,
        modelCalls: assistantEvents.length,
        inputTokens: typeof usage?.inputTokens === 'number' ? usage.inputTokens : null,
        outputTokens: typeof usage?.outputTokens === 'number' ? usage.outputTokens : null,
        toolCalls: events.filter((event: any) => event.type === 'tool/result').length,
      };
    } finally {
      await handle.dispose();
    }
  } finally {
    await ctx.fiber.dispose();
  }
}

const root = process.env.DSH_RUNTIME_ROOT;
if (!root) throw new Error('DSH_RUNTIME_ROOT is required');

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    const request = JSON.parse(line) as HostRequest;
    const result = await run(root, request);
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 200) : 'DSH host failed',
    })}\n`);
  }
}
