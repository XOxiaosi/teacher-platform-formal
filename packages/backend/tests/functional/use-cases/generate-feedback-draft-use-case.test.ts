import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { AiClient, ChatMessage, ChatResponse, ChatToolDefinition } from '../../../src/shared/ai-client/types.js';
import type { CommonError, Result } from '@teacher-platform/contracts';
import { createAssembleParentFeedbackContextUseCase } from '../../../src/app/use-cases/assemble-parent-feedback-context/assemble-parent-feedback-context-use-case.js';

let createGenerateFeedbackDraftUseCase: unknown;
let importError: unknown;
try {
  const mod = await import('../../../src/app/use-cases/generate-feedback-draft/generate-feedback-draft-use-case.js');
  createGenerateFeedbackDraftUseCase = mod.createGenerateFeedbackDraftUseCase;
} catch (e) {
  importError = e;
}

interface GenerateFeedbackDraftUseCase {
  execute(input: {
    teacherId: string;
    studentId: string;
    lessonIds?: string[];
    tone?: 'formal' | 'warm' | 'concise';
    classSize?: '1v1' | 'small' | 'large';
    parentType?: 'normal' | 'scores' | 'sensitive';
    focus?: 'highlight' | 'problem' | 'cooperation' | 'summary';
  }): Promise<Result<{
    studentId: string;
    lessonIds: string[];
    title: string;
    content: string;
    rationale: string;
    source: 'ai';
    evidence: Array<{
      id: string;
      type: 'assessment' | 'record' | 'lesson';
      occurredAt: string;
      category: string | null;
      summary: string | null;
      examName: string | null;
      subject: string | null;
      score: number | null;
      fullScore: number | null;
      previousScore: number | null;
    }>;
    windowStart: string;
    windowEnd: string;
    classSize?: '1v1' | 'small' | 'large';
    parentType?: 'normal' | 'scores' | 'sensitive';
    focus?: 'highlight' | 'problem' | 'cooperation' | 'summary';
  }, CommonError>>;
}

const prisma = new PrismaClient();
const TEACHER_A = 'test-teacher-feedback-draft-a';
const TEACHER_B = 'test-teacher-feedback-draft-b';

