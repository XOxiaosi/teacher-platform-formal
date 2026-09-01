/**
 * P10 平台预配线 A1（t6）+ P11 A2（t1）+ P12 A3/C（t1）+ P13 D 切片（t3）功能测试：
 * 平台预配服务门面——env 解析 / 降级不崩服 / 占位 adapter / 本地规则审核。
 *
 * 覆盖：
 * - parsePlatformServicesEnv：缺省（enabled=false、asrProvider=none、ocrProvider=none、
 *   moderationProvider=none、scanProvider=none、moderationLocal=on）；PLATFORM_SERVICES_ENABLED=true；
 *   供应商大小写归一；未知供应商容忍（占位降级不崩服）；scan clamav host/port 解析；
 *   PLATFORM_MODERATION_LOCAL 开关（缺省 on / 显式 off）；
 * - createPlatformServices：未启用 → 空门面（asr/ocr/moderation/scan undefined）；启用+none → asr/ocr
 *   占位 adapter（占位文本含 阶段三占位）+ moderation/scan undefined（默认 off/未配置）；启用+tencent
 *   （已配置未实现）→ 占位降级 + 文本标注 PLATFORM_OCR_PROVIDER 接入点；启用+PLATFORM_MODERATION_PROVIDER=local
 *   → 本地规则 adapter（命中 flagged+reasons / 未命中 pass）；=external → 云审核占位（本地优先拦截，
 *   未命中外部占位 review）；历史/未知供应商 → 占位降级；启用+PLATFORM_SCAN_PROVIDER=clamav → scan 占位
 *   （scan 返回 status='error'——不静默放行也不误杀，标注接入点）；
 * - 本地规则引擎（moderateWithLocalRules 纯函数）：命中（暴力/辱骂/隐私正则）/未命中/白名单防误杀/
 *   规则集完整性；
 * - 占位 adapter 契约：asr.transcribe / ocr.ocr / moderation.moderateText / scan.scan 返回契约形状，不抛错。
 */

import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_MODERATION_PLACEHOLDER_LABEL,
  LOCAL_MODERATION_DISABLED_LABEL,
  LOCAL_MODERATION_RULES,
  PLATFORM_ASR_PROVIDER_ENV,
  PLATFORM_MODERATION_LOCAL_ENV,
  PLATFORM_MODERATION_PROVIDER_ENV,
  PLATFORM_OCR_PROVIDER_ENV,
  PLATFORM_OCR_PLACEHOLDER_TEXT,
  PLATFORM_SCAN_CLAMAV_HOST_ENV,
  PLATFORM_SCAN_CLAMAV_PORT_ENV,
  PLATFORM_SCAN_PLACEHOLDER_ERROR,
  PLATFORM_SCAN_PROVIDER_ENV,
  PLATFORM_SERVICES_ENABLED_ENV,
  PLATFORM_TRANSCRIPTION_PLACEHOLDER_TEXT,
  createExternalModerationAdapter,
  createLocalModerationAdapter,
  createPlaceholderAsrAdapter,
  createPlaceholderModerationAdapter,
  createPlaceholderOcrAdapter,
  createPlaceholderScanAdapter,
  createPlatformServices,
  moderateWithLocalRules,
  parsePlatformServicesEnv,
  type OcrRequest,
  type ScanRequest,
  type TranscribeRequest,
} from '../../../src/shared/platform-services/index.js';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides };
}

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

