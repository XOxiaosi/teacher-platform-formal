import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, internalError } from '@teacher-platform/contracts';
import { createStudentRecordsService } from '../../../src/features/student-records/student-record-service.js';
import {
  createChangelogService,
  type ChangelogFactory,
} from '../../../src/shared/changelog/index.js';

const prisma = new PrismaClient();
const service = createStudentRecordsService(prisma);

const TEACHER_ID = 'test-teacher-rec-records';
const OTHER_TEACHER_ID = 'other-teacher-rec-records';
const AUDIT_FAILURE_PUBLIC_MESSAGE = '审计日志写入失败';

const failingChangelogFactory: ChangelogFactory = () => ({
  async recordChange() {
    return err(internalError('sensitive database failure'));
  },
});

async function createStudent(teacherId: string, name: string): Promise<string> {
  const student = await prisma.student.create({
    data: { teacherId, name, grade: '高三' },
  });
  return student.id;
}

async function createSource(
  teacherId: string,
  studentId?: string,
  sourceEntityType?: string,
  sourceEntityId?: string,
) {
  const now = new Date();
  return prisma.studentSourceRecord.create({
    data: {
      teacherId,
      studentId: studentId ?? null,
      sourceType: 'manual',
      sourceEntityType: sourceEntityType ?? null,
      sourceEntityId: sourceEntityId ?? null,
      occurredAtTs: now,
      rawText: '证据文本',
      contentHash: 'hash',
      captureStatus: studentId ? 'captured' : 'unresolved',
      createdAtTs: now,
      updatedAtTs: now,
    },
  });
}

async function cleanup() {
  await prisma.studentRecord.deleteMany({
    where: { teacherId: { in: [TEACHER_ID, OTHER_TEACHER_ID] } },
  });
  await prisma.studentSourceRecord.deleteMany({
    where: { teacherId: { in: [TEACHER_ID, OTHER_TEACHER_ID] } },
  });
  await prisma.student.deleteMany({
    where: { teacherId: { in: [TEACHER_ID, OTHER_TEACHER_ID] } },
  });
  await prisma.changeLog.deleteMany({
    where: { teacherId: { in: [TEACHER_ID, OTHER_TEACHER_ID] } },
  });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('studentRecordsService.createRecord', () => {
  it('创建记录：reviewStatus=candidate 且默认字段正确 + 写入 ChangeLog', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');

    const result = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '本周学习状态稳定',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reviewStatus).toBe('candidate');
    expect(result.value.confidence).toBe('medium');
    expect(result.value.visibility).toBe('needs_review');
    expect(result.value.importance).toBe('normal');
    expect(result.value.studentId).toBe(studentId);
    expect(result.value.structuredData).toBeNull();

    const log = await prisma.changeLog.findFirst({
      where: { teacherId: TEACHER_ID, module: 'student-records', targetId: result.value.id },
    });
    expect(log).not.toBeNull();
    expect(log!.action).toBe('create');
    expect(log!.targetType).toBe('StudentRecord');
    expect(log!.source).toBe('manual');
  });

  it('携带 sourceRecordId 与 structuredData', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const source = await createSource(TEACHER_ID, studentId);

    const result = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'assessment',
      summary: '期中数学 92 分',
      sourceRecordId: source.id,
      structuredData: { score: 92, subject: '数学' },
      confidence: 'high',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceRecordId).toBe(source.id);
    expect(result.value.structuredData).toEqual({ score: 92, subject: '数学' });
    expect(result.value.confidence).toBe('high');
  });

  it('非法 category 返回 VALIDATION_ERROR', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const result = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'bogus' as never,
      summary: '摘要',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('拒绝通过通用服务创建 parent_communication 记录', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const result = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'parent_communication',
      summary: '家长沟通摘要',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'category' });
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('非法 confidence/visibility/importance 返回 VALIDATION_ERROR', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');

    const badConfidence = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '摘要',
      confidence: 'bogus' as never,
    });
    expect(badConfidence.ok).toBe(false);
    if (!badConfidence.ok) expect(badConfidence.error.code).toBe('VALIDATION_ERROR');

    const badVisibility = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '摘要',
      visibility: 'bogus' as never,
    });
    expect(badVisibility.ok).toBe(false);
    if (!badVisibility.ok) expect(badVisibility.error.code).toBe('VALIDATION_ERROR');

    const badImportance = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '摘要',
      importance: 'bogus' as never,
    });
    expect(badImportance.ok).toBe(false);
    if (!badImportance.ok) expect(badImportance.error.code).toBe('VALIDATION_ERROR');
  });

  it('studentId 不属于 teacher 返回 NOT_FOUND', async () => {
    const otherStudentId = await createStudent(OTHER_TEACHER_ID, '别人的学生');
    const result = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId: otherStudentId,
      category: 'general_note',
      summary: '摘要',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('sourceRecordId 不存在返回 NOT_FOUND', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const result = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '摘要',
      sourceRecordId: 'nonexistent-source',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('sourceRecord 归属学生不匹配返回 VALIDATION_ERROR', async () => {
    const studentA = await createStudent(TEACHER_ID, '张三');
    const studentB = await createStudent(TEACHER_ID, '李四');
    const source = await createSource(TEACHER_ID, studentA);

    const result = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId: studentB,
      category: 'general_note',
      summary: '摘要',
      sourceRecordId: source.id,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('ChangeLog 返回 Err 时回滚新记录并隐藏底层错误', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const failingService = createStudentRecordsService({
      getClient: async () => prisma,
      changelogFactory: failingChangelogFactory,
    });

    const result = await failingService.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '不得落库',
    });

    expect(result).toEqual(err(internalError(AUDIT_FAILURE_PUBLIC_MESSAGE)));
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });
});

