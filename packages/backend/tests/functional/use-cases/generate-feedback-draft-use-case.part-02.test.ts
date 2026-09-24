import { describe, it, expect, vi } from 'vitest';
import { TEACHER_A, createMockRuntimeDriver, buildUseCase, createStudentFixture, createLessonFixture, createParentFeedbackFixture } from './generate-feedback-draft-use-case.fixtures.js';
describe("generate-feedback-draft use-case", () => {



  it('传入 classSize/parentType/focus 时 user 消息含对应中文标签并回显在 result 中', async () => {
    const student = await createStudentFixture(TEACHER_A, '陈十三');
    const lesson = await createLessonFixture({
      teacherId: TEACHER_A,
      studentId: student.id,
      progress: '阅读理解专项训练',
    });
    const runtimeDriver = createMockRuntimeDriver({
      ok: true,
      value: { content: '标题：陈十三阅读反馈\n内容：陈十三阅读理解有进步。\n所以这样写：抓住阅读进步给家长确定感。' },
    });

    const useCase = buildUseCase(runtimeDriver);
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

    const userContent = vi.mocked(runtimeDriver.run).mock.calls[0][0].message;
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
    const runtimeDriver = createMockRuntimeDriver({
      ok: true,
      value: {
        content: '标题：黄十四力学反馈\n内容：黄十四力学专题练习思路清晰，受力分析做得很到位。\n所以这样写：用受力分析这个具体动作证明能力提升，不空夸。',
      },
    });

    const useCase = buildUseCase(runtimeDriver);
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
    const runtimeDriver = createMockRuntimeDriver({
      ok: true,
      value: { content: '标题：徐十五电磁反馈\n内容：徐十五电磁感应掌握不错。' },
    });

    const useCase = buildUseCase(runtimeDriver);
    const result = await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rationale).toBe('');
  });


  it('历史反馈内容不会成为未经重新准入的新事实', async () => {
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

    const runtimeDriver = createMockRuntimeDriver({
      ok: true,
      value: { content: '标题：何十六函数反馈\n内容：何十六函数单调性掌握很好。\n所以这样写：突出具体进步点。' },
    });

    const useCase = buildUseCase(runtimeDriver);
    const result = await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
    });

    expect(result.ok).toBe(true);

    const userContent = vi.mocked(runtimeDriver.run).mock.calls[0][0].message;
    expect(userContent).toContain('该生近期历史反馈（避免雷同）');
    expect(userContent).not.toContain('上次函数反馈');
    expect(userContent).not.toContain('上上次几何反馈');
    expect(userContent).not.toContain('几何证明步骤需加强');
  });


  it('无历史反馈时 user 消息历史反馈段写"无"', async () => {
    const student = await createStudentFixture(TEACHER_A, '吕十七');
    const lesson = await createLessonFixture({
      teacherId: TEACHER_A,
      studentId: student.id,
      progress: '三角函数',
    });
    const runtimeDriver = createMockRuntimeDriver({
      ok: true,
      value: { content: '标题：吕十七三角反馈\n内容：吕十七三角函数入门顺利。\n所以这样写：入门阶段给家长正面反馈。' },
    });

    const useCase = buildUseCase(runtimeDriver);
    const result = await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
    });

    expect(result.ok).toBe(true);
    const userContent = vi.mocked(runtimeDriver.run).mock.calls[0][0].message;
    // 匹配"该生近期历史反馈（避免雷同）："之后紧跟的是"无"
    const match = userContent.match(/该生近期历史反馈（避免雷同）：\s*\n(\S+)/);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('无');
  });


  it('任何状态的历史草稿均不作为新回答事实输入', async () => {
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

    const runtimeDriver = createMockRuntimeDriver({
      ok: true,
      value: { content: '标题：施十八几何反馈\n内容：施十八立体几何有进步。\n所以这样写：突出空间想象能力提升。' },
    });

    const useCase = buildUseCase(runtimeDriver);
    const result = await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
    });

    expect(result.ok).toBe(true);
    const userContent = vi.mocked(runtimeDriver.run).mock.calls[0][0].message;
    // 3 条有效都在
    expect(userContent).not.toContain('最新一条');
    expect(userContent).not.toContain('第二条');
    expect(userContent).not.toContain('第三条');
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
    const runtimeDriver = createMockRuntimeDriver({
      ok: true,
      value: { content: '标题：张十九数列反馈\n内容：张十九数列求和方法掌握良好。\n所以这样写：用方法掌握度给家长确定感。' },
    });

    const useCase = buildUseCase(runtimeDriver);
    await useCase.execute({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonIds: [lesson.id],
    });

    const systemContent = vi.mocked(runtimeDriver.run).mock.calls[0][0].message
      .split('\n\n本次材料：')[0];
    expect(systemContent).toContain('与近期历史反馈对比');
    expect(systemContent).toContain('避免同一切入点');
  });
});
