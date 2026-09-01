import { describe, it, expect } from 'vitest';
import { validateStudentTransition } from '../../../src/features/students/state-machine.js';

describe('validateStudentTransition', () => {
  it('active -> paused: 合法', () => {
    expect(validateStudentTransition('active', 'paused').ok).toBe(true);
  });

  it('active -> finished: 合法', () => {
    expect(validateStudentTransition('active', 'finished').ok).toBe(true);
  });

  it('paused -> active: 合法', () => {
    expect(validateStudentTransition('paused', 'active').ok).toBe(true);
  });

  it('paused -> finished: 合法', () => {
    expect(validateStudentTransition('paused', 'finished').ok).toBe(true);
  });

  it('finished -> active: 非法（终态）', () => {
    const result = validateStudentTransition('finished', 'active');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('finished -> paused: 非法（终态）', () => {
    expect(validateStudentTransition('finished', 'paused').ok).toBe(false);
  });

  it('active -> active: 非法（相同状态）', () => {
    expect(validateStudentTransition('active', 'active').ok).toBe(false);
  });

  it('错误信息包含当前状态和目标状态', () => {
    const result = validateStudentTransition('finished', 'active');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('finished');
    expect(result.error.message).toContain('active');
    expect(result.error.field).toBe('currentStatus');
  });
});