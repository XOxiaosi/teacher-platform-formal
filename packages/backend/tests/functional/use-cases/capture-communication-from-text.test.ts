import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, ok, internalError } from '@teacher-platform/contracts';
import { createCommunicationService } from '../../../src/features/student-communications/communication-service.js';
import {
  createCaptureCommunicationFromTextUseCase,
  normalizeCommunicationExtraction,
} from '../../../src/app/use-cases/capture-communication-from-text/capture-communication-from-text-use-case.js';
import type { AiClient, AiOutput } from '../../../src/shared/ai-client/types.js';

const prisma = new PrismaClient();
const communications = createCommunicationService(prisma);

const TEACHER_ID = 'test-teacher-capture-comm';
const OTHER_TEACHER_ID = 'test-teacher-capture-comm-other';

function mockAiClient(response: () => ReturnType<AiClient['run']>) {
  const run = vi.fn(response);
  const client: AiClient = {
    run,
    chat: vi.fn(),
  };
  return { client, run };
}

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

describe('captureCommunicationFromText.execute', () => {
  it('成功全链路：AI 返回完整字段，建出 record+detail+sourceRecord', async () => {
    const student = await createStudent(TEACHER_ID, '张三');
    const aiOutput: AiOutput = {
      direction: 'inbound',
      channel: 'phone',
      parentType: 'scores',
      parentConcerns: ['作业太多', '睡眠不足'],
      teacherResponses: ['约好减量', '下周调整'],
      agreements: ['减少周末作业量'],
      followUps: ['下周三回访'],
      nextContactAt: '2026-08-28T10:00:00.000Z',
      summary: '家长来电反映作业量问题',
      confidence: 'high',
    };
    const { client, run } = mockAiClient(() => Promise.resolve(ok(aiOutput)));
    const useCase = createCaptureCommunicationFromTextUseCase({ prisma, aiClient: client, communications });

    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      studentId: student.id,
      rawText: '家长打电话来说作业太多孩子睡不好，我约好了下周减量',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.value.studentId).toBe(student.id);
    expect(result.value.extraction.direction).toBe('inbound');
    expect(result.value.extraction.channel).toBe('phone');
    expect(result.value.extraction.parentType).toBe('scores');
    expect(result.value.extraction.parentConcerns).toEqual(['作业太多', '睡眠不足']);
    expect(result.value.extraction.teacherResponses).toEqual(['约好减量', '下周调整']);
    expect(result.value.extraction.agreements).toEqual(['减少周末作业量']);
    expect(result.value.extraction.followUps).toEqual(['下周三回访']);
    expect(result.value.extraction.nextContactAt).toBe('2026-08-28T10:00:00.000Z');
    expect(result.value.extraction.summary).toBe('家长来电反映作业量问题');
    expect(result.value.extraction.confidence).toBe('high');

    expect(result.value.detail.direction).toBe('inbound');
    expect(result.value.detail.channel).toBe('phone');
    expect(result.value.detail.parentType).toBe('scores');
    expect(result.value.detail.parentConcerns).toEqual(['作业太多', '睡眠不足']);
    expect(result.value.detail.teacherResponses).toEqual(['约好减量', '下周调整']);
    expect(result.value.detail.agreements).toEqual(['减少周末作业量']);
    expect(result.value.detail.followUps).toEqual(['下周三回访']);
    expect(result.value.detail.nextContactAtTs?.toISOString()).toBe('2026-08-28T10:00:00.000Z');

    expect(result.value.record.sourceRecordId).not.toBeNull();
    expect(result.value.sourceRecord).not.toBeNull();
    expect(result.value.sourceRecord?.id).toBe(result.value.record.sourceRecordId);
  });

  it('owner 隔离：别的老师的 studentId → NOT_FOUND，且 aiClient.run 未被调用', async () => {
    const otherStudent = await createStudent(OTHER_TEACHER_ID, '别家学生');
    const { client, run } = mockAiClient(() => Promise.resolve(ok({})));
    const useCase = createCaptureCommunicationFromTextUseCase({ prisma, aiClient: client, communications });

    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      studentId: otherStudent.id,
      rawText: '家长说作业太多',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(run).not.toHaveBeenCalled();
  });

  it('rawText 空 → VALIDATION_ERROR，不调用 AI', async () => {
    const student = await createStudent(TEACHER_ID, '李四');
    const { client, run } = mockAiClient(() => Promise.resolve(ok({})));
    const useCase = createCaptureCommunicationFromTextUseCase({ prisma, aiClient: client, communications });

    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      studentId: student.id,
      rawText: '   ',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('rawText');
    expect(run).not.toHaveBeenCalled();
  });

  it('AI 全空（direction/数组/summary 全无）→ VALIDATION_ERROR，不写记录', async () => {
    const student = await createStudent(TEACHER_ID, '王五');
    const beforeCount = await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } });
    const aiOutput: AiOutput = { confidence: 'medium' };
    const { client } = mockAiClient(() => Promise.resolve(ok(aiOutput)));
    const useCase = createCaptureCommunicationFromTextUseCase({ prisma, aiClient: client, communications });

    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      studentId: student.id,
      rawText: '今天天气不错',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('rawText');

    const afterCount = await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } });
    expect(afterCount).toBe(beforeCount);
  });

  it('AI 返回非法 direction → 归一化为 null，回退 two_way，不报错', async () => {
    const student = await createStudent(TEACHER_ID, '孙六');
    const aiOutput: AiOutput = {
      direction: 'invalid_dir',
      parentConcerns: ['作业多'],
      summary: '有诉求',
    };
    const { client } = mockAiClient(() => Promise.resolve(ok(aiOutput)));
    const useCase = createCaptureCommunicationFromTextUseCase({ prisma, aiClient: client, communications });

    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      studentId: student.id,
      rawText: '家长说作业多',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extraction.direction).toBeNull();
    // 回退 two_way
    expect(result.value.detail.direction).toBe('two_way');
  });

  it('AI 返回非法 nextContactAt → VALIDATION_ERROR', async () => {
    const student = await createStudent(TEACHER_ID, '周七');
    const aiOutput: AiOutput = {
      direction: 'inbound',
      nextContactAt: '不是日期',
      summary: '测试非法日期',
    };
    const { client } = mockAiClient(() => Promise.resolve(ok(aiOutput)));
    const useCase = createCaptureCommunicationFromTextUseCase({ prisma, aiClient: client, communications });

    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      studentId: student.id,
      rawText: '随便说点啥',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('nextContactAt');
  });

  it('aiClient.run 返回 internalError → 透传，不写库', async () => {
    const student = await createStudent(TEACHER_ID, '吴八');
    const beforeCount = await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } });
    const { client } = mockAiClient(() => Promise.resolve(err(internalError('AI 调用失败'))));
    const useCase = createCaptureCommunicationFromTextUseCase({ prisma, aiClient: client, communications });

    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      studentId: student.id,
      rawText: '家长来电',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.message).toBe('AI 调用失败');

    const afterCount = await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } });
    expect(afterCount).toBe(beforeCount);
  });

  it('direction 为空但有 parentConcerns → 走默认 two_way，成功创建', async () => {
    const student = await createStudent(TEACHER_ID, '郑九');
    const aiOutput: AiOutput = {
      parentConcerns: ['作业太多'],
    };
    const { client } = mockAiClient(() => Promise.resolve(ok(aiOutput)));
    const useCase = createCaptureCommunicationFromTextUseCase({ prisma, aiClient: client, communications });

    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      studentId: student.id,
      rawText: '家长反映作业太多孩子睡不好',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.detail.direction).toBe('two_way');
    expect(result.value.detail.parentConcerns).toEqual(['作业太多']);
  });
});

