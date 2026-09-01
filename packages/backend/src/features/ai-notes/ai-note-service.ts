import type { Prisma } from '@prisma/client';
import { err, ok, internalError, validationError } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  decryptJsonFieldValue,
  encryptFieldValue,
  encryptJsonFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import type {
  AiConfidence,
  AiIntent,
  AiNoteData,
  AiNoteService,
  CreateAiNoteServiceOptions,
  ParseInputInput,
  SaveAiNoteInput,
} from './types.js';

export function createAiNoteService(options: CreateAiNoteServiceOptions): AiNoteService {
  const getClient = options.getClient ?? (async () => options.prisma);
  // P8 phase-3 批3：AINote rawInput/extractedData 字段加密 cipher（缺省 env 构建）
  const cipher = options.cipher ?? createFieldCipherFromEnv();

  return {
    async parseInput(input: ParseInputInput) {
      const raw = await resolveRawInput(input, options);
      if (!raw.ok) return raw;

      const intent = await options.aiClient.run({ taskType: 'intent_recognition', input: { text: raw.value.rawInput } });
      if (!intent.ok) return intent;

      const extracted = await options.aiClient.run({ taskType: 'information_extraction', input: { text: raw.value.rawInput } });
      if (!extracted.ok) return extracted;

      const score = readScore(intent.value.confidenceScore);
      const confidence = toConfidence(score);
      const data = applyDefaults(extracted.value);
      const pendingFields = detectPendingFields(data, confidence);

      return ok({
        teacherId: input.teacherId,
        inputType: input.inputType,
        rawInput: raw.value.rawInput,
        audioFileRef: raw.value.audioFileRef,
        intent: confidence === 'low' ? null : readIntent(intent.value.intent),
        extractedData: data,
        confidence,
        pendingFields,
        status: pendingFields.length > 0 || confidence === 'low' ? 'pending' : 'processed',
        defaultsApplied: { type: 'lesson', durationMinutes: 90, location: '待确认' },
      });
    },

    async saveNote(input: SaveAiNoteInput) {
      if (!input.rawInput.trim()) {
        return err(validationError('原始输入不能为空', 'rawInput'));
      }

      const prisma = await getClient();
      const trustedClock = createDatabaseTrustedClock(prisma);
      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      try {
        const record = await prisma.aINote.create({
          data: {
            teacherId: input.teacherId,
            inputType: input.inputType,
            rawInput: encryptFieldValue(cipher, input.rawInput),
            audioFileRef: input.audioFileRef ?? null,
            intent: input.intent ?? null,
            extractedData: (encryptJsonFieldValue(cipher, input.extractedData ?? {}) as unknown) as Prisma.InputJsonValue,
            confidence: input.confidence ?? null,
            pendingFields: input.pendingFields as Prisma.InputJsonValue,
            status: input.status,
            routedTo: input.routedTo ?? null,
            routedModuleId: input.routedModuleId ?? null,
            createdAtTs: now.value,
            updatedAtTs: now.value,
          },
        });
        return ok(toAiNoteData(record, cipher));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`保存 AI 笔记失败：${message}`));
      }
    },
  };
}

async function resolveRawInput(input: ParseInputInput, options: CreateAiNoteServiceOptions) {
  if (input.inputType === 'text') {
    if (!input.text?.trim()) return err(validationError('文字输入不能为空', 'text'));
    return ok({ rawInput: input.text, audioFileRef: null });
  }
  if (!input.audio || !input.filename) return err(validationError('语音输入缺少音频或文件名', 'audio'));

  const saved = await options.storage.save({ filename: input.filename, content: input.audio, directory: 'audio' });
  if (!saved.ok) return saved;
  const transcribed = await options.aiClient.run({ taskType: 'speech_to_text', input: { audioFileRef: saved.value.fileRef } });
  if (!transcribed.ok) return transcribed;
  return ok({ rawInput: String(transcribed.value.text ?? ''), audioFileRef: saved.value.fileRef });
}

function applyDefaults(data: Record<string, unknown>): Record<string, unknown> {
  return {
    type: data.type ?? 'lesson',
    durationMinutes: data.durationMinutes ?? 90,
    location: data.location ?? '待确认',
    ...data,
  };
}

function detectPendingFields(data: Record<string, unknown>, confidence: AiConfidence): string[] {
  if (confidence === 'low') return ['confirmation'];
  const fields: string[] = [];
  if (!data.studentName) fields.push('studentName');
  if (!data.timeText && data.intent === 'schedule_create') fields.push('timeText');
  return fields;
}

function toConfidence(score: number): AiConfidence {
  if (score >= 0.8) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

function readScore(value: unknown): number {
  return typeof value === 'number' ? value : 0.5;
}

function readIntent(value: unknown): AiIntent | null {
  return typeof value === 'string' ? (value as AiIntent) : null;
}

function toAiNoteData(r: any, cipher: FieldCipher | undefined): AiNoteData {
  return {
    id: r.id,
    teacherId: r.teacherId,
    inputType: r.inputType,
    rawInput: decryptFieldValue(cipher, r.rawInput),
    audioFileRef: r.audioFileRef,
    intent: r.intent,
    extractedData: (decryptJsonFieldValue(cipher, r.extractedData) ?? {}) as Record<string, unknown>,
    confidence: r.confidence,
    pendingFields: Array.isArray(r.pendingFields) ? r.pendingFields : [],
    status: r.status,
    routedTo: r.routedTo,
    routedModuleId: r.routedModuleId,
    createdAt: r.createdAtTs,
    updatedAt: r.updatedAtTs,
  };
}
