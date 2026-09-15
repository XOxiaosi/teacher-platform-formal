import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTeachingTaskService } from "../../../src/features/teaching-tasks/index.js";
import {
  createFieldCipher,
  loadEncryptionKey,
} from "../../../src/shared/field-encryption/index.js";
import {
  createIsolatedPostgres,
  type IsolatedPostgres,
} from "../../helpers/isolated-postgres.js";

const TEACHER_A = "a01-runtime-teacher-a";
const TEACHER_B = "a01-runtime-teacher-b";
const cipher = createFieldCipher(loadEncryptionKey().key);
let database: IsolatedPostgres;
let prisma: PrismaClient;

beforeAll(async () => {
  database = await createIsolatedPostgres();
  prisma = database.prisma;
});
afterAll(async () => database.cleanup());
beforeEach(async () => {
  await prisma.conversationTurn.deleteMany({
    where: { teacherId: { in: [TEACHER_A, TEACHER_B] } },
  });
  await prisma.stepReceipt.deleteMany({
    where: { teacherId: { in: [TEACHER_A, TEACHER_B] } },
  });
  await prisma.agentExecution.deleteMany({
    where: { teacherId: { in: [TEACHER_A, TEACHER_B] } },
  });
  await prisma.taskRuntime.deleteMany({
    where: { teacherId: { in: [TEACHER_A, TEACHER_B] } },
  });
  await prisma.conversation.deleteMany({
    where: { teacherId: { in: [TEACHER_A, TEACHER_B] } },
  });
});

function service(availability: "unavailable" | "test_only" = "test_only") {
  return createTeachingTaskService({
    prisma,
    cipher,
    runtimeAvailability: availability,
    leaseMs: 60_000,
  });
}

