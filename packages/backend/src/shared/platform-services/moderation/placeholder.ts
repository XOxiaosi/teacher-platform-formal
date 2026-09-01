/**
 * 文本审核占位 adapter（P10 平台预配线 A2 · P11 t1，任务项 1：moderation 占位，默认 off）。
 *
 * 阶段三-D（可选）：证据链写库前过审（合规加分项）。默认 off——PLATFORM_MODERATION_PROVIDER=none
 * 时门面不实例化本 adapter（services.moderation === undefined，调用方走「未配置」分支）。
 * 已配置（tencent 等）但真实供应商未实现时占位降级：moderateText 返回 review 标记 + 占位 label——
 * 不实际审核（不阻断写库也不放行，交由人工复核心智），不崩服。
 *
 * 真实供应商 adapter（moderation/tencent-tianyu.ts）在用户确认合规启用后按本契约实现。
 */

import type { ModerationAdapter, ModerationRequest, ModerationResponse } from '../types.js';

/** 占位 label：标注「平台预配文本审核未实际启用」（写入 labels 供调用方/审计可辨）。 */
export const PLATFORM_MODERATION_PLACEHOLDER_LABEL = 'platform-moderation-not-configured';

/**
 * 创建占位文本审核 adapter（仅已配置供应商时调用；provider 为归一后的小写供应商 id）。
 * @param provider 已配置的供应商（'tencent' 等；'none' 由门面拦截不实例化）
 */
export function createPlaceholderModerationAdapter(provider: string): ModerationAdapter {
  const normalized = provider.trim().toLowerCase();
  return {
    provider: normalized,
    async moderateText(_input: ModerationRequest): Promise<ModerationResponse> {
      // 占位降级：不实际审核——review（人工复核）而非 pass/block，避免「静默放行」或「误杀」。
      return { verdict: 'review', labels: [PLATFORM_MODERATION_PLACEHOLDER_LABEL], flagged: false, reasons: [] };
    },
  };
}
