/**
 * ASR 真实供应商骨架：腾讯云 ASR（录音文件识别 API，离线批量 D2）——出域路径（P13 评估 §3 + §8.1）。
 *
 * 红线：**数据出域 = 必须用户确认**（T1 隐私授权 + T5 采购 + T6 隐私披露全部通过前，
 * **不实现真实 HTTP 调用**）。本骨架只做：
 * - 工厂 `createTencentAsrAdapter(env)`（契约 §8.1，替换 `asr/placeholder.ts` 装配分支）；
 * - 读 env：PLATFORM_ASR_SECRET_ID / PLATFORM_ASR_SECRET_KEY（S1 敏感项：只读 env，禁硬编码禁日志，
 *   不进 .env.example 明文）；
 * - 校验：`validateTencentAsrConfig` 返回缺失 env 名（骨架阶段只提示，不抛错——降级不崩服纪律）；
 * - 未确认降级：transcribe **占位降级**（返回标注「已配置但未确认 T1/T5/T6」的文本，绝不静默假装可用）。
 *
 * 用户确认后接真实调用的接入点（见文件尾部 TODO）：腾讯云录音文件识别 API（签名 TC3-HMAC-SHA256、
 * 提交任务 → 轮询结果）→ TranscribeResponse；错误归一复用 ProviderError 心智（timeout retryable:true /
 * 5xx provider_down:true / 格式不支持 invalid_request:false）。零新依赖（骨架不引 SDK）。
 */

import type { AsrAdapter, TranscribeRequest, TranscribeResponse } from '../types.js';

export const PLATFORM_ASR_SECRET_ID_ENV = 'PLATFORM_ASR_SECRET_ID';
export const PLATFORM_ASR_SECRET_KEY_ENV = 'PLATFORM_ASR_SECRET_KEY';

/** 腾讯云 ASR 骨架配置（env 读取结果；trim 归一，空串 → undefined）。 */
export interface TencentAsrConfig {
  /** 腾讯云 SecretId（S1：只读 env）。 */
  secretId?: string;
  /** 腾讯云 SecretKey（S1：只读 env）。 */
  secretKey?: string;
}

/** 读腾讯云 ASR 配置（纯函数，测试可注入 env）。 */
export function readTencentAsrConfig(env: NodeJS.ProcessEnv = process.env): TencentAsrConfig {
  return {
    secretId: (env[PLATFORM_ASR_SECRET_ID_ENV] ?? '').trim() || undefined,
    secretKey: (env[PLATFORM_ASR_SECRET_KEY_ENV] ?? '').trim() || undefined,
  };
}

/** 校验腾讯云 ASR 配置：返回缺失的必填 env 名（骨架阶段不抛错，仅降级文本提示）。 */
export function validateTencentAsrConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const config = readTencentAsrConfig(env);
  const missing: string[] = [];
  if (!config.secretId) missing.push(PLATFORM_ASR_SECRET_ID_ENV);
  if (!config.secretKey) missing.push(PLATFORM_ASR_SECRET_KEY_ENV);
  return missing;
}

/** 未确认降级前缀（含 PLATFORM_ASR_PROVIDER=tencent 标注——既有测试断言该接入点文本）。 */
export const TENCENT_ASR_PENDING_CONFIRMATION_TEXT =
  '[阶段三占位] PLATFORM_ASR_PROVIDER=tencent 已配置但未确认（T1 隐私授权 + T5 采购 + T6 隐私披露）——真实调用未启用（用户确认后接入腾讯云录音文件识别 API）';

/**
 * 创建腾讯云 ASR adapter（骨架）。
 * @param env 进程 env（测试可注入）；读取 PLATFORM_ASR_SECRET_ID / PLATFORM_ASR_SECRET_KEY
 */
export function createTencentAsrAdapter(env: NodeJS.ProcessEnv = process.env): AsrAdapter {
  const missing = validateTencentAsrConfig(env);
  return {
    provider: 'tencent',
    async transcribe(_input: TranscribeRequest): Promise<TranscribeResponse> {
      // 未确认降级：不发起任何真实调用——返回显式「未启用」文本，绝不静默假装可用。
      const configStatus =
        missing.length === 0 ? '密钥已配置（待用户确认出域）' : `缺少配置：${missing.join(', ')}`;
      return {
        text: `${TENCENT_ASR_PENDING_CONFIRMATION_TEXT}（${configStatus}）`,
        confidence: 0,
      };
    },
  };
}

// TODO(user-confirmed · T1+T5+T6)：用户确认出域后在此接入腾讯云录音文件识别 API——
//   TC3-HMAC-SHA256 签名 → 提交识别任务 → 轮询结果 → TranscribeResponse{ text, confidence?, durationMs?, segments? }。
//   错误归一复用 ProviderError：timeout → retryable:true；5xx → provider_down:true；格式不支持 → invalid_request:false。
//   本骨架阶段以上代码不落地（红线：用户确认前不接云）。
