import { describe, expect, it } from 'vitest';
import {
  createAssistantPresentationEnvelope,
  createPresentationBuilder,
  readAssistantPresentationEnvelope,
} from '../../../src/app/presentation/index.js';

describe('Presentation Builder', () => {
  it('无工具结果时返回可跨端降级的summary文档', () => {
    const document = createPresentationBuilder().build({
      summary: '  已完成查询。  ',
      toolResults: [],
    });

    expect(document).toEqual({
      schemaVersion: 1,
      summary: '已完成查询。',
      sections: [],
      references: [],
      actions: [],
    });
  });

  it('students.get只投影白名单事实、Student引用和安全导航动作', () => {
    const document = createPresentationBuilder().build({
      summary: '已找到张三。',
      toolResults: [{
        toolCallId: 'call-student',
        toolName: 'students.get',
        value: {
          id: 'student-1',
          teacherId: 'must-not-leak',
          name: '张三',
          grade: '高三',
          currentStatus: 'active',
          stageGoal: '冲刺一本',
          privateNote: '不得展示',
        },
      }],
    });

    expect(document.sections).toEqual([{
      id: 'students.get:call-student:facts',
      kind: 'facts',
      heading: '学生信息',
      items: [
        { label: '姓名', value: '张三' },
        { label: '年级', value: '高三' },
        { label: '状态', value: 'active' },
        { label: '阶段目标', value: '冲刺一本' },
      ],
    }]);
    expect(document.references).toEqual([{
      id: 'Student:student-1',
      type: 'Student',
      objectId: 'student-1',
      label: '张三',
    }]);
    expect(document.actions).toEqual([{
      id: 'open:Student:student-1',
      kind: 'open-reference',
      label: '查看张三',
      referenceId: 'Student:student-1',
    }]);
    expect(JSON.stringify(document)).not.toContain('must-not-leak');
    expect(JSON.stringify(document)).not.toContain('不得展示');
  });

  it('students.list最多投影50项并按对象去重引用', () => {
    const items = Array.from({ length: 55 }, (_, index) => ({
      id: index === 1 ? 'student-0' : `student-${index}`,
      name: index === 1 ? '重复学生' : `学生${index}`,
      grade: '高一',
      currentStatus: 'active',
      teacherId: 'must-not-leak',
    }));
    const document = createPresentationBuilder().build({
      summary: '学生列表如下。',
      toolResults: [{
        toolCallId: 'call-list',
        toolName: 'students.list',
        value: { items, total: 55 },
      }],
    });

    expect(document.sections).toHaveLength(1);
    expect(document.sections[0]).toMatchObject({ kind: 'list', heading: '学生列表' });
    expect(document.sections[0].items).toHaveLength(50);
    expect(document.references).toHaveLength(49);
    expect(document.actions).toHaveLength(49);
    expect(JSON.stringify(document)).not.toContain('must-not-leak');
  });

  it('scheduling.create规范化可信时间并生成Schedule引用', () => {
    const document = createPresentationBuilder().build({
      summary: '课程已安排。',
      toolResults: [{
        toolCallId: 'call-schedule',
        toolName: 'scheduling.create',
        value: {
          schedule: {
            id: 'schedule-1',
            title: '张三物理课',
            scheduledStart: new Date('2030-07-20T08:00:00.000Z'),
            scheduledEnd: '2030-07-20T17:30:00+08:00',
            status: 'planned',
            teacherId: 'must-not-leak',
          },
          conflicts: [],
        },
      }],
    });

    expect(document.sections[0]).toEqual({
      id: 'scheduling.create:call-schedule:facts',
      kind: 'facts',
      heading: '日程信息',
      items: [
        { label: '标题', value: '张三物理课' },
        { label: '开始', value: '2030-07-20T08:00:00.000Z' },
        { label: '结束', value: '2030-07-20T09:30:00.000Z' },
        { label: '状态', value: 'planned' },
      ],
    });
    expect(document.references).toEqual([{
      id: 'Schedule:schedule-1',
      type: 'Schedule',
      objectId: 'schedule-1',
      label: '张三物理课',
    }]);
  });

  it('scheduling.list生成最多50项的ISO时间列表和受控引用', () => {
    const document = createPresentationBuilder().build({
      summary: '课程列表如下。',
      toolResults: [{
        toolCallId: 'call-schedules',
        toolName: 'scheduling.list',
        value: {
          items: [{
            id: 'schedule-1',
            title: '周六物理课',
            scheduledStart: '2030-07-20T16:00:00+08:00',
            scheduledEnd: new Date('2030-07-20T09:30:00.000Z'),
            status: 'planned',
            sourceInput: '不得展示',
          }],
          total: 1,
        },
      }],
    });

    expect(document.sections).toEqual([{
      id: 'scheduling.list:call-schedules:list',
      kind: 'list',
      heading: '日程列表',
      items: [{
        id: 'scheduling.list:call-schedules:item:0',
        label: '周六物理课',
        detail: '2030-07-20T08:00:00.000Z 至 2030-07-20T09:30:00.000Z · planned',
        referenceId: 'Schedule:schedule-1',
      }],
    }]);
    expect(document.references).toEqual([{
      id: 'Schedule:schedule-1',
      type: 'Schedule',
      objectId: 'schedule-1',
      label: '周六物理课',
    }]);
    expect(JSON.stringify(document)).not.toContain('不得展示');
  });

  it('未知工具和非法白名单结果不复制原始JSON', () => {
    const document = createPresentationBuilder().build({
      summary: '处理完成。',
      toolResults: [
        { toolCallId: 'unknown-1', toolName: 'unknown.tool', value: { secret: 'do-not-copy' } },
        { toolCallId: 'student-bad', toolName: 'students.get', value: { id: '', name: 42 } },
      ],
    });

    expect(document).toEqual({
      schemaVersion: 1,
      summary: '处理完成。',
      sections: [],
      references: [],
      actions: [],
    });
    expect(JSON.stringify(document)).not.toContain('do-not-copy');
  });

  it('极长运行时ID不产生截断碰撞，Builder输出始终可被严格信封读回', () => {
    const longToolCallId = `call-${'x'.repeat(180)}`;
    const objectPrefix = 'student-'.padEnd(115, 'a');
    const document = createPresentationBuilder().build({
      summary: '长ID输入已安全降级。',
      toolResults: [
        {
          toolCallId: longToolCallId,
          toolName: 'students.list',
          value: { items: [{ id: 'ignored-student', name: '应被安全忽略' }] },
        },
        {
          toolCallId: 'call-safe',
          toolName: 'students.list',
          value: {
            items: [
              { id: `${objectPrefix}11111`, name: '学生一', grade: '高一', currentStatus: 'active' },
              { id: `${objectPrefix}22222`, name: '学生二', grade: '高一', currentStatus: 'active' },
            ],
          },
        },
      ],
    });

    const envelope = createAssistantPresentationEnvelope(document);
    expect(readAssistantPresentationEnvelope(envelope)).toEqual(document);
    expect(document.sections).toHaveLength(1);
    expect(JSON.stringify(document)).not.toContain('应被安全忽略');
    expect(document.actions.map((action) => action.id)).toEqual([
      'open-reference:0',
      'open-reference:1',
    ]);
  });

  it('空summary使用稳定fallback，过长summary确定性截断', () => {
    const builder = createPresentationBuilder();

    expect(builder.build({ summary: '   ', toolResults: [] }).summary).toBe('已完成处理。');
    expect(builder.build({ summary: '甲'.repeat(4100), toolResults: [] }).summary).toHaveLength(4000);
  });
});
