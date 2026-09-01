/** Framework-agnostic rate-limiter contract and in-memory implementation. */
export interface RateLimiter {
  check(key: string, windowMs: number, max: number): Promise<{ allowed: boolean; retryAfterMs: number }>;
  recordFailure(key: string, options?: { failLimit?: number; lockoutMs?: number }): { locked: boolean; retryAfterMs: number };
  recordSuccess(key: string): void;
  isLocked(key: string): { locked: boolean; retryAfterMs: number };
  size(): number;
  sweep(): void;
}

export interface CreateRateLimiterOptions {
  maxKeys?: number;
  sweepIntervalMs?: number;
}

interface LoginLockState {
  failCount: number;
  lockedUntil: number;
}

export function createSlidingWindowLimiter(options: CreateRateLimiterOptions = {}): RateLimiter {
  const maxKeys = options.maxKeys ?? 100_000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
  const windows = new Map<string, number[]>();
  const locks = new Map<string, LoginLockState>();

  function pruneWindow(key: string, windowMs: number, now: number): number[] {
    const timestamps = windows.get(key) ?? [];
    const cutoff = now - windowMs;
    const kept = timestamps.filter((ts) => ts > cutoff);
    if (kept.length === 0) windows.delete(key);
    else windows.set(key, kept);
    return kept;
  }

  function sweepNow(): void {
    const now = performance.now();
    for (const [key, timestamps] of windows) {
      const kept = timestamps.filter((ts) => ts > now - 24 * 60 * 60 * 1000);
      if (kept.length === 0) windows.delete(key);
      else windows.set(key, kept);
    }
    for (const [key, state] of locks) {
      if (state.lockedUntil > 0 && state.lockedUntil <= now) locks.delete(key);
    }
  }

  const sweepTimer = setInterval(sweepNow, sweepIntervalMs);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  return {
    async check(key, windowMs, max) {
      const now = performance.now();
      const kept = pruneWindow(key, windowMs, now);
      if (kept.length >= max) {
        const oldest = kept[0] ?? now;
        return { allowed: false, retryAfterMs: Math.max(0, oldest + windowMs - now) };
      }
      if (!windows.has(key) && windows.size >= maxKeys) {
        return { allowed: true, retryAfterMs: 0 };
      }
      windows.set(key, [...kept, now]);
      return { allowed: true, retryAfterMs: 0 };
    },
    recordFailure(key, options) {
      const now = performance.now();
      const current = locks.get(key);
      if (current && current.lockedUntil > now) {
        return { locked: true, retryAfterMs: current.lockedUntil - now };
      }
      const failLimit = options?.failLimit ?? 5;
      const lockoutMs = options?.lockoutMs ?? 15 * 60 * 1000;
      const failCount = (current?.failCount ?? 0) + 1;
      if (failCount >= failLimit) {
        const lockedUntil = now + lockoutMs;
        locks.set(key, { failCount, lockedUntil });
        return { locked: true, retryAfterMs: lockoutMs };
      }
      locks.set(key, { failCount, lockedUntil: 0 });
      return { locked: false, retryAfterMs: 0 };
    },
    recordSuccess(key) {
      locks.delete(key);
    },
    isLocked(key) {
      const current = locks.get(key);
      if (!current) return { locked: false, retryAfterMs: 0 };
      const now = performance.now();
      if (current.lockedUntil === 0) return { locked: false, retryAfterMs: 0 };
      if (current.lockedUntil <= now) {
        locks.delete(key);
        return { locked: false, retryAfterMs: 0 };
      }
      return { locked: true, retryAfterMs: current.lockedUntil - now };
    },
    size() {
      return windows.size + locks.size;
    },
    sweep() {
      sweepNow();
    },
  };
}
