import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createToolRegistry } from '../../../src/shared/tool-registry/index.js';
import { registerStudentRecordsTools } from '../../../src/app/tools/register-student-records-tools.js';

const prisma = new PrismaClient();
const TEACHER_A = 'test-teacher-student-records-tools-a';
const TEACHER_B = 'test-teacher-student-records-tools-b';

async function cleanup() {
  await prisma.assessmentDetail.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.studentRecord.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
}

async function createStudentFixture(teacherId: string, name: string) {
  return prisma.student.create({
    data: { teacherId, name, grade: '高一', source: 'test' },
  });
}

function createRegistry() {
  const registry = createToolRegistry();
  registerStudentRecordsTools(registry, prisma);
  return registry;
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('学生长期资料库 Agent 工具注册（D40 Phase 1）', () => {
  it('registry.list 包含三个工具且 sideEffect 为 create', () => {
    const registry = createRegistry();
    const tools = registry.list();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.has('students.sources.ingest')).toBe(true);
    expect(byName.has('students.records.capture')).toBe(true);
    expect(byName.has('students.assessments.create')).toBe(true);

    expect(byName.get('students.sources.ingest')?.sideEffect).toBe('create');
    expect(byName.get('students.records.capture')?.sideEffect).toBe('create');
    expect(byName.get('students.assessments.create')?.sideEffect).toBe('create');
  });

  it('students.sources.ingest 含 studentId 创建证据，captureStatus=captured', async () => {
    const student = await createStudentFixture(TEACHER_A, '张三');
    const registry = createRegistry();

    const result = await registry.execute(
      'students.sources.ingest',
      {
        studentId: student.id,
        sourceType: 'agent_text',
        rawText: '课堂表现记录',
      },
      { teacherId: TEACHER_A },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as {
      id: string;
      studentId: string;
      captureStatus: string;
      rawText: string;
    };
    expect(value.captureStatus).toBe('captured');
    expect(value.studentId).toBe(student.id);

    const rows = await prisma.studentSourceRecord.findMany({ where: { teacherId: TEACHER_A } });
    expect(rows).toHaveLength(1);
    expect(rows[0].captureStatus).toBe('captured');
  });

  it('students.sources.ingest 无 studentId 创建待归属证据，captureStatus=unresolved', async () => {
    const registry = createRegistry();

    const result = await registry.execute(
      'students.sources.ingest',
      {
        sourceType: 'manual',
        rawText: '无归属文本',
      },
      { teacherId: TEACHER_A },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { studentId: string | null; captureStatus: string };
    expect(value.captureStatus).toBe('unresolved');
    expect(value.studentId).toBeNull();
  });

  it('students.sources.ingest 非法 sourceType 返回 VALIDATION_ERROR', async () => {
    const registry = createRegistry();

    const result = await registry.execute(
      'students.sources.ingest',
      { sourceType: 'invalid', rawText: 'x' },
      { teacherId: TEACHER_A },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('sourceType');
  });

  it('students.sources.ingest 空 rawText 返回 VALIDATION_ERROR', async () => {
    const registry = createRegistry();

    const result = await registry.execute(
      'students.sources.ingest',
      { sourceType: 'agent_text', rawText: '   ' },
      { teacherId: TEACHER_A },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('rawText');
  });

  it('students.sources.ingest 非法 occurredAt 返回 VALIDATION_ERROR', async () => {
    const registry = createRegistry();

    const result = await registry.execute(
      'students.sources.ingest',
      { sourceType: 'agent_text', rawText: 'x', occurredAt: '2031-02-03T04:05:06' },
      { teacherId: TEACHER_A },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('occurredAt');
  });

  it('students.records.capture 声明 required，direct execute fail-closed 且零写入', async () => {
    const student = await createStudentFixture(TEACHER_A, '李四');
    const registry = createRegistry();
    const definition = registry.list().find((tool) => tool.name === 'students.records.capture');

    expect(definition).toBeDefined();
    expect((definition as { confirmation?: string }).confirmation).toBe('required');

    const result = await registry.execute(
      'students.records.capture',
      {
        studentId: student.id,
        category: 'general_note',
        summary: '本周学习状态稳定',
        sourceText: '课堂观察原始文本',
      },
      { teacherId: TEACHER_A },
    );

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'confirmation' }),
    });
    expect(await prisma.studentSourceRecord.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('students.records.capture 任意参数（parent_communication/非法 category/跨老师）都 fail-closed 且零写入', async () => {
    const student = await createStudentFixture(TEACHER_A, '王五');
    const other = await createStudentFixture(TEACHER_B, '别人学生');
    const registry = createRegistry();

    const parentComm = await registry.execute(
      'students.records.capture',
      { studentId: student.id, category: 'parent_communication', summary: '家长沟通摘要' },
      { teacherId: TEACHER_A },
    );
    expect(parentComm).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'confirmation' }),
    });

    const invalidCategory = await registry.execute(
      'students.records.capture',
      { studentId: student.id, category: 'invalid', summary: 'x', sourceText: '原始文本' },
      { teacherId: TEACHER_A },
    );
    expect(invalidCategory).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'confirmation' }),
    });

    const crossed = await registry.execute(
      'students.records.capture',
      { studentId: other.id, category: 'general_note', summary: '越权' },
      { teacherId: TEACHER_A },
    );
    expect(crossed).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'confirmation' }),
    });

    expect(await prisma.studentSourceRecord.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('students.assessments.create 创建 record + detail', async () => {
    const student = await createStudentFixture(TEACHER_A, '赵六');
    const registry = createRegistry();

    const result = await registry.execute(
      'students.assessments.create',
      {
        studentId: student.id,
        examName: '期中考试',
        subject: '数学',
        score: 92,
        fullScore: 100,
        examDate: '2031-05-10T09:00:00+08:00',
      },
      { teacherId: TEACHER_A },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as {
      record: { id: string; category: string; reviewStatus: string };
      detail: { score: number; fullScore: number; subject: string };
    };
    expect(value.record.category).toBe('assessment');
    expect(value.record.reviewStatus).toBe('candidate');
    expect(value.detail.score).toBe(92);
    expect(value.detail.fullScore).toBe(100);
    expect(value.detail.subject).toBe('数学');

    const detailRow = await prisma.assessmentDetail.findUniqueOrThrow({
      where: { studentRecordId: value.record.id },
    });
    expect(detailRow.score).toBe(92);
  });

  it('students.assessments.create 非法 score<=0 返回 VALIDATION_ERROR', async () => {
    const student = await createStudentFixture(TEACHER_A, '孙七');
    const registry = createRegistry();

    const result = await registry.execute(
      'students.assessments.create',
      { studentId: student.id, examName: '期中考试', score: 0 },
      { teacherId: TEACHER_A },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('score');
  });

  it('跨 teacher 使用他人 studentId 返回 NOT_FOUND', async () => {
    const other = await createStudentFixture(TEACHER_B, '别人学生');
    const registry = createRegistry();

    const ingest = await registry.execute(
      'students.sources.ingest',
      { studentId: other.id, sourceType: 'agent_text', rawText: '越权' },
      { teacherId: TEACHER_A },
    );
    expect(ingest.ok).toBe(false);
    if (ingest.ok) return;
    expect(ingest.error.code).toBe('NOT_FOUND');

    const capture = await registry.execute(
      'students.records.capture',
      { studentId: other.id, category: 'general_note', summary: '越权' },
      { teacherId: TEACHER_A },
    );
    // P29-W1：records.capture 已改 confirmation:required，跨 teacher 也 fail-closed
    expect(capture).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'confirmation' }),
    });

    const assessments = await registry.execute(
      'students.assessments.create',
      { studentId: other.id, examName: '越权' },
      { teacherId: TEACHER_A },
    );
    expect(assessments.ok).toBe(false);
    if (assessments.ok) return;
    expect(assessments.error.code).toBe('NOT_FOUND');
  });
});
