import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createMorningBriefUseCase } from '../../../src/app/use-cases/morning-brief/index.js';
import type { MessageAdapter } from '../../../src/adapters/shared/index.js';
import type { WeatherAdapter } from '../../../src/adapters/weather/index.js';

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-morning-brief';

async function cleanup() {
  await prisma.pushRecord.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.payment.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.schedule.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
}

async function createStudent(name: string) {
  return prisma.student.create({ data: { teacherId: TEACHER_ID, name, grade: '高二' } });
}

function createPushAdapter(): MessageAdapter {
  return { send: vi.fn(async () => ok({ providerMessageId: 'morning-brief-1' })) };
}

function createWeatherAdapter(): WeatherAdapter {
  return { query: vi.fn(async () => ok({ city: '福州', weather: '晴', temperatureC: 30 })) };
}

beforeEach(async () => { await cleanup(); });
afterEach(async () => { await cleanup(); });

describe('morningBriefUseCase.sendMorningBrief', () => {
  it('组装天气、今日日程、今日缴费摘要并发送早安简报', async () => {
    const studentA = await createStudent('李四');
    const studentB = await createStudent('王五');
    await prisma.schedule.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: studentB.id,
        type: 'lesson',
        title: '王五物理课',
        scheduledStartTs: new Date('2025-03-20T09:00:00+08:00'),
        scheduledEndTs: new Date('2025-03-20T10:30:00+08:00'),
        status: 'planned',
      },
    });
    await prisma.schedule.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: studentA.id,
        type: 'lesson',
        title: '李四物理课',
        scheduledStartTs: new Date('2025-03-20T14:00:00+08:00'),
        scheduledEndTs: new Date('2025-03-20T15:30:00+08:00'),
        status: 'planned',
      },
    });
    await prisma.schedule.create({
      data: {
        teacherId: TEACHER_ID,
        type: 'meeting',
        title: '教研会',
        scheduledStartTs: new Date('2025-03-21T09:00:00+08:00'),
        scheduledEndTs: new Date('2025-03-21T10:00:00+08:00'),
        status: 'planned',
      },
    });
    await prisma.payment.create({
      data: { teacherId: TEACHER_ID, studentId: studentA.id, amount: 1200, lessonCount: 8, paidAtTs: new Date('2025-03-20T11:00:00+08:00') },
    });
    await prisma.payment.create({
      data: { teacherId: TEACHER_ID, studentId: studentB.id, amount: 900, lessonCount: 6, paidAtTs: new Date('2025-03-19T11:00:00+08:00') },
    });
    const pushAdapter = createPushAdapter();
    const weather = createWeatherAdapter();
    const useCase = createMorningBriefUseCase({ prisma, weather, pushAdapters: { 'wechat-bot': pushAdapter } });

    const result = await useCase.sendMorningBrief({
      teacherId: TEACHER_ID,
      date: new Date('2025-03-20T08:00:00+08:00'),
      city: '福州',
      channel: 'wechat-bot',
    });

    expect(result.ok).toBe(true);
    expect(weather.query).toHaveBeenCalledWith({ city: '福州' });
    expect(pushAdapter.send).toHaveBeenCalledTimes(1);
    const sentContent = vi.mocked(pushAdapter.send).mock.calls[0]![0].content;
    expect(sentContent).toContain('早安简报｜2025-03-20');
    expect(sentContent).toContain('天气：福州 晴 30℃');
    expect(sentContent).toContain('今日安排（2项）');
    expect(sentContent).toContain('09:00-10:30 王五物理课');
    expect(sentContent).toContain('14:00-15:30 李四物理课');
    expect(sentContent).toContain('今日缴费：1 笔，8 课时，¥1200');
    if (!result.ok) return;
    expect(result.value.content).toBe(sentContent);
    expect(result.value.pushRecord.type).toBe('morning_brief');
    expect(result.value.pushRecord.status).toBe('sent');
  });

  it('天气查询失败时不发送推送并透传错误', async () => {
    const pushAdapter = createPushAdapter();
    const weather: WeatherAdapter = { query: vi.fn(async () => ({ ok: false, error: { code: 'INTERNAL_ERROR', message: '天气失败' } })) };
    const useCase = createMorningBriefUseCase({ prisma, weather, pushAdapters: { 'wechat-bot': pushAdapter } });

    const result = await useCase.sendMorningBrief({
      teacherId: TEACHER_ID,
      date: new Date('2025-03-20T08:00:00+08:00'),
      city: '福州',
      channel: 'wechat-bot',
    });

    expect(result.ok).toBe(false);
    expect(pushAdapter.send).not.toHaveBeenCalled();
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
  });
});
