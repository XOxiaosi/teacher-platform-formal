import type { CommonError, Result } from '@teacher-platform/contracts';

export type ScheduledTaskHandler = () => void | Promise<void>;

export interface RegisterTaskInput {
  id: string;
  intervalMs: number;
  handler: ScheduledTaskHandler;
}

export interface SchedulerService {
  register(input: RegisterTaskInput): Result<true, CommonError>;
  unregister(id: string): Result<true, CommonError>;
  list(): string[];
}
