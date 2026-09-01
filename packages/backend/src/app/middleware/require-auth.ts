/** Compatibility export: authentication middleware is a shared lower-layer HTTP primitive. */
export {
  createRequireAuth,
  parseSessionToken,
  type AuthenticatedRequest,
  type TokenAuthService,
} from '../../shared/http-auth/index.js';