describe('parsePlatformServicesEnv（平台级配置，env 契约）', () => {
  it('缺省：未启用 + asr/ocr/moderation/scan 全 none（降级基线）', () => {
    const config = parsePlatformServicesEnv(env());
    expect(config.enabled).toBe(false);
    expect(config.asrProvider).toBe('none');
    expect(config.ocrProvider).toBe('none');
    expect(config.moderationProvider).toBe('none');
    expect(config.scanProvider).toBe('none');
    expect(config.clamavHost).toBe('127.0.0.1');
    expect(config.clamavPort).toBe(3310);
  });

  it('PLATFORM_SERVICES_ENABLED=true 且各供应商配置 → 启用 + 供应商', () => {
    const config = parsePlatformServicesEnv(env({
      [PLATFORM_SERVICES_ENABLED_ENV]: 'true',
      [PLATFORM_ASR_PROVIDER_ENV]: 'tencent',
      [PLATFORM_OCR_PROVIDER_ENV]: 'tencent',
      [PLATFORM_MODERATION_PROVIDER_ENV]: 'external',
      [PLATFORM_SCAN_PROVIDER_ENV]: 'clamav',
    }));
    expect(config.enabled).toBe(true);
    expect(config.asrProvider).toBe('tencent');
    expect(config.ocrProvider).toBe('tencent');
    expect(config.moderationProvider).toBe('external');
    expect(config.scanProvider).toBe('clamav');
  });

  it('enabled 严格匹配 true（TRUE/1 不误开）；供应商大小写/空白归一', () => {
    expect(parsePlatformServicesEnv(env({ [PLATFORM_SERVICES_ENABLED_ENV]: 'TRUE' })).enabled).toBe(false);
    expect(parsePlatformServicesEnv(env({ [PLATFORM_SERVICES_ENABLED_ENV]: '1' })).enabled).toBe(false);
    expect(parsePlatformServicesEnv(env({ [PLATFORM_ASR_PROVIDER_ENV]: '  Whisper ' })).asrProvider).toBe('whisper');
    expect(parsePlatformServicesEnv(env({ [PLATFORM_OCR_PROVIDER_ENV]: '  Tencent ' })).ocrProvider).toBe('tencent');
    expect(parsePlatformServicesEnv(env({ [PLATFORM_MODERATION_PROVIDER_ENV]: '  External ' })).moderationProvider).toBe('external');
    expect(parsePlatformServicesEnv(env({ [PLATFORM_SCAN_PROVIDER_ENV]: '  ClamAV ' })).scanProvider).toBe('clamav');
  });

  it('PLATFORM_MODERATION_LOCAL：缺省 on；显式 off 关闭（大小写/空白归一，其他值视为 on）', () => {
    expect(parsePlatformServicesEnv(env()).moderationLocal).toBe(true); // 缺省 on
    expect(parsePlatformServicesEnv(env({ [PLATFORM_MODERATION_LOCAL_ENV]: 'on' })).moderationLocal).toBe(true);
    expect(parsePlatformServicesEnv(env({ [PLATFORM_MODERATION_LOCAL_ENV]: 'ON' })).moderationLocal).toBe(true);
    expect(parsePlatformServicesEnv(env({ [PLATFORM_MODERATION_LOCAL_ENV]: '  Off ' })).moderationLocal).toBe(false);
    expect(parsePlatformServicesEnv(env({ [PLATFORM_MODERATION_LOCAL_ENV]: 'off' })).moderationLocal).toBe(false);
    expect(parsePlatformServicesEnv(env({ [PLATFORM_MODERATION_LOCAL_ENV]: 'true' })).moderationLocal).toBe(true); // 非 off → on
  });

  it('scan clamav host/port 解析：自定义 + 非法 port 回落缺省 3310', () => {
    const custom = parsePlatformServicesEnv(env({
      [PLATFORM_SCAN_CLAMAV_HOST_ENV]: 'clamd.internal',
      [PLATFORM_SCAN_CLAMAV_PORT_ENV]: '3311',
    }));
    expect(custom.clamavHost).toBe('clamd.internal');
    expect(custom.clamavPort).toBe(3311);
    expect(parsePlatformServicesEnv(env({ [PLATFORM_SCAN_CLAMAV_PORT_ENV]: 'not-a-number' })).clamavPort).toBe(3310);
    expect(parsePlatformServicesEnv(env({ [PLATFORM_SCAN_CLAMAV_PORT_ENV]: '999999' })).clamavPort).toBe(3310);
  });
});

