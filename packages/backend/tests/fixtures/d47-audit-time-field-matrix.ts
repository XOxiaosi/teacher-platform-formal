export type AuditTimeSemantics = 'INSTANT' | 'BUSINESS_DATE' | 'LOCAL_WALL_TIME';
export type AuditTimeCurrentSource =
  | 'DDL_DEFAULT_PENDING_QUERY_EVIDENCE'
  | 'PRISMA'
  | 'TRUSTED_DB'
  | 'INPUT'
  | 'APP_CLOCK'
  | 'MIXED';
export type AuditTimeNewWriteRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'SEALED_HIGH';
export type AuditTimeMigrationRisk = 'LOW' | 'MEDIUM' | 'HIGH';

export interface D47AuditTimeFieldEntry {
  key: `${string}.${string}`;
  semantics: AuditTimeSemantics;
  currentSource: AuditTimeCurrentSource;
  newWriteRisk: AuditTimeNewWriteRisk;
  migrationRisk: AuditTimeMigrationRisk;
}

export const D47_AUDIT_TIME_FIELD_MATRIX = [
  { key: 'Student.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'Student.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'Schedule.scheduledStartTs', semantics: 'INSTANT', currentSource: 'INPUT', newWriteRisk: 'HIGH', migrationRisk: 'HIGH' },
  { key: 'Schedule.scheduledEndTs', semantics: 'INSTANT', currentSource: 'INPUT', newWriteRisk: 'HIGH', migrationRisk: 'HIGH' },
  { key: 'Schedule.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'Schedule.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'ScheduleParticipant.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'ScheduleParticipant.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'Lesson.dateTs', semantics: 'INSTANT', currentSource: 'INPUT', newWriteRisk: 'HIGH', migrationRisk: 'HIGH' },
  { key: 'Lesson.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'Lesson.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'AINote.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'AINote.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'Conversation.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'Conversation.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'ConversationTurn.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'AgentExecution.startedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'AgentExecution.finishedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'AgentExecution.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'AgentExecution.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'PendingAction.expiresAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'PendingAction.consumedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'PendingAction.cancelledAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'PendingAction.createdAtTs', semantics: 'INSTANT', currentSource: 'DDL_DEFAULT_PENDING_QUERY_EVIDENCE', newWriteRisk: 'MEDIUM', migrationRisk: 'HIGH' },
  { key: 'PendingAction.updatedAtTs', semantics: 'INSTANT', currentSource: 'MIXED', newWriteRisk: 'HIGH', migrationRisk: 'HIGH' },
  { key: 'Payment.paidAtTs', semantics: 'INSTANT', currentSource: 'INPUT', newWriteRisk: 'HIGH', migrationRisk: 'HIGH' },
  { key: 'Payment.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'Payment.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'DailyReview.dateTs', semantics: 'BUSINESS_DATE', currentSource: 'MIXED', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'DailyReview.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'DailyReview.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'PushRecord.scheduledAtTs', semantics: 'INSTANT', currentSource: 'INPUT', newWriteRisk: 'HIGH', migrationRisk: 'HIGH' },
  { key: 'PushRecord.sentAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'PushRecord.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'PushRecord.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'ChangeLog.timestampTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'ChangeLog.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'Memo.dueAtTs', semantics: 'INSTANT', currentSource: 'INPUT', newWriteRisk: 'HIGH', migrationRisk: 'HIGH' },
  { key: 'Memo.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'Memo.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'ParentFeedback.sentAtTs', semantics: 'INSTANT', currentSource: 'MIXED', newWriteRisk: 'HIGH', migrationRisk: 'HIGH' },
  { key: 'ParentFeedback.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  { key: 'ParentFeedback.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'HIGH' },
  // D40 学生长期资料库（新表，无历史数据，迁移风险 LOW）
  { key: 'StudentSourceRecord.occurredAtTs', semantics: 'INSTANT', currentSource: 'MIXED', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'StudentSourceRecord.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'StudentSourceRecord.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'StudentRecord.occurredAtTs', semantics: 'INSTANT', currentSource: 'MIXED', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'StudentRecord.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'StudentRecord.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'AssessmentDetail.examDateTs', semantics: 'INSTANT', currentSource: 'INPUT', newWriteRisk: 'HIGH', migrationRisk: 'LOW' },
  { key: 'AssessmentDetail.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'AssessmentDetail.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'CommunicationDetail.nextContactAtTs', semantics: 'INSTANT', currentSource: 'INPUT', newWriteRisk: 'HIGH', migrationRisk: 'LOW' },
  { key: 'CommunicationDetail.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'CommunicationDetail.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'FeedbackContextSnapshot.windowStartTs', semantics: 'INSTANT', currentSource: 'INPUT', newWriteRisk: 'HIGH', migrationRisk: 'LOW' },
  { key: 'FeedbackContextSnapshot.windowEndTs', semantics: 'INSTANT', currentSource: 'INPUT', newWriteRisk: 'HIGH', migrationRisk: 'LOW' },
  { key: 'FeedbackContextSnapshot.assembledAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'FeedbackContextSnapshot.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'FeedbackContextSnapshot.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'FeedbackEvidence.occurredAtTs', semantics: 'INSTANT', currentSource: 'INPUT', newWriteRisk: 'HIGH', migrationRisk: 'LOW' },
  { key: 'FeedbackEvidence.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  // P7 认证地基（新表，无历史数据；注册表/会话时间为系统可信时间）
  { key: 'TeacherRegistry.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'TeacherRegistry.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  // T-014 邀请制入口（新表，无历史数据；到期、接受、撤销及审计时间均来自数据库可信时间）
  { key: 'TeacherInvitation.expiresAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'TeacherInvitation.acceptedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'TeacherInvitation.revokedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'TeacherInvitation.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'TeacherInvitation.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'SessionStore.expiresAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'SessionStore.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'SessionStore.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  // P2 用户需求追溯（新表，无历史数据；需求发生时刻来自输入/Agent 捕获，登记时间为系统可信时间）
  { key: 'UserRequirement.occurredAtTs', semantics: 'INSTANT', currentSource: 'INPUT', newWriteRisk: 'HIGH', migrationRisk: 'LOW' },
  { key: 'UserRequirement.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'UserRequirement.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  // P7 渠道线 ProviderConfig（新表，无历史数据；登记/更新时间均为系统可信时间）
  { key: 'ProviderConfig.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'ProviderConfig.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  // P7 渠道线 ProviderUsage（新表，无历史数据；请求发生时刻来自输入，登记时间为系统可信时间）
  { key: 'ProviderUsage.requestAt', semantics: 'INSTANT', currentSource: 'INPUT', newWriteRisk: 'HIGH', migrationRisk: 'LOW' },
  { key: 'ProviderUsage.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  // P7 管理后台 AdminAccount / AdminAuditLog（新表，无历史数据；登记/更新时间均为系统可信时间）
  { key: 'AdminAccount.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'AdminAccount.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'AdminAuditLog.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  // P8 微信渠道身份 ChannelIdentity（t9，新表，无历史数据；登记/更新时间均为系统可信时间）
  { key: 'ChannelIdentity.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'ChannelIdentity.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  // P8 S3 媒体资产 MediaAsset（t8，新表，无历史数据；登记时间为系统可信时间）
  { key: 'MediaAsset.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  // P9 S3 阶段二（t3）：孤儿标记时刻=TrustedClock 服务写入（保留期起算；不引入 new Date）
  { key: 'MediaAsset.orphanMarkedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  // P8 微信入站消息 ChannelMessage（t13，新表，无历史数据；登记时间=DDL 可信，处理时刻=TrustedClock 服务写入）
  { key: 'ChannelMessage.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'ChannelMessage.processedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  // P8 渠道会话映射 ChannelConversation（t23 S5，新表，无历史数据；lastMessage=TrustedClock 服务写入，登记/更新=DDL 可信）
  { key: 'ChannelConversation.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'ChannelConversation.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'ChannelConversation.lastMessageAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  // T-015 原始捕获链（新表，无历史数据；所有事件时刻由数据库可信时间写入）
  { key: 'CaptureEvent.occurredAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'CaptureEvent.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'CaptureEvent.redactedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'CaptureTask.startedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'CaptureTask.completedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'CaptureTask.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'CaptureTask.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'CaptureCandidate.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'CaptureCandidate.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'CaptureCandidate.redactedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'CaptureCandidate.confirmedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'CaptureDeletionReceipt.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'CaptureDeletionReceipt.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'CaptureDeletionReceipt.completedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'CaptureDeletionReceipt.claimExpiresAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  // T-017 lesson ledger and adjustment confirmation timestamps
  { key: 'LessonLedgerEntry.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'LessonLedgerAdjustmentConfirmation.confirmedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'LessonLedgerAdjustmentConfirmation.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'LessonLedgerAdjustmentConfirmation.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'LessonStatusCorrectionConfirmation.expectedLessonUpdatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'LessonStatusCorrectionConfirmation.confirmedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'LessonStatusCorrectionConfirmation.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'LessonStatusCorrectionConfirmation.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  // T-016/T-017/T-020 新增排课、快照、工作区状态与幂等收据字段；来源与用途见下方证据表。
  { key: 'Schedule.recurrenceDay', semantics: 'BUSINESS_DATE', currentSource: 'INPUT', newWriteRisk: 'HIGH', migrationRisk: 'LOW' },
  { key: 'RecurrenceRule.startDate', semantics: 'BUSINESS_DATE', currentSource: 'INPUT', newWriteRisk: 'HIGH', migrationRisk: 'LOW' },
  { key: 'RecurrenceRule.endDate', semantics: 'BUSINESS_DATE', currentSource: 'INPUT', newWriteRisk: 'HIGH', migrationRisk: 'LOW' },
  { key: 'RecurrenceRule.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'RecurrenceRule.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'RecurrenceRuleParticipant.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'ScheduleRevision.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'ScheduleCompletionSnapshot.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'TeacherWorkspacePreference.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'WebMutationReceipt.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'SchedulingWebMutationReceipt.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'TaskRuntime.leaseExpiresAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'TaskRuntime.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'TaskRuntime.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'StepReceipt.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'StepReceipt.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'ConversationTurn.invalidatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'ConversationTurn.redactedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  // A05 反馈生成恢复任务（新表，无历史数据；调用边界与审计字段统一使用数据库可信时间）
  { key: 'FeedbackDraftTask.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'FeedbackDraftTask.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'FeedbackDraftAttempt.modelCallStartedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'FeedbackDraftAttempt.modelCallEndedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'FeedbackDraftAttempt.createdAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
  { key: 'FeedbackDraftAttempt.updatedAtTs', semantics: 'INSTANT', currentSource: 'TRUSTED_DB', newWriteRisk: 'LOW', migrationRisk: 'LOW' },
] as const satisfies readonly D47AuditTimeFieldEntry[];

export interface D47AuditTimeFieldEvidence {
  key: `${string}.${string}`;
  source: 'INPUT' | 'TRUSTED_DB';
  purpose: string;
  path: string;
}

export const D47_NEW_TIME_FIELD_EVIDENCE = [
  { key: 'Schedule.recurrenceDay', source: 'INPUT', purpose: '按重复规则物化例外所属业务日', path: 'packages/backend/src/features/scheduling-web/scheduling-web-service.ts' },
  { key: 'RecurrenceRule.startDate', source: 'INPUT', purpose: '重复规则投影的起始业务日', path: 'packages/backend/src/features/scheduling-web/scheduling-web-service.ts' },
  { key: 'RecurrenceRule.endDate', source: 'INPUT', purpose: '重复规则投影的结束业务日', path: 'packages/backend/src/features/scheduling-web/scheduling-web-service.ts' },
  { key: 'RecurrenceRule.createdAtTs', source: 'TRUSTED_DB', purpose: '规则审计创建时刻', path: 'packages/contracts/prisma/teaching-schedule.prisma' },
  { key: 'RecurrenceRule.updatedAtTs', source: 'TRUSTED_DB', purpose: '规则版本并发控制时刻', path: 'packages/contracts/prisma/teaching-schedule.prisma' },
  { key: 'RecurrenceRuleParticipant.createdAtTs', source: 'TRUSTED_DB', purpose: '重复规则参与人关系创建时刻', path: 'packages/contracts/prisma/teaching-schedule.prisma' },
  { key: 'ScheduleRevision.createdAtTs', source: 'TRUSTED_DB', purpose: '已完成课程修订审计时刻', path: 'packages/backend/src/features/scheduling-web/scheduling-web-service.ts' },
  { key: 'ScheduleCompletionSnapshot.createdAtTs', source: 'TRUSTED_DB', purpose: '完课余额快照写入时刻', path: 'packages/backend/src/features/scheduling-web/scheduling-web-service.ts' },
  { key: 'TeacherWorkspacePreference.updatedAtTs', source: 'TRUSTED_DB', purpose: '教师工作区偏好版本时刻', path: 'packages/backend/src/app/routes/workspace-web.service.ts' },
  { key: 'WebMutationReceipt.createdAtTs', source: 'TRUSTED_DB', purpose: '工作区变更幂等收据创建时刻', path: 'packages/backend/src/app/routes/workspace-web.service.ts' },
  { key: 'SchedulingWebMutationReceipt.createdAtTs', source: 'TRUSTED_DB', purpose: '排课变更幂等收据创建时刻', path: 'packages/backend/src/features/scheduling-web/scheduling-web-service.ts' },
  { key: 'LessonStatusCorrectionConfirmation.expectedLessonUpdatedAtTs', source: 'TRUSTED_DB', purpose: '出勤更正确认绑定的课次版本时刻', path: 'packages/backend/src/app/use-cases/lesson-status-fix/lesson-status-fix-use-case.ts' },
  { key: 'LessonStatusCorrectionConfirmation.confirmedAtTs', source: 'TRUSTED_DB', purpose: '出勤更正确认完成时刻', path: 'packages/backend/src/app/use-cases/lesson-status-fix/lesson-status-fix-use-case.ts' },
  { key: 'LessonStatusCorrectionConfirmation.createdAtTs', source: 'TRUSTED_DB', purpose: '出勤更正预览创建时刻', path: 'packages/backend/src/app/use-cases/lesson-status-fix/lesson-status-fix-use-case.ts' },
  { key: 'LessonStatusCorrectionConfirmation.updatedAtTs', source: 'TRUSTED_DB', purpose: '出勤更正确认状态版本时刻', path: 'packages/backend/src/app/use-cases/lesson-status-fix/lesson-status-fix-use-case.ts' },
  { key: 'FeedbackDraftTask.createdAtTs', source: 'TRUSTED_DB', purpose: '反馈生成任务创建审计时刻', path: 'packages/contracts/prisma/student-feedback.prisma' },
  { key: 'FeedbackDraftTask.updatedAtTs', source: 'TRUSTED_DB', purpose: '反馈生成任务状态版本时刻', path: 'packages/contracts/prisma/student-feedback.prisma' },
  { key: 'FeedbackDraftAttempt.modelCallStartedAtTs', source: 'TRUSTED_DB', purpose: '模型尝试开始与租约判定时刻', path: 'packages/backend/src/features/feedback/feedback-draft-task-service.ts' },
  { key: 'FeedbackDraftAttempt.modelCallEndedAtTs', source: 'TRUSTED_DB', purpose: '模型尝试终态审计时刻', path: 'packages/backend/src/features/feedback/feedback-draft-task-service.ts' },
  { key: 'FeedbackDraftAttempt.createdAtTs', source: 'TRUSTED_DB', purpose: '反馈生成尝试创建审计时刻', path: 'packages/contracts/prisma/student-feedback.prisma' },
  { key: 'FeedbackDraftAttempt.updatedAtTs', source: 'TRUSTED_DB', purpose: '反馈生成尝试状态版本时刻', path: 'packages/contracts/prisma/student-feedback.prisma' },
] as const satisfies readonly D47AuditTimeFieldEvidence[];
