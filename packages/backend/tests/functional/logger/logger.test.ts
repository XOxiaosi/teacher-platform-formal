import { describe, it, expect } from 'vitest';
import { createLogger, parseLogLevel } from '../../../src/shared/logger/index.js';

/** 捕获 logger 输出的测试 sink。 */
function captureLogger(level?: 'debug' | 'info' | 'warn' | 'error') {
  const lines: string[] = [];
  const logger = createLogger({ level, write: (line) => lines.push(line) });
  return { logger, lines };
}

describe('parseLogLevel', () => {
  it('缺省/非法值回退 info', () => {
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('bogus')).toBe('info');
  });

  it('识别四种级别（大小写不敏感）', () => {
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel('info')).toBe('info');
    expect(parseLogLevel('warn')).toBe('warn');
    expect(parseLogLevel('error')).toBe('error');
  });
});

describe('createLogger 结构化输出', () => {
  it('输出单行 JSON，含 ts/level/msg 与附加字段', () => {
    const { logger, lines } = captureLogger('info');
    logger.info('request completed', {
      requestId: 'req_abc123',
      teacherId: 'clx_teacher_1',
      method: 'GET',
      path: '/api/v1/students',
      status: 200,
      durationMs: 12.3,
    });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe('info');
    expect(entry.msg).toBe('request completed');
    expect(entry.requestId).toBe('req_abc123');
    expect(entry.teacherId).toBe('clx_teacher_1');
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/api/v1/students');
    expect(entry.status).toBe(200);
    expect(entry.durationMs).toBe(12.3);

    // ts 是合法 ISO 时间
    const parsed = new Date(entry.ts);
    expect(parsed.getTime()).not.toBeNaN();
  });

  it('undefined 字段不输出；error 序列化为 {name,message,stack}', () => {
    const { logger, lines } = captureLogger('info');
    logger.error('db acquire failed', {
      dbName: 'teacher_db_001',
      teacherId: undefined,
      error: new Error('connection refused'),
    });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.teacherId).toBeUndefined();
    expect(entry.error.name).toBe('Error');
    expect(entry.error.message).toBe('connection refused');
    expect(typeof entry.error.stack).toBe('string');
  });

  it('level 过滤：低于阈值的不输出（info 下 debug 丢弃、error 输出）', () => {
    const { logger, lines } = captureLogger('info');
    logger.debug('hidden');
    logger.warn('visible warn');
    logger.error('visible error');

    expect(lines).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(['warn', 'error']);
  });

  it('debug 级别放行 debug 日志', () => {
    const { logger, lines } = captureLogger('debug');
    logger.debug('debug visible');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).level).toBe('debug');
  });
});
