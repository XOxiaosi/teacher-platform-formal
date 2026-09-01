import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createCommunicationService } from '../../../src/features/student-communications/communication-service.js';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';

const prisma = new PrismaClient();
const service = createCommunicationService(prisma);
// P8 phase-3 批1：测试密钥 cipher（与 setup 注入同钥）——用于校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);

const TEACHER_ID = 'test-teacher-communications';
const OTHER_TEACHER_ID = 'test-teacher-communications-other';

async function createStudent(teacherId: string, name: string) {
  return prisma.student.create({
    data: { teacherId, name, grade: '高三' },
  });
}

async function cleanup() {
  const teacherIds = { in: [TEACHER_ID, OTHER_TEACHER_ID] };
  await prisma.communicationDetail.deleteMany({ where: { teacherId: teacherIds } });
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

describe('communicationService.createCommunicationRecord', () => {
  it('成功：record+detail 原子落库，category=parent_communication，数组字段 roundtrip 正确', async () => {
    const student = await createStudent(TEACHER_ID, '张三');

    const result = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '与家长电话沟通作业量问题',
      direction: 'two_way',
      channel: 'phone',
      parentType: 'normal',
      parentConcerns: ['作业太多', '睡眠不足'],
      teacherResponses: ['已了解诉求', '下周调整作业量'],
      agreements: ['减少周末作业量', '保持每日1小时运动'],
      followUps: ['下周三回访'],
      sourceText: '家长来电说孩子作业太多...',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.record.category).toBe('parent_communication');
    expect(result.value.record.summary).toBe('与家长电话沟通作业量问题');
    expect(result.value.record.studentId).toBe(student.id);
    expect(result.value.detail.studentRecordId).toBe(result.value.record.id);
    expect(result.value.detail.direction).toBe('two_way');
    expect(result.value.detail.channel).toBe('phone');
    expect(result.value.detail.parentType).toBe('normal');
    expect(result.value.detail.parentConcerns).toEqual(['作业太多', '睡眠不足']);
    expect(result.value.detail.teacherResponses).toEqual(['已了解诉求', '下周调整作业量']);
    expect(result.value.detail.agreements).toEqual(['减少周末作业量', '保持每日1小时运动']);
    expect(result.value.detail.followUps).toEqual(['下周三回访']);

    // 持久化校验
    const persistedRecord = await prisma.studentRecord.findUniqueOrThrow({
      where: { id: result.value.record.id },
    });
    expect(persistedRecord.category).toBe('parent_communication');

    const persistedDetail = await prisma.communicationDetail.findUniqueOrThrow({
      where: { studentRecordId: result.value.record.id },
    });
    expect(persistedDetail.studentRecordId).toBe(result.value.record.id);
    expect(persistedDetail.direction).toBe('two_way');
    // P8 phase-3 批1：Json 字段落库为密文字符串（非明文数组），解密后与输入一致
    expect(persistedDetail.parentConcerns).not.toEqual(['作业太多', '睡眠不足']);
    expect(cipher.decryptJson<unknown>(persistedDetail.parentConcerns as unknown as string)).toEqual(['作业太多', '睡眠不足']);
    expect(cipher.decryptJson<unknown>(persistedDetail.followUps as unknown as string)).toEqual(['下周三回访']);
  });

  it('带 sourceText 时创建 StudentSourceRecord 并关联 sourceRecordId，且同内容幂等', async () => {
    const student = await createStudent(TEACHER_ID, '王五');

    const result = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '微信沟通考试成绩',
      direction: 'outbound',
      channel: 'wechat',
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
    expect(sourceRecord.contentHash).not.toBeNull();
  });

  it('无 sourceText：不建 source record', async () => {
    const student = await createStudent(TEACHER_ID, '赵六');

    const result = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '线下沟通',
      direction: 'inbound',
      channel: 'offline',
      parentConcerns: ['孩子最近状态不好'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.record.sourceRecordId).toBeNull();

    const sourceCount = await prisma.studentSourceRecord.count({
      where: { teacherId: TEACHER_ID, studentId: student.id },
    });
    expect(sourceCount).toBe(0);
  });

  it('缺省 reviewStatus=candidate，visibility=needs_review', async () => {
    const student = await createStudent(TEACHER_ID, '钱七');

    const result = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '普通沟通',
      direction: 'two_way',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.record.reviewStatus).toBe('candidate');
    expect(result.value.record.visibility).toBe('needs_review');
    expect(result.value.record.confidence).toBe('medium');
  });

  it('自定义 reviewStatus 和 visibility', async () => {
    const student = await createStudent(TEACHER_ID, '孙八');

    const result = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '已审核的沟通',
      direction: 'outbound',
      reviewStatus: 'confirmed',
      visibility: 'parent_shareable',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.record.reviewStatus).toBe('confirmed');
    expect(result.value.record.visibility).toBe('parent_shareable');
  });

  it('非法 direction → VALIDATION_ERROR', async () => {
    const student = await createStudent(TEACHER_ID, '周九');

    const result = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '测试',
      direction: 'invalid' as any,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('direction');
  });

  it('非法 channel → VALIDATION_ERROR', async () => {
    const student = await createStudent(TEACHER_ID, '吴十');

    const result = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '测试',
      direction: 'inbound',
      channel: 'email' as any,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('channel');
  });

  it('非法 parentType → VALIDATION_ERROR', async () => {
    const student = await createStudent(TEACHER_ID, '郑十一');

    const result = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '测试',
      direction: 'inbound',
      parentType: 'angry' as any,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('parentType');
  });

  it('数组含非字符串 → VALIDATION_ERROR', async () => {
    const student = await createStudent(TEACHER_ID, '王十二');

    const result = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '测试',
      direction: 'inbound',
      parentConcerns: ['正常诉求', 123] as any,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('parentConcerns');
  });

  it('summary 空 → VALIDATION_ERROR', async () => {
    const student = await createStudent(TEACHER_ID, '李十三');

    const result = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '   ',
      direction: 'inbound',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('summary');
  });

  it('owner 隔离：给其他老师的学生建记录返回 NOT_FOUND', async () => {
    const otherStudent = await createStudent(OTHER_TEACHER_ID, '别人家学生');

    const result = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: otherStudent.id,
      summary: '测试',
      direction: 'two_way',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('nextContactAtTs 正确持久化', async () => {
    const student = await createStudent(TEACHER_ID, '张十四');
    const nextContact = new Date('2026-08-28T10:00:00.000Z');

    const result = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '下次再聊',
      direction: 'outbound',
      nextContactAtTs: nextContact,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.detail.nextContactAtTs).toBeInstanceOf(Date);
    expect(result.value.detail.nextContactAtTs?.toISOString()).toBe('2026-08-28T10:00:00.000Z');
  });
});