describe("A01 TeachingTaskService PostgreSQL integration", () => {
  it("原子接收消息，精确幂等，并拒绝 legacy 会话接管", async () => {
    const tasks = service();
    const conversation = await tasks.createConversation({
      teacherId: TEACHER_A,
    });
    expect(conversation.ok).toBe(true);
    if (!conversation.ok) return;
    const originalMessage = "  请总结这节课  ";
    const received = await tasks.receiveMessage({
      teacherId: TEACHER_A,
      conversationId: conversation.value.id,
      clientRequestId: "a01-receive-0001",
      message: originalMessage,
    });
    expect(received.ok).toBe(true);
    if (!received.ok) return;
    expect(received.value.task.status).toBe("queued");
    const persisted = await prisma.taskRuntime.findUnique({
      where: { id: received.value.task.id },
    });
    expect(persisted?.dshCheckpoint).toBeNull();
    expect(persisted?.runtimeVersion).toBe("dsh-v1");
    const userTurn = await prisma.conversationTurn.findUnique({
      where: { id: received.value.receipt.userTurnId },
    });
    expect(userTurn?.content).toMatch(/^enc:v1:/);
    const turns = await tasks.listTaskEvents({
      teacherId: TEACHER_A,
      taskId: received.value.task.id,
    });
    expect(turns.ok).toBe(true);
    if (!turns.ok) throw new Error("Expected persisted events");
    const originalTurns = turns.value.items.filter((event) => event.role === "user");
    expect(originalTurns).toHaveLength(1);
    expect(originalTurns[0]?.content).toBe(originalMessage);
    expect(turns.value.items.filter((event) => event.eventKind === "task_state")).toHaveLength(1);
    const replay = await tasks.receiveMessage({
      teacherId: TEACHER_A,
      conversationId: conversation.value.id,
      clientRequestId: "a01-receive-0001",
      message: originalMessage,
    });
    expect(replay).toMatchObject({
      ok: true,
      value: {
        replayed: true,
        receipt: { executionId: received.value.receipt.executionId },
      },
    });
    const conflict = await tasks.receiveMessage({
      teacherId: TEACHER_A,
      conversationId: conversation.value.id,
      clientRequestId: "a01-receive-0001",
      message: "换一段正文",
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: "VERSION_CONFLICT" },
    });
    expect(
      await prisma.agentExecution.count({ where: { teacherId: TEACHER_A } }),
    ).toBe(1);
    const legacy = await prisma.conversation.create({
      data: { teacherId: TEACHER_A, status: "active", runtimeOwner: null },
    });
    const rejected = await tasks.receiveMessage({
      teacherId: TEACHER_A,
      conversationId: legacy.id,
      clientRequestId: "a01-receive-0002",
      message: "不能接管旧会话",
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("默认 unavailable 仍保存完整回执，而不同教师不能读取", async () => {
    const unavailable = service("unavailable");
    const conversation = await unavailable.createConversation({
      teacherId: TEACHER_A,
    });
    expect(conversation.ok).toBe(true);
    if (!conversation.ok) return;
    const received = await unavailable.receiveMessage({
      teacherId: TEACHER_A,
      conversationId: conversation.value.id,
      clientRequestId: "a01-unavailable-01",
      message: "保存但不要伪造模型结果",
    });
    expect(received).toMatchObject({
      ok: true,
      value: {
        task: { status: "unavailable", runtimeAvailability: "unavailable" },
      },
    });
    if (!received.ok) return;
    const execution = await prisma.agentExecution.findUnique({
      where: { id: received.value.receipt.executionId },
    });
    expect(execution?.status).toBe("unavailable");
    expect(
      await unavailable.getTask({
        teacherId: TEACHER_B,
        taskId: received.value.task.id,
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(
      await unavailable.claim({
        teacherId: TEACHER_A,
        taskId: received.value.task.id,
      }),
    ).toMatchObject({ ok: true, value: { unavailable: true } });
  });

  it("租约 epoch 阻止过期 worker 写步骤，并保留已成功 query 回执", async () => {
    const tasks = service();
    const conversation = await tasks.createConversation({
      teacherId: TEACHER_A,
    });
    expect(conversation.ok).toBe(true);
    if (!conversation.ok) return;
    const received = await tasks.receiveMessage({
      teacherId: TEACHER_A,
      conversationId: conversation.value.id,
      clientRequestId: "a01-lease-00001",
      message: "查询学生信息",
    });
    expect(received.ok).toBe(true);
    if (!received.ok) return;
    const first = await tasks.claim({
      teacherId: TEACHER_A,
      taskId: received.value.task.id,
    });
    expect(first.ok).toBe(true);
    if (!first.ok || "unavailable" in first.value) return;
    const prepared = await tasks.prepareStep({
      ...first.value.lease,
      executionId: received.value.receipt.executionId,
      stepKey: "student-query-v1",
      inputFingerprint: "f".repeat(64),
      kind: "query",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const done = await tasks.completeStep({
      ...first.value.lease,
      executionId: received.value.receipt.executionId,
      stepKey: "student-query-v1",
      result: { type: "query", items: [{ id: "student-a" }] },
    });
    expect(done).toMatchObject({
      ok: true,
      value: { status: "succeeded", result: { type: "query" } },
    });
    await prisma.taskRuntime.update({
      where: { id: received.value.task.id },
      data: { leaseExpiresAtTs: new Date(0) },
    });
    const second = await tasks.claim({
      teacherId: TEACHER_A,
      taskId: received.value.task.id,
    });
    expect(second.ok).toBe(true);
    if (!second.ok || "unavailable" in second.value) return;
    expect(second.value.lease.leaseEpoch).toBeGreaterThan(
      first.value.lease.leaseEpoch,
    );
    const stale = await tasks.failStep({
      ...first.value.lease,
      executionId: received.value.receipt.executionId,
      stepKey: "student-query-v1",
      error: { code: "OLD_WORKER", message: "过期 worker", retryable: true },
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "VERSION_CONFLICT" },
    });
    const detail = await tasks.getTask({
      teacherId: TEACHER_A,
      taskId: received.value.task.id,
    });
    expect(detail).toMatchObject({
      ok: true,
      value: { steps: [{ status: "succeeded", result: { type: "query" } }] },
    });
  });

  it("归档会话、错误 execution 与终态步骤均只返回冲突，不抛出或降级已成功回执", async () => {
    const tasks = service();
    const conversation = await tasks.createConversation({
      teacherId: TEACHER_A,
    });
    expect(conversation.ok).toBe(true);
    if (!conversation.ok) return;
    const received = await tasks.receiveMessage({
      teacherId: TEACHER_A,
      conversationId: conversation.value.id,
      clientRequestId: "a01-conflict-001",
      message: "查询",
    });
    expect(received.ok).toBe(true);
    if (!received.ok) return;
    const claimed = await tasks.claim({
      teacherId: TEACHER_A,
      taskId: received.value.task.id,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok || "unavailable" in claimed.value) return;
    const lease = claimed.value.lease;
    await expect(
      tasks.completeStep({
        ...lease,
        executionId: "foreign-execution",
        stepKey: "missing",
        result: { type: "query" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "VERSION_CONFLICT" },
    });
    await tasks.prepareStep({
      ...lease,
      executionId: received.value.receipt.executionId,
      stepKey: "stable",
      inputFingerprint: "a".repeat(64),
      kind: "query",
    });
    await tasks.completeStep({
      ...lease,
      executionId: received.value.receipt.executionId,
      stepKey: "stable",
      result: { type: "query", items: [] },
    });
    await expect(
      tasks.failStep({
        ...lease,
        executionId: received.value.receipt.executionId,
        stepKey: "stable",
        error: { code: "LATE", message: "late", retryable: false },
      }),
    ).resolves.toMatchObject({ ok: true, value: { status: "succeeded" } });
    await prisma.conversation.update({
      where: { id: conversation.value.id },
      data: { status: "archived" },
    });
    await expect(tasks.heartbeat(lease)).resolves.toMatchObject({
      ok: false,
      error: { code: "VERSION_CONFLICT" },
    });
  });

  it("接收事务在写入 turn 失败时回滚 task、execution 和 turn", async () => {
    const faulting = prisma.$extends({
      query: {
        conversationTurn: {
          async create({ args, query }) {
            void args;
            void query;
            throw new Error("inject turn failure");
          },
        },
      },
    }) as unknown as PrismaClient;
    const tasks = createTeachingTaskService({
      prisma: faulting,
      cipher,
      runtimeAvailability: "test_only",
    });
    const conversation = await tasks.createConversation({
      teacherId: TEACHER_A,
    });
    expect(conversation.ok).toBe(true);
    if (!conversation.ok) return;
    await expect(
      tasks.receiveMessage({
        teacherId: TEACHER_A,
        conversationId: conversation.value.id,
        clientRequestId: "a01-rollback-001",
        message: "必须整体回滚",
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(
      await prisma.taskRuntime.count({ where: { teacherId: TEACHER_A } }),
    ).toBe(0);
    expect(
      await prisma.agentExecution.count({ where: { teacherId: TEACHER_A } }),
    ).toBe(0);
    expect(
      await prisma.conversationTurn.count({ where: { teacherId: TEACHER_A } }),
    ).toBe(0);
  });

  it("同一 clientRequestId 并发接收只保留一个 task/execution/turn 三元组", async () => {
    const tasks = service();
    const conversation = await tasks.createConversation({ teacherId: TEACHER_A });
    expect(conversation.ok).toBe(true);
    if (!conversation.ok) return;
    const request = {
      teacherId: TEACHER_A,
      conversationId: conversation.value.id,
      clientRequestId: "a01-parallel-001",
      message: "并发重放",
    };
    const [first, second] = await Promise.all([
      tasks.receiveMessage(request),
      tasks.receiveMessage(request),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.receipt.executionId).toBe(second.value.receipt.executionId);
    expect(first.value.receipt.userTurnId).toBe(second.value.receipt.userTurnId);
    expect(first.value.task.id).toBe(second.value.task.id);
    expect([first.value.replayed, second.value.replayed]).toContain(true);
    expect(await prisma.taskRuntime.count({ where: { teacherId: TEACHER_A } })).toBe(1);
    expect(await prisma.agentExecution.count({ where: { teacherId: TEACHER_A } })).toBe(1);
    expect(await prisma.conversationTurn.count({ where: { teacherId: TEACHER_A, role: "user" } })).toBe(1);
  });

  it("waiting_input 的同版本续消息并发重试返回同一回执", async () => {
    const tasks = service();
    const conversation = await tasks.createConversation({ teacherId: TEACHER_A });
    expect(conversation.ok).toBe(true);
    if (!conversation.ok) return;
    const initial = await tasks.receiveMessage({ teacherId: TEACHER_A, conversationId: conversation.value.id, clientRequestId: "a01-waiting-001", message: "需要补充学生姓名" });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const claimed = await tasks.claim({ teacherId: TEACHER_A, taskId: initial.value.task.id });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok || "unavailable" in claimed.value) return;
    const waiting = await tasks.finish({ ...claimed.value.lease, executionId: initial.value.receipt.executionId, status: "waiting_input" });
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;
    const request = { teacherId: TEACHER_A, conversationId: conversation.value.id, taskId: initial.value.task.id, expectedVersion: waiting.value.version, clientRequestId: "a01-waiting-002", message: "学生是小明" };
    const [first, second] = await Promise.all([tasks.receiveMessage(request), tasks.receiveMessage(request)]);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.receipt.executionId).toBe(second.value.receipt.executionId);
    expect([first.value.replayed, second.value.replayed]).toContain(true);
  });
});
