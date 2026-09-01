/**
 * 病毒扫描占位 adapter（P12 平台预配线 A3/C，任务项 1：scan-client 接口占位实现）。
 *
 * 未配置（PLATFORM_SCAN_PROVIDER=none，缺省）→ 门面不实例化本 adapter（services.scan === undefined，
 * 上传保持 scanStatus=skipped——阶段二基线零破坏）；已配置（clamav 等）但真实供应商未实现/clamd
 * 未装时占位降级：scan 返回 { status: 'error', message }——不静默放行（绝不伪造 clean）也不误杀
 * （绝不伪造 infected），交由 scanStatus=error 表达「扫描未实际执行，可重扫」，不崩服（同 A1/A2 心智；
 * 参考 A2 moderation 占位「review 而非 pass/block」的安全语义）。
 *
 * 真实供应商 adapter（scan/clamav.ts）在用户确认后按本契约实现并替换占位。
 */

import type { ScanAdapter, ScanRequest, ScanResponse } from '../types.js';

/** 未配置时的占位 error 消息（scanStatus=error，作业错误可辨「平台预配扫描未启用」）。 */
export const PLATFORM_SCAN_PLACEHOLDER_ERROR = '平台预配病毒扫描未实际执行（PLATFORM_SCAN_PROVIDER=none）';

/**
 * 创建占位病毒扫描 adapter。
 * @param provider 已配置的供应商（'none'/缺省 → 'placeholder'；'clamav' 等 → 占位降级并标注接入点）
 */
export function createPlaceholderScanAdapter(provider: string = 'none'): ScanAdapter {
  const normalized = provider.trim().toLowerCase();
  const isConfigured = normalized !== '' && normalized !== 'none';
  const message = isConfigured
    ? `PLATFORM_SCAN_PROVIDER=${normalized} 已配置但未启用（真实 ClamAV adapter 接入需用户确认后实现；clamd 未装时同样降级）`
    : PLATFORM_SCAN_PLACEHOLDER_ERROR;

  return {
    provider: isConfigured ? normalized : 'placeholder',
    async scan(_input: ScanRequest): Promise<ScanResponse> {
      // 占位降级：不实际扫描——返回 error（既不伪造 clean 放行，也不伪造 infected 误杀）
      return { status: 'error', message };
    },
  };
}
