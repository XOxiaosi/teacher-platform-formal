import { err, validationError } from '@teacher-platform/contracts';
import type { ToolRegistry } from '../../shared/tool-registry/types.js';

const confirmationRequired = async () => err(
  validationError('该工具必须通过 ConfirmationGateway 创建待确认操作', 'confirmation'),
);

export function registerP0StateTools(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'scheduling.cancel',
      description: '为当前老师创建“取消日程”的待确认操作。',
      sideEffect: 'update',
      confirmation: 'required',
      parameters: {
        type: 'object',
        properties: {
          scheduleId: { type: 'string', description: '日程 ID' },
        },
        required: ['scheduleId'],
        additionalProperties: false,
      },
    },
    confirmationRequired,
  );

  registry.register(
    {
      name: 'students.updateStatus',
      description: '为当前老师创建“更新学生状态”的待确认操作。',
      sideEffect: 'update',
      confirmation: 'required',
      parameters: {
        type: 'object',
        properties: {
          studentId: { type: 'string', description: '学生 ID' },
          status: { type: 'string', description: '目标状态：active/paused/finished' },
        },
        required: ['studentId', 'status'],
        additionalProperties: false,
      },
    },
    confirmationRequired,
  );
}
