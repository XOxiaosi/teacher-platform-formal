import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createAssessmentService } from '../../../src/features/assessments/index.js';
import { createPaymentService } from '../../../src/features/payments/index.js';
import { createMemoService } from '../../../src/features/memos/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';

/**
 * P8 phase-3 加密落位批6（t25）：Payment.note + AssessmentDetail.note + Memo.content 服务层加密。
 * - setup 已注入测试 ENCRYPTION_KEY → 服务 env 构建 cipher；
 * - 加密往返 / 旧明文双读 / 篡改拒绝 / owner 不变 / 缺钥 SAFETY_BLOCK；
 * - 分数列（score/fullScore/previousScore）与金额（amount/lessonCount）按 p7 裁定留明文。
 */

const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const TEST_KEY = 'b'.repeat(64);

const TEACHER_A = `teacher_enc6_a_${randomBytes(4).toString('hex')}`;
const TEACHER_B = `teacher_enc6_b_${randomBytes(4).toString('hex')}`;
const STUDENT_A = `student_enc6_a_${randomBytes(4).toString('hex')}`;

let paymentService: ReturnType<typeof createPaymentService>;
let memoService: ReturnType<typeof createMemoService>;
let assessmentService: ReturnType<typeof createAssessmentService>;

beforeAll(async () => {
  await prisma.student.create({
    data: { id: STUDENT_A, teacherId: TEACHER_A, name: '加密批6学生', grade: 'grade-1', currentStatus: 'active' },
  });
  paymentService = createPaymentService(prisma);
  memoService = createMemoService({ prisma });
  assessmentService = createAssessmentService(prisma);
});

afterAll(async () => {
  // FK 顺序：payment(student) → assessmentDetail(studentRecord) → studentRecord(source) → source → student
  await prisma.payment.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.memo.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.assessmentDetail.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.studentRecord.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.student.deleteMany({ where: { id: STUDENT_A } });
  await prisma.$disconnect();
});

