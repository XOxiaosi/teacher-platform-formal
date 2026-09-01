/**
 * 本地规则文本审核 adapter（P13 D 切片 · moderation，设计 p10-platform-services-design.md §8.4 D6）。
 *
 * PLATFORM_MODERATION_PROVIDER=local → 本 adapter：内置规则引擎（rules.ts）零外部依赖、零出域、零费用。
 *
 * 语义：
 * - 未命中 → { verdict:'pass', flagged:false, reasons:[] }（放行）；
 * - 命中   → { verdict:'review', flagged:true, reasons:[规则组...] }——只标记不阻断（人工复核心智，
 *   与既有占位「review 而非 pass/block」一致，宁可人工复核不可误杀）；
 * - PLATFORM_MODERATION_LOCAL=off（本地引擎关闭）→ 占位降级 { verdict:'review', flagged:false,
 *   reasons:[], labels:['local-moderation-disabled'] }——不实际审核，不崩服（同占位心智）。
 *
 * 真实外部供应商 adapter（moderation/external.ts 占位）在用户确认出域后按本契约实现/替换。
 */

import type { ModerationAdapter, ModerationRequest, ModerationResponse } from '../types.js';
import { parsePlatformServicesEnv, PLATFORM_MODERATION_LOCAL_ENV } from '../config.js';
import { moderateWithLocalRules } from './rules.js';

/** 本地引擎关闭时的占位 label（写入 labels 供调用方/审计可辨）。 */
export const LOCAL_MODERATION_DISABLED_LABEL = 'local-moderation-disabled';

/**
 * 创建本地规则审核 adapter（provider='local'）。
 * @param env 进程 env（测试可注入）；PLATFORM_MODERATION_LOCAL 缺省 'on'（引擎开）
 */
export function createLocalModerationAdapter(env: NodeJS.ProcessEnv = process.env): ModerationAdapter {
  const { moderationLocal } = parsePlatformServicesEnv(env);
  return {
    provider: 'local',
    async moderateText(input: ModerationRequest): Promise<ModerationResponse> {
      if (!moderationLocal) {
        // 本地引擎被 PLATFORM_MODERATION_LOCAL=off 关闭：不实际审核（review 占位），不崩服
        return {
          verdict: 'review',
          labels: [LOCAL_MODERATION_DISABLED_LABEL],
          flagged: false,
          reasons: [],
        };
      }
      const { flagged, reasons } = moderateWithLocalRules(input.text);
      if (!flagged) {
        return { verdict: 'pass', labels: [], flagged: false, reasons: [] };
      }
      // 命中 → review（人工复核），reasons 与 labels 同源（审计可辨）
      return { verdict: 'review', labels: reasons, flagged: true, reasons };
    },
  };
}

// 导出 env 常量供门面/测试引用
export { PLATFORM_MODERATION_LOCAL_ENV };
