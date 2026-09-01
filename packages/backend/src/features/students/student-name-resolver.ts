/**
 * 学生身份自动解析（D51 §七 渠道线 · t56）：
 * 老师记东西/问 AI 时只提学生姓名，系统自动匹配学生（无需先选学生）。
 *
 * 匹配策略（按优先级）：
 * 1. 精确匹配（归一化后完全相等）→ 唯一命中 exact
 * 2. 前缀匹配（学生名以输入开头）→ 唯一 candidate / 多个 ambiguous
 * 3. 包含匹配（学生名包含输入）→ 唯一 candidate / 多个 ambiguous
 *
 * 归一化：去空白（含全角空格 U+3000）→ 全角字母数字转半角 → 小写。
 * 候选列表 ≤ maxCandidates（默认 3），避免误配。
 *
 * ⚠️ 范围外（不实现）：模糊音匹配/拼音——需拼音词库，标注为后续渠道线工作。
 */

export interface NamedStudent {
  id: string;
  name: string;
}

export type StudentNameResolution<T extends NamedStudent = NamedStudent> =
  | { kind: 'exact'; student: T }
  | { kind: 'candidate'; student: T }
  | { kind: 'ambiguous'; candidates: T[] }
  | { kind: 'not_found' };

export interface ResolveStudentByNameOptions {
  /** 候选列表上限（默认 3）；超过上限截断并按 ambiguous 返回 */
  maxCandidates?: number;
}

/** 名称归一化：去空白（含全角空格）→ 全角字母数字转半角 → 小写。 */
export function normalizeStudentName(name: string): string {
  return name
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .toLowerCase();
}

export function resolveStudentByName<T extends NamedStudent>(
  students: readonly T[],
  rawName: string,
  options: ResolveStudentByNameOptions = {},
): StudentNameResolution<T> {
  const maxCandidates = options.maxCandidates ?? 3;
  const normalized = normalizeStudentName(rawName);
  if (!normalized) return { kind: 'not_found' };

  const exact = students.filter((student) => normalizeStudentName(student.name) === normalized);
  if (exact.length === 1) return { kind: 'exact', student: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact.slice(0, maxCandidates) };

  const prefix = students.filter((student) => normalizeStudentName(student.name).startsWith(normalized));
  if (prefix.length === 1) return { kind: 'candidate', student: prefix[0] };
  if (prefix.length > 1) return { kind: 'ambiguous', candidates: prefix.slice(0, maxCandidates) };

  const contains = students.filter((student) => normalizeStudentName(student.name).includes(normalized));
  if (contains.length === 1) return { kind: 'candidate', student: contains[0] };
  if (contains.length > 1) return { kind: 'ambiguous', candidates: contains.slice(0, maxCandidates) };

  return { kind: 'not_found' };
}
