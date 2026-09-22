import { beforeEach, describe, expect, it, vi } from 'vitest';
import { businessDate, listAll } from './workspace-api';
const request = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ apiRequest: request }));
beforeEach(() => request.mockReset());
describe('workspace DTO reading', () => {
  it('does not drop later list pages', async () => {
    request.mockResolvedValueOnce({ items: ['a'], total: 2 }).mockResolvedValueOnce({ items: ['b'], total: 2 });
    expect(await listAll('/students')).toEqual(['a', 'b']);
    expect(request.mock.calls[1][0]).toContain('page=2');
  });
  it('rejects an incomplete empty page rather than showing false totals', async () => {
    request.mockResolvedValue({ items: [], total: 2 });
    await expect(listAll('/students')).rejects.toThrow('未加载完整');
  });
  it('uses Shanghai dates across UTC midnight boundaries', () => expect(businessDate('2026-09-09T20:00:00Z')).toBe('2026-09-10'));
});
