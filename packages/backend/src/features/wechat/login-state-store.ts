import { randomBytes } from 'node:crypto';
import type { LoginStateStore, WechatLoginState } from './types.js';

/**
 * 扫码登录 state 存储（阶段一内存实现，零依赖）。
 *
 * - state = randomBytes(32) base64url（不可预测，防 CSRF/劫持）；
 * - TTL 用 performance.now()（单调时钟，D47/D48 纪律：簿记时间不走墙钟，不登记 R1）；
 * - 一次性语义：状态机 pending → confirmed → bound 单向流转，重放回调/重复 bind 被状态拒绝；
 * - 键数上限防护（maxKeys，防内存耗尽型攻击）+ unref 巡检定时器（同 rate-limit 风格）。
 */

export interface CreateLoginStateStoreOptions {
  ttlMs?: number;
  maxKeys?: number;
  sweepIntervalMs?: number;
  /** 单调时钟（测试注入；缺省 performance.now）。 */
  nowMs?: () => number;
}

export function createLoginStateStore(options: CreateLoginStateStoreOptions = {}): LoginStateStore {
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  const maxKeys = options.maxKeys ?? 100_000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
  const nowMs = options.nowMs ?? (() => performance.now());

  const states = new Map<string, WechatLoginState>();

  function isExpired(state: WechatLoginState, now: number): boolean {
    return state.expiresAtMs <= now;
  }

  function sweepNow(): void {
    const now = nowMs();
    for (const [key, state] of states) {
      if (isExpired(state, now)) states.delete(key);
    }
  }

  // 巡检定时器（与 database-pool/rate-limit 同风格：unref 不阻塞进程退出）
  const sweepTimer = setInterval(sweepNow, sweepIntervalMs);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  return {
    create(input) {
      if (states.size >= maxKeys) return null; // 键数上限：拒绝新建（防内存耗尽）
      const state: WechatLoginState = {
        state: randomBytes(32).toString('base64url'),
        ...(input.teacherId ? { teacherId: input.teacherId } : {}),
        status: 'pending',
        expiresAtMs: nowMs() + ttlMs,
      };
      states.set(state.state, state);
      return state.state;
    },

    get(state) {
      const entry = states.get(state);
      if (!entry) return undefined;
      if (isExpired(entry, nowMs())) {
        states.delete(state);
        return undefined;
      }
      return entry;
    },

    markConfirmed(state, input) {
      const entry = states.get(state);
      if (!entry || entry.status !== 'pending') return false;
      if (isExpired(entry, nowMs())) {
        states.delete(state);
        return false;
      }
      entry.status = 'confirmed';
      entry.externalUserId = input.externalUserId;
      if (input.providerChannelId) entry.providerChannelId = input.providerChannelId;
      return true;
    },

    markBound(state) {
      const entry = states.get(state);
      if (!entry) return false;
      if (isExpired(entry, nowMs())) {
        states.delete(state);
        return false;
      }
      if (entry.status === 'pending' || entry.status === 'confirmed') {
        entry.status = 'bound';
        return true;
      }
      return false; // 已 bound：重放拒绝
    },

    delete(state) {
      states.delete(state);
    },

    size() {
      return states.size;
    },

    sweep() {
      sweepNow();
    },
  };
}
