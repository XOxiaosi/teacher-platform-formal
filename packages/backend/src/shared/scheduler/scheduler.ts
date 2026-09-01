import { err, notFound, ok, validationError } from '@teacher-platform/contracts';
import type { RegisterTaskInput, SchedulerService } from './types.js';

type TimerHandle = ReturnType<typeof setInterval>;

export function createScheduler(): SchedulerService {
  const tasks = new Map<string, TimerHandle>();

  return {
    register(input: RegisterTaskInput) {
      const validation = validateRegisterInput(input, tasks);
      if (!validation.ok) return validation;

      const timer = setInterval(() => {
        void input.handler();
      }, input.intervalMs);
      tasks.set(input.id, timer);
      return ok(true);
    },

    unregister(id: string) {
      const timer = tasks.get(id);
      if (!timer) return err(notFound('定时任务不存在'));
      clearInterval(timer);
      tasks.delete(id);
      return ok(true);
    },

    list() {
      return [...tasks.keys()];
    },
  };
}

function validateRegisterInput(input: RegisterTaskInput, tasks: Map<string, TimerHandle>) {
  if (!input.id.trim()) return err(validationError('任务 ID 不能为空', 'id'));
  if (tasks.has(input.id)) return err(validationError('任务 ID 已存在', 'id'));
  if (input.intervalMs <= 0) return err(validationError('定时间隔必须大于 0', 'intervalMs'));
  return ok(true);
}
