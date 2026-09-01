/**
 * OCR 占位 adapter（P10 平台预配线 A2 · P11 t1，任务项 1：ocr-client 接口占位实现）。
 *
 * 未配置（PLATFORM_OCR_PROVIDER=none）或已配置但真实供应商未实现（tencent 待用户确认）
 * 时统一走占位降级：ocr 返回占位文本（标注真实 OCR 供应商接入点在 PLATFORM_OCR_PROVIDER env）
 * + 空版面块 []，保证 OCR 作业流转（pending→completed + ocrText/ocrLayoutBlocks）在平台预配
 * 启用前基线不破坏（同 A1 ASR 占位心智）。
 *
 * 真实供应商 adapter（ocr/tencent.ts）在用户确认后按本契约实现并替换占位。
 */

import type { OcrAdapter, OcrRequest, OcrResponse } from '../types.js';

/** 未配置时的占位 OCR 文本（前缀沿用 A1 断言 `阶段三占位`，测试心智一致）。 */
export const PLATFORM_OCR_PLACEHOLDER_TEXT =
  '[阶段三占位] 平台预配 OCR 未启用（PLATFORM_OCR_PROVIDER=none）；真实供应商（tencent）接入需用户确认后启用';

/**
 * 创建占位 OCR adapter。
 * @param provider 已配置的供应商（'none'/缺省 → 'placeholder'；'tencent' 等 → 占位降级并标注接入点）
 */
export function createPlaceholderOcrAdapter(provider: string = 'none'): OcrAdapter {
  const normalized = provider.trim().toLowerCase();
  const isConfigured = normalized !== '' && normalized !== 'none';
  const text = isConfigured
    ? `[阶段三占位] PLATFORM_OCR_PROVIDER=${normalized} 已配置但未启用（真实供应商接入需用户确认后实现）`
    : PLATFORM_OCR_PLACEHOLDER_TEXT;

  return {
    provider: isConfigured ? normalized : 'placeholder',
    async ocr(_input: OcrRequest): Promise<OcrResponse> {
      return { text, blocks: [], confidence: 0 };
    },
  };
}
