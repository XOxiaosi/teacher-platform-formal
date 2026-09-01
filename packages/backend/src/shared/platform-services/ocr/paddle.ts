/**
 * OCR 真实供应商骨架：PaddleOCR 自建（PP-OCRv4/v5 serving）——不出域默认路径（P13 评估 §4 D3/D4 + §8.2）。
 *
 * 红线：用户确认前**不实现真实 HTTP 调用**（T8 资源确认：模型服务常驻；不出域但耗资源，
 * 非隐私红线，仍需确认）。本骨架只做：
 * - 工厂 `createPaddleOcrAdapter(env)`（契约 §8.2，替换 `ocr/placeholder.ts` 装配分支）；
 * - 读 env：PLATFORM_OCR_BASE_URL（PaddleOCR serving 地址）；
 * - 校验：`validatePaddleOcrConfig` 返回缺失 env 名（骨架阶段只提示，不抛错——降级不崩服纪律）；
 * - 未确认降级：ocr **占位降级**（返回标注「已配置但未确认 T8」的文本 + 空版面块，绝不静默假装可用）。
 *
 * 用户确认 T8 后接真实调用的接入点（见文件尾部 TODO）：POST 图片到 `{baseUrl}` → 解析文本框坐标并
 * **归一为内部 OcrLayoutBlock.bbox{x,y,w,h}（图片像素坐标系）** → 消费方（MediaAnalysis.layoutBlocks）
 * 零厂商特判；失败抛 ProviderError（timeout → retryable:true；5xx → provider_down:true）。零新依赖。
 */

import type { OcrAdapter, OcrRequest, OcrResponse } from '../types.js';

export const PLATFORM_OCR_BASE_URL_ENV = 'PLATFORM_OCR_BASE_URL';

/** PaddleOCR 骨架配置（env 读取结果；trim 归一，空串 → undefined）。 */
export interface PaddleOcrConfig {
  /** PaddleOCR serving 地址（必填；缺失 → 降级文本标注）。 */
  baseUrl?: string;
}

/** 读 PaddleOCR 配置（纯函数，测试可注入 env）。 */
export function readPaddleOcrConfig(env: NodeJS.ProcessEnv = process.env): PaddleOcrConfig {
  return { baseUrl: (env[PLATFORM_OCR_BASE_URL_ENV] ?? '').trim() || undefined };
}

/** 校验 PaddleOCR 配置：返回缺失的必填 env 名（骨架阶段不抛错，仅降级文本提示）。 */
export function validatePaddleOcrConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const config = readPaddleOcrConfig(env);
  const missing: string[] = [];
  if (!config.baseUrl) missing.push(PLATFORM_OCR_BASE_URL_ENV);
  return missing;
}

/** 未确认降级前缀（含 PLATFORM_OCR_PROVIDER=paddle 标注——接入点文本）。 */
export const PADDLE_OCR_PENDING_CONFIRMATION_TEXT =
  '[阶段三占位] PLATFORM_OCR_PROVIDER=paddle 已配置但未确认（T8 资源确认：PaddleOCR 模型服务常驻）——真实调用未启用（用户确认后接入 PaddleOCR serving）';

/**
 * 创建 PaddleOCR adapter（骨架）。
 * @param env 进程 env（测试可注入）；读取 PLATFORM_OCR_BASE_URL
 */
export function createPaddleOcrAdapter(env: NodeJS.ProcessEnv = process.env): OcrAdapter {
  const config = readPaddleOcrConfig(env);
  const missing = validatePaddleOcrConfig(env);
  return {
    provider: 'paddle',
    async ocr(_input: OcrRequest): Promise<OcrResponse> {
      // 未确认降级：不发起任何真实调用——返回显式「未启用」文本 + 空版面块，绝不静默假装可用。
      const configStatus =
        missing.length === 0 ? `配置就绪（baseUrl=${config.baseUrl}）` : `缺少配置：${missing.join(', ')}`;
      return {
        text: `${PADDLE_OCR_PENDING_CONFIRMATION_TEXT}（${configStatus}）`,
        blocks: [],
        confidence: 0,
      };
    },
  };
}

// TODO(user-confirmed · T8)：用户确认资源后在此接入 PaddleOCR serving——
//   POST 图片到 `${config.baseUrl}` → 解析文本框坐标并归一为 OcrLayoutBlock.bbox{x,y,w,h}（像素系）。
//   错误归一复用 ProviderError：timeout → retryable:true；5xx → provider_down:true。
//   本骨架阶段以上代码不落地（红线：用户确认前不接任何服务）。
