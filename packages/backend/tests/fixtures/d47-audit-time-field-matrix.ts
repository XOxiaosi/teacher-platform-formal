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
] as const satisfies readonly D47AuditTimeFieldEntry[];
