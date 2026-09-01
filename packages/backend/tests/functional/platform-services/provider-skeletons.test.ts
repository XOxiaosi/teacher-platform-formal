/**
 * P16 t3 功能测试：真实供应商 adapter 骨架（p13-provider-adapter-assessment.md §8 契约）。
 *
 * 覆盖：
 * - 门面装配分支按 provider 名选择：asr whisper/tencent、ocr paddle/tencent、scan clamav
 *   → 各自骨架 adapter（provider 字段 = 配置值）；
 * - 未确认降级：骨架方法被调用 → 显式「已配置但未确认/真实调用未启用」输出（文本/status/labels），
 *   绝不静默假装可用；env 读+校验（validateXxxConfig 缺失/就绪；降级文本标注配置状态）；
 * - 默认占位不变：none → 占位 adapter（占位文本），scan/moderation 不实例化；未知供应商 → 占位降级；
 * - moderation tencent-tianyu 骨架：external 降级 labels 含未确认标注；§8.4 工厂名 createTencentModerationAdapter。
 */

import { describe, expect, it } from 'vitest';
import {
  CLAMAV_PENDING_CONFIRMATION_MESSAGE,
  EXTERNAL_MODERATION_PLACEHOLDER_LABEL,
  PADDLE_OCR_PENDING_CONFIRMATION_TEXT,
  PLATFORM_ASR_API_KEY_ENV,
  PLATFORM_ASR_BASE_URL_ENV,
  PLATFORM_ASR_MODEL_ENV,
  PLATFORM_ASR_PROVIDER_ENV,
  PLATFORM_ASR_SECRET_ID_ENV,
  PLATFORM_ASR_SECRET_KEY_ENV,
  PLATFORM_MODERATION_PROVIDER_ENV,
  PLATFORM_MODERATION_SECRET_ID_ENV,
  PLATFORM_MODERATION_SECRET_KEY_ENV,
  PLATFORM_OCR_API_KEY_ENV,
  PLATFORM_OCR_BASE_URL_ENV,
  PLATFORM_OCR_PROVIDER_ENV,
  PLATFORM_OCR_PLACEHOLDER_TEXT,
  PLATFORM_OCR_SECRET_ID_ENV,
  PLATFORM_OCR_SECRET_KEY_ENV,
  PLATFORM_SCAN_CLAMAV_HOST_ENV,
  PLATFORM_SCAN_CLAMAV_PORT_ENV,
  PLATFORM_SCAN_PROVIDER_ENV,
  PLATFORM_SERVICES_ENABLED_ENV,
  PLATFORM_TRANSCRIPTION_PLACEHOLDER_TEXT,
  TENCENT_ASR_PENDING_CONFIRMATION_TEXT,
  TENCENT_OCR_PENDING_CONFIRMATION_TEXT,
  TENCENT_TIANYU_PENDING_LABEL,
  WHISPER_PENDING_CONFIRMATION_TEXT,
  createClamavScanAdapter,
  createExternalModerationAdapter,
  createPaddleOcrAdapter,
  createPlatformServices,
  createTencentAsrAdapter,
  createTencentModerationAdapter,
  createTencentOcrAdapter,
  createWhisperAsrAdapter,
  readClamavScanConfig,
  readPaddleOcrConfig,
  readTencentAsrConfig,
  readTencentModerationConfig,
  readTencentOcrConfig,
  readWhisperAsrConfig,
  validatePaddleOcrConfig,
  validateTencentAsrConfig,
  validateTencentModerationConfig,
  validateTencentOcrConfig,
  validateWhisperAsrConfig,
  type OcrRequest,
  type ScanRequest,
  type TranscribeRequest,
} from '../../../src/shared/platform-services/index.js';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides };
}

const ENABLED = { [PLATFORM_SERVICES_ENABLED_ENV]: 'true' };

