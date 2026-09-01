import { apiRequest } from './client';
import type {
  EditReceipt,
  EditRequest,
  MemoChanges,
  MemoData,
} from './types';

export function updateMemo(
  teacherId: string,
  memoId: string,
  body: EditRequest<MemoChanges>,
): Promise<EditReceipt<MemoData>> {
  return apiRequest(`/memos/${encodeURIComponent(memoId)}`, {
    method: 'PATCH',
    teacherId,
    body,
  });
}
