import { err, notFound, ok, validationError } from '@teacher-platform/contracts';
import type { CommonError, Result } from '@teacher-platform/contracts';
import {
  COMMUNICATION_DIRECTIONS,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_PARENT_TYPES,
} from '../../../features/student-communications/types.js';
import type {
  CaptureCommunicationFromTextInput,
  CaptureCommunicationFromTextResult,
  CaptureCommunicationFromTextUseCase,
  CreateCaptureCommunicationFromTextUseCaseOptions,
  CommunicationExtraction,
} from './types.js';

function readOptionalString(value: unknown): string | null {
  if (value == null) return null;
  const str = String(value).trim();
  return str === '' ? null : str;
}

function readConfidence(value: unknown): 'high' | 'medium' | 'low' | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase() as 'high' | 'medium' | 'low';
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  return null;
}

function readWhitelistEnum(value: unknown, allowed: readonly string[]): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (allowed.includes(v)) return v;
  return null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed !== '') result.push(trimmed);
    }
  }
  return result;
}

function readNextContactAt(value: unknown): { ok: true; value: string | null; parsed: Date | undefined } | { ok: false; error: CommonError } {
  if (value == null || value === '') return { ok: true, value: null, parsed: undefined };
  const str = String(value).trim();
  if (str === '') return { ok: true, value: null, parsed: undefined };
  const ms = Date.parse(str);
  if (!Number.isFinite(ms) || Number.isNaN(ms)) {
    return { ok: false, error: validationError('下次联系时间不是有效日期', 'nextContactAt') };
  }
  return { ok: true, value: str, parsed: new Date(ms) };
}

export interface NormalizedCommunicationExtraction {
  extraction: CommunicationExtraction;
  nextContactAtParsed: Date | undefined;
}

export function normalizeCommunicationExtraction(
  raw: Record<string, unknown>,
): Result<NormalizedCommunicationExtraction, CommonError> {
  const direction = readWhitelistEnum(raw.direction, COMMUNICATION_DIRECTIONS) as CommunicationExtraction['direction'];
  const channel = readWhitelistEnum(raw.channel, COMMUNICATION_CHANNELS) as CommunicationExtraction['channel'];
  const parentType = readWhitelistEnum(raw.parentType, COMMUNICATION_PARENT_TYPES) as CommunicationExtraction['parentType'];
  const parentConcerns = readStringArray(raw.parentConcerns);
  const teacherResponses = readStringArray(raw.teacherResponses);
  const agreements = readStringArray(raw.agreements);
  const followUps = readStringArray(raw.followUps);
  const summary = readOptionalString(raw.summary);
  const confidence = readConfidence(raw.confidence);

  const nextContactAtResult = readNextContactAt(raw.nextContactAt);
  if (!nextContactAtResult.ok) return err(nextContactAtResult.error);

  return ok({
    extraction: {
      direction,
      channel,
      parentType,
      parentConcerns,
      teacherResponses,
      agreements,
      followUps,
      nextContactAt: nextContactAtResult.value,
      summary,
      confidence,
    },
    nextContactAtParsed: nextContactAtResult.parsed,
  });
}

export function createCaptureCommunicationFromTextUseCase(
  options: CreateCaptureCommunicationFromTextUseCaseOptions,
): CaptureCommunicationFromTextUseCase {
  const getClient = options.getClient ?? (async () => options.prisma);
  const { aiClient, communications } = options;

  return {
    async execute(input: CaptureCommunicationFromTextInput) {
      const prisma = await getClient();
      // 1. rawText 非空校验
      const rawText = input.rawText.trim();
      if (rawText === '') {
        return err(validationError('原始文字不能为空', 'rawText'));
      }

      // 2. owner 校验（先不调 AI、不写库）
      const student = await prisma.student.findFirst({
        where: { id: input.studentId, teacherId: input.teacherId },
        select: { id: true },
      });
      if (!student) {
        return err(notFound('学生不存在'));
      }

      // 3. 调用 AI 抽取
      const extracted = await aiClient.run({
        taskType: 'information_extraction',
        input: { text: rawText },
      });
      if (!extracted.ok) return extracted;

      // 4. 归一化 AiOutput
      const normalized = normalizeCommunicationExtraction(extracted.value);
      if (!normalized.ok) return normalized;

      const { extraction, nextContactAtParsed } = normalized.value;

      // 5. 前置校验：direction + 四个数组 + summary 全空则报错
      const hasDirection = extraction.direction != null;
      const hasParentConcerns = extraction.parentConcerns != null && extraction.parentConcerns.length > 0;
      const hasTeacherResponses = extraction.teacherResponses != null && extraction.teacherResponses.length > 0;
      const hasAgreements = extraction.agreements != null && extraction.agreements.length > 0;
      const hasFollowUps = extraction.followUps != null && extraction.followUps.length > 0;
      const hasSummary = extraction.summary != null;

      if (!hasDirection && !hasParentConcerns && !hasTeacherResponses && !hasAgreements && !hasFollowUps && !hasSummary) {
        return err(validationError('未能从文字中识别出沟通信息', 'rawText'));
      }

      // 6. 走沟通服务创建记录
      const created = await communications.createCommunicationRecord({
        teacherId: input.teacherId,
        studentId: input.studentId,
        occurredAt: input.occurredAt,
        summary: extraction.summary ?? rawText.slice(0, 200),
        direction: extraction.direction ?? 'two_way',
        channel: extraction.channel ?? undefined,
        parentType: extraction.parentType ?? undefined,
        parentConcerns: extraction.parentConcerns ?? undefined,
        teacherResponses: extraction.teacherResponses ?? undefined,
        agreements: extraction.agreements ?? undefined,
        followUps: extraction.followUps ?? undefined,
        nextContactAtTs: nextContactAtParsed,
        sourceText: input.rawText,
      });
      if (!created.ok) return created;

      // 7. 返回结果
      return ok({
        studentId: input.studentId,
        extraction,
        record: created.value.record,
        detail: created.value.detail,
        sourceRecord: created.value.record.sourceRecordId
          ? { id: created.value.record.sourceRecordId }
          : null,
      } satisfies CaptureCommunicationFromTextResult);
    },
  };
}
