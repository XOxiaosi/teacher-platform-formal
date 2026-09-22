/**
 * 后台管理员认证领域服务（阶段一 env 版）——模块出口。
 */
export {
  createAdminAuthService,
  createAdminAuthServiceFromEnv,
  hashAdminPassword,
  type AdminAuthService,
  type AdminAuthServiceOptions,
  type AdminSessionData,
} from './admin-auth-service.js';
export { createAdminRouter, type AdminRouterOptions } from './admin.routes.js';
export {
  getTeacherOverview,
  isSafeAdminDatabaseName,
  listTeachers,
  parsePagination,
  dbNotReadyError,
  findTeacherListItem,
  type ListTeachersInput,
  type ListTeachersResult,
  type OverviewError,
  type TeacherListItem,
  type TeacherMetricsCounts,
  type TeacherOverview,
} from './teacher-overview.js';
export {
  getInteractionStats,
  type InteractionStats,
  type InteractionStatsInput,
} from './interactions.js';
export {
  getAdminHealth,
  defaultBackupRoot,
  type AdminHealthInput,
  type AdminHealthSnapshot,
  type TeacherDbHealthEntry,
} from './admin-health.js';
export {
  createTeacherInvitation,
  isSafeRestoreTarget,
  listTeacherInvitations,
  resolveLatestDumpForDatabase,
  revokeTeacherInvitation,
  setTeacherStatus,
  type CreateTeacherInvitationInput,
  type TeacherInvitationData,
} from './admin-actions.js';
export {
  createAdminJobStore,
  runSpawnJob,
  type AdminJob,
  type AdminJobKind,
  type AdminJobStatus,
  type AdminJobStore,
} from './admin-jobs.js';
export {
  recordAdminAction,
  recordAdminActionDb,
  type AdminAuditInput,
  type AdminAuditLogModel,
} from './audit.js';
export {
  getAdminUsageSummary,
  type AdminUsageSummary,
  type AdminUsageSummaryInput,
  type AdminUsageSummaryResult,
  type AdminUsageSummaryRow,
} from './admin-usage-summary.js';
export {
  getFeedbackSummary,
  type FeedbackSummary,
  type FeedbackSummaryInput,
  type FeedbackSummaryResult,
  type FeedbackRecentItem,
} from './feedback-summary.js';
export {
  listFeedbackBoard,
  getFeedbackBoardDetail,
  updateFeedbackBoard,
  feedbackActionForChanges,
  FEEDBACK_STATUSES,
  FEEDBACK_PRIORITIES,
  FEEDBACK_CATEGORIES,
  type FeedbackBoardItem,
  type FeedbackCategory,
  type FeedbackPriority,
  type FeedbackStatus,
  type ListFeedbackBoardInput,
  type ListFeedbackBoardResult,
  type UpdateFeedbackBoardChanges,
  type UpdateFeedbackBoardInput,
} from './feedback-board.js';
