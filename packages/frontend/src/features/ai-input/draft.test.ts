import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCaptureDraft,
  readCaptureDraft,
  writeCaptureDraft,
} from './draft';

describe('capture draft storage', () => {
  beforeEach(() => window.localStorage.clear());

  it('按教师隔离草稿', () => {
    writeCaptureDraft('teacher-a', {
      text: 'A 的记录',
      clientRequestId: 'capture-request-a',
      updatedAt: '2026-09-02T00:00:00Z',
    });

    expect(readCaptureDraft('teacher-a')?.text).toBe('A 的记录');
    expect(readCaptureDraft('teacher-b')).toBeNull();
  });

  it('损坏内容安全降级且不会影响后续写入', () => {
    window.localStorage.setItem('teacher-platform:capture-draft:teacher-a', '{bad-json');
    expect(readCaptureDraft('teacher-a')).toBeNull();

    writeCaptureDraft('teacher-a', {
      text: '恢复后的记录',
      clientRequestId: 'capture-request-b',
      updatedAt: '2026-09-02T00:00:00Z',
    });
    expect(readCaptureDraft('teacher-a')?.text).toBe('恢复后的记录');
  });

  it('存储不可用时不让页面崩溃', () => {
    const getter = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    expect(readCaptureDraft('teacher-a')).toBeNull();
    getter.mockRestore();

    clearCaptureDraft('teacher-a');
  });
});
