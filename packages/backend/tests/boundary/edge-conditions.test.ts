import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, ok, validationError } from '@teacher-platform/contracts';
import { createStudentService } from '../../src/features/students/index.js';
import { createScheduleService } from '../../src/features/scheduling/index.js';
import { createPaymentService } from '../../src/features/payments/index.js';
import { createMorningBriefUseCase } from '../../src/app/use-cases/morning-brief/index.js';
import { createAutoArchiveUseCase } from '../../src/app/use-cases/auto-archive/index.js';
import type { MessageAdapter } from '../../src/adapters/shared/index.js';
import type { WeatherAdapter } from '../../src/adapters/weather/index.js';
import type { StorageService } from '../../src/shared/storage/index.js';

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-edge-conditions';

async function cleanup() {
  await prisma.pushRecord.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.lesson.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.schedule.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.payment.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
}

async function createStudent(name = '边界学生') {
  return prisma.student.create({ data: { teacherId: TEACHER_ID, name, grade: '高三' } });
}

beforeEach(async () => { await cleanup(); });
afterEach(async () => { await cleanup(); });

describe('T7.3 边界条件：空数据', () => {
  it('无学生、无日程、无缴费时列表接口返回空结果和 total 0', async () => {
    const students = await createStudentService(prisma).listStudents({ teacherId: TEACHER_ID });
    const schedules = await createScheduleService(prisma).listSchedules({ teacherId: TEACHER_ID });
    const payments = await createPaymentService(prisma).listPayments({ teacherId: TEACHER_ID });

    expect(students).toEqual(ok({ items: [], total: 0 }));
    expect(schedules).toEqual(ok({ items: [], total: 0 }));
    expect(payments).toEqual(ok({ items: [], total: 0 }));
  });

  it('早安简报在无日程、无缴费时仍发送合理空摘要', async () => {
    const pushAdapter: MessageAdapter = { send: vi.fn(async () => ok({ providerMessageId: 'empty-brief' })) };
    const weather: WeatherAdapter = { query: vi.fn(async () => ok({ city: '福州', weather: '多云', temperatureC: 25 })) };
    const useCase = createMorningBriefUseCase({ prisma, weather, pushAdapters: { 'wechat-bot': pushAdapter } });

    const result = await useCase.sendMorningBrief({
      teacherId: TEACHER_ID,
      date: new Date('2025-05-01T08:00:00+08:00'),
      city: '福州',
      channel: 'wechat-bot',
    });

    expect(result.ok).toBe(true);
    expect(pushAdapter.send).toHaveBeenCalledTimes(1);
    const content = vi.mocked(pushAdapter.send).mock.calls[0]![0].content;
    expect(content).toContain('今日安排（0项）：无');
    expect(content).toContain('今日缴费：0 笔，0 课时，¥0');
  });
});

describe('T7.3 边界条件：异常输入', () => {
  it('空标题日程返回 VALIDATION_ERROR 且不创建记录', async () => {
    const result = await createScheduleService(prisma).createSchedule({
      teacherId: TEACHER_ID,
      type: 'lesson',
      title: '   ',
      scheduledStart: new Date('2025-05-01T09:00:00+08:00'),
      scheduledEnd: new Date('2025-05-01T10:00:00+08:00'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    const count = await prisma.schedule.count({ where: { teacherId: TEACHER_ID } });
    expect(count).toBe(0);
  });

  it('非法日期范围查询日程和缴费均返回 VALIDATION_ERROR', async () => {
    const scheduleResult = await createScheduleService(prisma).listSchedules({
      teacherId: TEACHER_ID,
      dateFrom: new Date('2025-05-10T00:00:00+08:00'),
      dateTo: new Date('2025-05-01T00:00:00+08:00'),
    });
    const paymentResult = await createPaymentService(prisma).listPayments({
      teacherId: TEACHER_ID,
      paidAtFrom: new Date('2025-05-10T00:00:00+08:00'),
      paidAtTo: new Date('2025-05-01T00:00:00+08:00'),
    });

    expect(scheduleResult.ok).toBe(false);
    expect(paymentResult.ok).toBe(false);
    if (!scheduleResult.ok) expect(scheduleResult.error.code).toBe('VALIDATION_ERROR');
    if (!paymentResult.ok) expect(paymentResult.error.code).toBe('VALIDATION_ERROR');
  });

  it('负数分页参数返回 VALIDATION_ERROR 而不是抛出 Prisma 错误', async () => {
    const students = await createStudentService(prisma).listStudents({ teacherId: TEACHER_ID, page: -1 });
    const schedules = await createScheduleService(prisma).listSchedules({ teacherId: TEACHER_ID, pageSize: -10 });
    const payments = await createPaymentService(prisma).listPayments({ teacherId: TEACHER_ID, page: 0 });

    expect(students.ok).toBe(false);
    expect(schedules.ok).toBe(false);
    expect(payments.ok).toBe(false);
    if (!students.ok) expect(students.error.code).toBe('VALIDATION_ERROR');
    if (!schedules.ok) expect(schedules.error.code).toBe('VALIDATION_ERROR');
    if (!payments.ok) expect(payments.error.code).toBe('VALIDATION_ERROR');
  });

  it('非法学生状态和日程状态返回 VALIDATION_ERROR', async () => {
    const students = await createStudentService(prisma).listStudents({ teacherId: TEACHER_ID, status: 'unknown' });
    const schedules = await createScheduleService(prisma).listSchedules({ teacherId: TEACHER_ID, status: 'unknown' });

    expect(students.ok).toBe(false);
    expect(schedules.ok).toBe(false);
    if (!students.ok) expect(students.error.code).toBe('VALIDATION_ERROR');
    if (!schedules.ok) expect(schedules.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('T7.3 边界条件：较多记录', () => {
  it('学生列表分页在较多记录下 total 正确且分页数量正确', async () => {
    for (let i = 0; i < 25; i += 1) {
      await createStudent(`学生${String(i).padStart(2, '0')}`);
    }

    const result = await createStudentService(prisma).listStudents({ teacherId: TEACHER_ID, page: 2, pageSize: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(25);
    expect(result.value.items).toHaveLength(10);
  });
});

describe('T7.3 边界条件：外部依赖失败', () => {
  it('归档 storage 失败时透传错误，不返回成功归档结果', async () => {
    const storage: StorageService = {
      save: vi.fn(async () => err(validationError('磁盘不可写', 'storage'))),
      read: vi.fn(),
      delete: vi.fn(),
    };
    const useCase = createAutoArchiveUseCase({ storage });

    const result = await useCase.autoArchive({
      archiveType: 'lesson',
      recordId: 'lesson-1',
      studentName: '张三',
      date: new Date('2025-05-01T10:00:00+08:00'),
      title: '张三课次记录',
      sections: [{ heading: '课堂内容', content: '力学复习' }],
    });

    expect(result.ok).toBe(false);
    expect(storage.save).toHaveBeenCalledTimes(1);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.message).toContain('磁盘不可写');
  });
});