describe('studentRecordsService.getOwnedRecord', () => {
  it('owner 隔离：跨 teacher 查询返回 NOT_FOUND', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const created = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '我的记录',
    });
    if (!created.ok) return;

    const result = await service.getOwnedRecord({
      teacherId: OTHER_TEACHER_ID,
      recordId: created.value.id,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('studentRecordsService.listRecordsByStudent', () => {
  it('按学生返回记录，occurredAt 倒序', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const older = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '较早记录',
      occurredAt: new Date('2024-01-01T00:00:00Z'),
    });
    const newer = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '较新记录',
      occurredAt: new Date('2024-03-01T00:00:00Z'),
    });
    if (!older.ok || !newer.ok) return;

    const result = await service.listRecordsByStudent({ teacherId: TEACHER_ID, studentId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(2);
    expect(result.value.items.map((item) => item.id)).toEqual([newer.value.id, older.value.id]);
  });
});

describe('studentRecordsService.reviewRecord', () => {
  it('candidate -> confirmed 合法，写入 ChangeLog update', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const created = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '待审核记录',
    });
    if (!created.ok) return;

    const result = await service.reviewRecord({
      teacherId: TEACHER_ID,
      recordId: created.value.id,
      reviewStatus: 'confirmed',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reviewStatus).toBe('confirmed');

    const log = await prisma.changeLog.findFirst({
      where: {
        teacherId: TEACHER_ID,
        module: 'student-records',
        targetId: created.value.id,
        action: 'update',
      },
    });
    expect(log).not.toBeNull();
  });

  it('同一教师下 studentId 与 recordId 路径错配返回 NOT_FOUND', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const otherStudentId = await createStudent(TEACHER_ID, '李四');
    const created = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '待审核记录',
    });
    if (!created.ok) return;

    const result = await service.reviewRecord({
      teacherId: TEACHER_ID,
      studentId: otherStudentId,
      recordId: created.value.id,
      reviewStatus: 'confirmed',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    const unchanged = await prisma.studentRecord.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(unchanged.reviewStatus).toBe('candidate');
  });

  it('非法流转（confirmed -> confirmed）返回 VALIDATION_ERROR', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const created = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '记录',
    });
    if (!created.ok) return;
    await service.reviewRecord({
      teacherId: TEACHER_ID,
      recordId: created.value.id,
      reviewStatus: 'confirmed',
    });

    const result = await service.reviewRecord({
      teacherId: TEACHER_ID,
      recordId: created.value.id,
      reviewStatus: 'confirmed',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('非法 visibility 返回 VALIDATION_ERROR', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const created = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '记录',
    });
    if (!created.ok) return;

    const result = await service.reviewRecord({
      teacherId: TEACHER_ID,
      recordId: created.value.id,
      reviewStatus: 'confirmed',
      visibility: 'bogus' as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('expectedUpdatedAt 匹配时审核成功', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const created = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '记录',
    });
    if (!created.ok) return;

    const result = await service.reviewRecord({
      teacherId: TEACHER_ID,
      recordId: created.value.id,
      reviewStatus: 'confirmed',
      expectedUpdatedAt: created.value.updatedAt.toISOString(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reviewStatus).toBe('confirmed');
  });

  it('expectedUpdatedAt 不匹配返回 VERSION_CONFLICT', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const created = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '记录',
    });
    if (!created.ok) return;

    const stale = new Date(created.value.updatedAt.getTime() - 1000).toISOString();
    const result = await service.reviewRecord({
      teacherId: TEACHER_ID,
      recordId: created.value.id,
      reviewStatus: 'confirmed',
      expectedUpdatedAt: stale,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VERSION_CONFLICT');
  });

  it('expectedUpdatedAt 非带时区 RFC3339 返回 VALIDATION_ERROR', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const created = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '记录',
    });
    if (!created.ok) return;

    const result = await service.reviewRecord({
      teacherId: TEACHER_ID,
      recordId: created.value.id,
      reviewStatus: 'confirmed',
      expectedUpdatedAt: '2024-01-01T00:00:00',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('ChangeLog 返回 Err 时回滚审核状态并隐藏底层错误', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const created = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '待审核记录',
    });
    if (!created.ok) return;
    const logsBefore = await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } });
    const failingService = createStudentRecordsService({
      getClient: async () => prisma,
      changelogFactory: failingChangelogFactory,
    });

    const result = await failingService.reviewRecord({
      teacherId: TEACHER_ID,
      recordId: created.value.id,
      reviewStatus: 'confirmed',
    });

    expect(result).toEqual(err(internalError(AUDIT_FAILURE_PUBLIC_MESSAGE)));
    const unchanged = await prisma.studentRecord.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(unchanged.reviewStatus).toBe('candidate');
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(logsBefore);
  });
});

