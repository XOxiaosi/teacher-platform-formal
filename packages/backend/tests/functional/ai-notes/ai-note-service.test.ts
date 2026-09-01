import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAiNoteService } from '../../../src/features/ai-notes/ai-note-service.js';
import { createAiClient, type AiProvider } from '../../../src/shared/ai-client/index.js';
import { createStorage } from '../../../src/shared/storage/index.js';

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-ai-notes';
let rootDir: string;

const provider: AiProvider = {
  async run(task) {
    if (task.taskType === 'speech_to_text') return { text: '明天下午三点给张三上课' };
    if (task.taskType === 'intent_recognition') {
      return { intent: 'schedule_create', confidenceScore: 0.92 };
    }
    return { studentName: '张三', type: 'lesson', durationMinutes: 90, location: '待确认' };
  },
};

function createService() {
  return createAiNoteService({
    prisma,
    aiClient: createAiClient({ provider }),
    storage: createStorage({ rootDir }),
  });
}

async function cleanup() {
  await prisma.aINote.deleteMany({ where: { teacherId: TEACHER_ID } });
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'teacher-platform-ai-notes-'));
  await cleanup();
});

afterEach(async () => {
  await cleanup();
  await rm(rootDir, { recursive: true, force: true });
});

describe('aiNoteService.parseInput', () => {
  it('解析文字输入并填充默认值', async () => {
    const service = createService();
    const result = await service.parseInput({
      teacherId: TEACHER_ID,
      inputType: 'text',
      text: '明天下午三点给张三上课',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rawInput).toBe('明天下午三点给张三上课');
    expect(result.value.intent).toBe('schedule_create');
    expect(result.value.confidence).toBe('high');
    expect(result.value.extractedData.type).toBe('lesson');
    expect(result.value.extractedData.durationMinutes).toBe(90);
    expect(result.value.extractedData.location).toBe('待确认');
  });

  it('解析语音输入时保存音频并转文字', async () => {
    const service = createService();
    const result = await service.parseInput({
      teacherId: TEACHER_ID,
      inputType: 'voice',
      audio: Buffer.from('audio'),
      filename: 'voice.m4a',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.audioFileRef).toContain('voice.m4a');
    expect(result.value.rawInput).toBe('明天下午三点给张三上课');
  });

  it('低置信度时 intent 为空且状态为 pending', async () => {
    const lowProvider: AiProvider = {
      async run(task) {
        if (task.taskType === 'intent_recognition') {
          return { intent: 'schedule_create', confidenceScore: 0.3 };
        }
        return { text: '含糊输入' };
      },
    };
    const service = createAiNoteService({
      prisma,
      aiClient: createAiClient({ provider: lowProvider }),
      storage: createStorage({ rootDir }),
    });

    const result = await service.parseInput({ teacherId: TEACHER_ID, inputType: 'text', text: '随便记一下' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.intent).toBeNull();
    expect(result.value.confidence).toBe('low');
    expect(result.value.status).toBe('pending');
  });
});

describe('aiNoteService.saveNote', () => {
  it('保存 AI 记录', async () => {
    const service = createService();
    const result = await service.saveNote({
      teacherId: TEACHER_ID,
      inputType: 'text',
      rawInput: '记录张三今天状态不错',
      intent: 'lesson_record',
      extractedData: { studentName: '张三' },
      confidence: 'medium',
      pendingFields: ['lessonId'],
      status: 'pending',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rawInput).toBe('记录张三今天状态不错');
    expect(result.value.pendingFields).toEqual(['lessonId']);
  });

  it('缺少 rawInput 返回 VALIDATION_ERROR', async () => {
    const service = createService();
    const result = await service.saveNote({
      teacherId: TEACHER_ID,
      inputType: 'text',
      rawInput: '',
      extractedData: {},
      pendingFields: [],
      status: 'failed',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});