describe('createPlatformServices（门面：降级不崩服）', () => {
  it('未启用 → 空门面（asr/ocr/moderation/scan undefined），不崩服', () => {
    const services = createPlatformServices(env());
    expect(services.asr).toBeUndefined();
    expect(services.ocr).toBeUndefined();
    expect(services.moderation).toBeUndefined();
    expect(services.scan).toBeUndefined();
  });

  it('启用 + none（未配置）→ asr/ocr=占位 adapter，transcribe/ocr 返回占位文本（含 阶段三占位）；moderation/scan off', async () => {
    const services = createPlatformServices(env({
      [PLATFORM_SERVICES_ENABLED_ENV]: 'true',
    }));
    expect(services.asr).toBeDefined();
    expect(services.asr?.provider).toBe('placeholder');
    const asrResult = await services.asr?.transcribe(SAMPLE_INPUT);
    expect(asrResult?.text).toBe(PLATFORM_TRANSCRIPTION_PLACEHOLDER_TEXT);
    expect(asrResult?.text).toContain('阶段三占位');
    expect(asrResult?.confidence).toBe(0);

    // A2：ocr 占位（默认 none → placeholder adapter，作业流转基线不破坏）
    expect(services.ocr).toBeDefined();
    expect(services.ocr?.provider).toBe('placeholder');
    const ocrResult = await services.ocr?.ocr(SAMPLE_OCR_INPUT);
    expect(ocrResult?.text).toBe(PLATFORM_OCR_PLACEHOLDER_TEXT);
    expect(ocrResult?.text).toContain('阶段三占位');
    expect(ocrResult?.blocks).toEqual([]);
    expect(ocrResult?.confidence).toBe(0);

    // A2：moderation 默认 off——未配置不实例化（undefined，调用方走未配置分支）
    expect(services.moderation).toBeUndefined();
    // A3/C：scan 默认 off（PLATFORM_SCAN_PROVIDER=none）——未配置不实例化（上传保持 skipped 基线零破坏）
    expect(services.scan).toBeUndefined();
  });

  it('启用 + tencent（已配置但未实现）→ asr/ocr 占位降级，文本标注 PLATFORM_OCR_PROVIDER 接入点', async () => {
    const services = createPlatformServices(env({
      [PLATFORM_SERVICES_ENABLED_ENV]: 'true',
      [PLATFORM_ASR_PROVIDER_ENV]: 'tencent',
      [PLATFORM_OCR_PROVIDER_ENV]: 'tencent',
    }));
    expect(services.asr).toBeDefined();
    expect(services.asr?.provider).toBe('tencent');
    const asrResult = await services.asr?.transcribe(SAMPLE_INPUT);
    expect(asrResult?.text).toContain('PLATFORM_ASR_PROVIDER=tencent');

    expect(services.ocr).toBeDefined();
    expect(services.ocr?.provider).toBe('tencent');
    const ocrResult = await services.ocr?.ocr(SAMPLE_OCR_INPUT);
    expect(ocrResult?.text).toContain('PLATFORM_OCR_PROVIDER=tencent');
    expect(ocrResult?.text).toContain('用户确认后');
  });

  it('启用 + 未知 OCR 供应商 → 占位降级（不崩服）', async () => {
    const services = createPlatformServices(env({
      [PLATFORM_SERVICES_ENABLED_ENV]: 'true',
      [PLATFORM_OCR_PROVIDER_ENV]: 'mystery-vendor',
    }));
    expect(services.ocr).toBeDefined();
    expect(services.ocr?.provider).toBe('mystery-vendor');
  });

  it('启用 + PLATFORM_MODERATION_PROVIDER=local → 本地规则 adapter（命中 flagged+reasons；未命中 pass）', async () => {
    const services = createPlatformServices(env({
      [PLATFORM_SERVICES_ENABLED_ENV]: 'true',
      [PLATFORM_MODERATION_PROVIDER_ENV]: 'local',
    }));
    expect(services.moderation).toBeDefined();
    expect(services.moderation?.provider).toBe('local');
    const hit = await services.moderation?.moderateText({ text: '这个骗子说打死你，垃圾', scene: 'student_source' });
    expect(hit?.verdict).toBe('review'); // 本地命中 → 人工复核（不阻断不误杀）
    expect(hit?.flagged).toBe(true);
    expect(hit?.reasons?.length).toBeGreaterThan(0);
    expect(hit?.labels).toEqual(hit?.reasons); // labels 与 reasons 同源（审计可辨）
    const miss = await services.moderation?.moderateText({ text: '今天的作业是完成第三单元练习', scene: 'feedback' });
    expect(miss?.verdict).toBe('pass');
    expect(miss?.flagged).toBe(false);
    expect(miss?.reasons).toEqual([]);
  });

  it('启用 + PLATFORM_MODERATION_PROVIDER=external → 云审核占位：本地命中本地拦截（不出域）；未命中 → 外部占位 review', async () => {
    const services = createPlatformServices(env({
      [PLATFORM_SERVICES_ENABLED_ENV]: 'true',
      [PLATFORM_MODERATION_PROVIDER_ENV]: 'external',
    }));
    expect(services.moderation).toBeDefined();
    expect(services.moderation?.provider).toBe('external');
    // 本地规则命中 → 直接 flagged（本地拦截，不调外部 = 不出域）
    const localHit = await services.moderation?.moderateText({ text: '免费领取课程，扫码加微信', scene: 'chat' });
    expect(localHit?.flagged).toBe(true);
    expect(localHit?.reasons?.some((r) => r.startsWith('ad'))).toBe(true);
    // 本地未命中 → 外部占位降级（review + 占位 label，真实外部待用户确认出域）
    const externalFallback = await services.moderation?.moderateText({ text: '今天的课堂表现很好', scene: 'feedback' });
    expect(externalFallback?.verdict).toBe('review');
    expect(externalFallback?.flagged).toBe(false);
    expect(externalFallback?.labels).toContain(EXTERNAL_MODERATION_PLACEHOLDER_LABEL);
  });

  it('启用 + PLATFORM_MODERATION_PROVIDER=tencent（历史/未知供应商）→ 占位降级不崩服（review 心智）', async () => {
    const services = createPlatformServices(env({
      [PLATFORM_SERVICES_ENABLED_ENV]: 'true',
      [PLATFORM_MODERATION_PROVIDER_ENV]: 'tencent',
    }));
    expect(services.moderation).toBeDefined();
    expect(services.moderation?.provider).toBe('tencent');
    const result = await services.moderation?.moderateText({ text: '测试文本', scene: 'student_source' });
    expect(result?.verdict).toBe('review'); // 占位：不实际审核（review=人工复核），不阻断也不放行
    expect(result?.labels).toContain('platform-moderation-not-configured');
    expect(result?.flagged).toBe(false);
  });

  it('启用 + PLATFORM_SCAN_PROVIDER=clamav → scan 占位 adapter（provider=clamav，scan → status=error 不静默放行）', async () => {
    const services = createPlatformServices(env({
      [PLATFORM_SERVICES_ENABLED_ENV]: 'true',
      [PLATFORM_SCAN_PROVIDER_ENV]: 'clamav',
    }));
    expect(services.scan).toBeDefined();
    expect(services.scan?.provider).toBe('clamav');
    const result = await services.scan?.scan(SAMPLE_SCAN_INPUT);
    expect(result?.status).toBe('error'); // 占位：不伪造 clean（静默放行）也不伪造 infected（误杀）
    expect(result?.message).toContain('PLATFORM_SCAN_PROVIDER=clamav');
    expect(result?.message).toContain('用户确认后');
  });

  it('启用 + 未知 scan 供应商 → 占位降级（不崩服）', async () => {
    const services = createPlatformServices(env({
      [PLATFORM_SERVICES_ENABLED_ENV]: 'true',
      [PLATFORM_SCAN_PROVIDER_ENV]: 'mystery-antivirus',
    }));
    expect(services.scan).toBeDefined();
    expect(services.scan?.provider).toBe('mystery-antivirus');
    const result = await services.scan?.scan(SAMPLE_SCAN_INPUT);
    expect(result?.status).toBe('error');
  });
});

