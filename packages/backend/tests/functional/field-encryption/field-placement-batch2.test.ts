import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createStudentRecordsService } from '../../../src/features/student-records/index.js';
import { createStudentSourceRecordService } from '../../../src/features/student-records/index.js';
import { createAssessmentService } from '../../../src/features/assessments/index.js';
import { createStudentTimelineService } from '../../../src/features/student-timeline/index.js';
import { createAssembleParentFeedbackContextUseCase } from '../../../src/app/use-cases/assemble-parent-feedback-context/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';

/**
 * P8 phase-3 加密落位批2（t12）：StudentRecord（summary/structuredData）+ StudentSourceRecord（rawText）。
 * - setup 已注入测试 ENCRYPTION_KEY → 服务 env 构建 cipher；
 * - 加密往返 / 旧明文双读 / 篡改拒绝 / owner 不变 / 缺钥 SAFETY_BLOCK / 时间线+上下文读路径解密。
 */

const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const TEST_KEY = 'b'.repeat(64);

const TEACHER_A = `teacher_enc2_a_${randomBytes(4).toString('hex')}`;
const TEACHER_B = `teacher_enc2_b_${randomBytes(4).toString('hex')}`;
const STUDENT_A = `student_enc2_a_${randomBytes(4).toString('hex')}`;

let recordsService: ReturnType<typeof createStudentRecordsService>;
let sourcesService: ReturnType<typeof createStudentSourceRecordService>;
let assessmentService: ReturnType<typeof createAssessmentService>;
let timelineService: ReturnType<typeof createStudentTimelineService>;
let assembleUseCase: ReturnType<typeof createAssembleParentFeedbackContextUseCase>;

beforeAll(async () => {
  await prisma.student.create({
    data: { id: STUDENT_A, teacherId: TEACHER_A, name: '加密批2学生', grade: 'grade-1', currentStatus: 'active' },
  });
  recordsService = createStudentRecordsService(prisma);
  sourcesService = createStudentSourceRecordService(prisma);
  assessmentService = createAssessmentService(prisma);
  timelineService = createStudentTimelineService(prisma);
  assembleUseCase = createAssembleParentFeedbackContextUseCase({ prisma });
});

afterAll(async () => {
  // FK 顺序：assessmentDetail(studentRecordId) → studentRecord(sourceRecordId) → source → student
  await prisma.assessmentDetail.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.studentRecord.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.student.deleteMany({ where: { id: STUDENT_A } });
  await prisma.$disconnect();
});

