import { err, notFound, ok, validationError } from '@teacher-platform/contracts';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type {
  CaptureScoreFromTextInput,
  CaptureScoreFromTextResult,
  CaptureScoreFromTextUseCase,
  CreateCaptureScoreFromTextUseCaseOptions,
  ScoreExtraction,
} from './types.js';

function readOptionalString(value: unknown): string | null {
  if (value == null) return null;
  const str = String(value).trim();
  return str === '' ? null : str;
}

function readPositiveNumber(value: unknown): { ok: true; value: number | null } | { ok: false; error: CommonError } {
  if (value == null || value === '') return { ok: true, value: null };
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, error: validationError('分数必须是正数', 'score') };
  }
  return { ok: true, value: num };
}

function readExamDate(value: unknown): { ok: true; value: string | null; parsed: Date | undefined } | { ok: false; error: CommonError } {
  if (value == null || value === '') return { ok: true, value: null, parsed: undefined };
  const str = String(value).trim();
  if (str === '') return { ok: true, value: null, parsed: undefined };
  const ms = Date.parse(str);
  if (!Number.isFinite(ms) || Number.isNaN(ms)) {
    return { ok: false, error: validationError('考试日期不是有效日期', 'examDate') };
  }
  return { ok: true, value: str, parsed: new Date(ms) };
}

function readConfidence(value: unknown): 'high' | 'medium' | 'low' | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase() as 'high' | 'medium' | 'low';
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  return null;
}

export interface NormalizedExtraction {
  extraction: ScoreExtraction;
  examDateParsed: Date | undefined;
}

export function normalizeExtraction(raw: Record<string, unknown>): Result<NormalizedExtraction, CommonError> {
  const studentName = readOptionalString(raw.studentName);
  const examName = readOptionalString(raw.examName);
  const subject = readOptionalString(raw.subject);
  const note = readOptionalString(raw.note);
  const confidence = readConfidence(raw.confidence);

  const scoreResult = readPositiveNumber(raw.score);
  if (!scoreResult.ok) return err(scoreResult.error);

  const fullScoreResult = readPositiveNumber(raw.fullScore);
  if (!fullScoreResult.ok) return err(fullScoreResult.error);

  const previousScoreResult = readPositiveNumber(raw.previousScore);
  if (!previousScoreResult.ok) return err(previousScoreResult.error);

  const examDateResult = readExamDate(raw.examDate);
  if (!examDateResult.ok) return err(examDateResult.error);

  return ok({
    extraction: {
      studentName,
      examName,
      subject,
      score: scoreResult.value,
      fullScore: fullScoreResult.value,
      examDate: examDateResult.value,
      previousScore: previousScoreResult.value,
      note,
      confidence,
    },
    examDateParsed: examDateResult.parsed,
  });
}

export function createCaptureScoreFromTextUseCase(
  options: CreateCaptureScoreFromTextUseCaseOptions,
): CaptureScoreFromTextUseCase {
  const getClient = options.getClient ?? (async () => options.prisma);
  const { aiClient, assessments } = options;

  return {
    async execute(input: CaptureScoreFromTextInput) {
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
      const normalized = normalizeExtraction(extracted.value);
      if (!normalized.ok) return normalized;

      const { extraction, examDateParsed } = normalized.value;

      // 5. 前置校验：三者全空则报错
      const hasAny = extraction.examName != null || extraction.subject != null || extraction.score != null;
      if (!hasAny) {
        return err(validationError('未能从文字中识别出成绩信息', 'rawText'));
      }

      // 6. 走成绩服务创建记录
      const created = await assessments.createScoreRecord({
        teacherId: input.teacherId,
        studentId: input.studentId,
        examName: extraction.examName ?? undefined,
        subject: extraction.subject ?? undefined,
        score: extraction.score ?? undefined,
        fullScore: extraction.fullScore ?? undefined,
        examDate: examDateParsed,
        previousScore: extraction.previousScore ?? undefined,
        note: extraction.note ?? undefined,
        occurredAt: input.occurredAt,
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
      } satisfies CaptureScoreFromTextResult);
    },
  };
}
