import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { err, ok, type Result } from '@teacher-platform/contracts';
import type { TeachingRuntimeDriver, TeachingRuntimeError, TeachingRuntimeInput, TeachingRuntimeOutput } from './runtime-driver.js';
import { dshTeachingSessionId } from './dsh-runtime-driver.js';

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
  /** Formal project root used to resolve the host bridge when hostScript is omitted. */
  projectRoot?: string;
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
  return isAbsolute(options.runtimeRoot)
    && existsSync(join(root, 'packages/core/agent-loop/src/index.ts'))
    && existsSync(join(root, 'node_modules/tsx/package.json'))
    && existsSync(script)
    && Boolean(resolveKey(options));
}

function hostFailure(message: string, retryable = true): Result<never, TeachingRuntimeError> {
  return error('DSH_HOST_UNAVAILABLE', message, retryable);
}

async function invokeHost(options: RealDshTeachingRuntimeOptions, input: TeachingRuntimeInput): Promise<Result<HostResult, TeachingRuntimeError>> {
  if (input.signal.aborted) return error('DSH_CANCELLED', '教学任务已暂停', true);
  const root = resolve(options.runtimeRoot);
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const script = resolve(options.hostScript ?? join(projectRoot, 'scripts/dsh-teaching-host.ts'));
  const key = resolveKey(options);
  if (!key) return hostFailure('DeepSeek API 配置未就绪');
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return error('DSH_TIMEOUT_INVALID', 'DSH 运行超时配置无效', false);

  return await new Promise((resolveResult) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', script], {
      // Resolve the DSH workspace's package aliases and tsx loader from the
      // fixed upstream checkout. The bridge itself remains an absolute path in
      // the formal project, so no source or credential is copied into DSH.
      cwd: root,
      env: {
        ...process.env,
        DSH_RUNTIME_ROOT: root,
        DEEPSEEK_API_KEY: key,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
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
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', () => finish(hostFailure('AI 运行进程未能启动')));
    child.once('exit', (code) => {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', abort);
      if (settled) return;
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      try {
        const parsed = line ? JSON.parse(line) as { ok: boolean; result?: HostResult } : undefined;
        if (parsed?.ok && parsed.result) {
          finish(ok(parsed.result));
          return;
        }
      } catch { /* malformed child output is handled as an unavailable host */ }
      // stderr is deliberately not reflected to the teacher; it is only useful
      // to the parent process logger while debugging the local adapter.
      void stderr;
      finish(hostFailure(code === null ? 'AI 运行进程被中断' : 'AI 运行连接中断，结果待核对', false));
    });
    child.stdin.end(JSON.stringify({
      sessionId: dshTeachingSessionId(input),
      executionId: input.executionId,
      message: input.message,
      model: options.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
      history: input.history,
    }) + '\n');
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
      if (!ready) return hostFailure('真实 DSH 运行配置未就绪');
      if (!input.teacherId.trim() || !input.taskId.trim() || !input.executionId.trim()) {
        return error('DSH_IDENTITY_INVALID', '教学任务身份无效', false);
      }
      const sessionRef = dshTeachingSessionId(input);
      if (input.sessionRef !== null && input.sessionRef !== sessionRef) {
        return error('DSH_SESSION_MISMATCH', '教学任务上下文已变更，需要重新整理', false);
      }
      const response = await invokeHost(options, input);
      if (!response.ok) return response;
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
      if (result.outcome === 'cancelled') return error('DSH_CANCELLED', '教学任务已暂停', true);
      if (result.outcome === 'outcome_unknown') return error('DSH_OUTCOME_UNKNOWN', '上次操作结果待核对，暂不重试', false);
      if (result.outcome === 'failed') return error('DSH_RUN_FAILED', 'AI 暂时未完成，可以重试', true);
      if (!result.reply?.trim()) return error('DSH_EMPTY_REPLY', 'AI 尚未返回完整结果', true);
      const cost: TeachingRuntimeOutput['cost'] = {
        modelCalls: result.modelCalls,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        toolCalls: result.toolCalls,
        synthetic: false,
        usageStatus: result.modelCalls === null || result.inputTokens === null || result.outputTokens === null ? 'unknown' : 'reported',
      };
      return ok({
        reply: result.reply,
        sessionRef,
        status: result.outcome === 'waiting_input' ? 'waiting_input' : 'succeeded',
        checkpoint: { schemaVersion: 1, runtimeVersion: 'dsh-v1', contextEpoch: input.contextEpoch, lastEventKey: `${sessionRef}:event:${result.lastEventSeq}` },
        cost,
      });
    },
  };
}
