import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, ok, internalError } from '@teacher-platform/contracts';
import { createAssessmentService } from '../../../src/features/assessments/assessment-service.js';
import {
  createCaptureScoreFromTextUseCase,
  normalizeExtraction,
} from '../../../src/app/use-cases/capture-score-from-text/capture-score-from-text-use-case.js';
import type { AiClient, AiOutput } from '../../../src/shared/ai-client/types.js';

const prisma = new PrismaClient();
const assessments = createAssessmentService(prisma);

const TEACHER_ID = 'test-teacher-capture-score';
const OTHER_TEACHER_ID = 'test-teacher-capture-score-other';

function mockAiClient(response: () => ReturnType<AiClient['run']>) {
  const run = vi.fn(response);
  const client: AiClient = {
    run,
    chat: vi.fn(),
  };
  return { client, run };
}

async function createStudent(teacherId: string, name: string) {
  return prisma.student.create({
    data: { teacherId, name, grade: '高三' },
  });
}

async function cleanup() {
  const teacherIds = { in: [TEACHER_ID, OTHER_TEACHER_ID] };
  await prisma.assessmentDetail.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.studentRecord.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.changeLog.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.student.deleteMany({ where: { teacherId: teacherIds } });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('captureScoreFromText.execute', () => {
  it('成功：AI 返回完整成绩字段，建出 record+detail+sourceRecord，previousScore 持久化', async () => {
    const student = await createStudent(TEACHER_ID, '张三');
    const aiOutput: AiOutput = {
      examName: '月考',
      subject: '物理',
      score: 83,
      fullScore: 100,
      previousScore: 76,
    };
    const { client, run } = mockAiClient(() => Promise.resolve(ok(aiOutput)));
    const useCase = createCaptureScoreFromTextUseCase({ prisma, aiClient: client, assessments });

    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      studentId: student.id,
      rawText: '这次月考物理83分，上次76分',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.value.studentId).toBe(student.id);
    expect(result.value.extraction.examName).toBe('月考');
    expect(result.value.extraction.subject).toBe('物理');
    expect(result.value.extraction.score).toBe(83);
    expect(result.value.extraction.fullScore).toBe(100);
    expect(result.value.extraction.previousScore).toBe(76);

    expect(result.value.detail.previousScore).toBe(76);
    expect(result.value.detail.score).toBe(83);
    expect(result.value.record.sourceRecordId).not.toBeNull();
    expect(result.value.sourceRecord).not.toBeNull();
    expect(result.value.sourceRecord?.id).toBe(result.value.record.sourceRecordId);
  });

  it('owner 隔离：别的老师的 studentId → NOT_FOUND，且 aiClient.run 未被调用', async () => {
    const otherStudent = await createStudent(OTHER_TEACHER_ID, '别家学生');
    const { client, run } = mockAiClient(() => Promise.resolve(ok({})));
    const useCase = createCaptureScoreFromTextUseCase({ prisma, aiClient: client, assessments });

    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      studentId: otherStudent.id,
      rawText: '物理 80 分',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(run).not.toHaveBeenCalled();
  });

  it('rawText 空 → VALIDATION_ERROR，不调用 AI', async () => {
    const student = await createStudent(TEACHER_ID, '李四');
    const { client, run } = mockAiClient(() => Promise.resolve(ok({})));
    const useCase = createCaptureScoreFromTextUseCase({ prisma, aiClient: client, assessments });

    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      studentId: student.id,
      rawText: '   ',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('rawText');
    expect(run).not.toHaveBeenCalled();
  });

  it('AI 返回 score 为负数 → VALIDATION_ERROR', async () => {
    const student = await createStudent(TEACHER_ID, '王五');
    const aiOutput: AiOutput = { subject: '物理', score: -5 };
    const { client } = mockAiClient(() => Promise.resolve(ok(aiOutput)));
    const useCase = createCaptureScoreFromTextUseCase({ prisma, aiClient: client, assessments });

    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      studentId: student.id,
      rawText: '物理 -5 分',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('AI 返回 score 为非数字字符串 → VALIDATION_ERROR', async () => {
    const student = await createStudent(TEACHER_ID, '孙六');
    const aiOutput: AiOutput = { subject: '物理', score: 'abc' };
    const { client } = mockAiClient(() => Promise.resolve(ok(aiOutput)));
    const useCase = createCaptureScoreFromTextUseCase({ prisma, aiClient: client, assessments });

    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      studentId: student.id,
      rawText: '物理 abc 分',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('AI 返回 examDate 不是有效日期 → VALIDATION_ERROR', async () => {
    const student = await createStudent(TEACHER_ID, '周七');
    const aiOutput: AiOutput = { subject: '物理', score: 80, examDate: '不是日期' };
    const { client } = mockAiClient(() => Promise.resolve(ok(aiOutput)));
    const useCase = createCaptureScoreFromTextUseCase({ prisma, aiClient: client, assessments });

    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      studentId: student.id,
      rawText: '物理 80 分',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('examDate');
  });

  it('AI 全部为空（examName/subject/score 全无）→ VALIDATION_ERROR，不写记录', async () => {
    const student = await createStudent(TEACHER_ID, '吴八');
    const beforeCount = await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } });
    const aiOutput: AiOutput = { note: '随便说说' };
    const { client } = mockAiClient(() => Promise.resolve(ok(aiOutput)));
    const useCase = createCaptureScoreFromTextUseCase({ prisma, aiClient: client, assessments });

    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      studentId: student.id,
      rawText: '今天状态不错',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('rawText');

    const afterCount = await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } });
    expect(afterCount).toBe(beforeCount);
  });

  it('aiClient.run 返回 internalError → 原样返回错误，不写库', async () => {
    const student = await createStudent(TEACHER_ID, '郑九');
    const beforeCount = await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } });
    const { client } = mockAiClient(() => Promise.resolve(err(internalError('AI 调用失败'))));
    const useCase = createCaptureScoreFromTextUseCase({ prisma, aiClient: client, assessments });

    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      studentId: student.id,
      rawText: '物理 80 分',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.message).toBe('AI 调用失败');

    const afterCount = await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } });
    expect(afterCount).toBe(beforeCount);
  });
});