describe('批6 Payment.note 加密往返', () => {
  it('createPayment → DB note 密文，getOwnedPayment/listPayments 解密；amount/lessonCount 留明文', async () => {
    const created = await paymentService.createPayment({
      teacherId: TEACHER_A,
      clientRequestId: 'field-placement-batch6-payment-0001',
      studentId: STUDENT_A,
      amount: 5000,
      lessonCount: 20,
      paidAt: new Date('2026-10-05T10:00:00Z'),
      note: '批6缴费备注：秋季班续费',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.note).toBe('批6缴费备注：秋季班续费');

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(row.note).not.toBe('批6缴费备注：秋季班续费');
    expect(cipher.decrypt(row.note!)).toBe('批6缴费备注：秋季班续费');
    // 金额/课时数按 p7 裁定留明文
    expect(row.amount).toBe(5000);
    expect(row.lessonCount).toBe(20);

    const got = await paymentService.getOwnedPayment({ teacherId: TEACHER_A, paymentId: created.value.id });
    expect(got.ok && got.value.note).toBe('批6缴费备注：秋季班续费');

    const list = await paymentService.listPayments({ teacherId: TEACHER_A });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.items.find((item) => item.id === created.value.id)?.note).toBe('批6缴费备注：秋季班续费');
  });

  it('updatePayment note 更新后仍密文落库、读解密；note=null 置空', async () => {
    const created = await paymentService.createPayment({
      teacherId: TEACHER_A,
      clientRequestId: 'field-placement-batch6-payment-0002',
      studentId: STUDENT_A,
      amount: 3000,
      lessonCount: 10,
      paidAt: new Date('2026-10-06T10:00:00Z'),
      note: '初次备注',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await paymentService.updatePayment({
      paymentId: created.value.id,
      note: '更新后的备注',
    });
    expect(updated.ok && updated.value.note).toBe('更新后的备注');

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(cipher.decrypt(row.note!)).toBe('更新后的备注');

    const cleared = await paymentService.updatePayment({ paymentId: created.value.id, note: null });
    expect(cleared.ok && cleared.value.note).toBeNull();
    const row2 = await prisma.payment.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(row2.note).toBeNull();
  });

  it('旧明文双读：prisma 直插明文 note → list/getOwnedPayment 直通', async () => {
    const legacy = await prisma.payment.create({
      data: {
        teacherId: TEACHER_A,
        studentId: STUDENT_A,
        amount: 1000,
        lessonCount: 4,
        paidAtTs: new Date('2026-10-07T10:00:00Z'),
        note: '旧明文缴费备注',
        createdAtTs: new Date('2026-10-07T10:00:00Z'),
        updatedAtTs: new Date('2026-10-07T10:00:00Z'),
      },
    });
    const got = await paymentService.getOwnedPayment({ teacherId: TEACHER_A, paymentId: legacy.id });
    expect(got.ok && got.value.note).toBe('旧明文缴费备注');
  });

  it('DB note 密文被篡改 → 读 INTERNAL_ERROR（SAFETY_BLOCK），不泄露明文', async () => {
    const created = await paymentService.createPayment({
      teacherId: TEACHER_A,
      clientRequestId: 'field-placement-batch6-payment-0003',
      studentId: STUDENT_A,
      amount: 2000,
      lessonCount: 8,
      paidAt: new Date('2026-10-08T10:00:00Z'),
      note: '篡改测试备注',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: created.value.id } });
    const original = row.note!;
    const parts = original.split(':');
    parts[4] = Buffer.from('tampered!').toString('base64');
    await prisma.payment.update({ where: { id: created.value.id }, data: { note: parts.join(':') } });

    try {
      const got = await paymentService.getOwnedPayment({ teacherId: TEACHER_A, paymentId: created.value.id });
      expect(got.ok).toBe(false);
      if (got.ok) return;
      expect(got.error.code).toBe('INTERNAL_ERROR');
      expect(got.error.message).toContain('SAFETY_BLOCK');
    } finally {
      await prisma.payment.update({ where: { id: created.value.id }, data: { note: original } });
    }
  });

  it('owner 隔离不变：跨教师读缴费仍 NOT_FOUND', async () => {
    const created = await paymentService.createPayment({
      teacherId: TEACHER_A,
      clientRequestId: 'field-placement-batch6-payment-0004',
      studentId: STUDENT_A,
      amount: 6000,
      lessonCount: 24,
      paidAt: new Date('2026-10-09T10:00:00Z'),
      note: '隔离测试备注',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const crossed = await paymentService.getOwnedPayment({ teacherId: TEACHER_B, paymentId: created.value.id });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.code).toBe('NOT_FOUND');
  });
});

describe('批6 AssessmentDetail.note 加密往返', () => {
  it('createScoreRecord → DB detail note 密文，getOwnedDetail/listByStudent 解密；score 留明文', async () => {
    const created = await assessmentService.createScoreRecord({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      subject: '数学',
      score: 92,
      fullScore: 100,
      note: '批6成绩备注：进步明显',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.detail.note).toBe('批6成绩备注：进步明显');

    const detailRow = await prisma.assessmentDetail.findUniqueOrThrow({
      where: { id: created.value.detail.id },
    });
    expect(detailRow.note).not.toBe('批6成绩备注：进步明显');
    expect(cipher.decrypt(detailRow.note!)).toBe('批6成绩备注：进步明显');
    // 分数列按 p7 裁定留明文
    expect(detailRow.score).toBe(92);
    expect(detailRow.fullScore).toBe(100);

    const got = await assessmentService.getOwnedDetail({
      teacherId: TEACHER_A,
      studentRecordId: created.value.record.id,
    });
    expect(got.ok && got.value.note).toBe('批6成绩备注：进步明显');

    const list = await assessmentService.listByStudent({ teacherId: TEACHER_A, studentId: STUDENT_A });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.items.find((item) => item.record.id === created.value.record.id)?.detail.note)
      .toBe('批6成绩备注：进步明显');
  });

  it('旧明文双读：prisma 直插明文 detail note → getOwnedDetail 直通', async () => {
    const record = await prisma.studentRecord.create({
      data: {
        teacherId: TEACHER_A,
        studentId: STUDENT_A,
        category: 'assessment',
        summary: '旧明文成绩摘要',
        occurredAtTs: new Date('2026-10-10T10:00:00Z'),
        confidence: 'medium',
        reviewStatus: 'candidate',
        visibility: 'needs_review',
        importance: 'normal',
      },
    });
    const detail = await prisma.assessmentDetail.create({
      data: {
        teacherId: TEACHER_A,
        studentRecordId: record.id,
        subject: '语文',
        score: 85,
        note: '旧明文成绩备注',
      },
    });
    const got = await assessmentService.getOwnedDetail({ teacherId: TEACHER_A, studentRecordId: record.id });
    expect(got.ok && got.value.note).toBe('旧明文成绩备注');
    expect(detail.id).toBeDefined();
  });

  it('DB detail note 密文被篡改 → 读 INTERNAL_ERROR（SAFETY_BLOCK）', async () => {
    const created = await assessmentService.createScoreRecord({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      subject: '物理',
      score: 78,
      note: '篡改测试成绩备注',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const detailRow = await prisma.assessmentDetail.findUniqueOrThrow({
      where: { id: created.value.detail.id },
    });
    const original = detailRow.note!;
    const parts = original.split(':');
    parts[4] = Buffer.from('tampered!').toString('base64');
    await prisma.assessmentDetail.update({
      where: { id: created.value.detail.id },
      data: { note: parts.join(':') },
    });

    try {
      const got = await assessmentService.getOwnedDetail({
        teacherId: TEACHER_A,
        studentRecordId: created.value.record.id,
      });
      expect(got.ok).toBe(false);
      if (got.ok) return;
      expect(got.error.code).toBe('INTERNAL_ERROR');
      expect(got.error.message).toContain('SAFETY_BLOCK');
    } finally {
      await prisma.assessmentDetail.update({
        where: { id: created.value.detail.id },
        data: { note: original },
      });
    }
  });
});

describe('批6 Memo.content 加密往返', () => {
  it('createMemo → DB content 密文，getMemo/listMemos/listDueMemos 解密；title 留明文', async () => {
    const created = await memoService.createMemo({
      teacherId: TEACHER_A,
      title: '批6备忘标题',
      content: '批6备忘内容：记得跟进续费',
      dueAt: new Date('2026-10-20T09:00:00Z'),
      tags: ['缴费', '跟进'],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.content).toBe('批6备忘内容：记得跟进续费');

    const row = await prisma.memo.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(row.content).not.toBe('批6备忘内容：记得跟进续费');
    expect(cipher.decrypt(row.content)).toBe('批6备忘内容：记得跟进续费');
    expect(row.title).toBe('批6备忘标题');

    const got = await memoService.getMemo({ teacherId: TEACHER_A, memoId: created.value.id });
    expect(got.ok && got.value.content).toBe('批6备忘内容：记得跟进续费');

    const list = await memoService.listMemos({ teacherId: TEACHER_A });
    expect(list.ok && list.value.items.find((item) => item.id === created.value.id)?.content)
      .toBe('批6备忘内容：记得跟进续费');

    const due = await memoService.listDueMemos({
      teacherId: TEACHER_A,
      dueBefore: new Date('2026-10-21T00:00:00Z'),
    });
    expect(due.ok).toBe(true);
    if (!due.ok) return;
    expect(due.value.find((item) => item.id === created.value.id)?.content).toBe('批6备忘内容：记得跟进续费');
  });

  it('updateMemo content 更新后仍密文落库、读解密；updateMemoStatus 不改 content', async () => {
    const created = await memoService.createMemo({
      teacherId: TEACHER_A,
      title: '更新测试备忘',
      content: '初始内容',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await memoService.updateMemo({
      teacherId: TEACHER_A,
      memoId: created.value.id,
      content: '更新后的备忘内容',
    });
    expect(updated.ok && updated.value.content).toBe('更新后的备忘内容');

    const row = await prisma.memo.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(cipher.decrypt(row.content)).toBe('更新后的备忘内容');

    const status = await memoService.updateMemoStatus({
      teacherId: TEACHER_A,
      memoId: created.value.id,
      status: 'done',
    });
    expect(status.ok && status.value.content).toBe('更新后的备忘内容');
  });

  it('旧明文双读：prisma 直插明文 content → getMemo 直通', async () => {
    const legacy = await prisma.memo.create({
      data: {
        teacherId: TEACHER_A,
        title: '旧明文备忘',
        content: '旧明文备忘内容',
        status: 'active',
        createdAtTs: new Date('2026-10-11T10:00:00Z'),
        updatedAtTs: new Date('2026-10-11T10:00:00Z'),
      },
    });
    const got = await memoService.getMemo({ teacherId: TEACHER_A, memoId: legacy.id });
    expect(got.ok && got.value.content).toBe('旧明文备忘内容');
  });

  it('DB content 密文被篡改 → 读 INTERNAL_ERROR（SAFETY_BLOCK）', async () => {
    const created = await memoService.createMemo({
      teacherId: TEACHER_A,
      title: '篡改测试备忘',
      content: '篡改测试内容',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const row = await prisma.memo.findUniqueOrThrow({ where: { id: created.value.id } });
    const original = row.content;
    const parts = original.split(':');
    parts[4] = Buffer.from('tampered!').toString('base64');
    await prisma.memo.update({ where: { id: created.value.id }, data: { content: parts.join(':') } });

    try {
      const got = await memoService.getMemo({ teacherId: TEACHER_A, memoId: created.value.id });
      expect(got.ok).toBe(false);
      if (got.ok) return;
      expect(got.error.code).toBe('INTERNAL_ERROR');
      expect(got.error.message).toContain('SAFETY_BLOCK');
    } finally {
      await prisma.memo.update({ where: { id: created.value.id }, data: { content: original } });
    }
  });

  it('owner 隔离不变：跨教师读备忘仍 NOT_FOUND', async () => {
    const created = await memoService.createMemo({
      teacherId: TEACHER_A,
      title: '隔离测试备忘',
      content: '隔离测试内容',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const crossed = await memoService.getMemo({ teacherId: TEACHER_B, memoId: created.value.id });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.code).toBe('NOT_FOUND');
  });
});

describe('批6 ENCRYPTION_KEY 缺省行为', () => {
  it('未配置密钥 → 写路径 SAFETY_BLOCK（payment/memo/assessment）；旧明文读可用', async () => {
    const originalKey = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      const noKeyPayments = createPaymentService(prisma);
      const noKeyMemos = createMemoService({ prisma });
      const noKeyAssessments = createAssessmentService(prisma);

      const paymentWrite = await noKeyPayments.createPayment({
        teacherId: TEACHER_A,
        clientRequestId: 'field-placement-batch6-no-key-0001',
        studentId: STUDENT_A,
        amount: 100,
        lessonCount: 1,
        paidAt: new Date('2026-10-12T10:00:00Z'),
        note: '不应落库备注',
      });
      expect(paymentWrite.ok).toBe(false);
      if (paymentWrite.ok) return;
      expect(paymentWrite.error.message).toContain('SAFETY_BLOCK');

      const memoWrite = await noKeyMemos.createMemo({
        teacherId: TEACHER_A,
        title: '不应落库备忘',
        content: '不应落库内容',
      });
      expect(memoWrite.ok).toBe(false);
      if (memoWrite.ok) return;
      expect(memoWrite.error.message).toContain('SAFETY_BLOCK');

      const assessmentWrite = await noKeyAssessments.createScoreRecord({
        teacherId: TEACHER_A,
        studentId: STUDENT_A,
        subject: '化学',
        score: 60,
        note: '不应落库成绩备注',
      });
      expect(assessmentWrite.ok).toBe(false);
      if (assessmentWrite.ok) return;
      expect(assessmentWrite.error.message).toContain('SAFETY_BLOCK');

      // 旧明文行缺钥仍可读（双读直通）
      const legacy = await prisma.memo.create({
        data: {
          teacherId: TEACHER_A,
          title: '缺钥旧明文备忘',
          content: '缺钥旧明文内容',
          status: 'active',
          createdAtTs: new Date('2026-10-13T10:00:00Z'),
          updatedAtTs: new Date('2026-10-13T10:00:00Z'),
        },
      });
      const got = await noKeyMemos.getMemo({ teacherId: TEACHER_A, memoId: legacy.id });
      expect(got.ok && got.value.content).toBe('缺钥旧明文内容');
    } finally {
      process.env.ENCRYPTION_KEY = originalKey ?? TEST_KEY;
    }
  });
});
