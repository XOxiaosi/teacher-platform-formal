import { describe, it, expect } from 'vitest';
import { validateTransition } from '../../../src/features/scheduling/state-machine.js';

describe('validateTransition', () => {
  it('planned -> completed: 合法', () => {
    const result = validateTransition('planned', 'completed');
    expect(result.ok).toBe(true);
  });

  it('planned -> cancelled: 合法', () => {
    const result = validateTransition('planned', 'cancelled');
    expect(result.ok).toBe(true);
  });

  it('planned -> missed: 合法', () => {
    const result = validateTransition('planned', 'missed');
    expect(result.ok).toBe(true);
  });

  it('planned -> rescheduled: 合法', () => {
    const result = validateTransition('planned', 'rescheduled');
    expect(result.ok).toBe(true);
  });

  it('extra -> completed: 合法（临时加课直接完成）', () => {
    const result = validateTransition('extra', 'completed');
    expect(result.ok).toBe(true);
  });

  it('completed -> planned: 非法（已完成不能回到计划）', () => {
    const result = validateTransition('completed', 'planned');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.message).toContain('completed');
    expect(result.error.message).toContain('planned');
  });

  it('cancelled -> planned: 合法（D49 误删恢复，restore 前过冲突检查）', () => {
    const result = validateTransition('cancelled', 'planned');
    expect(result.ok).toBe(true);
  });

  it('cancelled -> completed: 非法', () => {
    const result = validateTransition('cancelled', 'completed');
    expect(result.ok).toBe(false);
  });

  it('missed -> completed: 非法（缺席不能变完成）', () => {
    const result = validateTransition('missed', 'completed');
    expect(result.ok).toBe(false);
  });

  it('rescheduled -> planned: 非法（已改期不能恢复）', () => {
    const result = validateTransition('rescheduled', 'planned');
    expect(result.ok).toBe(false);
  });

  it('planned -> planned: 非法（相同状态无意义）', () => {
    const result = validateTransition('planned', 'planned');
    expect(result.ok).toBe(false);
  });

  it('相同终态之间不能转换: completed -> cancelled', () => {
    const result = validateTransition('completed', 'cancelled');
    expect(result.ok).toBe(false);
  });

  it('错误信息包含当前状态和目标状态', () => {
    const result = validateTransition('completed', 'planned');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('completed');
    expect(result.error.message).toContain('planned');
    expect(result.error.field).toBe('status');
  });
});