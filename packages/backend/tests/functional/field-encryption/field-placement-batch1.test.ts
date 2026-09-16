import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createFeedbackService } from '../../../src/features/feedback/index.js';
import { createCommunicationService } from '../../../src/features/student-communications/index.js';
import { createStudentTimelineService } from '../../../src/features/student-timeline/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';

/**
 * P8 phase-3 加密落位批1（t10）：ParentFeedback + CommunicationDetail 服务层加密验收。
 * - setup 已注入测试 ENCRYPTION_KEY（tests/setup/encryption-key.ts）→ 服务 env 构建 cipher；
 * - 加密往返 / 旧明文双读 / 篡改拒绝 / owner 隔离不变 / 缺失密钥行为 / 时间线读路径解密。
 */

const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const TEST_KEY = 'b'.repeat(64); // 与 setup 同钥（hex）

const TEACHER_A = `teacher_enc_a_${randomBytes(4).toString('hex')}`;
const TEACHER_B = `teacher_enc_b_${randomBytes(4).toString('hex')}`;
const STUDENT_A = `student_enc_a_${randomBytes(4).toString('hex')}`;

let feedbackService: ReturnType<typeof createFeedbackService>;
let commService: ReturnType<typeof createCommunicationService>;
let timelineService: ReturnType<typeof createStudentTimelineService>;

beforeAll(async () => {
  await prisma.student.create({
    data: { id: STUDENT_A, teacherId: TEACHER_A, name: '加密批1学生', grade: 'grade-1', currentStatus: 'active' },
  });
  feedbackService = createFeedbackService({ prisma });
  commService = createCommunicationService(prisma);
  timelineService = createStudentTimelineService(prisma);
});

afterAll(async () => {
  await prisma.parentFeedback.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.communicationDetail.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.studentRecord.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.student.deleteMany({ where: { id: STUDENT_A } });
  await prisma.$disconnect();
});

