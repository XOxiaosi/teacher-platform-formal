import { describe, expect, it } from 'vitest';
import config from '../../vite.config.js';

describe('teacher frontend Vite configuration', () => {
  it('keeps the controller port deterministic', () => {
    expect(config.server?.port).toBe(5173);
    expect(config.server?.strictPort).toBe(true);
  });
});
