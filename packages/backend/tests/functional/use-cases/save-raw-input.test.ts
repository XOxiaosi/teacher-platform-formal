import { describe, it, expect, vi } from 'vitest';
import { ok } from '@teacher-platform/contracts';
import { createSaveRawInputUseCase } from '../../../src/app/use-cases/save-raw-input/index.js';
import type { SaveRawInputServices } from '../../../src/app/use-cases/save-raw-input/index.js';

function createServices(): SaveRawInputServices {
  return {
    aiNotes: {
      parseInput: vi.fn(async () => ok({
        teacherId: 'teacher-1',
        inputType: 'voice',
        rawInput: '明天下午三点给张三上课',
        audioFileRef: 'audio/voice.m4a',
        intent: 'schedule_create',
        extractedData: { studentName: '张三' },
        confidence: 'high',
        pendingFields: [],
        status: 'processed',
        defaultsApplied: {},
      } as any)),
      saveNote: vi.fn(async () => ok({ id: 'note-1' } as any)),
    },
  };
}

describe('saveRawInputUseCase.saveRawInput', () => {
  it('语音输入：先解析原始输入，再保存 AI 记录', async () => {
    const services = createServices();
    const useCase = createSaveRawInputUseCase(services);

    const result = await useCase.saveRawInput({
      teacherId: 'teacher-1',
      inputType: 'voice',
      audio: Buffer.from('audio'),
      filename: 'voice.m4a',
    });

    expect(result.ok).toBe(true);
    expect(services.aiNotes.parseInput).toHaveBeenCalledBefore(services.aiNotes.saveNote as any);
    expect(services.aiNotes.parseInput).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      inputType: 'voice',
      audio: Buffer.from('audio'),
      filename: 'voice.m4a',
    });
    if (!result.ok) return;
    expect(result.value.noteId).toBe('note-1');
    expect(result.value.rawInput).toBe('明天下午三点给张三上课');
    expect(result.value.audioFileRef).toBe('audio/voice.m4a');
  });

  it('文字输入：解析后保存 AI 记录', async () => {
    const services = createServices();
    const useCase = createSaveRawInputUseCase(services);

    const result = await useCase.saveRawInput({
      teacherId: 'teacher-1',
      inputType: 'text',
      text: '记录一下张三今天状态不错',
    });

    expect(result.ok).toBe(true);
    expect(services.aiNotes.parseInput).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      inputType: 'text',
      text: '记录一下张三今天状态不错',
    });
    expect(services.aiNotes.saveNote).toHaveBeenCalledOnce();
  });

  it('解析失败时不保存 AI 记录', async () => {
    const services: SaveRawInputServices = {
      aiNotes: {
        parseInput: vi.fn(async () => ({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'bad' } }) as any),
        saveNote: vi.fn(async () => ok({ id: 'note-1' } as any)),
      },
    };
    const useCase = createSaveRawInputUseCase(services);

    const result = await useCase.saveRawInput({ teacherId: 'teacher-1', inputType: 'text', text: '' });

    expect(result.ok).toBe(false);
    expect(services.aiNotes.saveNote).not.toHaveBeenCalled();
  });
});
