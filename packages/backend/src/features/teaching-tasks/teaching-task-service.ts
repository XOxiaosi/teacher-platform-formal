import { Prisma } from '@prisma/client';
import { err, internalError, notFound, ok, validationError, versionConflict } from '@teacher-platform/contracts';
import { encryptFieldValue, encryptJsonFieldValue } from '../../shared/field-encryption/index.js';
import { createTeachingTaskReader, taskDto } from './teaching-task-reader.js';
import { createTeachingTaskLeaseMethods } from './teaching-task-lease.js';
import { createTaskContext, fingerprint, json, validRefs, REQUEST_ID } from './teaching-task-context.js';
import { createQueryStepMethods } from './teaching-task-steps.js';
import type { CreateTeachingTaskServiceOptions, TeachingTaskService } from './types.js';

export function createTeachingTaskService(options: CreateTeachingTaskServiceOptions): TeachingTaskService {
  const context = createTaskContext(options);
  const { getClient, cipher, availability, leaseMs, writable, now, lockConversation, lockTask, event } = context;
  return {
    async createConversation(input) {
      const blocked = writable();
      if (blocked) return blocked;
      const db = await getClient();
      const clock = await now(db);
      if (!clock.ok) return clock;
      const row = await db.conversation.create({
        data: {
          teacherId: input.teacherId,
          status: "active",
          runtimeOwner: "dsh-v1",
          nextEventSeq: 0,
          createdAtTs: clock.value,
          updatedAtTs: clock.value,
        },
      });
      return ok({ id: row.id, createdAt: row.createdAtTs.toISOString() });
    },
    async receiveMessage(input) {
      const blocked = writable();
      if (blocked) return blocked;
      if (!REQUEST_ID.test(input.clientRequestId))
        return err(
          validationError("clientRequestId 格式不合法", "clientRequestId"),
        );
      if (!input.message.trim())
        return err(validationError("消息不能为空", "message"));
      if (!validRefs(input.materialRefs))
        return err(validationError("本批不接受材料来源引用", "materialRefs"));
      const db = await getClient();
      const requestFingerprint = fingerprint(
        input.conversationId,
        input.taskId,
        input.message,
      );
      const existing = await db.agentExecution.findUnique({
        where: {
          teacherId_clientRequestId: {
            teacherId: input.teacherId,
            clientRequestId: input.clientRequestId,
          },
        },
        include: { task: { include: { steps: true } } },
      });
      if (existing) {
        if (
          existing.requestFingerprint !== requestFingerprint ||
          !existing.task
        )
          return err({ ...versionConflict(), field: "clientRequestId" });
        return ok({
          task: taskDto(
            existing.task,
            cipher,
            availability,
            existing.task.steps.some((s) => s.status === "uncertain"),
          ),
          receipt: {
            executionId: existing.id,
            userTurnId: existing.userTurnId!,
            clientRequestId: existing.clientRequestId,
            receivedAt: existing.createdAtTs.toISOString(),
          },
          replayed: true,
        });
      }
      try {
        const result = await db.$transaction(async (tx) => {
          await lockConversation(tx, input.conversationId);
          const replay = await tx.agentExecution.findUnique({
            where: { teacherId_clientRequestId: { teacherId: input.teacherId, clientRequestId: input.clientRequestId } },
          });
          if (replay) throw new Error(replay.requestFingerprint === requestFingerprint ? "TASK_REPLAY" : "TASK_FINGERPRINT_CONFLICT");
          const conversation = await tx.conversation.findFirst({
            where: { id: input.conversationId, teacherId: input.teacherId },
          });
          if (!conversation) throw new Error("TASK_CONVERSATION_NOT_FOUND");
          if (conversation.status !== "active")
            throw new Error("TASK_CONVERSATION_ARCHIVED");
          if (conversation.runtimeOwner !== "dsh-v1")
            throw new Error("TASK_CONVERSATION_OWNER");
          let task = input.taskId
            ? await tx.taskRuntime.findFirst({
                where: {
                  id: input.taskId,
                  teacherId: input.teacherId,
                  conversationId: input.conversationId,
                },
              })
            : null;
          if (input.taskId && !task) throw new Error("TASK_NOT_FOUND");
          if (!task && input.expectedVersion !== undefined)
            throw new Error("TASK_VERSION");
          if (task && input.expectedVersion === undefined)
            throw new Error("TASK_VERSION");
          if (task) {
            await lockTask(tx, task.id);
            task = await tx.taskRuntime.findUniqueOrThrow({
              where: { id: task.id },
            });
          }
          const clock = await now(tx);
          if (!clock.ok) throw new Error("TASK_CLOCK_UNAVAILABLE");
          if (
            task &&
            input.expectedVersion !== undefined &&
            task.version !== input.expectedVersion
          )
            throw new Error("TASK_VERSION");
          if (task && (task.status === "queued" || task.status === "running"))
            throw new Error("TASK_BUSY");
          const initialStatus =
            availability === "unavailable" ? "unavailable" : "queued";
          const execution = await tx.agentExecution.create({
            data: {
              teacherId: input.teacherId,
              conversationId: input.conversationId,
              taskId: task?.id ?? null,
              clientRequestId: input.clientRequestId,
              requestFingerprint,
              status: initialStatus,
              stage: "conversation",
              completedToolCallIds: [],
              startedAtTs: clock.value,
              createdAtTs: clock.value,
              updatedAtTs: clock.value,
            },
          });
          if (!task)
            task = await tx.taskRuntime.create({
              data: {
                teacherId: input.teacherId,
                conversationId: input.conversationId,
                originExecutionId: execution.id,
                currentExecutionId: execution.id,
                status: initialStatus,
                runtimeVersion: "dsh-v1",
                dshSessionRef: null,
                dshCheckpoint: Prisma.DbNull,
                contextEpoch: 0,
                version: 1,
                leaseEpoch: 0,
                attemptCount: 0,
                lastError:
                  initialStatus === "unavailable"
                    ? json(
                        encryptJsonFieldValue(cipher, {
                          code: "RUNTIME_UNAVAILABLE",
                          message: "教学任务运行能力当前不可用",
                          retryable: true,
                        }),
                      )
                    : Prisma.DbNull,
                createdAtTs: clock.value,
                updatedAtTs: clock.value,
              },
            });
          else
            task = await tx.taskRuntime.update({
              where: { id: task.id },
              data: {
                currentExecutionId: execution.id,
                status: initialStatus,
                version: { increment: 1 },
                lastError:
                  initialStatus === "unavailable"
                    ? json(
                        encryptJsonFieldValue(cipher, {
                          code: "RUNTIME_UNAVAILABLE",
                          message: "教学任务运行能力当前不可用",
                          retryable: true,
                        }),
                      )
                    : Prisma.DbNull,
                updatedAtTs: clock.value,
              },
            });
          await tx.agentExecution.update({
            where: { id: execution.id },
            data: { taskId: task.id, updatedAtTs: clock.value },
          });
          const userConversation = await tx.conversation.update({
            where: { id: input.conversationId },
            data: { nextEventSeq: { increment: 1 }, updatedAtTs: clock.value },
            select: { nextEventSeq: true },
          });
          const userTurn = await tx.conversationTurn.create({
            data: {
              conversationId: input.conversationId,
              teacherId: input.teacherId,
              taskId: task.id,
              executionId: execution.id,
              seq: userConversation.nextEventSeq,
              eventKey: `execution:${execution.id}:received`,
              eventKind: "message_received",
              role: "user",
              content: encryptFieldValue(cipher, input.message),
              createdAtTs: clock.value,
            },
          });
          await tx.agentExecution.update({
            where: { id: execution.id },
            data: { userTurnId: userTurn.id, updatedAtTs: clock.value },
          });
          await event(
            tx,
            input.conversationId,
            input.teacherId,
            task.id,
            execution.id,
            "task_state",
            `task:${task.id}:state:${task.version}`,
            "tool",
            "任务状态已更新",
            { status: task.status },
            clock.value,
          );
          return { task, execution, userTurn };
        });
        return ok({
          task: taskDto(result.task, cipher, availability),
          receipt: {
            executionId: result.execution.id,
            userTurnId: result.userTurn.id,
            clientRequestId: input.clientRequestId,
            receivedAt: result.userTurn.createdAtTs.toISOString(),
          },
          replayed: false,
        });
      } catch (caught) {
        if (
          caught instanceof Error &&
          caught.message === "TASK_CONVERSATION_NOT_FOUND"
        )
          return err(notFound("会话不存在"));
        if (caught instanceof Error && caught.message === "TASK_NOT_FOUND")
          return err(notFound("教学任务不存在"));
        if (
          caught instanceof Error &&
          caught.message === "TASK_CONVERSATION_ARCHIVED"
        )
          return err(
            validationError("已归档的会话不能发送消息", "conversationId"),
          );
        if (
          caught instanceof Error &&
          caught.message === "TASK_CONVERSATION_OWNER"
        )
          return err(
            validationError("会话不属于教学任务运行时", "conversationId"),
          );
        if (caught instanceof Error && caught.message === "TASK_VERSION")
          return err({ ...versionConflict(), field: "expectedVersion" });
        if (caught instanceof Error && caught.message === "TASK_BUSY")
          return err({ ...versionConflict(), field: "taskStatus" });
        if (caught instanceof Error && caught.message === "TASK_REPLAY") {
          const replay = await db.agentExecution.findUnique({
            where: { teacherId_clientRequestId: { teacherId: input.teacherId, clientRequestId: input.clientRequestId } },
            include: { task: { include: { steps: true } } },
          });
          if (replay?.task && replay.userTurnId) return ok({
            task: taskDto(replay.task, cipher, availability, replay.task.steps.some((step) => step.status === "uncertain")),
            receipt: { executionId: replay.id, userTurnId: replay.userTurnId, clientRequestId: replay.clientRequestId, receivedAt: replay.createdAtTs.toISOString() },
            replayed: true,
          });
          return err(internalError("教学任务幂等回执读取失败"));
        }
        if (caught instanceof Error && caught.message === "TASK_FINGERPRINT_CONFLICT")
          return err({ ...versionConflict(), field: "clientRequestId" });
        if (
          caught instanceof Prisma.PrismaClientKnownRequestError &&
          caught.code === "P2002"
        ) {
          const raced = await db.agentExecution.findUnique({
            where: {
              teacherId_clientRequestId: {
                teacherId: input.teacherId,
                clientRequestId: input.clientRequestId,
              },
            },
            include: { task: { include: { steps: true } } },
          });
          if (
            raced &&
            raced.requestFingerprint === requestFingerprint &&
            raced.task &&
            raced.userTurnId
          ) {
            return ok({
              task: taskDto(
                raced.task,
                cipher,
                availability,
                raced.task.steps.some((step) => step.status === "uncertain"),
              ),
              receipt: {
                executionId: raced.id,
                userTurnId: raced.userTurnId,
                clientRequestId: raced.clientRequestId,
                receivedAt: raced.createdAtTs.toISOString(),
              },
              replayed: true,
            });
          }
          return err({ ...versionConflict(), field: "clientRequestId" });
        }
        return err(internalError("教学任务接收事务失败"));
      }
    },
    ...createQueryStepMethods(context),
    ...createTeachingTaskReader({ getClient, cipher, availability }),
    ...createTeachingTaskLeaseMethods({
      getClient,
      cipher,
      availability,
      leaseMs,
    }),
  };
}
