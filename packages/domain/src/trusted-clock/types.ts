import type { CommonError, Result } from '@teacher-platform/api-contracts';

export interface TrustedClock {
  now(): Promise<Result<Date, CommonError>>;
}
