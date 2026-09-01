/**
 * OCR 真实供应商骨架：腾讯云通用印刷体 OCR——出域路径（P13 评估 §4 + §8.2）。
 *
 * 红线：**数据出域（图片可能含未成年影像/成绩外显，S1）= 必须用户确认**（T2 隐私授权 + T5 采购 +
 * T6 隐私披露全部通过前，**不实现真实 HTTP 调用**）。本骨架只做：
 * - 工厂 `createTencentOcrAdapter(env)`（契约 §8.2，替换 `ocr/placeholder.ts` 装配分支）；
 * - 读 env：PLATFORM_OCR_SECRET_ID / PLATFORM_OCR_SECRET_KEY / PLATFORM_OCR_API_KEY
 *   （S1 敏感项：只读 env，禁硬编码禁日志，不进 .env.example 明文）；
 * - 校验：`validateTencentOcrConfig` 返回缺失 env 名（骨架阶段只提示，不抛错——降级不崩服纪律）；
 * - 未确认降级：ocr **占位降级**（返回标注「已配置但未确认 T2/T5/T6」的文本 + 空版面块，
 *   绝不静默假装可用）。
 *
 * 用户确认后接真实调用的接入点（见文件尾部 TODO）：腾讯云通用印刷体识别 API（TC3 签名）→
 * text + blocks（厂商四顶点 → 归一为 OcrLayoutBlock.bbox{x,y,w,h} 像素系）→ MediaAnalysis.layoutBlocks
 * 消费方零厂商特判。零新依赖（骨架不引 SDK）。
 */

import type { OcrAdapter, OcrRequest, OcrResponse } from '../types.js';

export const PLATFORM_OCR_SECRET_ID_ENV = 'PLATFORM_OCR_SECRET_ID';
export const PLATFORM_OCR_SECRET_KEY_ENV = 'PLATFORM_OCR_SECRET_KEY';
export const PLATFORM_OCR_API_KEY_ENV = 'PLATFORM_OCR_API_KEY';

/** 腾讯云 OCR 骨架配置（env 读取结果；trim 归一，空串 → undefined）。 */
export interface TencentOcrConfig {
  /** 腾讯云 SecretId（S1：只读 env）。 */
  secretId?: string;
  /** 腾讯云 SecretKey（S1：只读 env）。 */
  secretKey?: string;
  /** 可选 API Key（部分套餐鉴权；S1：只读 env）。 */
  apiKey?: string;
}

/** 读腾讯云 OCR 配置（纯函数，测试可注入 env）。 */
export function readTencentOcrConfig(env: NodeJS.ProcessEnv = process.env): TencentOcrConfig {
  return {
    secretId: (env[PLATFORM_OCR_SECRET_ID_ENV] ?? '').trim() || undefined,
    secretKey: (env[PLATFORM_OCR_SECRET_KEY_ENV] ?? '').trim() || undefined,
    apiKey: (env[PLATFORM_OCR_API_KEY_ENV] ?? '').trim() || undefined,
  };
}

/** 校验腾讯云 OCR 配置：返回缺失的必填 env 名（secretId/secretKey 必填；apiKey 可选，骨架阶段不抛错）。 */
export function validateTencentOcrConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const config = readTencentOcrConfig(env);
  const missing: string[] = [];
  if (!config.secretId) missing.push(PLATFORM_OCR_SECRET_ID_ENV);
  if (!config.secretKey) missing.push(PLATFORM_OCR_SECRET_KEY_ENV);
  return missing;
}

/** 未确认降级前缀（含 PLATFORM_OCR_PROVIDER=tencent + 「用户确认后」标注——既有测试断言这两处文本）。 */
export const TENCENT_OCR_PENDING_CONFIRMATION_TEXT =
  '[阶段三占位] PLATFORM_OCR_PROVIDER=tencent 已配置但未确认（T2 隐私授权 + T5 采购 + T6 隐私披露）——真实调用未启用（用户确认后接入腾讯云通用印刷体识别 API）';

/**
 * 创建腾讯云 OCR adapter（骨架）。
 * @param env 进程 env（测试可注入）；读取 PLATFORM_OCR_SECRET_ID / PLATFORM_OCR_SECRET_KEY / PLATFORM_OCR_API_KEY
 */
export function createTencentOcrAdapter(env: NodeJS.ProcessEnv = process.env): OcrAdapter {
  const missing = validateTencentOcrConfig(env);
  return {
    provider: 'tencent',
    async ocr(_input: OcrRequest): Promise<OcrResponse> {
      // 未确认降级：不发起任何真实调用——返回显式「未启用」文本 + 空版面块，绝不静默假装可用。
      const configStatus =
        missing.length === 0 ? '密钥已配置（待用户确认出域）' : `缺少配置：${missing.join(', ')}`;
      return {
        text: `${TENCENT_OCR_PENDING_CONFIRMATION_TEXT}（${configStatus}）`,
        blocks: [],
        confidence: 0,
      };
    },
  };
}

// TODO(user-confirmed · T2+T5+T6)：用户确认出域后在此接入腾讯云通用印刷体识别 API——
//   TC3-HMAC-SHA256 签名 → 识别请求 → text + blocks（厂商四顶点 → bbox{x,y,w,h} 像素系归一）。
//   错误归一复用 ProviderError：timeout → retryable:true；5xx → provider_down:true；格式不支持 → invalid_request:false。
//   本骨架阶段以上代码不落地（红线：用户确认前不接云）。
