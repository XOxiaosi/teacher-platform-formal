-- P2 架构精简（D50 §6.1）：删除 teacherId 索引（独立库模型下无区分度）
-- 只 DROP INDEX，绝不动表结构/数据/约束。
-- 保留：唯一约束（幂等语义）+ studentId/conversationId/status 等有区分度索引
--       + 共享库表（SessionStore/UserRequirement）的 teacherId 索引（共享库内按教师查询有区分度）。
-- 本迁移由 prisma migrate diff 生成，人工核验 28 个 DROP INDEX 与 schema 删除清单一致。

-- DropIndex
DROP INDEX "AINote_teacherId_idx";

-- DropIndex
DROP INDEX "AgentExecution_teacherId_status_updatedAtTs_idx";

-- DropIndex
DROP INDEX "AssessmentDetail_teacherId_idx";

-- DropIndex
DROP INDEX "ChangeLog_teacherId_idx";

-- DropIndex
DROP INDEX "CommunicationDetail_teacherId_idx";

-- DropIndex
DROP INDEX "CommunicationDetail_teacherId_studentRecordId_idx";

-- DropIndex
DROP INDEX "Conversation_teacherId_idx";

-- DropIndex
DROP INDEX "Conversation_teacherId_status_idx";

-- DropIndex
DROP INDEX "ConversationTurn_teacherId_idx";

-- DropIndex
DROP INDEX "DailyReview_teacherId_idx";

-- DropIndex
DROP INDEX "FeedbackContextSnapshot_teacherId_feedbackId_idx";

-- DropIndex
DROP INDEX "FeedbackContextSnapshot_teacherId_idx";

-- DropIndex
DROP INDEX "FeedbackEvidence_teacherId_idx";

-- DropIndex
DROP INDEX "FeedbackEvidence_teacherId_snapshotId_idx";

-- DropIndex
DROP INDEX "Lesson_teacherId_idx";

-- DropIndex
DROP INDEX "Memo_teacherId_createdAtTs_idx";

-- DropIndex
DROP INDEX "Memo_teacherId_dueAtTs_idx";

-- DropIndex
DROP INDEX "Memo_teacherId_status_idx";

-- DropIndex
DROP INDEX "ParentFeedback_teacherId_createdAtTs_idx";

-- DropIndex
DROP INDEX "ParentFeedback_teacherId_status_idx";

-- DropIndex
DROP INDEX "Payment_teacherId_idx";

-- DropIndex
DROP INDEX "PendingAction_teacherId_status_expiresAtTs_idx";

-- DropIndex
DROP INDEX "PushRecord_teacherId_idx";

-- DropIndex
DROP INDEX "Schedule_teacherId_idx";

-- DropIndex
DROP INDEX "Schedule_teacherId_scheduledStartTs_idx";

-- DropIndex
DROP INDEX "Student_teacherId_idx";

-- DropIndex
DROP INDEX "StudentRecord_teacherId_reviewStatus_idx";

-- DropIndex
DROP INDEX "StudentSourceRecord_teacherId_captureStatus_idx";
