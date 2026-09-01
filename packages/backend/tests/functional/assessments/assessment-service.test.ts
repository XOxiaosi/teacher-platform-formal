import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, internalError } from '@teacher-platform/contracts';
import { createAssessmentService } from '../../../src/features/assessments/assessment-service.js';
import { defaultChangelogFactory, type ChangelogFactory } from '../../../src/shared/changelog/index.js';
import {
  createFieldCipher,
  FIELD_ENCRYPTION_MISSING_KEY_WRITE_MESSAGE,
  loadEncryptionKey,
} from '../../../src/shared/field-encryption/index.js';

const prisma = new PrismaClient();
const service = createAssessmentService(prisma);
// P8 phase-3 批2：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);

const TEACHER_ID = 'test-teacher-assessments';
const OTHER_TEACHER_ID = 'test-teacher-assessments-other';
const AUDIT_SECRET = 'database audit failure detail';
const UNKNOWN_SECRET = 'unknown storage failure detail';

function createAssessmentServiceWithoutKey() {
  const originalKey = process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY;
  try {
    return createAssessmentService(prisma);
  } finally {
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  }
}

function failChangelogAt(failureAt: number): ChangelogFactory {
  let callCount = 0;
  return (client) => {
    const changelog = defaultChangelogFactory(client);
    return {
      async recordChange(input) {
        callCount += 1;
        if (callCount === failureAt) return err(internalError(AUDIT_SECRET));
        return changelog.recordChange(input);
      },
    };
  };
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

describe('assessmentService.createScoreRecord', () => {
  it('创建成绩：record+detail 原子落库，category=assessment，summary 自动拼接', async () => {
    const student = await createStudent(TEACHER_ID, '张三');

    const result = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '数学',
      examName: '期中考试',
      score: 95,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.record.category).toBe('assessment');
    expect(result.value.record.summary).toBe('数学 期中考试 95分');
    expect(result.value.record.studentId).toBe(student.id);
    expect(result.value.detail.studentRecordId).toBe(result.value.record.id);
    expect(result.value.detail.score).toBe(95);

    // 原子落库：record 与 detail 都已持久化且 1:1 关联
    const persistedRecord = await prisma.studentRecord.findUniqueOrThrow({
      where: { id: result.value.record.id },
    });
    expect(persistedRecord.category).toBe('assessment');
    const persistedDetail = await prisma.assessmentDetail.findUniqueOrThrow({
      where: { studentRecordId: result.value.record.id },
    });
    expect(persistedDetail.studentRecordId).toBe(result.value.record.id);
    expect(persistedDetail.subject).toBe('数学');
  });

  it('只给 score：examName/subject 等未知字段保持 null，不补默认', async () => {
    const student = await createStudent(TEACHER_ID, '李四');

    const result = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      score: 90,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.record.summary).toBe('90分');
    expect(result.value.detail.examName).toBeNull();
    expect(result.value.detail.subject).toBeNull();
    expect(result.value.detail.fullScore).toBeNull();
    expect(result.value.detail.examDate).toBeNull();
    expect(result.value.detail.note).toBeNull();
    expect(result.value.detail.score).toBe(90);
  });

  it('带 sourceText 时创建 StudentSourceRecord 并关联 sourceRecordId', async () => {
    const student = await createStudent(TEACHER_ID, '王五');

    const result = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '英语',
      score: 88,
      sourceText: '期中英语 88 分',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.record.sourceRecordId).not.toBeNull();
    const sourceRecord = await prisma.studentSourceRecord.findUniqueOrThrow({
      where: { id: result.value.record.sourceRecordId as string },
    });
    expect(sourceRecord.sourceType).toBe('agent_text');
    // P8 phase-3 批2：rawText 落库为密文，解密后为原文
    expect(sourceRecord.rawText).not.toBe('期中英语 88 分');
    expect(cipher.decrypt(sourceRecord.rawText)).toBe('期中英语 88 分');
    expect(sourceRecord.captureStatus).toBe('captured');
  });

  it.each([1, 2, 3])('第 %i 个审计写入 Err 时创建链整体回滚且不泄露底层错误', async (failureAt) => {
    const student = await createStudent(TEACHER_ID, `创建回滚-${failureAt}`);
    const failingService = createAssessmentService({
      getClient: async () => prisma,
      cipher,
      changelogFactory: failChangelogAt(failureAt),
    });

    const result = await failingService.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '化学',
      score: 91,
      sourceText: '化学成绩 91 分',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(expect.objectContaining({
      code: 'INTERNAL_ERROR',
      message: '创建成绩记录失败',
    }));
    expect(result.error.message).not.toContain(AUDIT_SECRET);
    expect(await prisma.studentSourceRecord.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.assessmentDetail.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('缺少字段加密密钥时创建保留 SAFETY_BLOCK 且整体零写入', async () => {
    const student = await createStudent(TEACHER_ID, '创建缺钥');

    const result = await createAssessmentServiceWithoutKey().createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '化学',
      score: 60,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.message).toBe(FIELD_ENCRYPTION_MISSING_KEY_WRITE_MESSAGE);
    expect(await prisma.studentSourceRecord.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.assessmentDetail.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('创建时未知底层异常固定泛化且不泄露 message', async () => {
    const student = await createStudent(TEACHER_ID, '创建未知异常');
    const unknownCipher = {
      ...cipher,
      encrypt() {
        throw new Error(UNKNOWN_SECRET);
      },
    };
    const unknownFailureService = createAssessmentService({
      getClient: async () => prisma,
      cipher: unknownCipher,
    });

    const result = await unknownFailureService.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '化学',
      score: 61,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(expect.objectContaining({
      code: 'INTERNAL_ERROR',
      message: '创建成绩记录失败',
    }));
    expect(result.error.message).not.toContain(UNKNOWN_SECRET);
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('伪造缺钥 SAFETY_BLOCK 前缀时固定泛化且不泄露后缀', async () => {
    const student = await createStudent(TEACHER_ID, '创建伪造缺钥');
    const prefixCollisionSecret = 'attacker-controlled secret suffix';
    const prefixCollisionCipher = {
      ...cipher,
      encrypt() {
        throw new Error(`${FIELD_ENCRYPTION_MISSING_KEY_WRITE_MESSAGE} ${prefixCollisionSecret}`);
      },
    };
    const prefixCollisionService = createAssessmentService({
      getClient: async () => prisma,
      cipher: prefixCollisionCipher,
    });

    const result = await prefixCollisionService.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '化学',
      score: 62,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(expect.objectContaining({
      code: 'INTERNAL_ERROR',
      message: '创建成绩记录失败',
    }));
    expect(result.error.message).not.toContain(prefixCollisionSecret);
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('至少提供考试名称、科目或分数之一，否则 VALIDATION_ERROR', async () => {
    const student = await createStudent(TEACHER_ID, '赵六');

    const result = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      note: '只有备注',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.message).toBe('至少提供考试名称、科目或分数之一');
  });

  it('score 或 fullScore 若提供必须大于 0', async () => {
    const student = await createStudent(TEACHER_ID, '钱七');

    const zeroScore = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      score: 0,
    });
    expect(zeroScore.ok).toBe(false);
    if (zeroScore.ok) return;
    expect(zeroScore.error.code).toBe('VALIDATION_ERROR');

    const zeroFull = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '数学',
      fullScore: -1,
    });
    expect(zeroFull.ok).toBe(false);
    if (zeroFull.ok) return;
    expect(zeroFull.error.code).toBe('VALIDATION_ERROR');
  });

  it('previousScore 持久化到 AssessmentDetail', async () => {
    const student = await createStudent(TEACHER_ID, '孙八');

    const result = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '物理',
      score: 83,
      previousScore: 76,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.detail.previousScore).toBe(76);

    const persisted = await prisma.assessmentDetail.findUniqueOrThrow({
      where: { studentRecordId: result.value.record.id },
    });
    expect(persisted.previousScore).toBe(76);
  });

  it('previousScore 为负数 → VALIDATION_ERROR', async () => {
    const student = await createStudent(TEACHER_ID, '周九');

    const result = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '物理',
      score: 80,
      previousScore: -1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('previousScore');
  });

  it('owner 隔离：给其他老师的学生建成绩返回 NOT_FOUND', async () => {
    const otherStudent = await createStudent(OTHER_TEACHER_ID, '别人家学生');

    const result = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: otherStudent.id,
      score: 80,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('assessmentService.correctScoreRecord', () => {
  it('纠正后旧记录 superseded，新记录 supersedesId 指向旧记录', async () => {
    const student = await createStudent(TEACHER_ID, '张三');
    const created = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '数学',
      score: 95,
    });
    if (!created.ok) return;

    const corrected = await service.correctScoreRecord({
      teacherId: TEACHER_ID,
      oldRecordId: created.value.record.id,
      subject: '数学',
      score: 98,
    });

    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect(corrected.value.record.supersedesId).toBe(created.value.record.id);
    expect(corrected.value.record.id).not.toBe(created.value.record.id);

    const oldPersisted = await prisma.studentRecord.findUniqueOrThrow({
      where: { id: created.value.record.id },
    });
    expect(oldPersisted.reviewStatus).toBe('superseded');

    // 新记录也带明细
    const newDetail = await prisma.assessmentDetail.findUniqueOrThrow({
      where: { studentRecordId: corrected.value.record.id },
    });
    expect(newDetail.score).toBe(98);
  });

  it.each([1, 2, 3, 4])('第 %i 个审计写入 Err 时纠正链整体回滚且不泄露底层错误', async (failureAt) => {
    const student = await createStudent(TEACHER_ID, `纠正回滚-${failureAt}`);
    const created = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '数学',
      score: 80,
    });
    if (!created.ok) return;
    const baselineLogCount = await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } });

    const failingService = createAssessmentService({
      getClient: async () => prisma,
      cipher,
      changelogFactory: failChangelogAt(failureAt),
    });
    const corrected = await failingService.correctScoreRecord({
      teacherId: TEACHER_ID,
      oldRecordId: created.value.record.id,
      subject: '数学',
      score: 82,
      sourceText: '数学成绩纠正为 82 分',
    });

    expect(corrected.ok).toBe(false);
    if (corrected.ok) return;
    expect(corrected.error).toEqual(expect.objectContaining({
      code: 'INTERNAL_ERROR',
      message: '纠正成绩记录失败',
    }));
    expect(corrected.error.message).not.toContain(AUDIT_SECRET);
    expect((await prisma.studentRecord.findUniqueOrThrow({
      where: { id: created.value.record.id },
    })).reviewStatus).toBe('candidate');
    expect(await prisma.studentSourceRecord.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } })).toBe(1);
    expect(await prisma.assessmentDetail.count({ where: { teacherId: TEACHER_ID } })).toBe(1);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(baselineLogCount);
  });

  it('缺少字段加密密钥时纠正保留 SAFETY_BLOCK 且旧记录不变', async () => {
    const student = await createStudent(TEACHER_ID, '纠正缺钥');
    const created = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '数学',
      score: 80,
    });
    if (!created.ok) return;
    const baselineLogCount = await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } });

    const result = await createAssessmentServiceWithoutKey().correctScoreRecord({
      teacherId: TEACHER_ID,
      oldRecordId: created.value.record.id,
      subject: '数学',
      score: 82,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.message).toBe(FIELD_ENCRYPTION_MISSING_KEY_WRITE_MESSAGE);
    expect((await prisma.studentRecord.findUniqueOrThrow({
      where: { id: created.value.record.id },
    })).reviewStatus).toBe('candidate');
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } })).toBe(1);
    expect(await prisma.assessmentDetail.count({ where: { teacherId: TEACHER_ID } })).toBe(1);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(baselineLogCount);
  });

  it('纠正时未知底层异常固定泛化且不泄露 message', async () => {
    const student = await createStudent(TEACHER_ID, '纠正未知异常');
    const created = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '数学',
      score: 80,
    });
    if (!created.ok) return;
    const unknownCipher = {
      ...cipher,
      encrypt() {
        throw new Error(UNKNOWN_SECRET);
      },
    };
    const unknownFailureService = createAssessmentService({
      getClient: async () => prisma,
      cipher: unknownCipher,
    });

    const result = await unknownFailureService.correctScoreRecord({
      teacherId: TEACHER_ID,
      oldRecordId: created.value.record.id,
      subject: '数学',
      score: 82,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(expect.objectContaining({
      code: 'INTERNAL_ERROR',
      message: '纠正成绩记录失败',
    }));
    expect(result.error.message).not.toContain(UNKNOWN_SECRET);
    expect((await prisma.studentRecord.findUniqueOrThrow({
      where: { id: created.value.record.id },
    })).reviewStatus).toBe('candidate');
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } })).toBe(1);
  });

  it('纠正不存在的记录返回 NOT_FOUND', async () => {
    const result = await service.correctScoreRecord({
      teacherId: TEACHER_ID,
      oldRecordId: 'nonexistent',
      score: 90,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('纠正非 assessment 记录返回 VALIDATION_ERROR', async () => {
    const student = await createStudent(TEACHER_ID, '李四');
    const other = await prisma.studentRecord.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: student.id,
        category: 'general_note',
        occurredAtTs: new Date('2026-01-01T00:00:00.000Z'),
        summary: '普通记录',
        confidence: 'medium',
        reviewStatus: 'candidate',
        visibility: 'needs_review',
        importance: 'normal',
      },
    });

    const result = await service.correctScoreRecord({
      teacherId: TEACHER_ID,
      oldRecordId: other.id,
      score: 90,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('纠正已 superseded 记录返回 VALIDATION_ERROR', async () => {
    const student = await createStudent(TEACHER_ID, '王五');
    const created = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '数学',
      score: 95,
    });
    if (!created.ok) return;
    await service.correctScoreRecord({
      teacherId: TEACHER_ID,
      oldRecordId: created.value.record.id,
      subject: '数学',
      score: 98,
    });

    const again = await service.correctScoreRecord({
      teacherId: TEACHER_ID,
      oldRecordId: created.value.record.id,
      subject: '数学',
      score: 99,
    });

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe('VALIDATION_ERROR');
  });

  it('纠正时 previousScore 覆盖旧值', async () => {
    const student = await createStudent(TEACHER_ID, '吴十');
    const created = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '物理',
      score: 83,
      previousScore: 76,
    });
    if (!created.ok) return;
    expect(created.value.detail.previousScore).toBe(76);

    const corrected = await service.correctScoreRecord({
      teacherId: TEACHER_ID,
      oldRecordId: created.value.record.id,
      subject: '物理',
      score: 85,
      previousScore: 80,
    });

    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect(corrected.value.detail.previousScore).toBe(80);

    const persisted = await prisma.assessmentDetail.findUniqueOrThrow({
      where: { studentRecordId: corrected.value.record.id },
    });
    expect(persisted.previousScore).toBe(80);
  });
});

