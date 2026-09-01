/**
 * LLM 用量看板窗口/分桶（P8 · t24）。
 *
 * 纯函数（无 React 依赖）：
 * - usageWindow：整窗口 [now - days, now]（from < to，ISO 由调用方序列化）；
 * - usageBuckets：把整窗口均分为 bucketCount 个子窗口，用于趋势简图——
 *   每个子窗口调一次 GET /usage/summary?from&to 聚合，得到按时间分段的 token 趋势
 *   （后端 summary 无时间序列字段，趋势用分桶聚合实现，无新图表库依赖）。
 *
 * 时间语义：窗口边界用毫秒算术（对齐 usage summary 的 ISO 时间）；桶标签用 UTC 日期
 * （M/D），跨时区/测试环境确定。
 */

export type UsageRangeKey = '7d' | '30d' | '90d';

export interface UsageRangeSpec {
  key: UsageRangeKey;
  /** 切换按钮文案 */
  label: string;
  /** 窗口天数（from = now - days） */
  days: number;
  /** 趋势分桶数 */
  bucketCount: number;
}

export const USAGE_RANGES: UsageRangeSpec[] = [
  { key: '7d', label: '近 7 天', days: 7, bucketCount: 7 },
  { key: '30d', label: '近 30 天', days: 30, bucketCount: 6 },
  { key: '90d', label: '近 90 天', days: 90, bucketCount: 6 },
];

export function usageRangeSpec(key: UsageRangeKey): UsageRangeSpec {
  return USAGE_RANGES.find((spec) => spec.key === key) ?? USAGE_RANGES[1];
}

export interface UsageWindow {
  from: Date;
  to: Date;
}

/** 整窗口：[now - days, now]。 */
export function usageWindow(days: number, now: Date): UsageWindow {
  return {
    from: new Date(now.getTime() - days * 24 * 3600 * 1000),
    to: now,
  };
}

export interface UsageBucket {
  from: Date;
  to: Date;
  /** 桶起始日（UTC M/D，如 '7/24'） */
  label: string;
}

/** 把 [now - days, now] 均分为 spec.bucketCount 个子窗口（相邻不重叠，末桶以 now 收口）。 */
export function usageBuckets(spec: UsageRangeSpec, now: Date): UsageBucket[] {
  const { from } = usageWindow(spec.days, now);
  const spanMs = now.getTime() - from.getTime();
  const stepMs = spanMs / spec.bucketCount;
  const buckets: UsageBucket[] = [];

  for (let i = 0; i < spec.bucketCount; i += 1) {
    const bucketFrom = new Date(from.getTime() + i * stepMs);
    const bucketTo = i === spec.bucketCount - 1 ? now : new Date(from.getTime() + (i + 1) * stepMs);
    buckets.push({
      from: bucketFrom,
      to: bucketTo,
      label: monthDayLabel(bucketFrom),
    });
  }

  return buckets;
}

function monthDayLabel(date: Date): string {
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}
