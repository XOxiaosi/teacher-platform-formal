import { describe, it, expect } from 'vitest';
import {
  budgetConfigFromEnv,
  createBudgetTracker,
  dateKeyOf,
  estimateTokens,
  truncateHistory,
} from '../../../src/shared/agent-cost/index.js';

describe('estimateTokens', () => {
  it('空串为 0；纯英文约 4 字符/token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('hello world')).toBe(3); // 11 字符 → ceil(11/4)=3
  });

  it('CJK 字符约 1 字/token', () => {
    expect(estimateTokens('你好')).toBe(2);
    expect(estimateTokens('今天天气很好')).toBe(6);
  });

  it('混合文本：CJK 计 1、其余按 4 字符/token', () => {
    // '你好' (2) + 'abc' (ceil(3/4)=1) = 3
    expect(estimateTokens('你好abc')).toBe(3);
  });

  it('全角标点按 CJK 计', () => {
    expect(estimateTokens('，。')).toBe(2);
  });
});

describe('dateKeyOf', () => {
  it('生成 YYYY-MM-DD 本地日期键', () => {
    expect(dateKeyOf(new Date(2026, 7, 30, 2, 0, 0))).toBe('2026-08-30');
    expect(dateKeyOf(new Date(2026, 0, 5, 23, 59, 59))).toBe('2026-01-05');
  });
});

describe('createBudgetTracker 记账', () => {
  const config = { dailyTokenLimit: 1000, perTurnTokenLimit: 200 };

  it('正常消耗累计 usedToday 并返回剩余', () => {
    const tracker = createBudgetTracker(config);
    const first = tracker.checkAndConsume('t1', 100, new Date(2026, 7, 30));
    expect(first.ok).toBe(true);
    expect(first.usedToday).toBe(100);
    expect(first.remaining).toBe(900);

    const second = tracker.checkAndConsume('t1', 150, new Date(2026, 7, 30));
    expect(second.ok).toBe(true);
    expect(second.usedToday).toBe(250);
    expect(second.remaining).toBe(750);
  });

  it('不同教师独立记账', () => {
    const tracker = createBudgetTracker(config);
    tracker.checkAndConsume('a', 900, new Date(2026, 7, 30));
    const b = tracker.checkAndConsume('b', 100, new Date(2026, 7, 30));
    expect(b.ok).toBe(true);
    expect(b.usedToday).toBe(100);
  });

  it('单轮超限：ok=false turnExceeded，不记账', () => {
    const tracker = createBudgetTracker(config);
    const result = tracker.checkAndConsume('t1', 300, new Date(2026, 7, 30));
    expect(result.ok).toBe(false);
    expect(result.turnExceeded).toBe(true);
    expect(result.dailyExceeded).toBe(false);
    expect(tracker.usedToday('t1', new Date(2026, 7, 30))).toBe(0); // 未记账
  });

  it('每日超限：ok=false dailyExceeded，不记账', () => {
    const tracker = createBudgetTracker({ dailyTokenLimit: 1000, perTurnTokenLimit: 2000 });
    tracker.checkAndConsume('t1', 900, new Date(2026, 7, 30));
    const result = tracker.checkAndConsume('t1', 200, new Date(2026, 7, 30));
    expect(result.ok).toBe(false);
    expect(result.dailyExceeded).toBe(true);
    expect(result.turnExceeded).toBe(false);
    expect(tracker.usedToday('t1', new Date(2026, 7, 30))).toBe(900); // 未叠加
  });

  it('日期窗口重置：跨天 usedToday 归零', () => {
    const tracker = createBudgetTracker({ dailyTokenLimit: 1000, perTurnTokenLimit: 2000 });
    tracker.checkAndConsume('t1', 900, new Date(2026, 7, 30));
    expect(tracker.usedToday('t1', new Date(2026, 7, 30))).toBe(900);
    // 次日
    const nextDay = tracker.checkAndConsume('t1', 100, new Date(2026, 7, 31));
    expect(nextDay.ok).toBe(true);
    expect(nextDay.usedToday).toBe(100); // 重置后从 0 累计
  });

  it('reset 清空指定教师', () => {
    const tracker = createBudgetTracker(config);
    tracker.checkAndConsume('t1', 500, new Date(2026, 7, 30));
    tracker.reset('t1');
    expect(tracker.usedToday('t1', new Date(2026, 7, 30))).toBe(0);
  });
});

describe('truncateHistory 截断策略', () => {
  // 每回合 content 长度 = token 数（1 字符英文 = ceil(1/4)=1 token）
  const turn = (role: string, content: string) => ({ role, content });

  it('未超预算：原样返回', () => {
    const turns = [turn('user', 'a'), turn('assistant', 'b')];
    expect(truncateHistory(turns, 10)).toEqual(turns);
  });

  it('超预算：保留最新回合，丢弃最旧', () => {
    const turns = [
      turn('user', 'old question'),      // 11 chars → 3 tokens
      turn('assistant', 'old answer'),   // 3
      turn('user', 'new question'),      // 3
      turn('assistant', 'new answer'),   // 3
    ];
    const result = truncateHistory(turns, 6);
    // 共 12 tokens > 6；从尾部保留：new answer(3) + new question(3) = 6 ≤ 6
    expect(result).toEqual([
      turn('user', 'new question'),
      turn('assistant', 'new answer'),
    ]);
  });

  it('system 首条恒保留', () => {
    const turns = [
      turn('system', 'context rule'),  // 3
      turn('user', 'old q'),           // 1
      turn('assistant', 'old a'),      // 1
      turn('user', 'new q'),           // 1
    ];
    const result = truncateHistory(turns, 4);
    // system(3) 恒首位；尾部从最新：new q(1) → 4 ≤ 4 保留；old a(1) → 5 > 4 停
    expect(result).toEqual([
      turn('system', 'context rule'),
      turn('user', 'new q'),
    ]);
  });

  it('预算极小：至少保留最新一条（system 场景不空上下文）', () => {
    const turns = [
      turn('system', 'long system rule here'),
      turn('user', 'question'),
    ];
    const result = truncateHistory(turns, 2);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].role).toBe('system');
  });
});

describe('budgetConfigFromEnv', () => {
  it('默认 50000/8000', () => {
    expect(budgetConfigFromEnv({})).toEqual({ dailyTokenLimit: 50000, perTurnTokenLimit: 8000 });
  });

  it('env 覆盖；非法值回退默认', () => {
    const config = budgetConfigFromEnv({ AGENT_DAILY_TOKEN_LIMIT: '100000', AGENT_TURN_TOKEN_LIMIT: '4000' });
    expect(config).toEqual({ dailyTokenLimit: 100000, perTurnTokenLimit: 4000 });

    const invalid = budgetConfigFromEnv({ AGENT_DAILY_TOKEN_LIMIT: 'abc', AGENT_TURN_TOKEN_LIMIT: '-5' });
    expect(invalid).toEqual({ dailyTokenLimit: 50000, perTurnTokenLimit: 8000 });
  });
});
