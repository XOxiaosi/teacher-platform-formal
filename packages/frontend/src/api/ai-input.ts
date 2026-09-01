import { apiRequest } from './client';
import type { AiRawInputResult } from './types';

export interface SaveRawInputRequest {
  inputType: 'text';
  text: string;
}

export function saveRawInput(teacherId: string, body: SaveRawInputRequest): Promise<AiRawInputResult> {
  return apiRequest('/ai/raw-input', { method: 'POST', teacherId, body });
}
