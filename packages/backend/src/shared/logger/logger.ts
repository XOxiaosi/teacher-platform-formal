/**
 * 统一结构化日志 logger 工厂（P7 G1，T8b 设计 §5.1）。
 *
 * 输出：stdout 单行 JSON，每行一个事件：
 *   {"ts":"2026-08-30T01:00:00.000Z","level":"info","msg":"request completed",
 *    "requestId":"req_abc123","teacherId":"clx_teacher_1","method":"GET",
 *    "path":"/api/v1/students","status":200,"durationMs":12.3}
 *
 * - ts：ISO 8601 UTC；level：debug/info/warn/error（LOG_LEVEL env 控制，默认 info）；
 * - msg：事件名；业务字段（requestId/teacherId/durationMs/dbName/error 等）按事件附加；
 * - undefined 字段不输出；Error 值序列化为 {name,message,stack}，不丢堆栈；
 * - 用 process.stdout.write 直写（非 console），满足 eslint no-console 规则。
 *
 * 采集端（pm2-logrotate / docker json-file / Sentry）留 P1，本文件只定格式。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 日志事件附加字段（设计 §5.1：requestId/teacherId/durationMs/dbName/error + 按事件扩展）。 */
export interface LogFields {
  requestId?: string;
  teacherId?: string;
  durationMs?: number;
  dbName?: string;
  method?: string;
  path?: string;
  status?: number;
  error?: unknown;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const KNOWN_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** 解析 LOG_LEVEL env（非法值回退 info）。 */
export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = (value ?? 'info').trim().toLowerCase();
  return (KNOWN_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as LogLevel)
    : 'info';
}

/** Error → 可 JSON 序列化结构（保留 name/message/stack）。 */
function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return error;
}

export interface CreateLoggerOptions {
  /** 显式级别（测试注入用）；缺省读 process.env.LOG_LEVEL，再缺省 'info'。 */
  level?: LogLevel;
  /** 输出函数（测试捕获用）；缺省写 stdout。 */
  write?: (line: string) => void;
}

export function createLogger(options?: CreateLoggerOptions): Logger {
  const level = options?.level ?? parseLogLevel(process.env.LOG_LEVEL);
  const write = options?.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const threshold = LEVEL_ORDER[level];

  function emit(entryLevel: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[entryLevel] < threshold) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: entryLevel,
      msg,
    };
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        entry[key] = key === 'error' ? serializeError(value) : value;
      }
    }
    write(JSON.stringify(entry));
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
