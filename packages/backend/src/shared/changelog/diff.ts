import type { FieldDiff } from './types.js';

/** Prisma 元数据字段，不参与 diff（每次 update 都会变，是噪音） */
const METADATA_FIELDS = new Set(['createdAtTs', 'updatedAtTs']);

/**
 * 判断两个值是否相等。
 * 处理 Date 对象（按时间戳比较，而非引用比较）。
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (a instanceof Date && b === null) return false;
  if (b instanceof Date && a === null) return false;
  return a === b;
}

/**
 * 计算两个对象之间的字段级差异。
 * 纯函数，无副作用。
 *
 * - before 为 null：所有 after 字段视为新增
 * - after 为 null：所有 before 字段视为删除
 * - 两者都为 null：返回空数组
 * - 正常比较：只返回值不同的字段
 * - createdAt/updatedAt 不参与 diff（Prisma 元数据字段）
 */
export function computeDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): FieldDiff[] {
  if (before === null && after === null) {
    return [];
  }

  if (before === null && after !== null) {
    return Object.entries(after)
      .filter(([field]) => !METADATA_FIELDS.has(field))
      .map(([field, newValue]) => ({ field, oldValue: null, newValue }));
  }

  if (before !== null && after === null) {
    return Object.entries(before)
      .filter(([field]) => !METADATA_FIELDS.has(field))
      .map(([field, oldValue]) => ({ field, oldValue, newValue: null }));
  }

  // 两者都不为 null，逐字段比较
  const allKeys = new Set([...Object.keys(before!), ...Object.keys(after!)]);
  const diffs: FieldDiff[] = [];

  for (const field of allKeys) {
    if (METADATA_FIELDS.has(field)) continue;

    const oldValue = before![field] ?? null;
    const newValue = after![field] ?? null;

    if (!valuesEqual(oldValue, newValue)) {
      diffs.push({ field, oldValue, newValue });
    }
  }

  return diffs;
}