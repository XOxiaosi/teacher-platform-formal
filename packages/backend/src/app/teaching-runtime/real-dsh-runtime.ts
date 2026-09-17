import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { err, ok, type Result } from '@teacher-platform/contracts';
import type { TeachingRuntimeDriver, TeachingRuntimeError, TeachingRuntimeInput, TeachingRuntimeOutput } from './runtime-driver.js';
import { dshTeachingSessionId } from './dsh-runtime-driver.js';
import type {
  DshHostResult,
  DshHostRunRequest,
  DshHostToolCall,
  DshHostToolResult,
  DshUsageRecord,
} from './dsh-adapter-contract.js';
import type { ToolDefinition } from '../../shared/tool-registry/types.js';

export const DSH_PINNED_COMMIT = 'c291e7961a515f6d7af9304e7fd1d257929aef26';

export interface RealDshTeachingRuntimeOptions {
  /** Fixed upstream source checkout at DSH_PINNED_COMMIT. */
  runtimeRoot: string;
  /** Optional repo-external env file containing DEEPSEEK_API_KEY=... . */
  apiKeyFile?: string;
  /** Model accepted by the configured DeepSeek endpoint. */
  model?: string;
  /** Host script path; defaults to the repository's JSONL bridge. */
  hostScript?: string;
  /** Upper bound for one isolated host invocation. */
  timeoutMs?: number;
  /** Repo-external root for DSH JSONL session persistence. */
  sessionRoot?: string;
  /** Formal project root used to resolve the host bridge when hostScript is omitted. */
  projectRoot?: string;
  /** Injectable only for synthetic tests; production reads the checkout's HEAD. */
  gitHeadReader?: (root: string) => string;
  /** Durable platform-owned usage sink; omitted only for configuration tests. */
  onUsage?: (record: DshUsageRecord) => Promise<void>;
}

type HostResult = DshHostResult;

function error(field: string, message: string, retryable: boolean): Result<never, TeachingRuntimeError> {
  return err({ code: 'VALIDATION_ERROR', field, message, retryable });
}

function keyFromFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const line = readFileSync(path, 'utf8').split(/\r?\n/).find((item) => item.startsWith('DEEPSEEK_API_KEY='));
    const value = line?.slice('DEEPSEEK_API_KEY='.length).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function resolveKey(options: RealDshTeachingRuntimeOptions): string | undefined {
  const ambient = process.env.DEEPSEEK_API_KEY?.trim();
  return ambient || keyFromFile(options.apiKeyFile ?? process.env.DEEPSEEK_API_KEY_FILE);
}

function validConfig(options: RealDshTeachingRuntimeOptions): boolean {
  const root = resolve(options.runtimeRoot);
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const script = resolve(options.hostScript ?? join(projectRoot, 'scripts/dsh-teaching-host.ts'));
  const sessionRoot = options.sessionRoot ?? process.env.DSH_SESSION_ROOT;
  let pinned = false;
  try {
    const readHead = options.gitHeadReader ?? ((directory: string) => execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }));
    pinned = readHead(root).trim() === DSH_PINNED_COMMIT;
  } catch { /* Missing Git metadata is not a verified runtime. */ }
  return pinned && isAbsolute(options.runtimeRoot)
    && existsSync(join(root, 'packages/core/agent-loop/src/index.ts'))
    && existsSync(join(root, 'node_modules/tsx/package.json'))
    && existsSync(script)
    && typeof sessionRoot === 'string'
    && isAbsolute(sessionRoot)
    && resolve(sessionRoot) !== root
    && resolve(sessionRoot) !== projectRoot
    && Boolean(resolveKey(options));
}

function hostFailure(message: string, retryable = true): Result<never, TeachingRuntimeError> {
  return error('DSH_HOST_UNAVAILABLE', message, retryable);
}

async function recordUsage(
  options: RealDshTeachingRuntimeOptions,
  input: TeachingRuntimeInput,
  sessionId: string,
  eventKey: string,
  outcome: DshUsageRecord['outcome'],
  cost: TeachingRuntimeOutput['cost'],
  replayed = false,
): Promise<Result<void, TeachingRuntimeError>> {
  if (!options.onUsage) return ok(undefined);
  try {
    await options.onUsage({
      teacherId: input.teacherId,
      taskId: input.taskId,
      executionId: input.executionId,
      sessionId,
      eventKey,
      replayed,
      outcome,
      cost,
      currencyAmount: null,
    });
    return ok(undefined);
  } catch {
    return error('DSH_USAGE_RECORD_FAILED', 'AI 用量记录未能保存，结果待核对', true);
  }
}

const FORBIDDEN_TOOL_ARGUMENTS = new Set(['teacherId', 'prisma', 'credentials', 'apiKey']);
function wireToolName(name: string): string { return name.replaceAll('.', '_'); }

