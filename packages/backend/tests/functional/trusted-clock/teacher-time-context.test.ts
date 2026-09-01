import { describe, expect, it } from 'vitest';

let formatTeacherTimeContext: undefined | ((input: {
  now: Date;
  timeZone: 'Asia/Shanghai';
}) => string);

try {
  const module = await import('../../../src/shared/trusted-clock/teacher-time-context.js');
  formatTeacherTimeContext = module.formatTeacherTimeContext;
} catch {
  // R4 red: formatter does not exist yet.
}

describe('TeacherTimeContext', () => {
  it('用固定业务时区格式化可信 instant，不依赖进程本地时区', () => {
    expect(formatTeacherTimeContext).toBeDefined();
    if (!formatTeacherTimeContext) return;

    const content = formatTeacherTimeContext({
      now: new Date('2026-07-25T07:48:00.000Z'),
      timeZone: 'Asia/Shanghai',
    });

    expect(content).toContain('2026-07-25');
    expect(content).toContain('15:48:00');
    expect(content).toContain('星期六');
    expect(content).toContain('Asia/Shanghai');
    expect(content).toContain('createdAt');
    expect(content).toContain('时区');
  });
});
