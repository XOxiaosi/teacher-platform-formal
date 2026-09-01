/**
 * ASR 真实供应商骨架：Whisper 自部署（faster-whisper）——不出域默认路径（P13 评估 §3 D1/D2 + §8.1）。
 *
 * 红线：用户确认前**不实现真实 HTTP 调用**（T7 资源确认：GPU/模型服务常驻；不出域但耗资源，
 * 非隐私红线，仍需确认）。本骨架只做：
 * - 工厂 `createWhisperAsrAdapter(env)`（契约 §8.1，替换 `asr/placeholder.ts` 装配分支）；
 * - 读 env：PLATFORM_ASR_BASE_URL（faster-whisper 服务地址）、PLATFORM_ASR_MODEL、
 *   PLATFORM_ASR_API_KEY（可选本地鉴权）——密钥纪律：只读 env，禁硬编码禁日志；
 * - 校验：`validateWhisperAsrConfig` 返回缺失 env 名（骨架阶段只提示，不抛错——降级不崩服纪律）；
 * - 未确认降级：transcribe **占位降级**（返回标注「已配置但未确认 T7」的文本，绝不静默假装可用）。
 *
 * 用户确认 T7 后接真实调用的接入点（见文件尾部 TODO）：POST 音频（multipart/原始字节）到
 * `{baseUrl}` → 解析全文 + segments → 映射 TranscribeResponse{text, confidence?, durationMs?, segments?}；
 * 失败抛 ProviderError（timeout → retryable:true；5xx → provider_down:true；格式不支持 → invalid_request:false）。
 * 零新依赖（骨架不引 SDK；真实调用也仅用全局 fetch）。
 */

import type { AsrAdapter, TranscribeRequest, TranscribeResponse } from '../types.js';

export const PLATFORM_ASR_BASE_URL_ENV = 'PLATFORM_ASR_BASE_URL';
export const PLATFORM_ASR_MODEL_ENV = 'PLATFORM_ASR_MODEL';
export const PLATFORM_ASR_API_KEY_ENV = 'PLATFORM_ASR_API_KEY';

/** whisper 骨架配置（env 读取结果；trim 归一，空串 → undefined）。 */
export interface WhisperAsrConfig {
  /** faster-whisper 服务地址（必填；缺失 → 降级文本标注）。 */
  baseUrl?: string;
  /** 模型名（如 large-v3-int8；可选，服务端缺省）。 */
  model?: string;
  /** 可选本地鉴权 key（S1 敏感项：只读 env，禁硬编码禁日志）。 */
  apiKey?: string;
}

/** 读 whisper 配置（纯函数，测试可注入 env）。 */
export function readWhisperAsrConfig(env: NodeJS.ProcessEnv = process.env): WhisperAsrConfig {
  return {
    baseUrl: (env[PLATFORM_ASR_BASE_URL_ENV] ?? '').trim() || undefined,
    model: (env[PLATFORM_ASR_MODEL_ENV] ?? '').trim() || undefined,
    apiKey: (env[PLATFORM_ASR_API_KEY_ENV] ?? '').trim() || undefined,
  };
}

/** 校验 whisper 配置：返回缺失的必填 env 名（当前仅 baseUrl；骨架阶段不抛错，仅降级文本提示）。 */
export function validateWhisperAsrConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const config = readWhisperAsrConfig(env);
  const missing: string[] = [];
  if (!config.baseUrl) missing.push(PLATFORM_ASR_BASE_URL_ENV);
  return missing;
}

/** 未确认降级前缀（与占位文本同心智：`[阶段三占位]`，测试可辨）。 */
export const WHISPER_PENDING_CONFIRMATION_TEXT =
  '[阶段三占位] PLATFORM_ASR_PROVIDER=whisper 已配置但未确认（T7 资源确认：GPU/模型服务常驻）——真实调用未启用（用户确认后接入 faster-whisper 服务）';

/**
 * 创建 whisper ASR adapter（骨架）。
 * @param env 进程 env（测试可注入）；读取 PLATFORM_ASR_BASE_URL / PLATFORM_ASR_MODEL / PLATFORM_ASR_API_KEY
 */
export function createWhisperAsrAdapter(env: NodeJS.ProcessEnv = process.env): AsrAdapter {
  const config = readWhisperAsrConfig(env);
  const missing = validateWhisperAsrConfig(env);
  return {
    provider: 'whisper',
    async transcribe(_input: TranscribeRequest): Promise<TranscribeResponse> {
      // 未确认降级：不发起任何真实调用——返回显式「未启用」文本，绝不静默假装可用。
      const configStatus =
        missing.length === 0
          ? `配置就绪（baseUrl=${config.baseUrl}${config.model ? `, model=${config.model}` : ''}）`
          : `缺少配置：${missing.join(', ')}`;
      return {
        text: `${WHISPER_PENDING_CONFIRMATION_TEXT}（${configStatus}）`,
        confidence: 0,
      };
    },
  };
}

// TODO(user-confirmed · T7)：用户确认资源后在此接入真实 faster-whisper 调用——
//   fetch(`${config.baseUrl}/transcribe`, { method: 'POST', headers: auth?, body: multipart(content) })
//   → TranscribeResponse{ text, confidence?, durationMs?, segments? }
//   错误归一复用 ProviderError：timeout → providerError('timeout', 0, msg, true)；
//   5xx → providerError('provider_down', status, msg, true)；格式不支持 → providerError('invalid_request', 400, msg, false)。
//   本骨架阶段以上代码不落地（红线：用户确认前不接任何服务）。
