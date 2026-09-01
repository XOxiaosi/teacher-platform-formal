export {
  alreadyConsumed,
  budgetExceeded,
  internalError,
  notFound,
  permissionDenied,
  rateLimited,
  validationError,
  versionConflict,
} from './common-error.js';
export type { CommonError, CommonErrorCode } from './common-error.js';
export { err, ok } from './result.js';
export type { Err, Ok, Result } from './result.js';
