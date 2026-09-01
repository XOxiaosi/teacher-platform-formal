import { describe, expect, it } from 'vitest';
import { USAGE_RANGES, usageBuckets, usageRangeSpec, usageWindow } from './usage-window';

// 固定 now：UTC 2026-08-01T00:00:00.000Z（避免测试受真实时钟/时区影响）
const NOW = new Date('2026-08-01T00:00:00.000Z');

describe('usage-window（t24 用量看板窗口/分桶）', () => {
  it('USAGE_RANGES 提供 7d/30d/90d 且桶数递增合理', () => {
    expect(USAGE_RANGES.map((spec) => spec.key)).toEqual(['7d', '30d', '90d']);
    expect(usageRangeSpec('7d').days).toBe(7);
    expect(usageRangeSpec('30d').days).toBe(30);
    expect(usageRangeSpec('90d').days).toBe(90);
    expect(usageRangeSpec('7d').bucketCount).toBe(7);
    expect(usageRangeSpec('90d').bucketCount).toBe(6);
  });

  it('usageWindow 返回 [now - days, now] 且 from < to', () => {
    const window7 = usageWindow(7, NOW);
    expect(window7.to).toEqual(NOW);
    expect(window7.from.getTime()).toBe(NOW.getTime() - 7 * 24 * 3600 * 1000);
    expect(window7.from.getTime()).toBeLessThan(window7.to.getTime());

    const window90 = usageWindow(90, NOW);
    expect(window90.from.getTime()).toBe(NOW.getTime() - 90 * 24 * 3600 * 1000);
  });

  it('usageBuckets 均分窗口：桶数正确、from<to、相邻相接、末桶收口于 now', () => {
    const buckets = usageBuckets(usageRangeSpec('7d'), NOW);

    expect(buckets).toHaveLength(7);
    for (let i = 0; i < buckets.length; i += 1) {
      expect(buckets[i].from.getTime()).toBeLessThan(buckets[i].to.getTime());
      if (i > 0) {
        expect(buckets[i].from.getTime()).toBe(buckets[i - 1].to.getTime());
      }
    }
    expect(buckets[0].from.getTime()).toBe(NOW.getTime() - 7 * 24 * 3600 * 1000);
    expect(buckets[buckets.length - 1].to).toEqual(NOW);
  });

  it('桶标签为 UTC M/D（跨环境确定）', () => {
    const buckets = usageBuckets(usageRangeSpec('7d'), NOW);
    // NOW = 2026-08-01 UTC；第一个桶起始 = 2026-07-25T00:00:00Z
    expect(buckets[0].label).toBe('7/25');
    // 末桶起始 = 07-31（结束收口于 now = 08-01）
    expect(buckets[buckets.length - 1].label).toBe('7/31');
  });

  it('30d/90d 分桶同样成立', () => {
    const buckets30 = usageBuckets(usageRangeSpec('30d'), NOW);
    expect(buckets30).toHaveLength(6);
    expect(buckets30[0].from.getTime()).toBe(NOW.getTime() - 30 * 24 * 3600 * 1000);
    expect(buckets30[buckets30.length - 1].to).toEqual(NOW);

    const buckets90 = usageBuckets(usageRangeSpec('90d'), NOW);
    expect(buckets90).toHaveLength(6);
    expect(buckets90[0].from.getTime()).toBe(NOW.getTime() - 90 * 24 * 3600 * 1000);
  });
});
