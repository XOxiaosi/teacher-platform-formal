/** Compatibility export: admin authentication middleware is a shared lower-layer HTTP primitive. */
export {
  createRequireAdmin,
  parseAdminToken,
  type AdminRequest,
  type AdminTokenAuthService,
} from '../../shared/http-admin-auth/index.js';
