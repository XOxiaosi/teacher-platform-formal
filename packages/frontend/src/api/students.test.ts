import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getStudentRecordSource, listStudentRecords, reviewStudentRecord } from './students';
const request = vi.hoisted(() => vi.fn());
vi.mock('./client', () => ({ apiRequest: request }));
beforeEach(() => request.mockReset());
describe('student record API contracts', () => {
  it('does not expose retired direct-model capture calls', async () => {
    const studentApi = await import('./students');
    expect(studentApi).not.toHaveProperty('captureScoreFromText');
    expect(studentApi).not.toHaveProperty('captureCommunicationFromText');
  });

  it('supports complete paging while preserving the default endpoint', async () => {
    await listStudentRecords('teacher', 'student/1');
    expect(request).toHaveBeenLastCalledWith('/students/student%2F1/records', { teacherId: 'teacher' });
    await listStudentRecords('teacher', 'student/1', { page: 2, pageSize: 100 });
    expect(request).toHaveBeenLastCalledWith('/students/student%2F1/records?page=2&pageSize=100', { teacherId: 'teacher' });
  });
  it('sends the displayed version for explicit visibility updates', async () => {
    const version = '2026-09-16T03:01:02.345Z';
    await reviewStudentRecord('teacher', 's/1', 'r/2', 'confirmed', 'parent_shareable', version);
    expect(request).toHaveBeenLastCalledWith('/students/s%2F1/records/r%2F2/review', {
      teacherId: 'teacher', method: 'POST', body: { reviewStatus: 'confirmed', visibility: 'parent_shareable', expectedUpdatedAt: version },
    });
  });
  it('binds source lookup to the selected record and student', async () => {
    await getStudentRecordSource('teacher', 's/1', 'r/2');
    expect(request).toHaveBeenLastCalledWith('/students/s%2F1/records/r%2F2/source', { teacherId: 'teacher' });
  });
});
