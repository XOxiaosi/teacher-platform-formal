/**
 * D48｜历史时间来源分群矩阵
 *
 * 逐字段标注生产数据中每行的时间来源分类。
 * 来源分类：UTC_WALL / LOS_ANGELES_WALL / SHANGHAI_WALL / BUSINESS_DATE / UNKNOWN / N_A（空表）
 *
 * 契约规则见 D48 报告 §3。
 */

export type HistoricalTimeSource =
  | 'UTC_WALL'
  | 'LOS_ANGELES_WALL'
  | 'SHANGHAI_WALL'
  | 'BUSINESS_DATE'
  | 'UNKNOWN'
  | 'N_A';

export type InvariantStatus = 'PASS' | 'FAIL' | 'N_A';

export interface D48HistoricalTimeSourceEntry {
  key: `${string}.${string}`;
  rowCount: number;
  source: HistoricalTimeSource;
  invariant: InvariantStatus;
  anomaly: string | null;
  /** 迁移转换方式 */
  migrationConversion: 'AT_TIME_ZONE_UTC' | 'AT_TIME_ZONE_LA' | 'DIRECT_COPY' | 'NONE';
}

export const D48_HISTORICAL_TIME_SOURCE_MATRIX: readonly D48HistoricalTimeSourceEntry[] = [
  { key: 'Student.createdAtTs', rowCount: 19, source: 'UTC_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'AT_TIME_ZONE_UTC' },
  { key: 'Student.updatedAtTs', rowCount: 19, source: 'UTC_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'AT_TIME_ZONE_UTC' },
  { key: 'Schedule.scheduledStartTs', rowCount: 12, source: 'SHANGHAI_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'DIRECT_COPY' },
  { key: 'Schedule.scheduledEndTs', rowCount: 12, source: 'SHANGHAI_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'DIRECT_COPY' },
  { key: 'Schedule.createdAtTs', rowCount: 12, source: 'UTC_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'AT_TIME_ZONE_UTC' },
  { key: 'Schedule.updatedAtTs', rowCount: 12, source: 'UTC_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'AT_TIME_ZONE_UTC' },
  { key: 'ScheduleParticipant.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'ScheduleParticipant.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'Lesson.dateTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'Lesson.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'Lesson.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'AINote.createdAtTs', rowCount: 2, source: 'UTC_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'AT_TIME_ZONE_UTC' },
  { key: 'AINote.updatedAtTs', rowCount: 2, source: 'UTC_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'AT_TIME_ZONE_UTC' },
  { key: 'Conversation.createdAtTs', rowCount: 2, source: 'UTC_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'AT_TIME_ZONE_UTC' },
  { key: 'Conversation.updatedAtTs', rowCount: 2, source: 'UTC_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'AT_TIME_ZONE_UTC' },
  { key: 'ConversationTurn.createdAtTs', rowCount: 27, source: 'UTC_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'AT_TIME_ZONE_UTC' },
  { key: 'AgentExecution.startedAtTs', rowCount: 6, source: 'UTC_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'AT_TIME_ZONE_UTC' },
  { key: 'AgentExecution.finishedAtTs', rowCount: 6, source: 'LOS_ANGELES_WALL', invariant: 'FAIL', anomaly: 'finishedAt < startedAt, offset ~-7h (PDT)', migrationConversion: 'AT_TIME_ZONE_LA' },
  { key: 'AgentExecution.createdAtTs', rowCount: 6, source: 'UTC_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'AT_TIME_ZONE_UTC' },
  { key: 'AgentExecution.updatedAtTs', rowCount: 6, source: 'LOS_ANGELES_WALL', invariant: 'FAIL', anomaly: 'updatedAt < createdAt, offset ~-7h (PDT)', migrationConversion: 'AT_TIME_ZONE_LA' },
  { key: 'PendingAction.expiresAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'PendingAction.consumedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'PendingAction.cancelledAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'PendingAction.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'PendingAction.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'Payment.paidAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'Payment.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'Payment.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'DailyReview.dateTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'DailyReview.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'DailyReview.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'PushRecord.scheduledAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'PushRecord.sentAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'PushRecord.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'PushRecord.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'ChangeLog.timestampTs', rowCount: 16, source: 'UTC_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'AT_TIME_ZONE_UTC' },
  { key: 'ChangeLog.createdAtTs', rowCount: 16, source: 'UTC_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'AT_TIME_ZONE_UTC' },
  { key: 'Memo.dueAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'Memo.createdAtTs', rowCount: 2, source: 'UTC_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'AT_TIME_ZONE_UTC' },
  { key: 'Memo.updatedAtTs', rowCount: 2, source: 'UTC_WALL', invariant: 'PASS', anomaly: null, migrationConversion: 'AT_TIME_ZONE_UTC' },
  { key: 'ParentFeedback.sentAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'ParentFeedback.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'ParentFeedback.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  // D40 学生长期资料库（新表，无历史数据）
  { key: 'StudentSourceRecord.occurredAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'StudentSourceRecord.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'StudentSourceRecord.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'StudentRecord.occurredAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'StudentRecord.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'StudentRecord.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'AssessmentDetail.examDateTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'AssessmentDetail.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'AssessmentDetail.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CommunicationDetail.nextContactAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CommunicationDetail.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CommunicationDetail.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'FeedbackContextSnapshot.windowStartTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'FeedbackContextSnapshot.windowEndTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'FeedbackContextSnapshot.assembledAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'FeedbackContextSnapshot.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'FeedbackContextSnapshot.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'FeedbackEvidence.occurredAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'FeedbackEvidence.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  // P7 认证地基（新表，无历史数据）
  { key: 'TeacherRegistry.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'TeacherRegistry.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  // T-014 邀请制入口（迁移后新表，无旧快照历史数据）
  { key: 'TeacherInvitation.expiresAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'TeacherInvitation.acceptedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'TeacherInvitation.revokedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'TeacherInvitation.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'TeacherInvitation.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'SessionStore.expiresAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'SessionStore.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'SessionStore.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  // P2 用户需求追溯（新表，无历史数据）
  { key: 'UserRequirement.occurredAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'UserRequirement.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'UserRequirement.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  // P2 教师 LLM 配置（新表，无历史数据）
  { key: 'ProviderConfig.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'ProviderConfig.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  // P7 渠道线 ProviderUsage（新表，无历史数据）
  { key: 'ProviderUsage.requestAt', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'ProviderUsage.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  // P7 管理后台 AdminAccount / AdminAuditLog（新表，无历史数据）
  { key: 'AdminAccount.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'AdminAccount.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'AdminAuditLog.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  // P8 微信渠道身份 ChannelIdentity（t9，新表，无历史数据）
  { key: 'ChannelIdentity.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'ChannelIdentity.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  // P8 S3 媒体资产 MediaAsset（t8，新表，无历史数据）
  { key: 'MediaAsset.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  // P9 S3 阶段二（t3）：孤儿标记时刻=TrustedClock 服务写入（新列，无历史数据）
  { key: 'MediaAsset.orphanMarkedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  // P8 微信入站消息 ChannelMessage（t13，新表，无历史数据）
  { key: 'ChannelMessage.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'ChannelMessage.processedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  // P8 渠道会话映射 ChannelConversation（t23 S5，新表，无历史数据）
  { key: 'ChannelConversation.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'ChannelConversation.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'ChannelConversation.lastMessageAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  // T-015 原始捕获链（新表，无旧快照历史数据）
  { key: 'CaptureEvent.occurredAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CaptureEvent.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CaptureEvent.redactedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CaptureTask.startedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CaptureTask.completedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CaptureTask.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CaptureTask.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CaptureCandidate.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CaptureCandidate.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CaptureCandidate.redactedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CaptureCandidate.confirmedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CaptureDeletionReceipt.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CaptureDeletionReceipt.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CaptureDeletionReceipt.completedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'CaptureDeletionReceipt.claimExpiresAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'LessonLedgerEntry.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'LessonLedgerAdjustmentConfirmation.confirmedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'LessonLedgerAdjustmentConfirmation.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'LessonLedgerAdjustmentConfirmation.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  // T-016/T-017/T-020 新增字段：recurrenceDay 是既有 Schedule 上的业务日期列，
  // 迁移前无历史值；其余字段均属于迁移后新表，同样没有历史数据。
  { key: 'Schedule.recurrenceDay', rowCount: 0, source: 'BUSINESS_DATE', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'RecurrenceRule.startDate', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'RecurrenceRule.endDate', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'RecurrenceRule.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'RecurrenceRule.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'RecurrenceRuleParticipant.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'ScheduleRevision.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'ScheduleCompletionSnapshot.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'TeacherWorkspacePreference.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'WebMutationReceipt.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'SchedulingWebMutationReceipt.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'TaskRuntime.leaseExpiresAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'TaskRuntime.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'TaskRuntime.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'StepReceipt.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'StepReceipt.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'ConversationTurn.invalidatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'ConversationTurn.redactedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  // A05 反馈生成恢复任务为迁移后新表，没有旧快照历史数据。
  { key: 'FeedbackDraftTask.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'FeedbackDraftTask.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'FeedbackDraftAttempt.modelCallStartedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'FeedbackDraftAttempt.modelCallEndedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'FeedbackDraftAttempt.createdAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
  { key: 'FeedbackDraftAttempt.updatedAtTs', rowCount: 0, source: 'N_A', invariant: 'N_A', anomaly: null, migrationConversion: 'NONE' },
] as const satisfies readonly D48HistoricalTimeSourceEntry[];

/** LOS_ANGELES_WALL 字段列表（需显式时区转换） */
export const LA_WALL_FIELDS = D48_HISTORICAL_TIME_SOURCE_MATRIX.filter(
  (e) => e.source === 'LOS_ANGELES_WALL',
).map((e) => e.key);

/** UTC_WALL 字段列表（可直接用 AT TIME ZONE 'UTC'） */
export const UTC_WALL_FIELDS = D48_HISTORICAL_TIME_SOURCE_MATRIX.filter(
  (e) => e.source === 'UTC_WALL',
).map((e) => e.key);

/** 存在异常的字段列表 */
export const ANOMALOUS_FIELDS = D48_HISTORICAL_TIME_SOURCE_MATRIX.filter(
  (e) => e.anomaly !== null,
).map((e) => e.key);

/** UNKNOWN 字段列表（阻断破坏性转换） */
export const UNKNOWN_FIELDS = D48_HISTORICAL_TIME_SOURCE_MATRIX.filter(
  (e) => e.source === 'UNKNOWN',
).map((e) => e.key);
