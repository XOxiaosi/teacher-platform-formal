/**
 * ASR 占位 adapter（P10 平台预配线 A1 · t6，任务项 3：接口占位实现）。
 *
 * 未配置（PLATFORM_ASR_PROVIDER=none）或已配置但真实供应商未实现（tencent/whisper 待用户确认）
 * 时统一走占位降级：transcribe 返回占位文本（标注真实 ASR 供应商接入点在 PLATFORM_ASR_PROVIDER env），
 * 保证转写作业流转（pending→completed + transcriptionText）在平台预配启用前基线不破坏。
 *
 * 真实供应商 adapter（asr/tencent.ts、asr/whisper.ts）在用户确认后按本契约实现并替换占位。
 */

import type { AsrAdapter, TranscribeRequest, TranscribeResponse } from '../types.js';

/** 未配置时的占位转写文本（前缀沿用 t6 断言 `阶段三占位`，既有测试零改动）。 */
export const PLATFORM_TRANSCRIPTION_PLACEHOLDER_TEXT =
  '[阶段三占位] 平台预配 ASR 未启用（PLATFORM_ASR_PROVIDER=none）；真实供应商（tencent/whisper）接入需用户确认后启用';

/**
 * 创建占位 ASR adapter。
 * @param provider 已配置的供应商（'none'/缺省 → 'placeholder'；'tencent'/'whisper' 等 → 占位降级并标注接入点）
 */
export function createPlaceholderAsrAdapter(provider: string = 'none'): AsrAdapter {
  const normalized = provider.trim().toLowerCase();
  const isConfigured = normalized !== '' && normalized !== 'none';
  const text = isConfigured
    ? `[阶段三占位] PLATFORM_ASR_PROVIDER=${normalized} 已配置但未启用（真实供应商接入需用户确认后实现）`
    : PLATFORM_TRANSCRIPTION_PLACEHOLDER_TEXT;

  return {
    provider: isConfigured ? normalized : 'placeholder',
    async transcribe(_input: TranscribeRequest): Promise<TranscribeResponse> {
      return { text, confidence: 0 };
    },
  };
}