function requireUseCaseFactory() {
  if (importError) {
    throw new Error(
      `generate-feedback-draft use-case import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (!createGenerateFeedbackDraftUseCase) {
    throw new Error('generate-feedback-draft use-case loaded but factory export is missing');
  }
  return createGenerateFeedbackDraftUseCase as (options: { prisma: PrismaClient; aiClient: AiClient; context: ReturnType<typeof createAssembleParentFeedbackContextUseCase> }) => GenerateFeedbackDraftUseCase;
}

function createMockAiClient(chatResult: Result<ChatResponse, CommonError>): AiClient {
  return {
    run: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    chat: vi.fn(async (_messages: ChatMessage[], _tools: ChatToolDefinition[]) => chatResult),
  };
}

function buildUseCase(aiClient: AiClient) {
  const context = createAssembleParentFeedbackContextUseCase({ prisma });
  return requireUseCaseFactory()({ prisma, aiClient, context });
}

async function cleanup() {
  await prisma.assessmentDetail.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.studentRecord.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
}

async function createStudentFixture(teacherId: string, name: string) {
  return prisma.student.create({
    data: {
      teacherId,
      name,
      grade: '高一',
      source: 'test',
      stageGoal: '提升力学综合题稳定性',
    },
  });
}

async function createLessonFixture(input: { teacherId: string; studentId: string; progress: string; studentState?: string; homework?: string; dateTs?: Date }) {
  const dateTs = input.dateTs ?? new Date('2026-09-01T10:00:00Z');
  const schedule = await prisma.schedule.create({
    data: {
      teacherId: input.teacherId,
      studentId: input.studentId,
      type: 'lesson',
      title: '反馈草稿关联课程',
      scheduledStartTs: dateTs,
      scheduledEndTs: new Date(dateTs.getTime() + 90 * 60 * 1000),
    },
  });

  return prisma.lesson.create({
    data: {
      teacherId: input.teacherId,
      studentId: input.studentId,
      scheduleId: schedule.id,
      dateTs,
      status: 'attended',
      progress: input.progress,
      studentState: input.studentState ?? null,
      homework: input.homework ?? null,
    },
  });
}

async function createAssessmentRecord(opts: {
  teacherId: string;
  studentId: string;
  occurredAt: Date;
  summary: string;
  examName?: string;
  subject?: string;
  score?: number;
  fullScore?: number;
  previousScore?: number;
}) {
  const record = await prisma.studentRecord.create({
    data: {
      teacherId: opts.teacherId,
      studentId: opts.studentId,
      category: 'assessment',
      occurredAtTs: opts.occurredAt,
      summary: opts.summary,
      reviewStatus: 'confirmed',
      visibility: 'parent_shareable',
      importance: 'normal',
    },
  });
  if (opts.examName || opts.subject || opts.score !== undefined) {
    await prisma.assessmentDetail.create({
      data: {
        teacherId: opts.teacherId,
        studentRecordId: record.id,
        examName: opts.examName ?? null,
        subject: opts.subject ?? null,
        score: opts.score ?? null,
        fullScore: opts.fullScore ?? null,
        previousScore: opts.previousScore ?? null,
      },
    });
  }
  return record;
}

async function createParentFeedbackFixture(opts: {
  teacherId: string;
  studentId: string;
  title: string;
  content: string;
  status?: string;
  createdAtTs?: Date;
}) {
  return prisma.parentFeedback.create({
    data: {
      teacherId: opts.teacherId,
      studentId: opts.studentId,
      title: opts.title,
      content: opts.content,
      status: opts.status ?? 'draft',
      createdAtTs: opts.createdAtTs ?? new Date(),
    },
  });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('generate-feedback-draft use-case', () => {
  it('模块可导入并导出 createGenerateFeedbackDraftUseCase', () => {
    const factory = requireUseCaseFactory();
    expect(factory).toBeTypeOf('function');
  });

  it('根据学生与指定课程调用 aiClient.chat 生成反馈草稿，不创建 ParentFeedback 记录', async () => {
    const student = await createStudentFixture(TEACHER_A, '张三');
    const lesson = await createLessonFixture({
      teacherId: TEACHER_A,
      studentId: student.id,
      progress: '完成牛顿第二定律综合题训练',
      studentState: '课堂专注，计算细节仍需巩固',
      homework: '完成力学专题第 3 讲',
    });
    const aiClient = createMockAiClient({
      ok: true,
      value: {
        content: '标题：张三本周物理学习反馈\n内容：张三本周课堂专注度较好，牛顿第二定律综合题有明显进步。建议继续巩固计算细节。\n所以这样写：用课堂专注+具体知识点进步给家长确定感。',
      },
    });

    const useCase = buildUseCase(aiClient);
    const result = await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
      tone: 'warm',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.studentId).toBe(student.id);
    expect(result.value.lessonIds).toEqual([lesson.id]);
    expect(result.value.title).toBe('张三本周物理学习反馈');
    expect(result.value.content).toContain('牛顿第二定律综合题有明显进步');
    expect(result.value.rationale).toContain('确定感');
    expect(result.value.source).toBe('ai');
    expect(result.value.evidence).toBeDefined();
    expect(result.value.windowStart).toBeDefined();
    expect(result.value.windowEnd).toBeDefined();
    expect(aiClient.chat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user', content: expect.stringContaining('张三') }),
      ]),
      [],
    );

    const savedCount = await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } });
    expect(savedCount).toBe(0);
  });

  it('system prompt 为通用课后反馈助手：不含“物理老师”等科目硬编码，且含三要素/红线/反千篇一律', async () => {
    const student = await createStudentFixture(TEACHER_A, '吴十');
    const lesson = await createLessonFixture({
      teacherId: TEACHER_A,
      studentId: student.id,
      progress: '完成一次函数图像与性质练习',
      studentState: '图像平移仍需巩固',
    });
    const aiClient = createMockAiClient({
      ok: true,
      value: { content: '标题：吴十本周学习反馈\n内容：吴十完成了一次函数图像与性质练习，图像平移仍需巩固，接下来针对性训练。\n所以这样写：抓住图像平移这个点，给家长明确的下一步。' },
    });

    const useCase = buildUseCase(aiClient);
    await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
      tone: 'warm',
    });

    expect(aiClient.chat).toHaveBeenCalledTimes(1);
    const messages = vi.mocked(aiClient.chat).mock.calls[0][0] as ChatMessage[];
    const systemMessage = messages.find((message) => message.role === 'system');
    expect(systemMessage).toBeDefined();
    const content = systemMessage!.content;

    // 移除"物理老师"等科目硬编码
    expect(content).not.toContain('物理老师');
    // 注："历史"不在此列表中，因为 system prompt 有"历史反馈"字样（不是科目含义）
    for (const subject of ['物理', '数学', '化学', '生物', '英语', '语文', '地理', '政治']) {
      expect(content).not.toContain(subject);
    }

    // 角色定位
    expect(content).toContain('课后反馈助手');

    // 方法论要素：三要素 + 家长三问
    expect(content).toContain('事实');
    expect(content).toContain('判断');
    expect(content).toContain('下一步动作');
    expect(content).toContain('发生了什么');
    expect(content).toContain('意味着什么');
    expect(content).toContain('接下来怎么办');

    // 红线 + 反千篇一律 + 长度
    expect(content).toContain('红线');
    expect(content).toContain('千篇一律');
    expect(content).toContain('100 字');

    // 输出格式约束
    expect(content).toContain('标题：');
    expect(content).toContain('内容：');
    expect(content).toContain('所以这样写：');

    // 事实来源铁律
    expect(content).toContain('事实来源铁律');
    expect(content).toContain('学生可信记录');
  });

  it('未传 lessonIds 时使用该学生最近课程生成草稿', async () => {
    const student = await createStudentFixture(TEACHER_A, '李四');
    await createLessonFixture({ teacherId: TEACHER_A, studentId: student.id, progress: '电场基础概念复习', dateTs: new Date(Date.now() - 2 * 24 * 3600 * 1000) });
    const aiClient = createMockAiClient({
      ok: true,
      value: { content: '标题：李四近期物理学习反馈\n内容：李四近期完成了电场基础概念复习。\n所以这样写：概述近期学习内容，让家长知道进度。' },
    });

    const useCase = buildUseCase(aiClient);
    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lessonIds).toHaveLength(1);
    expect(result.value.content).toContain('电场基础概念复习');
  });

  it('学生不存在或跨 teacher 返回 NOT_FOUND', async () => {
    const student = await createStudentFixture(TEACHER_A, '王五');
    const aiClient = createMockAiClient({ ok: true, value: { content: '标题：x\n内容：y\n所以这样写：z' } });
    const useCase = buildUseCase(aiClient);

    const missing = await useCase.execute({ teacherId: TEACHER_A, studentId: 'nonexistent-id' });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('NOT_FOUND');

    const crossed = await useCase.execute({ teacherId: TEACHER_B, studentId: student.id });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.code).toBe('NOT_FOUND');
  });

  it('lessonIds 包含不存在或跨 teacher 课程时返回 NOT_FOUND', async () => {
    const studentA = await createStudentFixture(TEACHER_A, '赵六');
    const studentB = await createStudentFixture(TEACHER_B, '钱七');
    const lessonB = await createLessonFixture({ teacherId: TEACHER_B, studentId: studentB.id, progress: 'B 的课程' });
    const aiClient = createMockAiClient({ ok: true, value: { content: '标题：x\n内容：y\n所以这样写：z' } });
    const useCase = buildUseCase(aiClient);

    const missing = await useCase.execute({ teacherId: TEACHER_A, studentId: studentA.id, lessonIds: ['nonexistent-id'] });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('NOT_FOUND');

    const crossed = await useCase.execute({ teacherId: TEACHER_A, studentId: studentA.id, lessonIds: [lessonB.id] });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.code).toBe('NOT_FOUND');
  });

  it('无任何记录也无课程时返回 VALIDATION_ERROR', async () => {
    const student = await createStudentFixture(TEACHER_A, '孙八');
    const aiClient = createMockAiClient({ ok: true, value: { content: '标题：x\n内容：y\n所以这样写：z' } });
    const useCase = buildUseCase(aiClient);

    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('lessonIds');
    expect(aiClient.chat).not.toHaveBeenCalled();
  });

  it('aiClient.chat 失败时返回 INTERNAL_ERROR，不创建 ParentFeedback 记录', async () => {
    const student = await createStudentFixture(TEACHER_A, '周九');
    const lesson = await createLessonFixture({ teacherId: TEACHER_A, studentId: student.id, progress: '磁场专题练习' });
    const aiClient = createMockAiClient({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '模型调用失败' },
    });
    const useCase = buildUseCase(aiClient);

    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id, lessonIds: [lesson.id] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    const savedCount = await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } });
    expect(savedCount).toBe(0);
  });

  it('生成结果包含 evidence、windowStart、windowEnd，且 user prompt 含成绩记录', async () => {
    const student = await createStudentFixture(TEACHER_A, '郑十');
    const now = new Date();
    const occurredAt = new Date(now.getTime() - 5 * 24 * 3600 * 1000);
    await createAssessmentRecord({
      teacherId: TEACHER_A,
      studentId: student.id,
      occurredAt,
      summary: '期中物理考试',
      examName: '期中考试',
      subject: '物理',
      score: 85,
      fullScore: 100,
      previousScore: 78,
    });
    // 至少有一节课以确保有依据
    await createLessonFixture({
      teacherId: TEACHER_A,
      studentId: student.id,
      progress: '复习考试内容',
      dateTs: new Date(now.getTime() - 2 * 24 * 3600 * 1000),
    });

    const aiClient = createMockAiClient({
      ok: true,
      value: { content: '标题：郑十学习反馈\n内容：郑十近期有进步。\n所以这样写：点出进步给家长信心。' },
    });
    const useCase = buildUseCase(aiClient);
    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evidence).toBeDefined();
    expect(result.value.windowStart).toBeDefined();
    expect(result.value.windowEnd).toBeDefined();
    expect(new Date(result.value.windowStart).getTime()).toBeLessThan(new Date(result.value.windowEnd).getTime());

    const assessment = result.value.evidence.find((e) => e.type === 'assessment');
    expect(assessment).toBeDefined();
    expect(assessment!.subject).toBe('物理');
    expect(assessment!.score).toBe(85);
    expect(assessment!.examName).toBe('期中考试');

    // user prompt 包含成绩信息
    expect(aiClient.chat).toHaveBeenCalledTimes(1);
    const messages = vi.mocked(aiClient.chat).mock.calls[0][0] as ChatMessage[];
    const userMessage = messages.find((m) => m.role === 'user');
    expect(userMessage).toBeDefined();
    const userContent = userMessage!.content;
    expect(userContent).toContain('学生可信记录');
    expect(userContent).toContain('物理');
    expect(userContent).toContain('85');
    expect(userContent).toContain('期中考试');
  });

  it('只有成绩记录无课程时仍能生成（不报错）', async () => {
    const student = await createStudentFixture(TEACHER_A, '王十一');
    const now = new Date();
    await createAssessmentRecord({
      teacherId: TEACHER_A,
      studentId: student.id,
      occurredAt: new Date(now.getTime() - 3 * 24 * 3600 * 1000),
      summary: '单元测试',
      examName: '单元测',
      subject: '数学',
      score: 92,
      fullScore: 100,
    });

    const aiClient = createMockAiClient({
      ok: true,
      value: { content: '标题：王十一学习反馈\n内容：王十一数学表现不错。\n所以这样写：用具体分数说话，给家长确定感。' },
    });
    const useCase = buildUseCase(aiClient);
    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lessonIds).toHaveLength(0);
    expect(result.value.evidence.some((e) => e.type === 'assessment')).toBe(true);
    expect(aiClient.chat).toHaveBeenCalledTimes(1);
  });

  // ===== 以下为新增用例 =====

  it('user 消息包含班型/家长类型/反馈目标段（未指定时显示"未指定，按默认推"）', async () => {
    const student = await createStudentFixture(TEACHER_A, '林十二');
    const lesson = await createLessonFixture({
      teacherId: TEACHER_A,
      studentId: student.id,
      progress: '函数综合训练',
    });
    const aiClient = createMockAiClient({
      ok: true,
      value: { content: '标题：林十二学习反馈\n内容：林十二函数综合训练有进步。\n所以这样写：抓住函数训练给家长确定感。' },
    });

    const useCase = buildUseCase(aiClient);
    await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
    });

    const messages = vi.mocked(aiClient.chat).mock.calls[0][0] as ChatMessage[];
    const userContent = messages.find((m) => m.role === 'user')!.content;
    expect(userContent).toContain('班型：');
    expect(userContent).toContain('未指定，按默认推');
    expect(userContent).toContain('家长类型：');
    expect(userContent).toContain('反馈目标：');
  });

  it('传入 classSize/parentType/focus 时 user 消息含对应中文标签并回显在 result 中', async () => {
    const student = await createStudentFixture(TEACHER_A, '陈十三');
    const lesson = await createLessonFixture({
      teacherId: TEACHER_A,
      studentId: student.id,
      progress: '阅读理解专项训练',
    });
    const aiClient = createMockAiClient({
      ok: true,
      value: { content: '标题：陈十三阅读反馈\n内容：陈十三阅读理解有进步。\n所以这样写：抓住阅读进步给家长确定感。' },
    });

    const useCase = buildUseCase(aiClient);
    const result = await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
      classSize: '1v1',
      parentType: 'scores',
      focus: 'highlight',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.classSize).toBe('1v1');
    expect(result.value.parentType).toBe('scores');
    expect(result.value.focus).toBe('highlight');

    const messages = vi.mocked(aiClient.chat).mock.calls[0][0] as ChatMessage[];
    const userContent = messages.find((m) => m.role === 'user')!.content;
    expect(userContent).toContain('班型：1对1');
    expect(userContent).toContain('家长类型：只认分');
    expect(userContent).toContain('反馈目标：高光/进步');
  });

  it('rationale 解析：正常三段式正确提取"所以这样写"', async () => {
    const student = await createStudentFixture(TEACHER_A, '黄十四');
    const lesson = await createLessonFixture({
      teacherId: TEACHER_A,
      studentId: student.id,
      progress: '力学专题',
    });
    const aiClient = createMockAiClient({
      ok: true,
      value: {
        content: '标题：黄十四力学反馈\n内容：黄十四力学专题练习思路清晰，受力分析做得很到位。\n所以这样写：用受力分析这个具体动作证明能力提升，不空夸。',
      },
    });

    const useCase = buildUseCase(aiClient);
    const result = await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rationale).toContain('受力分析');
    expect(result.value.rationale).toContain('不空夸');
    // content 不应包含"所以这样写"那行
    expect(result.value.content).not.toContain('所以这样写');
    expect(result.value.content).toContain('受力分析做得很到位');
  });

  it('rationale 缺省时为空字符串（不崩溃）', async () => {
    const student = await createStudentFixture(TEACHER_A, '徐十五');
    const lesson = await createLessonFixture({
      teacherId: TEACHER_A,
      studentId: student.id,
      progress: '电磁感应',
    });
    const aiClient = createMockAiClient({
      ok: true,
      value: { content: '标题：徐十五电磁反馈\n内容：徐十五电磁感应掌握不错。' },
    });

    const useCase = buildUseCase(aiClient);
    const result = await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rationale).toBe('');
  });

  it('有历史反馈时 user 消息含"近期历史反馈"段且内容来自 ParentFeedback', async () => {
    const student = await createStudentFixture(TEACHER_A, '何十六');
    const lesson = await createLessonFixture({
      teacherId: TEACHER_A,
      studentId: student.id,
      progress: '函数单调性',
    });
    await createParentFeedbackFixture({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '上次函数反馈',
      content: '上次函数单调性练习有进步，继续保持。',
      status: 'sent',
      createdAtTs: new Date(Date.now() - 7 * 24 * 3600 * 1000),
    });
    await createParentFeedbackFixture({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '上上次几何反馈',
      content: '几何证明步骤需加强。',
      status: 'draft',
      createdAtTs: new Date(Date.now() - 14 * 24 * 3600 * 1000),
    });

    const aiClient = createMockAiClient({
      ok: true,
      value: { content: '标题：何十六函数反馈\n内容：何十六函数单调性掌握很好。\n所以这样写：突出具体进步点。' },
    });

    const useCase = buildUseCase(aiClient);
    const result = await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
    });

    expect(result.ok).toBe(true);

    const messages = vi.mocked(aiClient.chat).mock.calls[0][0] as ChatMessage[];
    const userContent = messages.find((m) => m.role === 'user')!.content;
    expect(userContent).toContain('该生近期历史反馈（避免雷同）');
    expect(userContent).toContain('上次函数反馈');
    expect(userContent).toContain('上上次几何反馈');
    expect(userContent).toContain('几何证明步骤需加强');
  });

  it('无历史反馈时 user 消息历史反馈段写"无"', async () => {
    const student = await createStudentFixture(TEACHER_A, '吕十七');
    const lesson = await createLessonFixture({
      teacherId: TEACHER_A,
      studentId: student.id,
      progress: '三角函数',
    });
    const aiClient = createMockAiClient({
      ok: true,
      value: { content: '标题：吕十七三角反馈\n内容：吕十七三角函数入门顺利。\n所以这样写：入门阶段给家长正面反馈。' },
    });

    const useCase = buildUseCase(aiClient);
    const result = await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
    });

    expect(result.ok).toBe(true);
    const messages = vi.mocked(aiClient.chat).mock.calls[0][0] as ChatMessage[];
    const userContent = messages.find((m) => m.role === 'user')!.content;
    // 匹配"该生近期历史反馈（避免雷同）："之后紧跟的是"无"
    const match = userContent.match(/该生近期历史反馈（避免雷同）：\s*\n(\S+)/);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('无');
  });

  it('历史反馈仅取 draft/reviewed/sent 三种状态，最多 3 条，按 createdAtTs desc', async () => {
    const student = await createStudentFixture(TEACHER_A, '施十八');
    const lesson = await createLessonFixture({
      teacherId: TEACHER_A,
      studentId: student.id,
      progress: '立体几何',
    });
    // 4 条历史，其中 1 条 archived（应被排除），3 条有效
    await createParentFeedbackFixture({
      teacherId: TEACHER_A, studentId: student.id,
      title: '最新一条', content: '最新内容', status: 'sent',
      createdAtTs: new Date(Date.now() - 1 * 24 * 3600 * 1000),
    });
    await createParentFeedbackFixture({
      teacherId: TEACHER_A, studentId: student.id,
      title: '第二条', content: '第二条内容', status: 'reviewed',
      createdAtTs: new Date(Date.now() - 3 * 24 * 3600 * 1000),
    });
    await createParentFeedbackFixture({
      teacherId: TEACHER_A, studentId: student.id,
      title: '第三条', content: '第三条内容', status: 'draft',
      createdAtTs: new Date(Date.now() - 5 * 24 * 3600 * 1000),
    });
    await createParentFeedbackFixture({
      teacherId: TEACHER_A, studentId: student.id,
      title: '归档的', content: '归档内容', status: 'archived',
      createdAtTs: new Date(Date.now() - 7 * 24 * 3600 * 1000),
    });
    await createParentFeedbackFixture({
      teacherId: TEACHER_A, studentId: student.id,
      title: '第四条有效（应被截断）', content: '第四条有效内容', status: 'sent',
      createdAtTs: new Date(Date.now() - 10 * 24 * 3600 * 1000),
    });

    const aiClient = createMockAiClient({
      ok: true,
      value: { content: '标题：施十八几何反馈\n内容：施十八立体几何有进步。\n所以这样写：突出空间想象能力提升。' },
    });

    const useCase = buildUseCase(aiClient);
    const result = await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
    });

    expect(result.ok).toBe(true);
    const messages = vi.mocked(aiClient.chat).mock.calls[0][0] as ChatMessage[];
    const userContent = messages.find((m) => m.role === 'user')!.content;
    // 3 条有效都在
    expect(userContent).toContain('最新一条');
    expect(userContent).toContain('第二条');
    expect(userContent).toContain('第三条');
    // 归档的不在
    expect(userContent).not.toContain('归档的');
    // 第 4 条有效（take 3 截断）不在
    expect(userContent).not.toContain('第四条有效');
  });

  it('system prompt 含"与近期历史反馈对比，避免同一切入点/句式重复"反雷同要求', async () => {
    const student = await createStudentFixture(TEACHER_A, '张十九');
    const lesson = await createLessonFixture({
      teacherId: TEACHER_A,
      studentId: student.id,
      progress: '数列求和',
    });
    const aiClient = createMockAiClient({
      ok: true,
      value: { content: '标题：张十九数列反馈\n内容：张十九数列求和方法掌握良好。\n所以这样写：用方法掌握度给家长确定感。' },
    });

    const useCase = buildUseCase(aiClient);
    await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
    });

    const messages = vi.mocked(aiClient.chat).mock.calls[0][0] as ChatMessage[];
    const systemContent = messages.find((m) => m.role === 'system')!.content;
    expect(systemContent).toContain('与近期历史反馈对比');
    expect(systemContent).toContain('避免同一切入点');
  });
});
