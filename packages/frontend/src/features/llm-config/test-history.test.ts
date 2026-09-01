import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadTestHistory,
  removeTestHistory,
  saveTestHistory,
  testHistoryKey,
  type TestHistoryEntry,
} from './test-history';
import type { ProviderTestResult } from '../../api/types';

const okResult: ProviderTestResult = { ok: true, providerName: 'deepseek', model: 'deepseek-chat' };

function entry(testedAt: string, result: ProviderTestResult = okResult): TestHistoryEntry {
  return { testedAt, result };
}

describe('test-history（LLM 测试历史 localStorage 持久化）', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('无历史时返回空对象', () => {
    expect(loadTestHistory('t1')).toEqual({});
  });

  it('save 后 load 可读回完整条目（含前端记录的时间戳与结果）', () => {
    const saved = saveTestHistory('t1', 'config-1', entry('2026-08-01T10:05:00.000Z'));
    expect(saved['config-1']).toEqual(entry('2026-08-01T10:05:00.000Z'));
    expect(loadTestHistory('t1')['config-1']).toEqual(entry('2026-08-01T10:05:00.000Z'));
    expect(window.localStorage.getItem(testHistoryKey('t1'))).toContain('config-1');
  });

  it('同 providerId 重复测试：覆盖旧条目（仅保留最近一次）', () => {
    saveTestHistory('t1', 'config-1', entry('2026-08-01T10:05:00.000Z'));
    const saved = saveTestHistory('t1', 'config-1', entry('2026-08-01T11:00:00.000Z'));
    expect(Object.keys(saved)).toHaveLength(1);
    expect(saved['config-1'].testedAt).toBe('2026-08-01T11:00:00.000Z');
  });

  it('remove 删除指定 provider 条目，不影响其他条目', () => {
    saveTestHistory('t1', 'config-1', entry('2026-08-01T10:05:00.000Z'));
    saveTestHistory('t1', 'config-2', entry('2026-08-01T10:06:00.000Z'));
    const next = removeTestHistory('t1', 'config-1');
    expect(next['config-1']).toBeUndefined();
    expect(next['config-2']).toBeTruthy();
    expect(loadTestHistory('t1')['config-2']).toBeTruthy();
  });

  it('超过 20 条时按 testedAt 倒序裁剪（保留最近 20 条）', () => {
    for (let i = 0; i < 25; i += 1) {
      const ts = `2026-08-01T${String(i).padStart(2, '0')}:00:00.000Z`;
      saveTestHistory('t1', `config-${i}`, entry(ts));
    }
    const all = loadTestHistory('t1');
    expect(Object.keys(all)).toHaveLength(20);
    // 保留最新 20 条：config-5..config-24
    expect(all['config-0']).toBeUndefined();
    expect(all['config-4']).toBeUndefined();
    expect(all['config-5']).toBeTruthy();
    expect(all['config-24']).toBeTruthy();
  });

  it('localStorage 损坏（非法 JSON）时静默降级为空历史', () => {
    window.localStorage.setItem(testHistoryKey('t1'), '{not-json');
    expect(loadTestHistory('t1')).toEqual({});
  });

  it('形状不合法的条目被过滤（缺 testedAt / result.ok 非布尔）', () => {
    window.localStorage.setItem(
      testHistoryKey('t1'),
      JSON.stringify({
        'bad-1': { testedAt: '2026-08-01T00:00:00.000Z', result: { ok: 'yes' } },
        'bad-2': { result: { ok: true } },
        'good': entry('2026-08-01T00:00:00.000Z'),
      }),
    );
    expect(Object.keys(loadTestHistory('t1'))).toEqual(['good']);
  });

  it('按教师隔离：不同 teacherId 的 key 与内容互不影响', () => {
    saveTestHistory('t1', 'config-1', entry('2026-08-01T10:05:00.000Z'));
    expect(loadTestHistory('t2')).toEqual({});
    expect(testHistoryKey('t1')).not.toBe(testHistoryKey('t2'));
  });
});
