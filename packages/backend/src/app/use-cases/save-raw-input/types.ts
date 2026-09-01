import type { CommonError, Result } from '@teacher-platform/contracts';
import type { AiNoteData, AiNoteService, ParseInputInput } from '../../../features/ai-notes/index.js';

export type SaveRawInputInput = ParseInputInput;

export interface SaveRawInputOutput {
  noteId: string;
  rawInput: string;
  audioFileRef: string | null;
  savedNote: AiNoteData;
}

export interface SaveRawInputServices {
  aiNotes: Pick<AiNoteService, 'parseInput' | 'saveNote'>;
}

export interface SaveRawInputUseCase {
  saveRawInput(input: SaveRawInputInput): Promise<Result<SaveRawInputOutput, CommonError>>;
}
