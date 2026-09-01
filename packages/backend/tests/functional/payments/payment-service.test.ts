import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createPaymentService } from '../../../src/features/payments/payment-service.js';

const prisma = new PrismaClient();
const service = createPaymentService(prisma);
const TEACHER_ID = 'test-teacher-payments';
const OTHER_TEACHER_ID = 'test-teacher-payments-other';

async function createStudent(name: string) {
  return prisma.student.create({ data: { teacherId: TEACHER_ID, name, grade: '高三' } });
}

async function cleanup() {
  const teacherIds = [TEACHER_ID, OTHER_TEACHER_ID];
  await prisma.payment.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teacherIds } } });
}

beforeEach(async () => { await cleanup(); });
afterEach(async () => { await cleanup(); });

describe('paymentService.createPayment', () => {
  it('创建缴费记录', async () => {
    const student = await createStudent('张三');
    const result = await service.createPayment({
      teacherId: TEACHER_ID, studentId: student.id, amount: 3000, lessonCount: 20, paidAt: new Date('2025-03-01'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amount).toBe(3000);
    expect(result.value.lessonCount).toBe(20);

    const persisted = await prisma.payment.findUniqueOrThrow({ where: { id: result.value.id } });
    expect(persisted.paidAtTs).toBeInstanceOf(Date);
    expect(persisted.paidAtTs).toBeInstanceOf(Date);
  });

  it('拒绝关联其他 teacher 的学生，且零写入', async () => {
    const otherStudent = await prisma.student.create({
      data: { teacherId: OTHER_TEACHER_ID, name: '其他老师学生', grade: '高二' },
    });

    const result = await service.createPayment({
      teacherId: TEACHER_ID,
      studentId: otherStudent.id,
      amount: 3000,
      lessonCount: 20,
      paidAt: new Date('2025-03-01'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(expect.objectContaining({ code: 'NOT_FOUND', message: '学生不存在' }));
    expect(await prisma.payment.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('创建带备注', async () => {
    const student = await createStudent('张三');
    const result = await service.createPayment({
      teacherId: TEACHER_ID, studentId: student.id, amount: 1500, lessonCount: 10, paidAt: new Date('2025-03-01'), note: '第一次缴费',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.note).toBe('第一次缴费');
  });
});

describe('paymentService.getPayment', () => {
  it('查询单个缴费记录', async () => {
    const student = await createStudent('张三');
    const created = await service.createPayment({
      teacherId: TEACHER_ID, studentId: student.id, amount: 3000, lessonCount: 20, paidAt: new Date('2025-03-01'),
    });
    if (!created.ok) return;
    const result = await service.getPayment(created.value.id);
    expect(result.ok).toBe(true);
  });

  it('不存在返回 NOT_FOUND', async () => {
    const result = await service.getPayment('nonexistent');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('paymentService.listPayments', () => {
  it('按 teacherId 查询，按 paidAt 倒序', async () => {
    const student = await createStudent('张三');
    await service.createPayment({ teacherId: TEACHER_ID, studentId: student.id, amount: 3000, lessonCount: 20, paidAt: new Date('2025-01-01') });
    await service.createPayment({ teacherId: TEACHER_ID, studentId: student.id, amount: 1500, lessonCount: 10, paidAt: new Date('2025-03-01') });

    const result = await service.listPayments({ teacherId: TEACHER_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBe(2);
    expect(result.value.items[0].amount).toBe(1500);
    expect(result.value.items[1].amount).toBe(3000);
  });

  it('按 studentId 过滤', async () => {
    const s1 = await createStudent('张三');
    const s2 = await createStudent('李四');
    await service.createPayment({ teacherId: TEACHER_ID, studentId: s1.id, amount: 3000, lessonCount: 20, paidAt: new Date('2025-03-01') });
    await service.createPayment({ teacherId: TEACHER_ID, studentId: s2.id, amount: 1500, lessonCount: 10, paidAt: new Date('2025-03-01') });

    const result = await service.listPayments({ teacherId: TEACHER_ID, studentId: s1.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBe(1);
  });

  it('同时按 paidAtFrom 和 paidAtTo 过滤', async () => {
    const student = await createStudent('张三');
    await service.createPayment({ teacherId: TEACHER_ID, studentId: student.id, amount: 1000, lessonCount: 5, paidAt: new Date('2025-02-10T12:00:00') });
    await service.createPayment({ teacherId: TEACHER_ID, studentId: student.id, amount: 2000, lessonCount: 10, paidAt: new Date('2025-03-10T12:00:00') });
    await service.createPayment({ teacherId: TEACHER_ID, studentId: student.id, amount: 3000, lessonCount: 15, paidAt: new Date('2025-03-20T12:00:00') });
    await service.createPayment({ teacherId: TEACHER_ID, studentId: student.id, amount: 4000, lessonCount: 20, paidAt: new Date('2025-04-10T12:00:00') });

    const result = await service.listPayments({
      teacherId: TEACHER_ID,
      paidAtFrom: new Date('2025-03-01T12:00:00'),
      paidAtTo: new Date('2025-03-31T12:00:00'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((item) => item.amount)).toEqual([3000, 2000]);
  });

  it('paidAtFrom 和 paidAtTo 是双边界包含关系', async () => {
    const student = await createStudent('张三');
    await service.createPayment({ teacherId: TEACHER_ID, studentId: student.id, amount: 1000, lessonCount: 5, paidAt: new Date('2025-03-01T00:00:00') });
    await service.createPayment({ teacherId: TEACHER_ID, studentId: student.id, amount: 2000, lessonCount: 10, paidAt: new Date('2025-03-15T12:00:00') });
    await service.createPayment({ teacherId: TEACHER_ID, studentId: student.id, amount: 3000, lessonCount: 15, paidAt: new Date('2025-03-31T23:59:59') });
    await service.createPayment({ teacherId: TEACHER_ID, studentId: student.id, amount: 4000, lessonCount: 20, paidAt: new Date('2025-04-01T00:00:00') });

    const result = await service.listPayments({
      teacherId: TEACHER_ID,
      paidAtFrom: new Date('2025-03-01T00:00:00'),
      paidAtTo: new Date('2025-03-31T23:59:59'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((item) => item.amount)).toEqual([3000, 2000, 1000]);
    expect(result.value.total).toBe(3);
  });

  it('无缴费记录时返回空数组和 total 0', async () => {
    const result = await service.listPayments({ teacherId: TEACHER_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toEqual([]);
    expect(result.value.total).toBe(0);
  });
});

describe('paymentService.updatePayment', () => {
  it('修改缴费记录', async () => {
    const student = await createStudent('张三');
    const created = await service.createPayment({
      teacherId: TEACHER_ID, studentId: student.id, amount: 3000, lessonCount: 20, paidAt: new Date('2025-03-01'),
    });
    if (!created.ok) return;
    const newPaidAt = new Date('2025-04-01');
    const result = await service.updatePayment({ paymentId: created.value.id, amount: 3500, note: '调整金额', paidAt: newPaidAt });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amount).toBe(3500);
    expect(result.value.note).toBe('调整金额');
    const persisted = await prisma.payment.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(persisted.paidAtTs).toBeInstanceOf(Date);
    expect(persisted.paidAtTs).toBeInstanceOf(Date);
  });

  it('不存在返回 NOT_FOUND', async () => {
    const result = await service.updatePayment({ paymentId: 'nonexistent', amount: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('paymentService.sumLessonCount', () => {
  it('统计学生购买课时总数', async () => {
    const student = await createStudent('张三');
    await service.createPayment({ teacherId: TEACHER_ID, studentId: student.id, amount: 3000, lessonCount: 20, paidAt: new Date('2025-01-01') });
    await service.createPayment({ teacherId: TEACHER_ID, studentId: student.id, amount: 1500, lessonCount: 10, paidAt: new Date('2025-03-01') });

    const result = await service.sumLessonCount({ studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(30);
  });

  it('学生不存在返回 NOT_FOUND', async () => {
    const result = await service.sumLessonCount({ studentId: 'nonexistent' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});