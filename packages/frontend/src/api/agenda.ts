import type {
  AgendaTodayDocument,
  AgendaWeekDocument,
} from '@teacher-platform/contracts';
import { apiRequest } from './client';

export interface AgendaApi {
  getToday(teacherId: string): Promise<AgendaTodayDocument>;
  getWeek(teacherId: string, weekStart?: string): Promise<AgendaWeekDocument>;
}

export const agendaApi: AgendaApi = {
  getToday(teacherId) {
    return apiRequest<AgendaTodayDocument>('/agenda/today', { teacherId });
  },

  getWeek(teacherId, weekStart) {
    const query = weekStart === undefined
      ? ''
      : `?${new URLSearchParams({ weekStart }).toString()}`;
    return apiRequest<AgendaWeekDocument>(`/agenda/week${query}`, { teacherId });
  },
};
