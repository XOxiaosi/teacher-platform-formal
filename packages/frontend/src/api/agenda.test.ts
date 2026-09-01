import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgendaTodayDocument, AgendaWeekDocument } from '@teacher-platform/contracts';
import { ApiError } from './client';

interface AgendaApiLike {
  getToday(teacherId: string): Promise<AgendaTodayDocument>;
  getWeek(teacherId: string, weekStart?: string): Promise<AgendaWeekDocument>;
}

interface AgendaModule {
  agendaApi?: AgendaApiLike;
}

const todayDocument: AgendaTodayDocument = {
  schemaVersion: 1,
  timeZone: 'Asia/Shanghai',
  businessDate: '2030-07-24',
  generatedAt: '2030-07-24T01:00:00.000Z',
  items: [],
};

const weekDocument: AgendaWeekDocument = {
  schemaVersion: 1,
  timeZone: 'Asia/Shanghai',
  weekStart: '2030-07-22',
  weekEndExclusive: '2030-07-29',
  generatedAt: '2030-07-24T01:00:00.000Z',
  days: [
    '2030-07-22',
    '2030-07-23',
    '2030-07-24',
    '2030-07-25',
    '2030-07-26',
    '2030-07-27',
    '2030-07-28',
  ].map((date) => ({ date, items: [] })),
};

async function loadAgendaApi(): Promise<AgendaApiLike | undefined> {
  let module: AgendaModule = {};
  try {
    const modulePath = './agenda';
    module = await import(/* @vite-ignore */ modulePath) as unknown as AgendaModule;
  } catch {
    module = {};
  }
  expect(module.agendaApi).toMatchObject({
    getToday: expect.any(Function),
    getWeek: expect.any(Function),
  });
  return module.agendaApi;
}

function mockSuccess<T>(data: T) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, data }),
  } as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Agenda API client', () => {
  it('getToday 请求固定 Today path（credentials include，无 teacher header）', async () => {
    const api = await loadAgendaApi();
    if (!api) return;
    const fetchMock = mockSuccess(todayDocument);

    await expect(api.getToday('teacher-a')).resolves.toEqual(todayDocument);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/agenda/today', {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
      },
      credentials: 'include',
    });
  });

  it('getWeek缺少weekStart时不发送空query', async () => {
    const api = await loadAgendaApi();
    if (!api) return;
    const fetchMock = mockSuccess(weekDocument);

    await api.getWeek('teacher-a');

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/agenda/week', expect.objectContaining({
      method: 'GET',
    }));
  });

  it('getWeek使用URLSearchParams编码显式weekStart且不能注入其他query', async () => {
    const api = await loadAgendaApi();
    if (!api) return;
    const fetchMock = mockSuccess(weekDocument);

    await api.getWeek('teacher-a', '2030-07-22&teacherId=evil&timeZone=UTC');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/agenda/week?weekStart=2030-07-22%26teacherId%3Devil%26timeZone%3DUTC',
      expect.objectContaining({
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  it('后端CommonError继续作为ApiError传播', async () => {
    const api = await loadAgendaApi();
    if (!api) return;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'weekStart非法', field: 'weekStart' },
      }),
    } as Response);

    await expect(api.getWeek('teacher-a', 'bad')).rejects.toBeInstanceOf(ApiError);
    await expect(api.getWeek('teacher-a', 'bad')).rejects.toMatchObject({
      error: { code: 'VALIDATION_ERROR', field: 'weekStart' },
    });
  });
});