describe('communicationService.updateDetail', () => {
  it('成功：更新 direction/parentType/数组/nextContactAtTs', async () => {
    const student = await createStudent(TEACHER_ID, '陈十五');
    const created = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '初始沟通',
      direction: 'inbound',
      parentType: 'normal',
      parentConcerns: ['作业多'],
    });
    if (!created.ok) return;

    const newNextContact = new Date('2026-09-01T14:00:00.000Z');
    const updated = await service.updateDetail({
      teacherId: TEACHER_ID,
      studentId: student.id,
      recordId: created.value.record.id,
      patch: {
        direction: 'two_way',
        parentType: 'scores',
        parentConcerns: ['作业多', '成绩下滑'],
        teacherResponses: ['将安排补课'],
        agreements: ['每周日补习数学'],
        followUps: ['月底回访'],
        nextContactAtTs: newNextContact,
      },
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.direction).toBe('two_way');
    expect(updated.value.parentType).toBe('scores');
    expect(updated.value.parentConcerns).toEqual(['作业多', '成绩下滑']);
    expect(updated.value.teacherResponses).toEqual(['将安排补课']);
    expect(updated.value.agreements).toEqual(['每周日补习数学']);
    expect(updated.value.followUps).toEqual(['月底回访']);
    expect(updated.value.nextContactAtTs?.toISOString()).toBe('2026-09-01T14:00:00.000Z');
  });

  it('channel 可更新为 null', async () => {
    const student = await createStudent(TEACHER_ID, '刘十六');
    const created = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '有渠道的沟通',
      direction: 'two_way',
      channel: 'phone',
    });
    if (!created.ok) return;

    const updated = await service.updateDetail({
      teacherId: TEACHER_ID,
      studentId: student.id,
      recordId: created.value.record.id,
      patch: { channel: null },
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.channel).toBeNull();
  });

  it('owner 隔离：跨 teacher 更新返回 NOT_FOUND', async () => {
    const student = await createStudent(TEACHER_ID, '杨十七');
    const created = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '我的记录',
      direction: 'two_way',
    });
    if (!created.ok) return;

    const updated = await service.updateDetail({
      teacherId: OTHER_TEACHER_ID,
      studentId: student.id,
      recordId: created.value.record.id,
      patch: { direction: 'inbound' },
    });

    expect(updated.ok).toBe(false);
    if (updated.ok) return;
    expect(updated.error.code).toBe('NOT_FOUND');
  });

  it('非法 direction patch → VALIDATION_ERROR', async () => {
    const student = await createStudent(TEACHER_ID, '黄十八');
    const created = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '测试',
      direction: 'two_way',
    });
    if (!created.ok) return;

    const updated = await service.updateDetail({
      teacherId: TEACHER_ID,
      studentId: student.id,
      recordId: created.value.record.id,
      patch: { direction: 'bad' as any },
    });

    expect(updated.ok).toBe(false);
    if (updated.ok) return;
    expect(updated.error.code).toBe('VALIDATION_ERROR');
    expect(updated.error.field).toBe('direction');
  });
});

describe('communicationService.getOwnedDetail', () => {
  it('返回归属明细', async () => {
    const student = await createStudent(TEACHER_ID, '徐十九');
    const created = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '查询测试',
      direction: 'inbound',
      channel: 'wechat',
      parentConcerns: ['诉求A', '诉求B'],
    });
    if (!created.ok) return;

    const result = await service.getOwnedDetail({
      teacherId: TEACHER_ID,
      studentId: student.id,
      recordId: created.value.record.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.direction).toBe('inbound');
    expect(result.value.channel).toBe('wechat');
    expect(result.value.parentConcerns).toEqual(['诉求A', '诉求B']);
    expect(result.value.studentRecordId).toBe(created.value.record.id);
  });

  it('owner 隔离：跨 teacher 查返回 NOT_FOUND', async () => {
    const student = await createStudent(TEACHER_ID, '朱二十');
    const created = await service.createCommunicationRecord({
      teacherId: TEACHER_ID,
      studentId: student.id,
      summary: '我的记录',
      direction: 'two_way',
    });
    if (!created.ok) return;

    const result = await service.getOwnedDetail({
      teacherId: OTHER_TEACHER_ID,
      studentId: student.id,
      recordId: created.value.record.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('不存在的 recordId → NOT_FOUND', async () => {
    const result = await service.getOwnedDetail({
      teacherId: TEACHER_ID,
      studentId: 'fake-student',
      recordId: 'nonexistent-record',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});