describe('normalizeExtraction 纯函数', () => {
  it('score 数字字符串 "83" 能转成 83', () => {
    const result = normalizeExtraction({ score: '83' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extraction.score).toBe(83);
  });

  it('score 为 null 保持 null', () => {
    const result = normalizeExtraction({ score: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extraction.score).toBeNull();
  });

  it('score 为 0 → VALIDATION_ERROR', () => {
    const result = normalizeExtraction({ score: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('fullScore 数字字符串 "100" 转成 100', () => {
    const result = normalizeExtraction({ fullScore: '100' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extraction.fullScore).toBe(100);
  });

  it('previousScore 数字字符串 "76" 转成 76', () => {
    const result = normalizeExtraction({ previousScore: '76' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extraction.previousScore).toBe(76);
  });

  it('previousScore 为负数 → VALIDATION_ERROR', () => {
    const result = normalizeExtraction({ previousScore: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('examDate 为有效 RFC3339 字符串 → 保留原值且 parsed 为 Date', () => {
    const result = normalizeExtraction({ examDate: '2024-01-15T10:00:00Z' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extraction.examDate).toBe('2024-01-15T10:00:00Z');
    expect(result.value.examDateParsed).toBeInstanceOf(Date);
    expect(result.value.examDateParsed?.toISOString()).toBe('2024-01-15T10:00:00.000Z');
  });

  it('examDate 为无效字符串 → VALIDATION_ERROR', () => {
    const result = normalizeExtraction({ examDate: 'not-a-date' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('examDate');
  });

  it('字符串字段 trim', () => {
    const result = normalizeExtraction({ examName: ' 月考 ', subject: ' 物理 ', note: ' 备注 ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extraction.examName).toBe('月考');
    expect(result.value.extraction.subject).toBe('物理');
    expect(result.value.extraction.note).toBe('备注');
  });

  it('confidence 合法值原样保留，非法值变 null', () => {
    const r1 = normalizeExtraction({ confidence: 'high' });
    expect(r1.ok && r1.value.extraction.confidence).toBe('high');

    const r2 = normalizeExtraction({ confidence: 'unknown' });
    expect(r2.ok && r2.value.extraction.confidence).toBeNull();

    const r3 = normalizeExtraction({ confidence: null });
    expect(r3.ok && r3.value.extraction.confidence).toBeNull();
  });

  it('空对象返回全 null', () => {
    const result = normalizeExtraction({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extraction.examName).toBeNull();
    expect(result.value.extraction.subject).toBeNull();
    expect(result.value.extraction.score).toBeNull();
    expect(result.value.extraction.fullScore).toBeNull();
    expect(result.value.extraction.previousScore).toBeNull();
    expect(result.value.extraction.examDate).toBeNull();
  });
});
