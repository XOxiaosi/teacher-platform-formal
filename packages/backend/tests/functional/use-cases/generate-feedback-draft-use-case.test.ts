import { describe, it, expect, vi } from 'vitest';
import { ok } from '@teacher-platform/contracts';
import type { ChatMessage } from '../../../src/shared/ai-client/types.js';
import { createAssembleParentFeedbackContextUseCase } from '../../../src/app/use-cases/assemble-parent-feedback-context/assemble-parent-feedback-context-use-case.js';
import type { TeachingRuntimeDriver } from '../../../src/app/teaching-runtime/runtime-driver.js';
import { prisma, TEACHER_A, TEACHER_B, requireUseCaseFactory, createMockAiClient, buildUseCase, createStudentFixture, createLessonFixture, createAssessmentRecord } from './generate-feedback-draft-use-case.fixtures.js';
describe("generate-feedback-draft use-case", () => {


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

  it('正式适配可只通过 DSH driver 生成，并使用持久任务身份且不开放工具', async () => {
    const student = await createStudentFixture(TEACHER_A, '合成学生');
    const lesson = await createLessonFixture({
      teacherId: TEACHER_A,
      studentId: student.id,
      progress: '完成三道计算题',
    });
    const run = vi.fn<TeachingRuntimeDriver['run']>(async input => ok({
      reply: '标题：本次课堂进展\n内容：今天独立完成三道计算题，下一次继续练习验算。\n所以这样写：使用已确认的课堂事实。',
      sessionRef: `dsh:${input.taskId}`,
      status: 'succeeded',
      checkpoint: null,
      cost: { modelCalls: 1, inputTokens: 100, outputTokens: 40, toolCalls: 0, synthetic: true },
    }));
    const runtimeDriver: TeachingRuntimeDriver = { availability: 'test', runtimeVersion: 'dsh-v1', run };
    const context = createAssembleParentFeedbackContextUseCase({ prisma });
    const useCase = requireUseCaseFactory()({ prisma, runtimeDriver, context });

    const result = await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
      runtime: { taskId: 'feedback-task-1', executionId: 'attempt-1', contextEpoch: 0 },
    });

    expect(result).toMatchObject({ ok: true, value: { title: '本次课堂进展' } });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      teacherId: TEACHER_A,
      taskId: 'feedback-task-1',
      executionId: 'attempt-1',
      contextEpoch: 0,
      sessionRef: null,
      history: [],
      tools: expect.objectContaining({ definitions: [] }),
      message: expect.stringContaining('完成三道计算题'),
    }));
    await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
      runtime: { taskId: 'feedback-task-1', executionId: 'attempt-1', contextEpoch: 0, resume: true },
    });
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({
      taskId: 'feedback-task-1',
      executionId: 'attempt-1',
      sessionRef: expect.stringMatching(/^teaching-/),
    }));
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
    expect(result.error.field).toBe('evidence');
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
});
