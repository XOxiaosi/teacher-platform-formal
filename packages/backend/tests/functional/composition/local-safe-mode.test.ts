import { describe, expect, it } from 'vitest';
import { resolveLocalSafeMode } from '../../../src/app/composition/local-safe-mode.js';

describe('L0 local-safe mode resolution', () => {
  it('缺省开启，非严格 false 值也不能误关闭', () => {
    expect(resolveLocalSafeMode(undefined, {})).toBe(true);
    expect(resolveLocalSafeMode(undefined, { LOCAL_SAFE_MODE: 'FALSE' })).toBe(true);
    expect(resolveLocalSafeMode(undefined, { LOCAL_SAFE_MODE: '0' })).toBe(true);
  });

  it('只有显式 false 才关闭，调用参数优先于 env', () => {
    expect(resolveLocalSafeMode(false, {})).toBe(false);
    expect(resolveLocalSafeMode(undefined, { LOCAL_SAFE_MODE: 'false' })).toBe(false);
    expect(resolveLocalSafeMode(true, { LOCAL_SAFE_MODE: 'false' })).toBe(true);
  });
});