async function createCommRecord(teacherId: string, studentId: string, arrays: {
  parentConcerns: string[];
  teacherResponses: string[];
  agreements: string[];
  followUps: string[];
}) {
  const result = await commService.createCommunicationRecord({
    teacherId,
    studentId,
    summary: '加密批1沟通摘要',
    direction: 'two_way',
    parentConcerns: arrays.parentConcerns,
    teacherResponses: arrays.teacherResponses,
    agreements: arrays.agreements,
    followUps: arrays.followUps,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('批1 ParentFeedback：加密往返', () => {
  it('create → DB 密文（enc:v1），get/list/update 响应均为解密明文', async () => {
    const created = await feedbackService.createFeedback({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      title: '批1反馈标题',
      content: '批1反馈内容，含敏感评价',
      parentName: '批1家长',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.title).toBe('批1反馈标题');
    expect(created.value.content).toBe('批1反馈内容，含敏感评价');
    expect(created.value.parentName).toBe('批1家长');

    // DB 是密文
    const row = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(row.title).not.toContain('批1反馈标题');
    expect(row.content.startsWith('enc:v1:')).toBe(true);
    expect(row.parentName).not.toBe('批1家长');
    expect(cipher.decrypt(row.title)).toBe('批1反馈标题');
    expect(cipher.decrypt(row.content)).toBe('批1反馈内容，含敏感评价');
    expect(cipher.decrypt(row.parentName!)).toBe('批1家长');

    // 读路径解密
    const got = await feedbackService.getFeedback({ teacherId: TEACHER_A, feedbackId: created.value.id });
    expect(got.ok && got.value.title).toBe('批1反馈标题');
    const list = await feedbackService.listFeedbacks({ teacherId: TEACHER_A });
    expect(list.ok && list.value.items[0].content).toBe('批1反馈内容，含敏感评价');

    // 更新路径加密
    const updated = await feedbackService.updateFeedbackContent({
      teacherId: TEACHER_A,
      feedbackId: created.value.id,
      title: '批1新标题',
    });
    expect(updated.ok && updated.value.title).toBe('批1新标题');
    const rowAfter = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(cipher.decrypt(rowAfter.title)).toBe('批1新标题');
    expect(cipher.decrypt(rowAfter.content)).toBe('批1反馈内容，含敏感评价');
  });

  it('旧明文双读：prisma 直插明文行 → 服务读返回明文（tryDecrypt 直通）', async () => {
    const legacy = await prisma.parentFeedback.create({
      data: {
        teacherId: TEACHER_A,
        studentId: STUDENT_A,
        title: '旧明文标题',
        content: '旧明文内容',
        parentName: '旧明文家长',
      },
    });
    const got = await feedbackService.getFeedback({ teacherId: TEACHER_A, feedbackId: legacy.id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.title).toBe('旧明文标题');
    expect(got.value.content).toBe('旧明文内容');
    expect(got.value.parentName).toBe('旧明文家长');

    // 编辑旧明文行 → 写路径加密（迁移后行变为密文）
    const updated = await feedbackService.updateFeedbackContent({
      teacherId: TEACHER_A,
      feedbackId: legacy.id,
      content: '迁移后内容',
    });
    expect(updated.ok).toBe(true);
    const migrated = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(cipher.decrypt(migrated.content)).toBe('迁移后内容');
  });
});

describe('批1 CommunicationDetail：加密往返', () => {
  it('create → DB 4 个 Json 为密文字符串，get/update 响应解密为数组', async () => {
    const created = await createCommRecord(TEACHER_A, STUDENT_A, {
      parentConcerns: ['作业太多', '睡眠不足'],
      teacherResponses: ['已调整作业量'],
      agreements: ['减量两周'],
      followUps: ['两周后回访'],
    });

    const row = await prisma.communicationDetail.findUniqueOrThrow({
      where: { studentRecordId: created.record.id },
    });
    expect(row.parentConcerns).not.toEqual(['作业太多', '睡眠不足']);
    expect(typeof row.parentConcerns).toBe('string');
    expect((row.parentConcerns as unknown as string).startsWith('enc:v1:')).toBe(true);
    expect(cipher.decryptJson<unknown>(row.parentConcerns as unknown as string)).toEqual(['作业太多', '睡眠不足']);
    expect(cipher.decryptJson<unknown>(row.teacherResponses as unknown as string)).toEqual(['已调整作业量']);
    expect(cipher.decryptJson<unknown>(row.agreements as unknown as string)).toEqual(['减量两周']);
    expect(cipher.decryptJson<unknown>(row.followUps as unknown as string)).toEqual(['两周后回访']);

    // 读路径解密
    const owned = await commService.getOwnedDetail({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      recordId: created.record.id,
    });
    expect(owned.ok && owned.value.parentConcerns).toEqual(['作业太多', '睡眠不足']);
    expect(owned.ok && owned.value.followUps).toEqual(['两周后回访']);

    // 更新路径加密
    const updated = await commService.updateDetail({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      recordId: created.record.id,
      patch: { parentConcerns: ['新诉求1', '新诉求2'] },
    });
    expect(updated.ok && updated.value.parentConcerns).toEqual(['新诉求1', '新诉求2']);
    const rowAfter = await prisma.communicationDetail.findUniqueOrThrow({
      where: { studentRecordId: created.record.id },
    });
    expect(cipher.decryptJson<unknown>(rowAfter.parentConcerns as unknown as string)).toEqual(['新诉求1', '新诉求2']);
  });

  it('旧明文双读：prisma 直插明文 jsonb 数组 → 服务读返回数组', async () => {
    const studentRecord = await prisma.studentRecord.create({
      data: {
        teacherId: TEACHER_A,
        studentId: STUDENT_A,
        category: 'parent_communication',
        occurredAtTs: new Date(),
        summary: '旧明文沟通',
        confidence: 'medium',
        reviewStatus: 'candidate',
        visibility: 'needs_review',
        importance: 'normal',
      },
    });
    await prisma.communicationDetail.create({
      data: {
        teacherId: TEACHER_A,
        studentRecordId: studentRecord.id,
        direction: 'inbound',
        parentConcerns: ['旧明文诉求'],
        teacherResponses: ['旧明文回应'],
        agreements: [],
        followUps: [],
      },
    });

    const owned = await commService.getOwnedDetail({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      recordId: studentRecord.id,
    });
    expect(owned.ok).toBe(true);
    if (!owned.ok) return;
    expect(owned.value.parentConcerns).toEqual(['旧明文诉求']);
    expect(owned.value.teacherResponses).toEqual(['旧明文回应']);
  });
});

describe('批1 篡改拒绝 + owner 隔离不变', () => {
  it('DB 密文被篡改 → 服务读返回 INTERNAL_ERROR（含 SAFETY_BLOCK），不泄露明文', async () => {
    const created = await feedbackService.createFeedback({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      title: '篡改测试',
      content: '原始内容',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // 篡改 content 密文
    const row = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: created.value.id } });
    const originalContent = row.content;
    const parts = row.content.split(':');
    parts[4] = Buffer.from('tampered!').toString('base64');
    await prisma.parentFeedback.update({ where: { id: created.value.id }, data: { content: parts.join(':') } });

    try {
      const got = await feedbackService.getFeedback({ teacherId: TEACHER_A, feedbackId: created.value.id });
      expect(got.ok).toBe(false);
      if (got.ok) return;
      expect(got.error.code).toBe('INTERNAL_ERROR');
      expect(got.error.message).toContain('SAFETY_BLOCK');
    } finally {
      // 恢复原密文，避免影响后续测试（时间线全量读会遇篡改行）
      await prisma.parentFeedback.update({ where: { id: created.value.id }, data: { content: originalContent } });
    }
  });

  it('owner 隔离不变：跨教师读反馈/明细仍 NOT_FOUND', async () => {
    const feedback = await feedbackService.createFeedback({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      title: '隔离测试',
      content: 'A 的反馈',
    });
    expect(feedback.ok).toBe(true);
    if (!feedback.ok) return;
    const crossed = await feedbackService.getFeedback({ teacherId: TEACHER_B, feedbackId: feedback.value.id });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.code).toBe('NOT_FOUND');

    const comm = await createCommRecord(TEACHER_A, STUDENT_A, {
      parentConcerns: ['A 诉求'],
      teacherResponses: [],
      agreements: [],
      followUps: [],
    });
    const crossedDetail = await commService.getOwnedDetail({
      teacherId: TEACHER_B,
      studentId: STUDENT_A,
      recordId: comm.record.id,
    });
    expect(crossedDetail.ok).toBe(false);
  });
});

describe('批1 ENCRYPTION_KEY 缺省行为', () => {
  it('未配置密钥 → 写路径拒绝（SAFETY_BLOCK），旧明文读仍可用', async () => {
    const originalKey = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      const noKeyService = createFeedbackService({ prisma });

      // 旧明文行可读（双读窗口，无需密钥）
      const legacy = await prisma.parentFeedback.create({
        data: { teacherId: TEACHER_A, studentId: STUDENT_A, title: '无钥旧明文', content: '无钥旧内容' },
      });
      const got = await noKeyService.getFeedback({ teacherId: TEACHER_A, feedbackId: legacy.id });
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.value.title).toBe('无钥旧明文');

      // 写路径拒绝明文落库
      const beforeWriteCount = await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } });
      const write = await noKeyService.createFeedback({
        teacherId: TEACHER_A,
        studentId: STUDENT_A,
        title: '不应落库',
        content: '无钥拒绝',
      });
      expect(write.ok).toBe(false);
      if (write.ok) return;
      expect(write.error.message).toContain('SAFETY_BLOCK');
      expect(write.error.code).toBe('INTERNAL_ERROR');
      expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(beforeWriteCount);
      expect(write.error.message).not.toContain('无钥拒绝');
    } finally {
      process.env.ENCRYPTION_KEY = originalKey ?? TEST_KEY;
    }
  });
});

describe('批1 时间线读路径解密（StudentTimeline）', () => {
  it('加密后的反馈与沟通明细在时间线响应中解密展示', async () => {
    const feedback = await feedbackService.createFeedback({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      title: '时间线反馈标题',
      content: '时间线反馈内容',
    });
    expect(feedback.ok).toBe(true);
    if (!feedback.ok) return;

    const comm = await createCommRecord(TEACHER_A, STUDENT_A, {
      parentConcerns: ['时间线诉求'],
      teacherResponses: [],
      agreements: [],
      followUps: ['时间线跟进'],
    });

    const timeline = await timelineService.getStudentTimeline({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
    });
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;

    const feedbackEntry = timeline.value.items.find((item) => item.type === 'feedback');
    expect(feedbackEntry?.title).toBe('时间线反馈标题');
    expect(feedbackEntry?.summary).toBe('时间线反馈内容');

    const commEntry = timeline.value.items.find((item) => item.id === comm.record.id);
    expect(commEntry?.communicationDetail?.parentConcerns).toEqual(['时间线诉求']);
    expect(commEntry?.communicationDetail?.followUps).toEqual(['时间线跟进']);
  });
});
