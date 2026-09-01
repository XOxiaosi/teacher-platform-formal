import type { ProviderTestResult } from '../../api/types';

/**
 * LLM Provider 连通性测试历史（P11 小增强：test 结果历史）。
 *
 * 后端 POST /provider-configs/:id/test 返回 {ok, providerName?, model?, providerError?}，
 * 不含测试时间戳——时间由前端在发起测试时记录，本地持久化（localStorage），
 * 使「最近测试时间/结果」在刷新/重进页面后仍可见。
 *
 * - key 按教师隔离：`llm:test-history:<teacherId>`（owner 隔离，无跨教师泄露）。
 * - 内容仅含测试结果（providerName/model/错误 kind/message），绝不含 API Key。
 * - 单教师最多保留 MAX_ENTRIES 条（按 testedAt 倒序裁剪），防无限增长。
 * - localStorage 不可用/损坏时静默降级为空历史（不影响主流程）。
 */

export interface TestHistoryEntry {
  /** 测试发起时间（ISO 8601；前端记录，后端不返回）。 */
  testedAt: string;
  result: ProviderTestResult;
}

const MAX_ENTRIES = 20;

export function testHistoryKey(teacherId: string): string {
  return `llm:test-history:${teacherId}`;
}

/** 读取某教师全部测试历史；无/损坏/不可用时返回空对象。 */
export function loadTestHistory(teacherId: string): Record<string, TestHistoryEntry> {
  try {
    const raw = window.localStorage.getItem(testHistoryKey(teacherId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, TestHistoryEntry>;
    const out: Record<string, TestHistoryEntry> = {};
    for (const [providerId, entry] of Object.entries(parsed)) {
      if (
        providerId
        && entry
        && typeof entry.testedAt === 'string'
        && entry.result
        && typeof entry.result.ok === 'boolean'
      ) {
        out[providerId] = entry;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** 写入单条测试历史（合并已有记录并裁剪），返回写入后的完整历史。 */
export function saveTestHistory(
  teacherId: string,
  providerId: string,
  entry: TestHistoryEntry,
): Record<string, TestHistoryEntry> {
  const next = { ...loadTestHistory(teacherId), [providerId]: entry };
  const trimmed = Object.fromEntries(
    Object.entries(next)
      .sort((a, b) => b[1].testedAt.localeCompare(a[1].testedAt))
      .slice(0, MAX_ENTRIES),
  );
  try {
    window.localStorage.setItem(testHistoryKey(teacherId), JSON.stringify(trimmed));
  } catch {
    // localStorage 不可用（隐私模式/配额）→ 静默降级为内存态，不阻断 UI
  }
  return trimmed;
}

/** 删除某 provider 的测试历史（配置删除时调用，避免残留条目），返回删除后的完整历史。 */
export function removeTestHistory(
  teacherId: string,
  providerId: string,
): Record<string, TestHistoryEntry> {
  const next = { ...loadTestHistory(teacherId) };
  delete next[providerId];
  try {
    window.localStorage.setItem(testHistoryKey(teacherId), JSON.stringify(next));
  } catch {
    // 同上
  }
  return next;
}