describe('createPlaceholderAsrAdapter（契约：transcribe → {text, confidence}，不抛错）', () => {
  it('缺省 provider → placeholder，占位文本固定', async () => {
    const adapter = createPlaceholderAsrAdapter();
    expect(adapter.provider).toBe('placeholder');
    const result = await adapter.transcribe(SAMPLE_INPUT);
    expect(result.text).toBe(PLATFORM_TRANSCRIPTION_PLACEHOLDER_TEXT);
    expect(result.confidence).toBe(0);
  });

  it('忽略输入内容（占位不消费 Buffer，仅契约形状）', async () => {
    const adapter = createPlaceholderAsrAdapter('none');
    await expect(adapter.transcribe(SAMPLE_INPUT)).resolves.toEqual({
      text: PLATFORM_TRANSCRIPTION_PLACEHOLDER_TEXT,
      confidence: 0,
    });
  });
});

describe('createPlaceholderOcrAdapter（A2 契约：ocr → {text, blocks, confidence}，不抛错）', () => {
  it('缺省 provider → placeholder，占位文本固定 + 空版面块', async () => {
    const adapter = createPlaceholderOcrAdapter();
    expect(adapter.provider).toBe('placeholder');
    const result = await adapter.ocr(SAMPLE_OCR_INPUT);
    expect(result.text).toBe(PLATFORM_OCR_PLACEHOLDER_TEXT);
    expect(result.blocks).toEqual([]);
    expect(result.confidence).toBe(0);
  });

  it('已配置供应商 → provider 透传，占位文本标注接入点', async () => {
    const adapter = createPlaceholderOcrAdapter('tencent');
    expect(adapter.provider).toBe('tencent');
    const result = await adapter.ocr(SAMPLE_OCR_INPUT);
    expect(result.text).toContain('PLATFORM_OCR_PROVIDER=tencent');
  });
});