const SAMPLE_INPUT: TranscribeRequest = {
  assetId: 'asset_test',
  sha256: 'a'.repeat(64),
  content: Buffer.from('fake-mp3'),
  mimeType: 'audio/mpeg',
};

const SAMPLE_OCR_INPUT: OcrRequest = {
  assetId: 'asset_test',
  sha256: 'a'.repeat(64),
  content: Buffer.from('fake-png'),
  mimeType: 'image/png',
};

const SAMPLE_SCAN_INPUT: ScanRequest = {
  assetId: 'asset_test',
  sha256: 'a'.repeat(64),
  content: Buffer.from('fake-file-bytes'),
  mimeType: 'image/png',
};

describe('门面装配分支（provider 名选择 → 真实供应商骨架）', () => {
  it('PLATFORM_ASR_PROVIDER=whisper → 骨架 adapter（provider=whisper，未确认降级文本）', async () => {
    const services = createPlatformServices(env({
      ...ENABLED,
      [PLATFORM_ASR_PROVIDER_ENV]: 'whisper',
    }));
    expect(services.asr).toBeDefined();
    expect(services.asr?.provider).toBe('whisper');
    const result = await services.asr?.transcribe(SAMPLE_INPUT);
    expect(result?.text).toContain('PLATFORM_ASR_PROVIDER=whisper');
    expect(result?.text).toContain('未确认');
    expect(result?.text).toContain('真实调用未启用'); // 绝不静默假装可用
    expect(result?.confidence).toBe(0);
  });

  it('PLATFORM_ASR_PROVIDER=tencent → 骨架 adapter（provider=tencent，标注 T1/T5/T6）', async () => {
    const services = createPlatformServices(env({
      ...ENABLED,
      [PLATFORM_ASR_PROVIDER_ENV]: 'tencent',
    }));
    expect(services.asr?.provider).toBe('tencent');
    const result = await services.asr?.transcribe(SAMPLE_INPUT);
    expect(result?.text).toContain('PLATFORM_ASR_PROVIDER=tencent');
    expect(result?.text).toContain('用户确认后');
    expect(result?.text).toContain('真实调用未启用');
  });

  it('PLATFORM_OCR_PROVIDER=paddle → 骨架 adapter（provider=paddle，空版面块）', async () => {
    const services = createPlatformServices(env({
      ...ENABLED,
      [PLATFORM_OCR_PROVIDER_ENV]: 'paddle',
    }));
    expect(services.ocr?.provider).toBe('paddle');
    const result = await services.ocr?.ocr(SAMPLE_OCR_INPUT);
    expect(result?.text).toContain('PLATFORM_OCR_PROVIDER=paddle');
    expect(result?.text).toContain('真实调用未启用');
    expect(result?.blocks).toEqual([]);
    expect(result?.confidence).toBe(0);
  });

  it('PLATFORM_OCR_PROVIDER=tencent → 骨架 adapter（provider=tencent，标注 T2/T5/T6）', async () => {
    const services = createPlatformServices(env({
      ...ENABLED,
      [PLATFORM_OCR_PROVIDER_ENV]: 'tencent',
    }));
    expect(services.ocr?.provider).toBe('tencent');
    const result = await services.ocr?.ocr(SAMPLE_OCR_INPUT);
    expect(result?.text).toContain('PLATFORM_OCR_PROVIDER=tencent');
    expect(result?.text).toContain('用户确认后');
    expect(result?.text).toContain('真实调用未启用');
    expect(result?.blocks).toEqual([]);
  });

  it('PLATFORM_SCAN_PROVIDER=clamav → 骨架 adapter（provider=clamav，scan → status=error 不静默放行）', async () => {
    const services = createPlatformServices(env({
      ...ENABLED,
      [PLATFORM_SCAN_PROVIDER_ENV]: 'clamav',
    }));
    expect(services.scan?.provider).toBe('clamav');
    const result = await services.scan?.scan(SAMPLE_SCAN_INPUT);
    expect(result?.status).toBe('error');
    expect(result?.message).toContain('PLATFORM_SCAN_PROVIDER=clamav');
    expect(result?.message).toContain('真实调用未启用');
    expect(result?.threatName).toBeUndefined();
  });

  it('PLATFORM_MODERATION_PROVIDER=external → 腾讯云天御骨架（provider=external，本地优先）', async () => {
    const services = createPlatformServices(env({
      ...ENABLED,
      [PLATFORM_MODERATION_PROVIDER_ENV]: 'external',
    }));
    expect(services.moderation?.provider).toBe('external');
    const localHit = await services.moderation?.moderateText({ text: '扫码加微信领课程', scene: 'chat' });
    expect(localHit?.flagged).toBe(true); // 本地命中 → 本地拦截（不出域）
    const fallback = await services.moderation?.moderateText({ text: '今天讲了二元一次方程', scene: 'student_source' });
    expect(fallback?.verdict).toBe('review');
    expect(fallback?.flagged).toBe(false);
    expect(fallback?.labels).toContain(EXTERNAL_MODERATION_PLACEHOLDER_LABEL);
    expect(fallback?.labels).toContain(TENCENT_TIANYU_PENDING_LABEL); // tencent-tianyu 未确认标注
  });
});

