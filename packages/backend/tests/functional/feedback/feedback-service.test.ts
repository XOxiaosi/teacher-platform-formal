import { describe, it, expect } from 'vitest';

import { prisma, TEACHER_A, TEACHER_B, createService, createStudentFixture, createLessonFixture } from './feedback-service.fixtures.js';
describe("feedbackService.createFeedback", () => {


  it('创建 draft 家长反馈，保存学生、课程、渠道与家长姓名', async () => {
    const student = await createStudentFixture(TEACHER_A, '张三');
    const lesson = await createLessonFixture(TEACHER_A, student.id);

    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonId: lesson.id,
      title: '张三本周学习反馈',
      content: '课堂状态稳定，力学计算准确率提升。',
      channel: 'wechat',
      parentName: '张三妈妈',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.teacherId).toBe(TEACHER_A);
    expect(result.value.studentId).toBe(student.id);
    expect(result.value.lessonId).toBe(lesson.id);
    expect(result.value.title).toBe('张三本周学习反馈');
    expect(result.value.content).toBe('课堂状态稳定，力学计算准确率提升。');
    expect(result.value.status).toBe('draft');
    expect(result.value.channel).toBe('wechat');
    expect(result.value.parentName).toBe('张三妈妈');
    expect(result.value.sentAt).toBeNull();
  });


  it('title 或 content 为空返回 VALIDATION_ERROR', async () => {
    const student = await createStudentFixture(TEACHER_A, '李四');

    const titleResult = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '',
      content: '有效内容',
    });
    expect(titleResult.ok).toBe(false);
    if (titleResult.ok) return;
    expect(titleResult.error.code).toBe('VALIDATION_ERROR');
    expect(titleResult.error.field).toBe('title');

    const contentResult = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '有效标题',
      content: '',
    });
    expect(contentResult.ok).toBe(false);
    if (contentResult.ok) return;
    expect(contentResult.error.code).toBe('VALIDATION_ERROR');
    expect(contentResult.error.field).toBe('content');
  });


  it('拒绝关联其他 teacher 的学生，且零写入', async () => {
    const otherStudent = await createStudentFixture(TEACHER_B, '其他老师学生');

    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: otherStudent.id,
      title: '跨老师学生反馈',
      content: '不应创建',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(expect.objectContaining({ code: 'NOT_FOUND', message: '学生不存在' }));
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });


  it('拒绝关联其他 teacher 的课次，且零写入', async () => {
    const studentA = await createStudentFixture(TEACHER_A, '当前老师学生');
    const studentB = await createStudentFixture(TEACHER_B, '其他老师学生');
    const otherLesson = await createLessonFixture(TEACHER_B, studentB.id);

    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: studentA.id,
      lessonId: otherLesson.id,
      title: '跨老师课次反馈',
      content: '不应创建',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(expect.objectContaining({ code: 'NOT_FOUND', message: '课次不存在' }));
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });


  it('拒绝 lesson 与 student 不一致的反馈，且零写入', async () => {
    const selectedStudent = await createStudentFixture(TEACHER_A, '被选择学生');
    const lessonStudent = await createStudentFixture(TEACHER_A, '课次所属学生');
    const lesson = await createLessonFixture(TEACHER_A, lessonStudent.id);

    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: selectedStudent.id,
      lessonId: lesson.id,
      title: '错配课次反馈',
      content: '不应创建',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(expect.objectContaining({ code: 'NOT_FOUND', message: '课次不存在' }));
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });
});
