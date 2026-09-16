import type { StudentRecordItem } from '../../api/types';

export const record = (overrides: Partial<StudentRecordItem> = {}): StudentRecordItem => ({
  id: 'r1', teacherId: 'teacher-a', studentId: 's1', sourceRecordId: 'source1', category: 'general_note',
  occurredAt: '2026-09-16T01:00:00.000Z', summary: '教师核对后的完整记录\n第二段保留内容。',
  structuredData: null, confidence: 'high', reviewStatus: 'confirmed', visibility: 'internal_only', importance: 'normal',
  supersedesId: null, createdAt: '2026-09-16T01:01:00.000Z', updatedAt: '2026-09-16T01:02:00.001Z', ...overrides,
});
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