describe('未确认降级（骨架方法显式降级，绝不静默假装可用）+ env 读校验', () => {
  it('whisper：缺 baseUrl → 降级文本标注缺少配置；配齐 → 标注配置就绪', async () => {
    const missingCfg = createWhisperAsrAdapter(env());
    const missingResult = await missingCfg.transcribe(SAMPLE_INPUT);
    expect(missingResult.text).toBe(`${WHISPER_PENDING_CONFIRMATION_TEXT}（缺少配置：${PLATFORM_ASR_BASE_URL_ENV}）`);
    expect(validateWhisperAsrConfig(env())).toEqual([PLATFORM_ASR_BASE_URL_ENV]);

    const readyCfg = createWhisperAsrAdapter(env({
      [PLATFORM_ASR_BASE_URL_ENV]: 'http://127.0.0.1:8000',
    }));
    const readyResult = await readyCfg.transcribe(SAMPLE_INPUT);
    expect(readyResult.text).toContain('配置就绪（baseUrl=http://127.0.0.1:8000');
    expect(readyResult.text).toContain('真实调用未启用');
    expect(validateWhisperAsrConfig(env({ [PLATFORM_ASR_BASE_URL_ENV]: 'http://127.0.0.1:8000' }))).toEqual([]);
    // 读配置：model/apiKey 透传 trim 归一
    expect(readWhisperAsrConfig(env({
      [PLATFORM_ASR_BASE_URL_ENV]: ' http://x:1 ',
      [PLATFORM_ASR_MODEL_ENV]: 'large-v3-int8',
      [PLATFORM_ASR_API_KEY_ENV]: ' local-key ',
    }))).toEqual({ baseUrl: 'http://x:1', model: 'large-v3-int8', apiKey: 'local-key' });
  });

  it('tencent asr：缺密钥 → 降级文本标注缺少配置 + T1/T5/T6；配齐 → 密钥已配置', async () => {
    const missing = createTencentAsrAdapter(env());
    const missingResult = await missing.transcribe(SAMPLE_INPUT);
    expect(missingResult.text).toBe(
      `${TENCENT_ASR_PENDING_CONFIRMATION_TEXT}（缺少配置：${PLATFORM_ASR_SECRET_ID_ENV}, ${PLATFORM_ASR_SECRET_KEY_ENV}）`,
    );
    expect(validateTencentAsrConfig(env())).toEqual([PLATFORM_ASR_SECRET_ID_ENV, PLATFORM_ASR_SECRET_KEY_ENV]);

    const ready = createTencentAsrAdapter(env({
      [PLATFORM_ASR_SECRET_ID_ENV]: 'AKIDxxx',
      [PLATFORM_ASR_SECRET_KEY_ENV]: 'secret',
    }));
    const readyResult = await ready.transcribe(SAMPLE_INPUT);
    expect(readyResult.text).toContain('密钥已配置（待用户确认出域）');
    expect(validateTencentAsrConfig(env({ [PLATFORM_ASR_SECRET_ID_ENV]: 'AKIDxxx', [PLATFORM_ASR_SECRET_KEY_ENV]: 's' }))).toEqual([]);
    expect(readTencentAsrConfig(env({ [PLATFORM_ASR_SECRET_ID_ENV]: ' AKID ' }))).toEqual({ secretId: 'AKID' });
  });

  it('paddle：缺 baseUrl → 标注缺少配置；配齐 → 配置就绪；blocks 恒空（未确认不产出版面块）', async () => {
    const missing = createPaddleOcrAdapter(env());
    const missingResult = await missing.ocr(SAMPLE_OCR_INPUT);
    expect(missingResult.text).toBe(`${PADDLE_OCR_PENDING_CONFIRMATION_TEXT}（缺少配置：${PLATFORM_OCR_BASE_URL_ENV}）`);
    expect(validatePaddleOcrConfig(env())).toEqual([PLATFORM_OCR_BASE_URL_ENV]);

    const ready = createPaddleOcrAdapter(env({ [PLATFORM_OCR_BASE_URL_ENV]: 'http://127.0.0.1:9000' }));
    const readyResult = await ready.ocr(SAMPLE_OCR_INPUT);
    expect(readyResult.text).toContain('配置就绪（baseUrl=http://127.0.0.1:9000）');
    expect(readyResult.blocks).toEqual([]);
    expect(readPaddleOcrConfig(env({ [PLATFORM_OCR_BASE_URL_ENV]: ' x ' }))).toEqual({ baseUrl: 'x' });
  });

  it('tencent ocr：缺密钥 → 标注缺少配置；配齐 → 密钥已配置', async () => {
    const missing = createTencentOcrAdapter(env());
    const missingResult = await missing.ocr(SAMPLE_OCR_INPUT);
    expect(missingResult.text).toBe(
      `${TENCENT_OCR_PENDING_CONFIRMATION_TEXT}（缺少配置：${PLATFORM_OCR_SECRET_ID_ENV}, ${PLATFORM_OCR_SECRET_KEY_ENV}）`,
    );
    expect(validateTencentOcrConfig(env())).toEqual([PLATFORM_OCR_SECRET_ID_ENV, PLATFORM_OCR_SECRET_KEY_ENV]);

    const ready = createTencentOcrAdapter(env({
      [PLATFORM_OCR_SECRET_ID_ENV]: 'AKIDxxx',
      [PLATFORM_OCR_SECRET_KEY_ENV]: 'secret',
    }));
    const readyResult = await ready.ocr(SAMPLE_OCR_INPUT);
    expect(readyResult.text).toContain('密钥已配置（待用户确认出域）');
    expect(readTencentOcrConfig(env({ [PLATFORM_OCR_SECRET_ID_ENV]: 'A', [PLATFORM_OCR_SECRET_KEY_ENV]: 'B', [PLATFORM_OCR_API_KEY_ENV]: 'C' })))
      .toEqual({ secretId: 'A', secretKey: 'B', apiKey: 'C' });
  });

  it('clamav：host/port 读缺省与自定义；scan 恒 status=error（不伪造 clean/infected）', async () => {
    expect(readClamavScanConfig(env())).toEqual({ host: '127.0.0.1', port: 3310 });
    expect(readClamavScanConfig(env({
      [PLATFORM_SCAN_CLAMAV_HOST_ENV]: 'clamd.internal',
      [PLATFORM_SCAN_CLAMAV_PORT_ENV]: '3311',
    }))).toEqual({ host: 'clamd.internal', port: 3311 });
    expect(readClamavScanConfig(env({ [PLATFORM_SCAN_CLAMAV_PORT_ENV]: 'bad' }))).toEqual({ host: '127.0.0.1', port: 3310 });

    const adapter = createClamavScanAdapter(env({ [PLATFORM_SCAN_CLAMAV_HOST_ENV]: 'clamd.internal' }));
    const result = await adapter.scan(SAMPLE_SCAN_INPUT);
    expect(result.status).toBe('error');
    expect(result.message).toBe(`${CLAMAV_PENDING_CONFIRMATION_MESSAGE}（target=clamd.internal:3310）`);
    expect(result.threatName).toBeUndefined();
  });

  it('tencent-tianyu 骨架：§8.4 工厂名 createTencentModerationAdapter 行为与 external 一致', async () => {
    expect(createTencentModerationAdapter).toBe(createExternalModerationAdapter);
    const adapter = createTencentModerationAdapter(env());
    const result = await adapter.moderateText({ text: '今天课堂表现很好', scene: 'feedback' });
    expect(result.verdict).toBe('review');
    expect(result.flagged).toBe(false);
    expect(result.labels).toContain(TENCENT_TIANYU_PENDING_LABEL);
    // env 读 + 校验：缺密钥 → 标注
    expect(validateTencentModerationConfig(env())).toEqual([
      PLATFORM_MODERATION_SECRET_ID_ENV,
      PLATFORM_MODERATION_SECRET_KEY_ENV,
    ]);
    expect(readTencentModerationConfig(env({ [PLATFORM_MODERATION_SECRET_ID_ENV]: 'A', [PLATFORM_MODERATION_SECRET_KEY_ENV]: 'B' })))
      .toEqual({ secretId: 'A', secretKey: 'B' });
    expect(validateTencentModerationConfig(env({ [PLATFORM_MODERATION_SECRET_ID_ENV]: 'A', [PLATFORM_MODERATION_SECRET_KEY_ENV]: 'B' }))).toEqual([]);
  });
});

