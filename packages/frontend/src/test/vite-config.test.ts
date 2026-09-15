import { describe, expect, it } from 'vitest';
import config from '../../vite.config.js';

describe('teacher frontend Vite configuration', () => {
  it('bounds DOM worker contention without relaxing timeouts or retrying failures', () => {
    expect(Number(config.test?.maxWorkers)).toBeGreaterThanOrEqual(1);
    expect(Number(config.test?.maxWorkers)).toBeLessThanOrEqual(2);
    expect(config.test?.testTimeout ?? 5000).toBe(5000);
    expect(config.test?.retry ?? 0).toBe(0);
  });

  it('keeps the controller port deterministic', () => {
    expect(config.server?.port).toBe(5173);
    expect(config.server?.strictPort).toBe(true);
  });
});
