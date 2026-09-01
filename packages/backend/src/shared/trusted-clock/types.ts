import type { CommonError, Result } from '@teacher-platform/contracts';

export interface TrustedClock {
  now(): Promise<Result<Date, CommonError>>;
}