describe('studentRecordsService.supersedeRecord', () => {
  it('取代后旧记录标记为 superseded，新记录 supersedesId 指向旧记录，写两条 ChangeLog', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const created = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '旧摘要',
    });
    if (!created.ok) return;

    const result = await service.supersedeRecord({
      teacherId: TEACHER_ID,
      recordId: created.value.id,
      replacement: { category: 'general_note', summary: '新摘要' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.id).not.toBe(created.value.id);
    expect(result.value.supersedesId).toBe(created.value.id);
    expect(result.value.studentId).toBe(studentId);
    expect(result.value.summary).toBe('新摘要');

    const oldRecord = await prisma.studentRecord.findUnique({
      where: { id: created.value.id },
    });
    expect(oldRecord).not.toBeNull();
    expect(oldRecord!.reviewStatus).toBe('superseded');

    const updateLog = await prisma.changeLog.findFirst({
      where: {
        teacherId: TEACHER_ID,
        module: 'student-records',
        targetId: created.value.id,
        action: 'update',
      },
    });
    expect(updateLog).not.toBeNull();

    const createLog = await prisma.changeLog.findFirst({
      where: {
        teacherId: TEACHER_ID,
        module: 'student-records',
        targetId: result.value.id,
        action: 'create',
      },
    });
    expect(createLog).not.toBeNull();
  });

  it('拒绝通过通用服务取代为 parent_communication 记录', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const created = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '旧摘要',
    });
    if (!created.ok) return;

    const result = await service.supersedeRecord({
      teacherId: TEACHER_ID,
      recordId: created.value.id,
      replacement: { category: 'parent_communication', summary: '家长沟通摘要' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'category' });
    const unchanged = await prisma.studentRecord.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(unchanged.reviewStatus).toBe('candidate');
  });

  it('旧记录不存在返回 NOT_FOUND', async () => {
    const result = await service.supersedeRecord({
      teacherId: TEACHER_ID,
      recordId: 'nonexistent-record',
      replacement: { category: 'general_note', summary: '新摘要' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('第一条 ChangeLog 返回 Err 时回滚旧状态与新记录', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const created = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '旧摘要',
    });
    if (!created.ok) return;
    const logsBefore = await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } });
    let auditCalls = 0;
    const failFirstAudit: ChangelogFactory = () => ({
      async recordChange() {
        auditCalls += 1;
        return err(internalError('sensitive first audit failure'));
      },
    });
    const failingService = createStudentRecordsService({
      getClient: async () => prisma,
      changelogFactory: failFirstAudit,
    });

    const result = await failingService.supersedeRecord({
      teacherId: TEACHER_ID,
      recordId: created.value.id,
      replacement: { category: 'general_note', summary: '不得落库的新摘要' },
    });

    expect(result).toEqual(err(internalError(AUDIT_FAILURE_PUBLIC_MESSAGE)));
    expect(auditCalls).toBe(1);
    const unchanged = await prisma.studentRecord.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(unchanged.reviewStatus).toBe('candidate');
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } })).toBe(1);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(logsBefore);
  });

  it('第二条 ChangeLog 返回 Err 时回滚旧状态、新记录与首条日志', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const created = await service.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '旧摘要',
    });
    if (!created.ok) return;
    const logsBefore = await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } });
    let auditCalls = 0;
    const failSecondAudit: ChangelogFactory = (client) => ({
      async recordChange(input) {
        auditCalls += 1;
        if (auditCalls === 2) return err(internalError('sensitive second audit failure'));
        return createChangelogService(client).recordChange(input);
      },
    });
    const failingService = createStudentRecordsService({
      getClient: async () => prisma,
      changelogFactory: failSecondAudit,
    });

    const result = await failingService.supersedeRecord({
      teacherId: TEACHER_ID,
      recordId: created.value.id,
      replacement: { category: 'general_note', summary: '不得落库的新摘要' },
    });

    expect(result).toEqual(err(internalError(AUDIT_FAILURE_PUBLIC_MESSAGE)));
    expect(auditCalls).toBe(2);
    const unchanged = await prisma.studentRecord.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(unchanged.reviewStatus).toBe('candidate');
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } })).toBe(1);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(logsBefore);
  });
});
