export type ToolSideEffect = 'read' | 'create' | 'update' | 'destructive';

export interface ToolPresentation {
  displayName: string;
  sideEffect: ToolSideEffect;
}

const PRESENTATIONS: Record<string, ToolPresentation> = {
  'students.get': { displayName: '查询学生详情', sideEffect: 'read' },
  'students.list': { displayName: '查询学生列表', sideEffect: 'read' },
  'scheduling.list': { displayName: '查询日程', sideEffect: 'read' },
  'lessons.list': { displayName: '查询课程记录', sideEffect: 'read' },
  'payments.list': { displayName: '查询缴费记录', sideEffect: 'read' },
  'memos.list': { displayName: '查询备忘', sideEffect: 'read' },
  'feedback.list': { displayName: '查询家长反馈', sideEffect: 'read' },
  'students.create': { displayName: '创建学生', sideEffect: 'create' },
  'scheduling.create': { displayName: '创建日程', sideEffect: 'create' },
  'payments.create': { displayName: '创建缴费记录', sideEffect: 'create' },
  'memos.create': { displayName: '创建备忘', sideEffect: 'create' },
  'feedback.create': { displayName: '创建家长反馈', sideEffect: 'create' },
  'scheduling.complete': { displayName: '完成日程', sideEffect: 'update' },
  'scheduling.cancel': { displayName: '取消日程', sideEffect: 'update' },
  'lessons.updateStatus': { displayName: '更新课程状态', sideEffect: 'update' },
  'students.updateStatus': { displayName: '更新学生状态', sideEffect: 'update' },
  'memos.updateStatus': { displayName: '更新备忘状态', sideEffect: 'update' },
  'feedback.updateStatus': { displayName: '更新反馈状态', sideEffect: 'update' },
};

export function getToolPresentation(toolName: string): ToolPresentation {
  return PRESENTATIONS[toolName] ?? {
    displayName: toolName || '未知工具',
    sideEffect: 'destructive',
  };
}
