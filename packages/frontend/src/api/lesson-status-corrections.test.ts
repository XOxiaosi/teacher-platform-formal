import { beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmLessonStatusCorrection, prepareLessonStatusCorrection } from './lesson-status-corrections';

const request = vi.hoisted(() => vi.fn());
vi.mock('./client', () => ({ apiRequest: request }));

beforeEach(() => request.mockReset().mockResolvedValue({}));

describe('出勤状态更正 API', () => {
  it('prepare 使用固定路径和请求体，不附带隐式 reload', async () => {
    const body = { lessonId: 'lesson-1', targetStatus: 'absent' as const, reason: '签到复核', clientRequestId: 'request-1' };
    await prepareLessonStatusCorrection(body);
    expect(request).toHaveBeenCalledWith('/lesson-status-corrections', { method: 'POST', body });
  });

  it('confirm 使用 URL 编码的 confirmation id', async () => {
    await confirmLessonStatusCorrection('confirmation/1');
    expect(request).toHaveBeenCalledWith('/lesson-status-corrections/confirmation%2F1/confirm', { method: 'POST' });
  });
});
