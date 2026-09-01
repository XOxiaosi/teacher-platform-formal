import { describe, expect, it } from 'vitest';
import { createPlatformServicesForMode } from '../../../src/app/composition/core-route-dependencies.js';

const EXTERNAL_PLATFORM_ENV = {
  PLATFORM_SERVICES_ENABLED: 'true',
  PLATFORM_ASR_PROVIDER: 'tencent',
  PLATFORM_OCR_PROVIDER: 'tencent',
  PLATFORM_MODERATION_PROVIDER: 'external',
  PLATFORM_SCAN_PROVIDER: 'clamav',
} as NodeJS.ProcessEnv;

describe('L0 local-safe platform service assembly', () => {
  it('local-safe 忽略真实供应商 env，复用默认关闭能力返回空门面', () => {
    expect(createPlatformServicesForMode(true, EXTERNAL_PLATFORM_ENV)).toEqual({});
  });

  it('只有显式 opt-out 才按 env 装配平台供应商', () => {
    const services = createPlatformServicesForMode(false, EXTERNAL_PLATFORM_ENV);

    expect(services.asr?.provider).toBe('tencent');
    expect(services.ocr?.provider).toBe('tencent');
    expect(services.moderation?.provider).toBe('external');
    expect(services.scan?.provider).toBe('clamav');
  });
});
