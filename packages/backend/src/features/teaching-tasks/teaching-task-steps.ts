import { Prisma } from '@prisma/client';
import { err, internalError, ok, validationError, versionConflict } from '@teacher-platform/contracts';
import { encryptJsonFieldValue } from '../../shared/field-encryption/index.js';
import { stepDto } from './teaching-task-reader.js';
import { parseSourceRefs } from './teaching-task-sources.js';
import { json, safeResult, validRefs, validError, type createTaskContext } from './teaching-task-context.js';
import type { TeachingTaskService } from './types.js';

export function createQueryStepMethods(context: ReturnType<typeof createTaskContext>):
  Pick<TeachingTaskService, 'prepareStep' | 'completeStep' | 'failStep'> {
  const { getClient, cipher, writable, now, event, authorized, sourceRefsCurrent, invalidateContext } = context;
  return {
    async prepareStep(input) {
      try {
      const blocked = writable();
      if (blocked) return blocked;
      if (
        input.kind !== "query" ||
        !validRefs(input.sourceRefs) ||
        !input.stepKey ||
        !input.inputFingerprint
      )
        return err(
        validationError("query 步骤来源引用格式无效", "sourceRefs"),
        );
      const db = await getClient();
      const step = await db.$transaction(async (tx) => {
        const task = await authorized(tx, input);
        if (!task) return null;
        const clock = await now(tx);
        if (!clock.ok) return null;
        const inputRefs = input.sourceRefs ?? [];
        if (!(await sourceRefsCurrent(tx, input.teacherId, inputRefs))) return null;
        const execution = await tx.agentExecution.findFirst({
          where: {
            id: input.executionId,
            teacherId: input.teacherId,
            taskId: task.id,
          },
        });
        if (!execution || task.currentExecutionId !== input.executionId) return null;
        const existing = await tx.stepReceipt.findFirst({
          where: {
            teacherId: input.teacherId,
            taskId: task.id,
            stepKey: input.stepKey,
          },
        });
        if (existing) {
          if (
            existing.kind !== "query" ||
            existing.inputFingerprint !== input.inputFingerprint ||
            existing.executionId !== input.executionId
          )
            return null;
          if (existing.status === "succeeded") {
            const refs = parseSourceRefs(existing.sourceRefs);
            if (!refs || !(await sourceRefsCurrent(tx, input.teacherId, refs))) {
              await tx.stepReceipt.update({ where: { id: existing.id }, data: { status: 'invalidated', updatedAtTs: clock.value } });
              await invalidateContext(tx, task.id, input.teacherId, clock.value);
              return null;
            }
            return existing;
          }
          if (
            existing.status === "running" &&
            existing.executionId === input.executionId &&
            existing.leaseEpoch === input.leaseEpoch
          )
            return existing;
          if (["uncertain", "invalidated", "waiting_confirmation"].includes(existing.status)) return null;
          return tx.stepReceipt.update({
            where: { id: existing.id },
            data: {
              status: "running",
              leaseEpoch: input.leaseEpoch,
              attemptCount: { increment: 1 },
              error: Prisma.DbNull,
              updatedAtTs: clock.value,
            },
          });
        }
        return tx.stepReceipt.create({
          data: {
            teacherId: input.teacherId,
            taskId: task.id,
            executionId: input.executionId,
            stepKey: input.stepKey,
            kind: "query",
            inputFingerprint: input.inputFingerprint,
            status: "running",
            attemptCount: 1,
            leaseEpoch: input.leaseEpoch,
            sourceRefs: json(inputRefs),
            createdAtTs: clock.value,
            updatedAtTs: clock.value,
          },
        });
      });
      if (!step) return err(versionConflict());
      return ok(stepDto(step, cipher));
      } catch { return err(internalError("查询步骤事务失败")); }
    },
    async completeStep(input) {
      try {
      const blocked = writable();
      if (blocked) return blocked;
      if (!safeResult(input.result))
        return err(validationError("查询结果格式无效", "result"));
      const sourceRefs = input.sourceRefs ?? [];
      if (!validRefs(sourceRefs) || !parseSourceRefs(sourceRefs)) return err(validationError("查询来源引用格式无效", "sourceRefs"));
      const db = await getClient();
      const step = await db.$transaction(async (tx) => {
        const task = await authorized(tx, input);
        if (!task) return null;
        const clock = await now(tx);
        if (!clock.ok) return null;
        const row = await tx.stepReceipt.findFirst({
          where: {
            teacherId: input.teacherId,
            taskId: task.id,
            executionId: input.executionId,
            stepKey: input.stepKey,
            kind: "query",
          },
        });
        if (
          !row ||
          row.leaseEpoch !== input.leaseEpoch ||
          task.currentExecutionId !== input.executionId
        )
          return null;
        if (row.status === "succeeded") {
          const refs = parseSourceRefs(row.sourceRefs);
          if (!refs || !(await sourceRefsCurrent(tx, input.teacherId, refs))) {
            await tx.stepReceipt.update({ where: { id: row.id }, data: { status: 'invalidated', updatedAtTs: clock.value } });
            await invalidateContext(tx, task.id, input.teacherId, clock.value);
            return null;
          }
          return row;
        }
        if (!["prepared", "running"].includes(row.status)) return null;
        if (!(await sourceRefsCurrent(tx, input.teacherId, sourceRefs))) {
          await tx.stepReceipt.update({ where: { id: row.id }, data: { status: 'invalidated', updatedAtTs: clock.value } });
          await invalidateContext(tx, task.id, input.teacherId, clock.value);
          return null;
        }
        const updated = await tx.stepReceipt.update({
          where: { id: row.id },
          data: {
            status: "succeeded",
            resultRef: json(
              encryptJsonFieldValue(cipher, { public: input.result }),
            ),
            sourceRefs: json(sourceRefs),
            error: Prisma.DbNull,
            updatedAtTs: clock.value,
          },
        });
        const result = input.result as Record<string, unknown> | null;
        const proposal = result && typeof result.pendingActionId === 'string' && typeof result.toolCallId === 'string'
          ? await tx.pendingAction.findFirst({ where: { id: result.pendingActionId, toolCallId: result.toolCallId,
            teacherId: input.teacherId, conversationId: task.conversationId } }) : null;
        const savedStudent = input.stepKey.includes(':students.create:') && result && typeof result.id === 'string'
          ? await tx.student.findFirst({ where: { id: result.id, teacherId: input.teacherId }, select: { id: true, name: true } }) : null;
        await event(
          tx,
          task.conversationId,
          input.teacherId,
          task.id,
          input.executionId,
          "step_result",
          `step:${row.id}:succeeded`,
          "tool",
          proposal ? '已准备操作，请核对后确认' : savedStudent ? `学生 ${savedStudent.name} 已保存` : '查询步骤已完成',
          { stepId: row.id, ...(proposal ? { toolCallId: proposal.toolCallId } : {}),
            ...(savedStudent ? { toolName: 'students.create', savedStudent } : {}) },
          clock.value,
        );
        return updated;
      });
      if (!step) return err(versionConflict());
      return ok(stepDto(step, cipher));
      } catch { return err(internalError("查询步骤事务失败")); }
    },
    async failStep(input) {
      try {
      const blocked = writable();
      if (blocked) return blocked;
      if (!validError(input.error))
        return err(validationError("错误回执无效", "error"));
      const db = await getClient();
      const step = await db.$transaction(async (tx) => {
        const task = await authorized(tx, input);
        if (!task) return null;
        const clock = await now(tx);
        if (!clock.ok) return null;
        const row = await tx.stepReceipt.findFirst({
          where: {
            teacherId: input.teacherId,
            taskId: task.id,
            executionId: input.executionId,
            stepKey: input.stepKey,
            kind: "query",
          },
        });
        if (
          !row ||
          row.leaseEpoch !== input.leaseEpoch ||
          task.currentExecutionId !== input.executionId
        )
          return null;
        if (row.status === "succeeded") return row;
        if (["failed", "uncertain", "invalidated", "waiting_confirmation"].includes(row.status)) return row;
        const status = input.status ?? "failed";
        const updated = await tx.stepReceipt.update({
          where: { id: row.id },
          data: {
            status,
            error: json(encryptJsonFieldValue(cipher, input.error)),
            updatedAtTs: clock.value,
          },
        });
        await event(
          tx,
          task.conversationId,
          input.teacherId,
          task.id,
          input.executionId,
          "task_error",
          `step:${row.id}:${status}:${row.attemptCount}`,
          "error",
          "查询步骤失败",
          { stepId: row.id, status },
          clock.value,
        );
        return updated;
      });
      if (!step) return err(versionConflict());
      return ok(stepDto(step, cipher));
      } catch { return err(internalError("查询步骤事务失败")); }
    },
  };
}