describe('moderateWithLocalRules（本地规则引擎，纯函数）', () => {
  it('命中：暴力/辱骂 → flagged + reasons（规则组 id + 描述）', () => {
    const hit = moderateWithLocalRules('你这个骗子，打死你');
    expect(hit.flagged).toBe(true);
    expect(hit.reasons.some((r) => r.startsWith('violence'))).toBe(true);
    const abuse = moderateWithLocalRules('他妈的傻逼');
    expect(abuse.flagged).toBe(true);
    expect(abuse.reasons.some((r) => r.startsWith('abuse'))).toBe(true);
  });

  it('命中：隐私泄露（手机号/身份证正则 + 敏感凭证关键词）', () => {
    expect(moderateWithLocalRules('联系我 13812345678').flagged).toBe(true);
    const id = moderateWithLocalRules('身份证号 110101199003078888');
    expect(id.flagged).toBe(true);
    expect(id.reasons.some((r) => r.startsWith('privacy'))).toBe(true);
    expect(moderateWithLocalRules('请把验证码发给我').reasons.some((r) => r.startsWith('privacy'))).toBe(true);
  });

  it('未命中：正常教学文本 → flagged=false, reasons=[]', () => {
    const miss = moderateWithLocalRules('今天的作业是完成第三单元练习，明天课堂上讲解');
    expect(miss.flagged).toBe(false);
    expect(miss.reasons).toEqual([]);
  });

  it('白名单：习语/语境不误杀（「打死也不说」→ violence 组被抑制）', () => {
    expect(moderateWithLocalRules('这件事打死也不说').flagged).toBe(false);
    expect(moderateWithLocalRules('他妈妈今天来开家长会').flagged).toBe(false); // 他妈妈 ≠ 他妈的
  });

  it('空/非字符串输入 → 不 flagged', () => {
    expect(moderateWithLocalRules('').flagged).toBe(false);
    // @ts-expect-error 故意传非字符串验证防御（类型层拦截，运行时容错）
    expect(moderateWithLocalRules(undefined).flagged).toBe(false);
  });

  it('规则集完整性：5 个内置规则组，id 唯一', () => {
    expect(LOCAL_MODERATION_RULES.map((g) => g.id)).toEqual(['violence', 'porn', 'abuse', 'ad', 'privacy']);
    expect(new Set(LOCAL_MODERATION_RULES.map((g) => g.id)).size).toBe(LOCAL_MODERATION_RULES.length);
    for (const group of LOCAL_MODERATION_RULES) {
      expect(group.patterns.length).toBeGreaterThan(0);
    }
  });
});

