import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { err, internalError } from '@teacher-platform/contracts';
import { createStudentSourceRecordService } from '../../../src/features/student-records/student-source-record-service.js';
import type { ChangelogFactory } from '../../../src/shared/changelog/index.js';

const prisma = new PrismaClient();
const service = createStudentSourceRecordService(prisma);

const TEACHER_ID = 'test-teacher-src-records';
const OTHER_TEACHER_ID = 'other-teacher-src-records';
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

async function cleanup() {
  await prisma.studentRecord.deleteMany({ where: { teacherId: { in: [TEACHER_ID, OTHER_TEACHER_ID] } } });
  await prisma.studentSourceRecord.deleteMany({
    where: { teacherId: { in: [TEACHER_ID, OTHER_TEACHER_ID] } },
  });
  await prisma.student.deleteMany({ where: { teacherId: { in: [TEACHER_ID, OTHER_TEACHER_ID] } } });
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: [TEACHER_ID, OTHER_TEACHER_ID] } } });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('studentSourceRecordService.captureSource', () => {
  it('带 studentId：captureStatus=captured 且计算 sha256 contentHash', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');

    const result = await service.captureSource({
      teacherId: TEACHER_ID,
      studentId,
      sourceType: 'agent_text',
      rawText: '课堂表现积极',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.captureStatus).toBe('captured');
    expect(result.value.studentId).toBe(studentId);
    expect(result.value.contentHash).toBe(
      createHash('sha256').update('课堂表现积极').digest('hex'),
    );
    expect(result.value.occurredAt).toBeInstanceOf(Date);
    expect(result.value.createdAt).toBeInstanceOf(Date);
  });

  it('无 studentId：captureStatus=unresolved', async () => {
    const result = await service.captureSource({
      teacherId: TEACHER_ID,
      sourceType: 'manual',
      rawText: '某条无法归属的文本',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.captureStatus).toBe('unresolved');
    expect(result.value.studentId).toBeNull();
  });

  it('幂等捕获：相同 (teacherId, sourceEntityType, sourceEntityId) 返回已有记录', async () => {
    const first = await service.captureSource({
      teacherId: TEACHER_ID,
      sourceType: 'agent_text',
      sourceEntityType: 'ConversationTurn',
      sourceEntityId: 'turn-001',
      rawText: '第一次内容',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await service.captureSource({
      teacherId: TEACHER_ID,
      sourceType: 'agent_text',
      sourceEntityType: 'ConversationTurn',
      sourceEntityId: 'turn-001',
      rawText: '第二次内容（应被忽略）',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.id).toBe(first.value.id);
    expect(second.value.rawText).toBe('第一次内容');

    const count = await prisma.studentSourceRecord.count({
      where: { teacherId: TEACHER_ID, sourceEntityType: 'ConversationTurn', sourceEntityId: 'turn-001' },
    });
    expect(count).toBe(1);
  });

  it('非法 sourceType 返回 VALIDATION_ERROR', async () => {
    const result = await service.captureSource({
      teacherId: TEACHER_ID,
      sourceType: 'bogus' as never,
      rawText: '文本',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('空 rawText 返回 VALIDATION_ERROR', async () => {
    const result = await service.captureSource({
      teacherId: TEACHER_ID,
      sourceType: 'manual',
      rawText: '   ',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('studentId 不属于该 teacher 返回 NOT_FOUND', async () => {
    const otherStudentId = await createStudent(OTHER_TEACHER_ID, '别人的学生');

    const result = await service.captureSource({
      teacherId: TEACHER_ID,
      studentId: otherStudentId,
      sourceType: 'manual',
      rawText: '归属校验文本',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('studentSourceRecordService.getOwnedSource', () => {
  it('owner 隔离：跨 teacher 查询返回 NOT_FOUND', async () => {
    const created = await service.captureSource({
      teacherId: TEACHER_ID,
      sourceType: 'manual',
      rawText: '我的证据',
    });
    if (!created.ok) return;

    const result = await service.getOwnedSource({
      teacherId: OTHER_TEACHER_ID,
      sourceRecordId: created.value.id,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('同 teacher 查询返回记录', async () => {
    const created = await service.captureSource({
      teacherId: TEACHER_ID,
      sourceType: 'manual',
      rawText: '我的证据',
    });
    if (!created.ok) return;

    const result = await service.getOwnedSource({
      teacherId: TEACHER_ID,
      sourceRecordId: created.value.id,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(created.value.id);
  });
});

describe('studentSourceRecordService.listUnresolvedSources', () => {
  it('只返回 unresolved，且按 createdAtTs 倒序', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    await service.captureSource({ teacherId: TEACHER_ID, studentId, sourceType: 'manual', rawText: '已归属' });
    const unresolved = await service.captureSource({ teacherId: TEACHER_ID, sourceType: 'manual', rawText: '未归属一' });
    // TrustedClock 返回 CURRENT_TIMESTAMP（毫秒精度），同毫秒创建会得到相同时间戳导致排序不稳定；
    // 这里加间隔保证两条记录时间戳不同，断言"按 createdAtTs 倒序"才有确定性。
    await new Promise((resolve) => setTimeout(resolve, 25));
    const unresolved2 = await service.captureSource({ teacherId: TEACHER_ID, sourceType: 'manual', rawText: '未归属二' });
    if (!unresolved.ok || !unresolved2.ok) return;

    const result = await service.listUnresolvedSources({ teacherId: TEACHER_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(2);
    expect(result.value.items.map((item) => item.id)).toEqual([
      unresolved2.value.id,
      unresolved.value.id,
    ]);
  });

  it('非法页码返回 VALIDATION_ERROR', async () => {
    const result = await service.listUnresolvedSources({ teacherId: TEACHER_ID, page: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('studentSourceRecordService.archiveSource', () => {
  it('归档后 captureStatus=archived 且写入 ChangeLog', async () => {
    const created = await service.captureSource({
      teacherId: TEACHER_ID,
      sourceType: 'manual',
      rawText: '待归档证据',
    });
    if (!created.ok) return;

    const result = await service.archiveSource({
      teacherId: TEACHER_ID,
      sourceRecordId: created.value.id,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.captureStatus).toBe('archived');

    const log = await prisma.changeLog.findFirst({
      where: { teacherId: TEACHER_ID, module: 'student-source-record', targetId: created.value.id },
    });
    expect(log).not.toBeNull();
    expect(log!.action).toBe('update');
    expect(log!.targetType).toBe('StudentSourceRecord');
  });

  it('跨 teacher 归档返回 NOT_FOUND', async () => {
    const created = await service.captureSource({
      teacherId: TEACHER_ID,
      sourceType: 'manual',
      rawText: '我的证据',
    });
    if (!created.ok) return;

    const result = await service.archiveSource({
      teacherId: OTHER_TEACHER_ID,
      sourceRecordId: created.value.id,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('ChangeLog 返回 Err 时回滚归档状态并隐藏底层错误', async () => {
    const created = await service.captureSource({
      teacherId: TEACHER_ID,
      sourceType: 'manual',
      rawText: '不得归档的证据',
    });
    if (!created.ok) return;
    const failingService = createStudentSourceRecordService({
      getClient: async () => prisma,
      changelogFactory: failingChangelogFactory,
    });

    const result = await failingService.archiveSource({
      teacherId: TEACHER_ID,
      sourceRecordId: created.value.id,
    });

    expect(result).toEqual(err(internalError(AUDIT_FAILURE_PUBLIC_MESSAGE)));
    const unchanged = await prisma.studentSourceRecord.findUniqueOrThrow({
      where: { id: created.value.id },
    });
    expect(unchanged.captureStatus).toBe('unresolved');
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });
});
