import { ok } from '@teacher-platform/contracts';
import type { SaveRawInputServices, SaveRawInputUseCase } from './types.js';

export function createSaveRawInputUseCase(
  services: SaveRawInputServices,
): SaveRawInputUseCase {
  return {
    async saveRawInput(input) {
      const parsed = await services.aiNotes.parseInput(input);
      if (!parsed.ok) return parsed;

      const saved = await services.aiNotes.saveNote({
        teacherId: parsed.value.teacherId,
        inputType: parsed.value.inputType,
        rawInput: parsed.value.rawInput,
        audioFileRef: parsed.value.audioFileRef ?? null,
        intent: parsed.value.intent,
        extractedData: parsed.value.extractedData,
        confidence: parsed.value.confidence,
        pendingFields: parsed.value.pendingFields,
        status: parsed.value.status,
      });
      if (!saved.ok) return saved;

      return ok({
        noteId: saved.value.id,
        rawInput: parsed.value.rawInput,
        audioFileRef: parsed.value.audioFileRef ?? null,
        savedNote: saved.value,
      });
    },
  };
}