describe('normalizeCommunicationExtraction 纯函数', () => {
  it('direction 合法值保留，非法变 null', () => {
    const r1 = normalizeCommunicationExtraction({ direction: 'inbound' });
    expect(r1.ok && r1.value.extraction.direction).toBe('inbound');

    const r2 = normalizeCommunicationExtraction({ direction: 'invalid' });
    expect(r2.ok && r2.value.extraction.direction).toBeNull();

    const r3 = normalizeCommunicationExtraction({ direction: null });
    expect(r3.ok && r3.value.extraction.direction).toBeNull();
  });

  it('channel 合法值保留，非法变 null', () => {
    const r1 = normalizeCommunicationExtraction({ channel: 'phone' });
    expect(r1.ok && r1.value.extraction.channel).toBe('phone');

    const r2 = normalizeCommunicationExtraction({ channel: 'email' });
    expect(r2.ok && r2.value.extraction.channel).toBeNull();
  });

  it('parentType 合法值保留，非法变 null', () => {
    const r1 = normalizeCommunicationExtraction({ parentType: 'scores' });
    expect(r1.ok && r1.value.extraction.parentType).toBe('scores');

    const r2 = normalizeCommunicationExtraction({ parentType: 'unknown' });
    expect(r2.ok && r2.value.extraction.parentType).toBeNull();
  });

  it('数组字段：字符串数组保留，非数组变 null，元素 trim，空字符串过滤', () => {
    const r1 = normalizeCommunicationExtraction({ parentConcerns: ['作业多', ' 睡不好 '] });
    expect(r1.ok && r1.value.extraction.parentConcerns).toEqual(['作业多', '睡不好']);

    const r2 = normalizeCommunicationExtraction({ parentConcerns: 'not array' });
    expect(r2.ok && r2.value.extraction.parentConcerns).toBeNull();

    const r3 = normalizeCommunicationExtraction({ teacherResponses: ['', '  ', '有效'] });
    expect(r3.ok && r3.value.extraction.teacherResponses).toEqual(['有效']);

    const r4 = normalizeCommunicationExtraction({ agreements: [1, 2, '三个'] as any });
    expect(r4.ok && r4.value.extraction.agreements).toEqual(['三个']);
  });

  it('nextContactAt 有效 RFC3339 → 保留原值且 parsed 为 Date', () => {
    const result = normalizeCommunicationExtraction({ nextContactAt: '2026-08-28T10:00:00Z' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extraction.nextContactAt).toBe('2026-08-28T10:00:00Z');
    expect(result.value.nextContactAtParsed).toBeInstanceOf(Date);
    expect(result.value.nextContactAtParsed?.toISOString()).toBe('2026-08-28T10:00:00.000Z');
  });

  it('nextContactAt 无效字符串 → VALIDATION_ERROR', () => {
    const result = normalizeCommunicationExtraction({ nextContactAt: 'not-a-date' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('nextContactAt');
  });

  it('summary trim 处理', () => {
    const r1 = normalizeCommunicationExtraction({ summary: '  家长来电  ' });
    expect(r1.ok && r1.value.extraction.summary).toBe('家长来电');

    const r2 = normalizeCommunicationExtraction({ summary: '   ' });
    expect(r2.ok && r2.value.extraction.summary).toBeNull();
  });

  it('confidence 合法保留，非法变 null', () => {
    const r1 = normalizeCommunicationExtraction({ confidence: 'high' });
    expect(r1.ok && r1.value.extraction.confidence).toBe('high');

    const r2 = normalizeCommunicationExtraction({ confidence: 'unknown' });
    expect(r2.ok && r2.value.extraction.confidence).toBeNull();
  });

  it('空对象返回全 null', () => {
    const result = normalizeCommunicationExtraction({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extraction.direction).toBeNull();
    expect(result.value.extraction.channel).toBeNull();
    expect(result.value.extraction.parentType).toBeNull();
    expect(result.value.extraction.parentConcerns).toBeNull();
    expect(result.value.extraction.teacherResponses).toBeNull();
    expect(result.value.extraction.agreements).toBeNull();
    expect(result.value.extraction.followUps).toBeNull();
    expect(result.value.extraction.nextContactAt).toBeNull();
    expect(result.value.extraction.summary).toBeNull();
    expect(result.value.extraction.confidence).toBeNull();
  });

  it('direction 大小写不敏感（归一化到小写）', () => {
    const result = normalizeCommunicationExtraction({ direction: 'INBOUND' });
    expect(result.ok && result.value.extraction.direction).toBe('inbound');
  });
});
