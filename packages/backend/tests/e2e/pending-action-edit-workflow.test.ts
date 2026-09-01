import { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConfirmationGateway, createConfirmationTransactionPort } from '../../src/app/confirmation/index.js';
import { createConfirmPendingActionUseCase } from '../../src/app/use-cases/confirm-pending-action/index.js';
import { createUpdateStudentProfileUseCase } from '../../src/app/use-cases/update-student-profile/index.js';
import { createConversationService } from '../../src/features/conversation/index.js';
import { createFeedbackService } from '../../src/features/feedback/index.js';
import { createLessonService } from '../../src/features/lessons/index.js';
import { createMemoService } from '../../src/features/memos/index.js';
import { createPaymentService } from '../../src/features/payments/index.js';
import { createActionTokenSigner, createPendingActionService } from '../../src/features/pending-action/index.js';
import { createScheduleService } from '../../src/features/scheduling/index.js';
import { createStudentService } from '../../src/features/students/index.js';

const prisma = new PrismaClient();
const TEACHER = 'a5-i9-edit-teacher';
const SECRET = 'a5-i9-test-secret-at-least-32-bytes';

async function cleanup() {
  await prisma.changeLog.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.pendingAction.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.conversationTurn.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.conversation.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER } });
}

beforeEach(cleanup);
afterEach(cleanup);

async function runtime() {
  const conversations = createConversationService({ prisma });
  const conversation = await conversations.createConversation({ teacherId: TEACHER });
  if (!conversation.ok) throw new Error(conversation.error.message);
  const signer = createActionTokenSigner({ secret: SECRET });
  const pendingActions = createPendingActionService({
    prisma,
    actionTokenSigner: signer,
    conversationOwner: { getOwnedConversation: (input) => conversations.getConversation(input) },
  });
  const students = createStudentService(prisma);
  const schedules = createScheduleService(prisma);
  const lessons = createLessonService(prisma);
  const payments = createPaymentService(prisma);
  const memos = createMemoService({ prisma });
  const feedback = createFeedbackService({ prisma });
  const gateway = createConfirmationGateway({
    pendingActions,
    students,
    schedules,
    lessons,
    editOwners: {
      studentProfiles: { getOwnedStudentProfile: (input) => students.getOwnedStudent(input) },
      scheduleReschedules: schedules,
      lessonRecords: lessons,
      payments,
      memos: { getOwnedMemo: (input) => memos.getMemo(input) },
      feedback: { getOwnedFeedback: (input) => feedback.getFeedback(input) },
    },
  });
  const confirm = createConfirmPendingActionUseCase({
    actionTokenSigner: signer,
    transaction: createConfirmationTransactionPort({ rawPrisma: prisma }),
  });
  return { conversation: conversation.value, pendingActions, gateway, confirm };
}

async function createStudent() {
  return prisma.student.create({
    data: { teacherId: TEACHER, name: '小明', grade: '高二', source: 'test' },
  });
}

async function createProfilePending(studentId: string) {
  const app = await runtime();
  const requested = await app.gateway.requestConfirmation({
    teacherId: TEACHER,
    conversationId: app.conversation.id,
    toolCallId: `call-${studentId}-${Math.random()}`,
    toolName: 'students.updateProfile',
    args: { studentId, changes: { grade: '高三' } },
  });
  if (!requested.ok) throw new Error(`${requested.error.code}: ${requested.error.message}`);
  const loaded = await app.pendingActions.getPendingAction({
    teacherId: TEACHER,
    pendingActionId: requested.value.pendingActionId,
  });
  if (!loaded.ok) throw new Error(loaded.error.message);
  return { ...app, requested: requested.value, loaded: loaded.value };
}

describe('A5-I9c PendingAction 普通编辑确认事务', () => {
  it('stale 快照返回 VERSION_CONFLICT，PendingAction 回滚为 pending 且确认零业务写零日志', async () => {
    const student = await createStudent();
    const app = await createProfilePending(student.id);
    const external = await createUpdateStudentProfileUseCase({ rawPrisma: prisma }).updateStudentProfile({
      teacherId: TEACHER,
      studentId: student.id,
      expectedUpdatedAt: student.updatedAtTs.toISOString(),
      source: 'manual-web',
      changes: { grade: '高二下' },
    });
    if (!external.ok) throw new Error(external.error.message);
    const logsBeforeConfirm = await prisma.changeLog.count({ where: { teacherId: TEACHER } });

    const confirmed = await app.confirm.confirm({
      teacherId: TEACHER,
      pendingActionId: app.requested.pendingActionId,
      actionToken: app.loaded.actionToken,
    });

    expect(confirmed).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    const pending = await prisma.pendingAction.findUniqueOrThrow({ where: { id: app.requested.pendingActionId } });
    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(pending.status).toBe('pending');
    expect(after.grade).toBe('高二下');
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER } })).toBe(logsBeforeConfirm);
  });

  it('成功后才 consumed，并写恰好一条 agent-confirmed ChangeLog', async () => {
    const student = await createStudent();
    const app = await createProfilePending(student.id);

    const confirmed = await app.confirm.confirm({
      teacherId: TEACHER,
      pendingActionId: app.requested.pendingActionId,
      actionToken: app.loaded.actionToken,
    });

    expect(confirmed.ok).toBe(true);
    const pending = await prisma.pendingAction.findUniqueOrThrow({ where: { id: app.requested.pendingActionId } });
    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    const logs = await prisma.changeLog.findMany({ where: { teacherId: TEACHER } });
    expect(pending.status).toBe('consumed');
    expect(after.grade).toBe('高三');
    expect(logs).toHaveLength(1);
    expect(logs[0].source).toBe('agent-confirmed');
  });
});
