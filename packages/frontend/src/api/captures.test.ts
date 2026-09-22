import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listCaptures, editCaptureCandidate, reviewCaptureCandidate, confirmCaptureCandidate } from './captures';
const request = vi.hoisted(() => vi.fn());
vi.mock('./client', () => ({ apiRequest: request }));
beforeEach(() => request.mockReset());
describe('candidate API contract', () => {
  it('encodes cursor and candidate paths, retaining version and confirmation identity', async () => {
    await listCaptures('cursor/one');
    expect(request).toHaveBeenLastCalledWith('/captures?cursor=cursor%2Fone', { method: 'GET' });
    await editCaptureCandidate('event/1', 'candidate/2', { version: 3, text: '已修改' });
    expect(request).toHaveBeenLastCalledWith('/captures/event%2F1/candidates/candidate%2F2', { method: 'PATCH', body: { version: 3, text: '已修改' } });
    await reviewCaptureCandidate('e1', 'c2', { version: 4, action: 'defer' });
    expect(request).toHaveBeenLastCalledWith('/captures/e1/candidates/c2/review', { method: 'POST', body: { version: 4, action: 'defer' } });
    const body = { version: 5, clientRequestId: 'same-request', studentId: 'student-b', visibility: 'parent_shareable' as const };
    await confirmCaptureCandidate('e1', 'c2', body);
    expect(request).toHaveBeenLastCalledWith('/captures/e1/candidates/c2/confirm-record', { method: 'POST', body });
  });
});
