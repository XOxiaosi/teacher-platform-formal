/**
 * 外部云审核骨架：腾讯云天御（tencent-tianyu）——出域路径（P13 D 切片 · moderation，设计
 * p10-platform-services-design.md §8.4 D6；评估 p13 §6/§8.4）。
 *
 * PLATFORM_MODERATION_PROVIDER=external → 本骨架 adapter。真实外部供应商（腾讯云天御等）接入
 * 需用户确认（**文本出域红线**，P13 t1 评估 T4/T5/T6）——**用户确认前不实现真实调用**。本骨架只做：
 * - 工厂 `createExternalModerationAdapter(env)` + 契约 §8.4 工厂名别名 `createTencentModerationAdapter`；
 * - 读 env：PLATFORM_MODERATION_SECRET_ID / PLATFORM_MODERATION_SECRET_KEY / PLATFORM_MODERATION_API_KEY
 *   （S1 敏感项：只读 env，禁硬编码禁日志，不进 .env.example 明文）；
 * - 校验：`validateTencentModerationConfig` 返回缺失 env 名（骨架阶段只提示，不抛错——降级不崩服纪律）；
 * - 本地规则优先（PLATFORM_MODERATION_LOCAL=on 缺省）：
 *   · 本地规则命中 → 直接返回 { flagged:true, reasons }——**不出域**（明显违规本地拦截，省外部调用）；
 *   · 本地规则未命中 → 外部**占位降级** { verdict:'review', labels:[...tencent-tianyu 未确认标注],
 *     flagged:false }——不实际调用外部，交由人工复核心智，不崩服（同占位语义）。
 *
 * 用户确认 T4+T5+T6 后接真实调用的接入点（见文件尾部 TODO）：腾讯云天御文本审核 API（TC3 签名）→
 * verdict 映射 pass|review|block（label 命中映射）并保留本地先行逻辑。零新依赖（骨架不引 SDK）。
 */

import type { ModerationAdapter, ModerationRequest, ModerationResponse } from '../types.js';
import { parsePlatformServicesEnv } from '../config.js';
import { moderateWithLocalRules } from './rules.js';

export const PLATFORM_MODERATION_SECRET_ID_ENV = 'PLATFORM_MODERATION_SECRET_ID';
export const PLATFORM_MODERATION_SECRET_KEY_ENV = 'PLATFORM_MODERATION_SECRET_KEY';
export const PLATFORM_MODERATION_API_KEY_ENV = 'PLATFORM_MODERATION_API_KEY';

/** 外部云审核未配置占位 label（写入 labels 供调用方/审计可辨：外部未实际调用）。 */
export const EXTERNAL_MODERATION_PLACEHOLDER_LABEL = 'platform-moderation-external-not-configured';

/** tencent-tianyu 未确认降级 label（标注具体供应商，与占位 label 并存——审计可辨）。 */
export const TENCENT_TIANYU_PENDING_LABEL = 'platform-moderation-tencent-tianyu-not-confirmed';

/** 腾讯云天御骨架配置（env 读取结果；trim 归一，空串 → undefined）。 */
export interface TencentModerationConfig {
  /** 腾讯云 SecretId（S1：只读 env）。 */
  secretId?: string;
  /** 腾讯云 SecretKey（S1：只读 env）。 */
  secretKey?: string;
  /** 可选 API Key（部分套餐鉴权；S1：只读 env）。 */
  apiKey?: string;
}

/** 读腾讯云天御配置（纯函数，测试可注入 env）。 */
export function readTencentModerationConfig(env: NodeJS.ProcessEnv = process.env): TencentModerationConfig {
  return {
    secretId: (env[PLATFORM_MODERATION_SECRET_ID_ENV] ?? '').trim() || undefined,
    secretKey: (env[PLATFORM_MODERATION_SECRET_KEY_ENV] ?? '').trim() || undefined,
    apiKey: (env[PLATFORM_MODERATION_API_KEY_ENV] ?? '').trim() || undefined,
  };
}

/** 校验腾讯云天御配置：返回缺失的必填 env 名（secretId/secretKey 必填；apiKey 可选，骨架阶段不抛错）。 */
export function validateTencentModerationConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const config = readTencentModerationConfig(env);
  const missing: string[] = [];
  if (!config.secretId) missing.push(PLATFORM_MODERATION_SECRET_ID_ENV);
  if (!config.secretKey) missing.push(PLATFORM_MODERATION_SECRET_KEY_ENV);
  return missing;
}

/**
 * 创建外部云审核骨架 adapter（provider='external'；目标供应商 = 腾讯云天御）。
 * @param env 进程 env（测试可注入）；PLATFORM_MODERATION_LOCAL 缺省 'on'（本地规则优先开关）
 */
export function createExternalModerationAdapter(env: NodeJS.ProcessEnv = process.env): ModerationAdapter {
  const { moderationLocal } = parsePlatformServicesEnv(env);
  const missing = validateTencentModerationConfig(env);
  return {
    provider: 'external',
    async moderateText(input: ModerationRequest): Promise<ModerationResponse> {
      // 本地规则优先：命中 → 本地拦截（不出域）；未命中才应走外部（未确认 → review 降级）
      if (moderationLocal) {
        const { flagged, reasons } = moderateWithLocalRules(input.text);
        if (flagged) {
          return { verdict: 'review', labels: reasons, flagged: true, reasons };
        }
      }
      // 未确认降级：不实际调用外部——review（人工复核）+ 占位/未确认标注，绝不静默假装可用
      const tianyuStatus =
        missing.length === 0 ? '密钥已配置（待用户确认出域）' : `缺少配置：${missing.join(', ')}`;
      return {
        verdict: 'review',
        labels: [EXTERNAL_MODERATION_PLACEHOLDER_LABEL, TENCENT_TIANYU_PENDING_LABEL, `tencent-tianyu: ${tianyuStatus}`],
        flagged: false,
        reasons: [],
      };
    },
  };
}

/** 契约 §8.4 工厂名（tencent-tianyu 云审核骨架）；provider 配置值仍为 'external'（MODERATION_PROVIDERS 枚举）。 */
export const createTencentModerationAdapter = createExternalModerationAdapter;

// TODO(user-confirmed · T4+T5+T6)：用户确认出域后在此接入腾讯云天御文本审核 API——
//   TC3-HMAC-SHA256 签名 → 审核请求 → verdict 映射 pass|review|block（保留本地先行逻辑）。
//   错误归一复用 ProviderError：timeout → retryable:true；5xx → provider_down:true。
//   本骨架阶段以上代码不落地（红线：用户确认前不接云）。