describe('批2 StudentRecord：summary/structuredData 加密往返', () => {
  it('create → DB 密文，get/list 响应解密明文', async () => {
    const created = await recordsService.createRecord({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      category: 'learning_state',
      summary: '批2记录摘要，含成绩描述',
      structuredData: { score: 92, subject: '数学', tags: ['进步'] },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.summary).toBe('批2记录摘要，含成绩描述');
    expect(created.value.structuredData).toEqual({ score: 92, subject: '数学', tags: ['进步'] });

    // DB 是密文
    const row = await prisma.studentRecord.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(row.summary).not.toContain('批2记录摘要');
    expect(row.summary.startsWith('enc:v1:')).toBe(true);
    expect(row.structuredData).not.toEqual({ score: 92 });
    expect(typeof row.structuredData).toBe('string');
    expect(cipher.decrypt(row.summary)).toBe('批2记录摘要，含成绩描述');
    expect(cipher.decryptJson<unknown>(row.structuredData as unknown as string)).toEqual({ score: 92, subject: '数学', tags: ['进步'] });

    // 读路径解密
    const got = await recordsService.getOwnedRecord({ teacherId: TEACHER_A, recordId: created.value.id });
    expect(got.ok && got.value.summary).toBe('批2记录摘要，含成绩描述');
    const list = await recordsService.listRecordsByStudent({ teacherId: TEACHER_A, studentId: STUDENT_A });
    expect(list.ok && list.value.items[0].summary).toBe('批2记录摘要，含成绩描述');
  });

  it('旧明文双读：prisma 直插明文行 → 服务读直通', async () => {
    const legacy = await prisma.studentRecord.create({
      data: {
        teacherId: TEACHER_A,
        studentId: STUDENT_A,
        category: 'general_note',
        summary: '旧明文摘要',
        structuredData: { old: true },
        occurredAtTs: new Date(),
        confidence: 'medium',
        reviewStatus: 'candidate',
        visibility: 'needs_review',
        importance: 'normal',
      },
    });
    const got = await recordsService.getOwnedRecord({ teacherId: TEACHER_A, recordId: legacy.id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.summary).toBe('旧明文摘要');
    expect(got.value.structuredData).toEqual({ old: true });
  });

  it('supersede 替换记录同样加密', async () => {
    const created = await recordsService.createRecord({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      category: 'goal',
      summary: '原目标',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const superseded = await recordsService.supersedeRecord({
      teacherId: TEACHER_A,
      recordId: created.value.id,
      replacement: { category: 'goal', summary: '新目标', occurredAt: new Date() },
    });
    expect(superseded.ok).toBe(true);
    if (!superseded.ok) return;
    expect(superseded.value.summary).toBe('新目标');
    const newRow = await prisma.studentRecord.findUniqueOrThrow({ where: { id: superseded.value.id } });
    expect(cipher.decrypt(newRow.summary)).toBe('新目标');
  });
});

describe('批2 StudentSourceRecord：rawText 加密（contentHash 明文哈希不变）', () => {
  it('captureSource → DB rawText 密文 + contentHash 为明文哈希；服务读解密', async () => {
    const captured = await sourcesService.captureSource({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      sourceType: 'agent_text',
      sourceEntityType: 'ConversationTurn',
      sourceEntityId: 'turn-enc2-1',
      rawText: '批2原始证据文本',
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.value.rawText).toBe('批2原始证据文本');

    // contentHash = sha256(明文)（幂等键语义，设计文档 D2）
    const { createHash } = await import('node:crypto');
    expect(captured.value.contentHash).toBe(createHash('sha256').update('批2原始证据文本').digest('hex'));

    // DB rawText 是密文
    const row = await prisma.studentSourceRecord.findUniqueOrThrow({ where: { id: captured.value.id } });
    expect(row.rawText).not.toBe('批2原始证据文本');
    expect(cipher.decrypt(row.rawText!)).toBe('批2原始证据文本');

    // 读路径解密
    const got = await sourcesService.getOwnedSource({ teacherId: TEACHER_A, sourceRecordId: captured.value.id });
    expect(got.ok && got.value.rawText).toBe('批2原始证据文本');
  });

  it('旧明文双读：prisma 直插明文行 → 服务读直通', async () => {
    const legacy = await prisma.studentSourceRecord.create({
      data: {
        teacherId: TEACHER_A,
        sourceType: 'manual',
        rawText: '旧明文原始文本',
        captureStatus: 'unresolved',
        occurredAtTs: new Date(),
      },
    });
    const got = await sourcesService.getOwnedSource({ teacherId: TEACHER_A, sourceRecordId: legacy.id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.rawText).toBe('旧明文原始文本');
  });

  it('同内容幂等捕获仍生效（contentHash 明文语义未破坏）', async () => {
    const first = await sourcesService.captureSource({
      teacherId: TEACHER_A,
      sourceType: 'agent_text',
      sourceEntityType: 'ConversationTurn',
      sourceEntityId: 'turn-enc2-dedup',
      rawText: '幂等文本',
    });
    expect(first.ok).toBe(true);
    const second = await sourcesService.captureSource({
      teacherId: TEACHER_A,
      sourceType: 'agent_text',
      sourceEntityType: 'ConversationTurn',
      sourceEntityId: 'turn-enc2-dedup',
      rawText: '应被忽略',
    });
    expect(second.ok && second.value.id).toBe(first.ok ? first.value.id : '');
    const count = await prisma.studentSourceRecord.count({
      where: { teacherId: TEACHER_A, sourceEntityType: 'ConversationTurn', sourceEntityId: 'turn-enc2-dedup' },
    });
    expect(count).toBe(1);
  });
});

describe('批2 跨服务写路径（assessment/communication）加密 + 读路径解密', () => {
  it('assessment-service 建成绩：studentRecord.summary 与 sourceRecord.rawText 均密文，读解密', async () => {
    const created = await assessmentService.createScoreRecord({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      subject: '英语',
      score: 88,
      sourceText: '期中英语 88 分',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // summary = subject + score（buildSummary 不含 sourceText）
    expect(created.value.record.summary).toBe('英语 88分');

    const recordRow = await prisma.studentRecord.findUniqueOrThrow({ where: { id: created.value.record.id } });
    expect(cipher.decrypt(recordRow.summary)).toBe('英语 88分');

    const sourceRow = await prisma.studentSourceRecord.findUniqueOrThrow({
      where: { id: created.value.record.sourceRecordId as string },
    });
    expect(cipher.decrypt(sourceRow.rawText!)).toBe('期中英语 88 分');
  });

  it('时间线 + 反馈上下文组装读路径解密（summary/parentConcerns）', async () => {
    const record = await recordsService.createRecord({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      category: 'learning_state',
      summary: '时间线记录摘要',
    });
    expect(record.ok).toBe(true);
    if (!record.ok) return;

    // 确认 reviewStatus/visibility 使其进入上下文（confirmed + parent_shareable）
    await recordsService.reviewRecord({
      teacherId: TEACHER_A,
      recordId: record.value.id,
      reviewStatus: 'confirmed',
      visibility: 'parent_shareable',
    });

    const timeline = await timelineService.getStudentTimeline({ teacherId: TEACHER_A, studentId: STUDENT_A });
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;
    const entry = timeline.value.items.find((item) => item.id === record.value.id);
    expect(entry?.summary).toBe('时间线记录摘要');

    const context = await assembleUseCase.execute({ teacherId: TEACHER_A, studentId: STUDENT_A });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const evidence = context.value.evidence.find((item) => item.id === record.value.id);
    expect(evidence?.summary).toBe('时间线记录摘要');
  });
});

describe('批2 篡改拒绝 + owner 隔离不变', () => {
  it('DB summary 密文被篡改 → 服务读 INTERNAL_ERROR（SAFETY_BLOCK）', async () => {
    const created = await recordsService.createRecord({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      category: 'general_note',
      summary: '篡改测试摘要',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const row = await prisma.studentRecord.findUniqueOrThrow({ where: { id: created.value.id } });
    const original = row.summary;
    const parts = row.summary.split(':');
    parts[4] = Buffer.from('tampered!').toString('base64');
    await prisma.studentRecord.update({ where: { id: created.value.id }, data: { summary: parts.join(':') } });

    try {
      const got = await recordsService.getOwnedRecord({ teacherId: TEACHER_A, recordId: created.value.id });
      expect(got.ok).toBe(false);
      if (got.ok) return;
      expect(got.error.code).toBe('INTERNAL_ERROR');
      expect(got.error.message).toContain('SAFETY_BLOCK');
    } finally {
      await prisma.studentRecord.update({ where: { id: created.value.id }, data: { summary: original } });
    }
  });

  it('owner 隔离不变：跨教师读记录/证据仍 NOT_FOUND', async () => {
    const record = await recordsService.createRecord({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      category: 'general_note',
      summary: '隔离摘要',
    });
    expect(record.ok).toBe(true);
    if (!record.ok) return;
    const crossed = await recordsService.getOwnedRecord({ teacherId: TEACHER_B, recordId: record.value.id });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.code).toBe('NOT_FOUND');
  });
});

describe('批2 ENCRYPTION_KEY 缺省行为', () => {
  it('未配置密钥 → 写路径 SAFETY_BLOCK；旧明文读可用', async () => {
    const originalKey = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      const noKeyRecords = createStudentRecordsService(prisma);
      const noKeySources = createStudentSourceRecordService(prisma);

      // 旧明文行可读
      const legacy = await prisma.studentRecord.create({
        data: {
          teacherId: TEACHER_A,
          studentId: STUDENT_A,
          category: 'general_note',
          summary: '无钥旧明文',
          occurredAtTs: new Date(),
          confidence: 'medium',
          reviewStatus: 'candidate',
          visibility: 'needs_review',
          importance: 'normal',
        },
      });
      const got = await noKeyRecords.getOwnedRecord({ teacherId: TEACHER_A, recordId: legacy.id });
      expect(got.ok && got.value.summary).toBe('无钥旧明文');

      // 写路径拒绝
      const write = await noKeyRecords.createRecord({
        teacherId: TEACHER_A,
        studentId: STUDENT_A,
        category: 'general_note',
        summary: '不应落库',
      });
      expect(write.ok).toBe(false);
      if (write.ok) return;
      expect(write.error.message).toContain('SAFETY_BLOCK');

      const writeSource = await noKeySources.captureSource({
        teacherId: TEACHER_A,
        sourceType: 'manual',
        rawText: '不应落库',
      });
      expect(writeSource.ok).toBe(false);
      if (writeSource.ok) return;
      expect(writeSource.error.message).toContain('SAFETY_BLOCK');
    } finally {
      process.env.ENCRYPTION_KEY = originalKey ?? TEST_KEY;
    }
  });
});