describe('createLocalModerationAdapter（D 切片：本地规则 adapter，零出域）', () => {
  it('命中 → review + flagged:true + reasons；未命中 → pass', async () => {
    const adapter = createLocalModerationAdapter();
    expect(adapter.provider).toBe('local');
    const hit = await adapter.moderateText({ text: '免费领取课程加微信', scene: 'chat' });
    expect(hit.verdict).toBe('review');
    expect(hit.flagged).toBe(true);
    expect(hit.reasons?.some((r) => r.startsWith('ad'))).toBe(true);
    expect(hit.labels).toEqual(hit.reasons);
    const miss = await adapter.moderateText({ text: '课堂练习完成情况良好', scene: 'feedback' });
    expect(miss.verdict).toBe('pass');
    expect(miss.flagged).toBe(false);
    expect(miss.reasons).toEqual([]);
    expect(miss.labels).toEqual([]);
  });

  it('PLATFORM_MODERATION_LOCAL=off → 占位降级（review + disabled label，不实际审核不崩服）', async () => {
    const adapter = createLocalModerationAdapter({ [PLATFORM_MODERATION_LOCAL_ENV]: 'off' });
    const result = await adapter.moderateText({ text: '打死你这个骗子', scene: 'student_source' });
    expect(result.verdict).toBe('review');
    expect(result.flagged).toBe(false); // 引擎关闭：即使命中敏感词也不标记
    expect(result.labels).toContain(LOCAL_MODERATION_DISABLED_LABEL);
    expect(result.reasons).toEqual([]);
  });
});

describe('createExternalModerationAdapter（D 切片：云审核占位，本地优先）', () => {
  it('本地命中 → 本地拦截（不出域）；本地未命中 → 外部占位 review', async () => {
    const adapter = createExternalModerationAdapter();
    expect(adapter.provider).toBe('external');
    const localHit = await adapter.moderateText({ text: '扫码领优惠', scene: 'chat' });
    expect(localHit.flagged).toBe(true);
    expect(localHit.reasons?.some((r) => r.startsWith('ad'))).toBe(true);
    const fallback = await adapter.moderateText({ text: '今天讲了二元一次方程', scene: 'student_source' });
    expect(fallback.verdict).toBe('review');
    expect(fallback.flagged).toBe(false);
    expect(fallback.labels).toContain(EXTERNAL_MODERATION_PLACEHOLDER_LABEL);
  });

  it('PLATFORM_MODERATION_LOCAL=off → 跳过本地先行，直接外部占位 review', async () => {
    const adapter = createExternalModerationAdapter({ [PLATFORM_MODERATION_LOCAL_ENV]: 'off' });
    const result = await adapter.moderateText({ text: '打死你这个骗子', scene: 'student_source' });
    expect(result.verdict).toBe('review');
    expect(result.flagged).toBe(false); // 本地引擎关闭：命中敏感词也不本地拦截
    expect(result.labels).toContain(EXTERNAL_MODERATION_PLACEHOLDER_LABEL);
  });
});

describe('createPlaceholderModerationAdapter（未知供应商占位，默认 off 之外的兜底）', () => {
  it('moderateText → review + 占位 label（不实际审核）', async () => {
    const adapter = createPlaceholderModerationAdapter('tencent');
    expect(adapter.provider).toBe('tencent');
    const result = await adapter.moderateText({ text: '作业内容', scene: 'student_source' });
    expect(result.verdict).toBe('review');
    expect(result.flagged).toBe(false);
    expect(result.labels).toEqual(['platform-moderation-not-configured']);
  });
});

describe('createPlaceholderScanAdapter（A3/C 占位契约：scan → {status: clean|infected|error, threatName?}，不抛错）', () => {
  it('缺省 provider → placeholder，scan → status=error + 占位消息（不静默放行）', async () => {
    const adapter = createPlaceholderScanAdapter();
    expect(adapter.provider).toBe('placeholder');
    const result = await adapter.scan(SAMPLE_SCAN_INPUT);
    expect(result.status).toBe('error');
    expect(result.message).toBe(PLATFORM_SCAN_PLACEHOLDER_ERROR);
    expect(result.threatName).toBeUndefined();
  });

  it('已配置供应商（clamav）→ provider 透传，消息标注接入点', async () => {
    const adapter = createPlaceholderScanAdapter('clamav');
    expect(adapter.provider).toBe('clamav');
    const result = await adapter.scan(SAMPLE_SCAN_INPUT);
    expect(result.status).toBe('error');
    expect(result.message).toContain('PLATFORM_SCAN_PROVIDER=clamav');
  });
});
