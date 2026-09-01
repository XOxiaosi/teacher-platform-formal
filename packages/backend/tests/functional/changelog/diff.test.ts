import { describe, it, expect } from 'vitest';
import { computeDiff } from '../../../src/shared/changelog/diff.js';

describe('computeDiff', () => {
  it('create 动作：before 为 null，返回所有字段为新增', () => {
    const before = null;
    const after = { name: '张三', grade: '高三' };

    const result = computeDiff(before, after);

    expect(result).toEqual([
      { field: 'name', oldValue: null, newValue: '张三' },
      { field: 'grade', oldValue: null, newValue: '高三' },
    ]);
  });

  it('delete 动作：after 为 null，返回所有字段为删除', () => {
    const before = { name: '张三', grade: '高三' };
    const after = null;

    const result = computeDiff(before, after);

    expect(result).toEqual([
      { field: 'name', oldValue: '张三', newValue: null },
      { field: 'grade', oldValue: '高三', newValue: null },
    ]);
  });

  it('update 动作：只返回有变化的字段', () => {
    const before = { name: '张三', grade: '高三', source: '朋友介绍' };
    const after = { name: '张三', grade: '高二', source: '朋友介绍' };

    const result = computeDiff(before, after);

    expect(result).toEqual([
      { field: 'grade', oldValue: '高三', newValue: '高二' },
    ]);
  });

  it('update 动作：新增字段出现在 diff 中', () => {
    const before = { name: '张三' };
    const after = { name: '张三', grade: '高三' };

    const result = computeDiff(before, after);

    expect(result).toEqual([
      { field: 'grade', oldValue: null, newValue: '高三' },
    ]);
  });

  it('update 动作：删除字段出现在 diff 中', () => {
    const before = { name: '张三', grade: '高三' };
    const after = { name: '张三' };

    const result = computeDiff(before, after);

    expect(result).toEqual([
      { field: 'grade', oldValue: '高三', newValue: null },
    ]);
  });

  it('两者都为 null：返回空数组', () => {
    const result = computeDiff(null, null);
    expect(result).toEqual([]);
  });

  it('无变化：返回空数组', () => {
    const before = { name: '张三', grade: '高三' };
    const after = { name: '张三', grade: '高三' };

    const result = computeDiff(before, after);

    expect(result).toEqual([]);
  });

  it('字段顺序不影响比较', () => {
    const before = { grade: '高三', name: '张三' };
    const after = { name: '张三', grade: '高三' };

    const result = computeDiff(before, after);

    expect(result).toEqual([]);
  });

  it('值类型变化（数字变字符串）出现在 diff 中', () => {
    const before = { lessonCount: 10 };
    const after = { lessonCount: '10' };

    const result = computeDiff(before, after);

    expect(result).toEqual([
      { field: 'lessonCount', oldValue: 10, newValue: '10' },
    ]);
  });
});