import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  err,
  internalError,
  ok,
} from "@teacher-platform/contracts";
import {
  createFieldCipherFromEnv,
  encryptFieldValue,
  encryptJsonFieldValue,
} from "../../shared/field-encryption/index.js";
import type {
  CreateTeachingTaskServiceOptions,
  SourceRef,
  TeachingTaskLease,
} from "./types.js";
import { sourceRefsCurrent } from './teaching-task-sources.js';

export const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const LEASE_MS = 60_000;
type Db = PrismaClient | Prisma.TransactionClient;

export function fingerprint(
  conversationId: string,
  taskId: string | undefined,
  message: string,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "teaching-task-request-v1",
        conversationId,
        taskId ?? null,
        message,
        [],
      ]),
    )
    .digest("hex");
}
export function json(value: unknown) {
  return value as Prisma.InputJsonValue;
}
export function validError(value: unknown): value is { code: string; message: string; retryable: boolean } {
  return Boolean(value) && typeof value === "object"
    && typeof (value as Record<string, unknown>).code === "string"
    && typeof (value as Record<string, unknown>).message === "string"
    && typeof (value as Record<string, unknown>).retryable === "boolean";
}
export function safeResult(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(safeResult);
  return (
    typeof value === "object" &&
    Object.keys(value as Record<string, unknown>).length <= 100 &&
    Object.values(value as Record<string, unknown>).every(safeResult)
  );
}
export function validRefs(refs: SourceRef[] | undefined) {
  return !refs || refs.every((ref) => Boolean(ref) && typeof ref.type === 'string' && ref.type.length > 0
    && typeof ref.id === 'string' && ref.id.length > 0
    && typeof ref.version === 'string' && ref.version.length > 0);
}
export function createTaskContext(
  options: CreateTeachingTaskServiceOptions,
) {
  const getClient = options.getClient ?? (async () => options.prisma);
  const cipher = options.cipher ?? createFieldCipherFromEnv();
  const availability = options.runtimeAvailability ?? "unavailable";
  const leaseMs = options.leaseMs ?? LEASE_MS;
  if (!Number.isInteger(leaseMs) || leaseMs < 1)
    throw new Error("leaseMs 必须为正整数");
  const writable = () =>
    cipher
      ? null
      : err(
          internalError("SAFETY_BLOCK: 缺少 ENCRYPTION_KEY，拒绝教学任务写入"),
        );
  async function now(db: Db) {
    try {
      const rows = await db.$queryRaw<Array<{ now: Date }>>(
        Prisma.sql`SELECT clock_timestamp() AS "now"`,
      );
      return rows[0]?.now instanceof Date
        ? ok(rows[0].now)
        : err(internalError("数据库可信时钟不可用"));
    } catch {
      return err(internalError("数据库可信时钟不可用"));
    }
  }
  async function lockConversation(tx: Db, id: string) {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "Conversation" WHERE id = ${id} FOR UPDATE`,
    );
  }
  async function lockTask(tx: Db, id: string) {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "TaskRuntime" WHERE id = ${id} FOR UPDATE`,
    );
  }
  async function lockActiveTask(tx: Db, teacherId: string, taskId: string) {
    const target = await tx.taskRuntime.findFirst({
      where: { id: taskId, teacherId },
      select: { conversationId: true },
    });
    if (!target) return null;
    await lockConversation(tx, target.conversationId);
    await lockTask(tx, taskId);
    const clock = await now(tx);
    if (!clock.ok) return null;
    const conversation = await tx.conversation.findFirst({
      where: {
        id: target.conversationId,
        teacherId,
        status: "active",
        runtimeOwner: "dsh-v1",
      },
    });
    if (!conversation) return null;
    const task = await tx.taskRuntime.findFirst({
      where: { id: taskId, teacherId },
    });
    return task ? { task, at: clock.value } : null;
  }
  async function event(
    tx: Db,
    conversationId: string,
    teacherId: string,
    taskId: string,
    executionId: string | null,
    eventKind:
      | "message_received"
      | "task_state"
      | "step_result"
      | "task_error"
      | "assistant_message",
    eventKey: string,
    role: "user" | "assistant" | "tool" | "error",
    content: string,
    toolResults: unknown,
    at: Date,
  ) {
    const conversation = await tx.conversation.update({
      where: { id: conversationId },
      data: { nextEventSeq: { increment: 1 }, updatedAtTs: at },
      select: { nextEventSeq: true },
    });
    return tx.conversationTurn.create({
      data: {
        conversationId,
        teacherId,
        taskId,
        executionId,
        seq: conversation.nextEventSeq,
        eventKey,
        eventKind,
        role,
        content: encryptFieldValue(cipher, content),
        toolResults: json(encryptJsonFieldValue(cipher, toolResults)),
        createdAtTs: at,
      },
    });
  }
  async function authorized(tx: Db, lease: TeachingTaskLease) {
    const locked = await lockActiveTask(tx, lease.teacherId, lease.taskId);
    if (!locked) return null;
    return tx.taskRuntime.findFirst({
      where: {
        id: lease.taskId,
        teacherId: lease.teacherId,
        status: "running",
        leaseToken: lease.leaseToken,
        leaseEpoch: lease.leaseEpoch,
        leaseExpiresAtTs: { gt: locked.at },
      },
    });
  }

  async function invalidateContext(tx: Db, taskId: string, teacherId: string, at: Date): Promise<void> {
    await tx.taskRuntime.updateMany({
      where: { id: taskId, teacherId, status: 'running' },
      data: {
        contextEpoch: { increment: 1 },
        dshSessionRef: null,
        dshCheckpoint: Prisma.DbNull,
        version: { increment: 1 },
        updatedAtTs: at,
      },
    });
  }


  return { getClient, cipher, availability, leaseMs, writable, now, lockConversation, lockTask, event, authorized, sourceRefsCurrent, invalidateContext };
}
