import { describe, expect, it } from 'vitest';
import config from '../../vite.config.js';

describe('admin Vite configuration', () => {
  it('keeps the controller port deterministic', () => {
    expect(config.server?.port).toBe(5174);
    expect(config.server?.strictPort).toBe(true);
  });
});