describe('默认占位不变（none/未知 → 占位 adapter，P12 基线零破坏）', () => {
  it('启用 + none → asr/ocr 占位 adapter（占位文本不变）；scan/moderation 不实例化', async () => {
    const services = createPlatformServices(env(ENABLED));
    expect(services.asr?.provider).toBe('placeholder');
    expect((await services.asr?.transcribe(SAMPLE_INPUT))?.text).toBe(PLATFORM_TRANSCRIPTION_PLACEHOLDER_TEXT);
    expect(services.ocr?.provider).toBe('placeholder');
    expect((await services.ocr?.ocr(SAMPLE_OCR_INPUT))?.text).toBe(PLATFORM_OCR_PLACEHOLDER_TEXT);
    expect(services.scan).toBeUndefined();
    expect(services.moderation).toBeUndefined();
  });

  it('未知供应商 → 占位降级不崩服（provider 透传配置值）', async () => {
    const services = createPlatformServices(env({
      ...ENABLED,
      [PLATFORM_ASR_PROVIDER_ENV]: 'mystery-asr',
      [PLATFORM_OCR_PROVIDER_ENV]: 'mystery-ocr',
      [PLATFORM_SCAN_PROVIDER_ENV]: 'mystery-antivirus',
    }));
    expect(services.asr?.provider).toBe('mystery-asr');
    await expect(services.asr?.transcribe(SAMPLE_INPUT)).resolves.toMatchObject({ confidence: 0 });
    expect(services.ocr?.provider).toBe('mystery-ocr');
    await expect(services.ocr?.ocr(SAMPLE_OCR_INPUT)).resolves.toMatchObject({ blocks: [] });
    expect(services.scan?.provider).toBe('mystery-antivirus');
    expect((await services.scan?.scan(SAMPLE_SCAN_INPUT))?.status).toBe('error');
  });
});