describe('assessmentService.listByStudent', () => {
  it('按 occurredAtTs 降序返回并带 reviewStatus', async () => {
    const student = await createStudent(TEACHER_ID, '张三');
    const early = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '数学',
      score: 80,
      examDate: new Date('2026-03-01T00:00:00.000Z'),
    });
    const late = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '数学',
      score: 95,
      examDate: new Date('2026-06-01T00:00:00.000Z'),
    });
    if (!early.ok || !late.ok) return;

    const result = await service.listByStudent({
      teacherId: TEACHER_ID,
      studentId: student.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(2);
    expect(result.value.items).toHaveLength(2);
    expect(result.value.items[0].record.id).toBe(late.value.record.id);
    expect(result.value.items[1].record.id).toBe(early.value.record.id);
    expect(result.value.items[0].record.reviewStatus).toBe('candidate');
  });

  it('分页：page/pageSize 生效且 total 为全部数量', async () => {
    const student = await createStudent(TEACHER_ID, '李四');
    for (let i = 0; i < 3; i += 1) {
      await service.createScoreRecord({
        teacherId: TEACHER_ID,
        studentId: student.id,
        subject: '数学',
        score: 80 + i,
        examDate: new Date(`2026-04-0${i + 1}T00:00:00.000Z`),
      });
    }

    const page1 = await service.listByStudent({
      teacherId: TEACHER_ID,
      studentId: student.id,
      page: 1,
      pageSize: 2,
    });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.items).toHaveLength(2);
    expect(page1.value.total).toBe(3);

    const page2 = await service.listByStudent({
      teacherId: TEACHER_ID,
      studentId: student.id,
      page: 2,
      pageSize: 2,
    });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value.items).toHaveLength(1);
    expect(page2.value.total).toBe(3);
  });

  it('不返回其他学生的成绩', async () => {
    const mine = await createStudent(TEACHER_ID, '我的学生');
    const other = await createStudent(TEACHER_ID, '同老师另一学生');
    await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: mine.id,
      subject: '数学',
      score: 90,
    });
    await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: other.id,
      subject: '英语',
      score: 70,
    });

    const result = await service.listByStudent({
      teacherId: TEACHER_ID,
      studentId: mine.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(1);
    expect(result.value.items[0].record.studentId).toBe(mine.id);
  });
});

describe('assessmentService.getOwnedDetail', () => {
  it('返回归属明细', async () => {
    const student = await createStudent(TEACHER_ID, '张三');
    const created = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '数学',
      score: 95,
    });
    if (!created.ok) return;

    const result = await service.getOwnedDetail({
      teacherId: TEACHER_ID,
      studentRecordId: created.value.record.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.score).toBe(95);
    expect(result.value.studentRecordId).toBe(created.value.record.id);
  });

  it('owner 隔离：跨 teacher 查明细返回 NOT_FOUND', async () => {
    const student = await createStudent(TEACHER_ID, '李四');
    const created = await service.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      subject: '数学',
      score: 95,
    });
    if (!created.ok) return;

    const result = await service.getOwnedDetail({
      teacherId: OTHER_TEACHER_ID,
      studentRecordId: created.value.record.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});