function safeToolDefinitions(input: TeachingRuntimeInput): ToolDefinition[] {
  return input.tools.definitions
    .filter((definition) => definition.sideEffect === 'read' && definition.confirmation !== 'required')
    .map((definition) => {
      const parameters = structuredClone(definition.parameters);
      const normalizedParameters = Object.keys(parameters).length === 0
        ? { type: 'object', properties: {}, additionalProperties: false }
        : parameters;
      return {
        name: definition.name,
        description: definition.description,
        parameters: normalizedParameters,
        sideEffect: 'read' as const,
        ...(definition.confirmation ? { confirmation: definition.confirmation } : {}),
      };
    });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function invokeHost(options: RealDshTeachingRuntimeOptions, input: TeachingRuntimeInput): Promise<Result<HostResult, TeachingRuntimeError>> {
  if (input.signal.aborted) return error('DSH_CANCELLED', '教学任务已暂停', true);
  const root = resolve(options.runtimeRoot);
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const script = resolve(options.hostScript ?? join(projectRoot, 'scripts/dsh-teaching-host.ts'));
  const sessionRoot = options.sessionRoot ?? process.env.DSH_SESSION_ROOT;
  const key = resolveKey(options);
  if (!key) return hostFailure('DeepSeek API 配置未就绪');
  if (!sessionRoot || !isAbsolute(sessionRoot)) return hostFailure('DSH 会话持久化目录未配置', false);
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return error('DSH_TIMEOUT_INVALID', 'DSH 运行超时配置无效', false);
  const sessionId = dshTeachingSessionId(input);
  const definitions = safeToolDefinitions(input);
  const request: DshHostRunRequest = {
    sessionId,
    executionId: input.executionId,
    resume: input.sessionRef !== null,
    message: input.message,
    model: options.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
    history: input.history.map((entry) => ({ role: entry.role, content: entry.content })),
    tools: definitions,
    sessionRoot,
  };

  return await new Promise((resolveResult) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', script], {
      // Resolve the DSH workspace's package aliases and tsx loader from the
      // fixed upstream checkout. The bridge itself remains an absolute path in
      // the formal project, so no source or credential is copied into DSH.
      cwd: root,
      env: {
        ...process.env,
        DSH_RUNTIME_ROOT: root,
        DSH_SESSION_ROOT: sessionRoot,
        DEEPSEEK_API_KEY: key,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    let expectedCallId = 1;
    let observedToolCalls = 0;
    let protocolFailure = false;
    let finalResult: HostResult | undefined;
    let lineChain: Promise<void> = Promise.resolve();
    const finish = (result: Result<HostResult, TeachingRuntimeError>) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(hostFailure('AI 运行超时，结果待核对', true));
    }, timeoutMs);
    const abort = () => {
      child.kill('SIGTERM');
      finish(error('DSH_CANCELLED', '教学任务已暂停', true));
    };
    input.signal.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const handleLine = async (line: string) => {
      if (settled || !line.trim()) return;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { protocolFailure = true; child.kill('SIGTERM'); return; }
      if (isPlainRecord(parsed) && parsed.type === 'tool_call') {
        const call = parsed as Partial<DshHostToolCall>;
        const validCall = call.sessionId === sessionId
          && call.executionId === input.executionId
          && call.callId === expectedCallId
          && Number.isSafeInteger(call.callId) && (call.callId as number) > 0
          && typeof call.name === 'string'
          && isPlainRecord(call.args)
          && Object.keys(call.args).every((key) => !FORBIDDEN_TOOL_ARGUMENTS.has(key))
          && definitions.some((definition) => definition.name === call.name || wireToolName(definition.name) === call.name);
        expectedCallId += 1;
        if (!validCall) {
          protocolFailure = true;
          child.kill('SIGTERM');
          return;
        }
        const definition = definitions.find((item) => item.name === call.name || wireToolName(item.name) === call.name);
        if (!definition) {
          protocolFailure = true;
          child.kill('SIGTERM');
          return;
        }
        const result = await input.tools.execute(definition.name, call.args);
        const response: DshHostToolResult = {
          type: 'tool_result', sessionId, executionId: input.executionId,
          callId: call.callId!, result,
        };
        try {
          child.stdin.write(`${JSON.stringify(response)}\n`);
          observedToolCalls += 1;
        } catch {
          protocolFailure = true;
          child.kill('SIGTERM');
        }
        return;
      }
      if (isPlainRecord(parsed) && parsed.ok === true && parsed.result && !('type' in parsed)) {
        finalResult = parsed.result as HostResult;
        try { child.stdin.end(); } catch { /* close handler reports the failure */ }
        return;
      }
      // A host error or any unrecognized line is not a teacher-visible model
      // result. Kill the child and let the close handler return unavailable.
      protocolFailure = true;
      child.kill('SIGTERM');
    };
    lines.on('line', (line) => {
      lineChain = lineChain.then(() => handleLine(line)).catch(() => {
        protocolFailure = true;
        child.kill('SIGTERM');
      });
    });
    child.once('error', () => finish(hostFailure('AI 运行进程未能启动')));
    child.once('close', async (code) => {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', abort);
      lines.close();
      await lineChain;
      if (settled) return;
      if (protocolFailure) {
        void stderr;
        finish(hostFailure('AI 运行协议无法核验，结果待核对', false));
        return;
      }
      if (finalResult && finalResult.toolCalls === observedToolCalls) {
        finish(ok(finalResult));
        return;
      }
      finish(hostFailure(code === null ? 'AI 运行进程被中断' : 'AI 运行连接中断，结果待核对', false));
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

/**
 * Real DSH adapter boundary. It reports `ready` only when the fixed source
 * tree, host script, and DeepSeek credential are all present. No test model or
 * legacy Agent loop is used as a fallback.
 */
export function createRealDshTeachingRuntime(options: RealDshTeachingRuntimeOptions): TeachingRuntimeDriver {
  const ready = validConfig(options);
  return {
    availability: ready ? 'ready' : 'unavailable',
    runtimeVersion: 'dsh-v1',
    async run(input) {
      // Recheck before every invocation so a checkout changed after startup
      // cannot bypass the pinned-source gate.
      if (!ready || !validConfig(options)) return hostFailure('真实 DSH 运行配置未就绪');
      if (!input.teacherId.trim() || !input.taskId.trim() || !input.executionId.trim()) {
        return error('DSH_IDENTITY_INVALID', '教学任务身份无效', false);
      }
      const sessionRef = dshTeachingSessionId(input);
      if (input.sessionRef !== null && input.sessionRef !== sessionRef) {
        return error('DSH_SESSION_MISMATCH', '教学任务上下文已变更，需要重新整理', false);
      }
      const response = await invokeHost(options, input);
      if (!response.ok) {
        const unknownCost: TeachingRuntimeOutput['cost'] = {
          modelCalls: null, inputTokens: null, outputTokens: null, toolCalls: 0,
          synthetic: false, usageStatus: 'unknown',
        };
        const recorded = await recordUsage(
          options,
          input,
          sessionRef,
          `${sessionRef}:execution:${input.executionId}:unknown`,
          'outcome_unknown',
          unknownCost,
        );
        return recorded.ok ? response : recorded;
      }
      const result = response.value;
      if (result.sessionId !== sessionRef || !Number.isSafeInteger(result.lastEventSeq) || result.lastEventSeq < 0) {
        return error('DSH_RESULT_INVALID', 'AI 运行结果无法核验', false);
      }
      if (!['completed', 'waiting_input', 'cancelled', 'failed', 'outcome_unknown'].includes(result.outcome)
        || typeof result.replayed !== 'boolean'
        || ![result.modelCalls, result.inputTokens, result.outputTokens].every((value) => value === null || Number.isSafeInteger(value) && value >= 0)
        || !Number.isSafeInteger(result.toolCalls) || result.toolCalls < 0) {
        return error('DSH_RESULT_INVALID', 'AI 运行结果无法核验', false);
      }
      const cost: TeachingRuntimeOutput['cost'] = {
        modelCalls: result.modelCalls,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        toolCalls: result.toolCalls,
        synthetic: false,
        usageStatus: result.modelCalls === null || result.inputTokens === null || result.outputTokens === null ? 'unknown' : 'reported',
      };
      const recorded = await recordUsage(
        options,
        input,
        sessionRef,
        `${sessionRef}:execution:${input.executionId}:event:${result.lastEventSeq}`,
        result.outcome,
        cost,
        result.replayed,
      );
      if (!recorded.ok) return recorded;
      if (result.outcome === 'cancelled') return error('DSH_CANCELLED', '教学任务已暂停', true);
      if (result.outcome === 'outcome_unknown') return error('DSH_OUTCOME_UNKNOWN', '上次操作结果待核对，暂不重试', false);
      if (result.outcome === 'failed') return error('DSH_RUN_FAILED', 'AI 暂时未完成，可以重试', true);
      if (!result.reply?.trim()) return error('DSH_EMPTY_REPLY', 'AI 尚未返回完整结果', true);
      return ok({
        reply: result.reply,
        sessionRef,
        status: result.outcome === 'waiting_input' ? 'waiting_input' : 'succeeded',
        checkpoint: {
          schemaVersion: 1,
          runtimeVersion: 'dsh-v1',
          contextEpoch: input.contextEpoch,
          lastEventKey: `${sessionRef}:event:${result.lastEventSeq}`,
        },
        cost,
      });
    },
  };
}
