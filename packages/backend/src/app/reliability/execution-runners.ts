import { err, internalError } from '@teacher-platform/contracts';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { ToolSideEffect } from '../../shared/tool-registry/types.js';

export const DEFAULT_MODEL_TIMEOUT_MS = 90_000;
export const DEFAULT_READ_TOOL_TIMEOUT_MS = 15_000;

export interface ExecutionLogEvent {
  executionId: string;
  toolCallId: string;
  toolName: string;
  durationMs: number;
  status: 'success' | 'failed' | 'timeout';
  errorCode?: string;
}

export interface ToolRunMetadata {
  executionId: string;
  toolCallId: string;
  toolName: string;
  sideEffect: ToolSideEffect;
}

export interface ExecutionRunners {
  runModel<T>(operation: () => Promise<Result<T, CommonError>>, executionId?: string): Promise<Result<T, CommonError>>;
  runTool<T>(metadata: ToolRunMetadata, operation: () => Promise<Result<T, CommonError>>): Promise<Result<T, CommonError>>;
}

export interface CreateExecutionRunnersOptions {
  modelTimeoutMs: number;
  readToolTimeoutMs: number;
  log?: (event: ExecutionLogEvent) => void;
  monotonicNow?: () => number;
}

function withDeadline<T>(
  operation: () => Promise<Result<T, CommonError>>,
  timeoutMs: number,
  message: string,
): Promise<Result<T, CommonError>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(err(internalError(message)));
    }, timeoutMs);
    void operation().then((result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(err(internalError('执行服务异常')));
    });
  });
}

export function createExecutionRunners(options: CreateExecutionRunnersOptions): ExecutionRunners {
  if (options.modelTimeoutMs <= 0 || options.readToolTimeoutMs <= 0) {
    throw new Error('timeout 必须大于 0');
  }
  const now = options.monotonicNow ?? (() => performance.now());

  return {
    async runModel(operation, executionId) {
      const started = now();
      const result = await withDeadline(operation, options.modelTimeoutMs, '模型响应超时');
      if (executionId) {
        options.log?.({
          executionId,
          toolCallId: '',
          toolName: 'model.chat',
          durationMs: Math.max(0, now() - started),
          status: result.ok ? 'success' : result.error.message === '模型响应超时' ? 'timeout' : 'failed',
          ...(!result.ok ? { errorCode: result.error.code } : {}),
        });
      }
      return result;
    },
    async runTool(metadata, operation) {
      const started = now();
      const result = metadata.sideEffect === 'read'
        ? await withDeadline(operation, options.readToolTimeoutMs, '工具执行超时')
        : await operation().catch(() => err(internalError('工具执行异常')));
      const timedOut = !result.ok && result.error.message === '工具执行超时';
      options.log?.({
        executionId: metadata.executionId,
        toolCallId: metadata.toolCallId,
        toolName: metadata.toolName,
        durationMs: Math.max(0, now() - started),
        status: result.ok ? 'success' : timedOut ? 'timeout' : 'failed',
        ...(!result.ok ? { errorCode: result.error.code } : {}),
      });
      return result;
    },
  };
}
