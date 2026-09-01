import { apiRequest } from './client';
import type {
  EditReceipt,
  EditRequest,
  LessonData,
  LessonRecordChanges,
} from './types';

export function updateLessonRecord(
  teacherId: string,
  lessonId: string,
  body: EditRequest<LessonRecordChanges>,
): Promise<EditReceipt<LessonData>> {
  return apiRequest(`/lessons/${encodeURIComponent(lessonId)}/record`, {
    method: 'PATCH',
    teacherId,
    body,
  });
}
