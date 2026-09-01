import { describe, it, expect } from 'vitest';
import { validateLessonTransition } from '../../../src/features/lessons/state-machine.js';

describe('validateLessonTransition', () => {
  it('pending -> attended: 合法', () => {
    expect(validateLessonTransition('pending', 'attended').ok).toBe(true);
  });

  it('pending -> absent: 合法', () => {
    expect(validateLessonTransition('pending', 'absent').ok).toBe(true);
  });

  it('attended -> absent: 合法（回溯退还课时）', () => {
    expect(validateLessonTransition('attended', 'absent').ok).toBe(true);
  });

  it('absent -> attended: 合法（回溯补扣课时）', () => {
    expect(validateLessonTransition('absent', 'attended').ok).toBe(true);
  });

  it('attended -> pending: 非法', () => {
    const result = validateLessonTransition('attended', 'pending');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('absent -> pending: 非法', () => {
    expect(validateLessonTransition('absent', 'pending').ok).toBe(false);
  });

  it('pending -> pending: 非法（相同状态）', () => {
    expect(validateLessonTransition('pending', 'pending').ok).toBe(false);
  });

  it('错误信息包含状态和字段名', () => {
    const result = validateLessonTransition('attended', 'pending');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('attended');
    expect(result.error.message).toContain('pending');
    expect(result.error.field).toBe('status');
  });
});