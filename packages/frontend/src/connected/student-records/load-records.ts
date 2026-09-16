import { listStudentRecords } from '../../api/students';
import type { StudentRecordItem } from '../../api/types';
import { formatDateTime } from '../../shared/date-format';

/** A bounded page reader: failures never turn a partial result into “all records”. */
export async function loadRecords(teacherId: string, studentId: string): Promise<StudentRecordItem[]> {
  const records = new Map<string, StudentRecordItem>();
  let expectedTotal: number | undefined;
  for (let page = 1; page <= 10000; page += 1) {
    const result = await listStudentRecords(teacherId, studentId, { page, pageSize: 100 });
    if (!Number.isSafeInteger(result.total) || result.total < 0 || !Array.isArray(result.items)) {
      throw new Error('记录列表响应不完整，请重新刷新。');
    }
    if (expectedTotal !== undefined && expectedTotal !== result.total) {
      throw new Error('读取期间记录数量发生变化，请重新刷新。');
    }
    expectedTotal = result.total;
    const before = records.size;
    for (const item of result.items) {
      if (item.teacherId !== teacherId || item.studentId !== studentId) {
        throw new Error('记录归属不匹配，已停止显示。');
      }
      // Repeated rows indicate unstable offset pagination; never silently omit an older row.
      if (records.has(item.id)) throw new Error('读取期间记录顺序发生变化，请重新刷新。');
      records.set(item.id, item);
    }
    if (records.size === result.total) return [...records.values()];
    if (records.size > result.total || before === records.size) {
      throw new Error('尚未读取完整记录，请重新刷新。');
    }
  }
  throw new Error('记录较多，本次尚未读取完整，请重新刷新。');
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '暂时无法读取，请稍后重试。';
}

export function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : formatDateTime(value);
}
