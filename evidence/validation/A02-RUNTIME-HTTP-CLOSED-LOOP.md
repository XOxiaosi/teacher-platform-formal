# A02｜教学任务 HTTP 运行闭环与重建恢复验收

状态：聚焦集成验收与完整工程 Gate 均通过

日期：2026-09-21（America/Los_Angeles）

项目：TPF / 教师 AI 工作平台

本文记录 A02 的集成验收边界和回填位置。它不是对真实 DSH、DeepSeek、微信或真实教师资料的可用性声明；最终 Gate 以主 Agent 实际运行的测试命令、输出和提交为准。

## 1. 本包目标

A02 本包验证一条可以从 HTTP 入口追踪到持久结果的教学任务闭环：

`HTTP 消息接收 → TaskRuntime 持久化 → process-local worker 唤醒 → runner 认领租约 → synthetic driver 执行 → 结果/事件持久化 → HTTP 详情与事件回看`

同时验证重建边界：首个 app/worker 执行中断并保存持久 `dshSessionRef` 与加密 checkpoint 后，创建新的 app/worker 实例；新的补充消息重新唤醒任务，runner 从数据库读取同一任务的持久 session/checkpoint 和历史，继续未完成执行并把结果写回原任务。

本包的 driver 是 `test_only` 合成运行时。它用于证明平台的消息、租约、检查点、结果和事件契约，不模拟真实供应商延迟、质量、费用或网络行为。

## 2. 明确边界

- 不连接真实 DSH、DeepSeek、微信 chatbot 或其他外部供应商。
- 不读取、上传或写入真实教师、学生或业务资料；测试数据为合成数据，并使用本地临时数据库/隔离测试租户。
- 不把合成 driver 当作生产模型可用。生产能力关闭时，任务必须保留 `unavailable` 语义。
- 不把 checkpoint、session 引用、lease token、原始工具调用、密钥或内部运行参数通过 HTTP DTO 暴露；HTTP 只返回安全任务、执行、步骤和事件投影。
- 本包不声称存在服务启动后的自动扫描恢复。当前 worker 是显式唤醒、无后台循环的 process-local dispatcher；持久任务仍由受控消息/唤醒入口触发，扫描恢复另行验收。
- 本包不进入 `confirmed_write`、自动扣课、正式记录写入、微信连接或发布流程；B01/B02 未决产品语义不由本包冻结。

## 3. 集成场景与验收断言

### 3.1 HTTP 首次消息到结果回看

通过教学任务 HTTP 路由创建会话并提交首次消息，断言：

1. HTTP 返回持久 receipt 和任务快照；重复相同 `clientRequestId` 只读回原 receipt，不产生第二条用户消息或第二次执行。
2. worker 被路由显式唤醒后，runner 从数据库认领有效租约，并将合成 driver 的输出、步骤回执、任务状态和可见事件写入同一任务链。
3. 通过 `GET /teaching-tasks/:taskId` 和 `GET /teaching-tasks/:taskId/events` 读回成功状态、执行/步骤投影以及 `message_received`、`task_state`、`step_result`、`assistant_message` 等可见事件。
4. HTTP 返回的数据不包含 checkpoint、session 引用和租约内部字段。

### 3.2 中断、app/worker 重建与补充消息续跑

使用 synthetic driver 的等待输入/保存 checkpoint 行为，断言：

1. 首次执行能够落库 `dshSessionRef` 和版本化、加密的 checkpoint，并进入等待补充消息所对应的状态；数据库记录是恢复真源。
2. 以同一 PostgreSQL 数据创建新的 app、worker、runner 和 driver，并只通过新 app 提交后续请求。
3. 通过补充消息 HTTP 接口提交新的 `clientRequestId` 与正确的 `expectedVersion`；新的 runner 读取持久 session/checkpoint 和当前任务允许的历史，而不是依赖进程内 map 或旧 runner 内存。
4. 新执行只推进尚未完成的部分，并把最终 assistant 结果、任务状态、步骤和事件写回原 task；已完成步骤不因 app/worker 重建而整体重放。
5. 对同一补充消息重复请求或重复唤醒，driver 执行次数和平台可见消息保持幂等。

### 3.3 unavailable 分支

以生产能力 `unavailable` 的 driver 组装 worker，断言：

1. HTTP 消息和任务接收回执仍然保存，教师可以从任务详情看到明确的不可用状态。
2. worker 不认领任务、不调用 runner/driver、不写伪造的 assistant 成功正文，也不把测试运行结果投影为生产成功。
3. 后续恢复仍需显式能力恢复和受控唤醒；本包不宣称不可用任务会被后台自动扫描执行。

### 3.4 租户隔离

使用两个合成教师身份，断言另一个教师不能通过 taskId、conversationId、executionId 或事件接口读取或继续第一个教师的任务；服务端身份来自请求认证上下文，worker 从已验证的 TaskRuntime 派生教师范围。

## 4. 运行时实现对应关系

- `packages/backend/src/app/routes/teaching-tasks.routes.ts`：负责消息接收、详情/事件投影和显式 `wake`；重复回放不再次唤醒。
- `packages/backend/src/app/teaching-runtime/teaching-task-runtime-worker.ts`：维护进程内待处理键并在可用时调用一次 runner；`unavailable` 时保留待处理项，不出队、不认领。
- `packages/backend/src/app/teaching-runtime/task-runtime-runner.ts`：认领租约、读取当前任务历史、校验 checkpoint、调用受限 driver、保存加密 checkpoint，并在租约围栏内完成步骤和消息。
- `packages/backend/src/app/teaching-runtime/synthetic-runtime-driver.ts`：A02 `test_only` 合成 driver；只提供已审计教学查询/等待/失败等测试行为。
- `TaskRuntime.dshSessionRef` 与 `TaskRuntime.dshCheckpoint`：服务端持久恢复关联；两者不进入安全 HTTP DTO。

## 5. 验证记录

| 检查 | 命令 | 结果 |
|---|---|---|
| A02 HTTP 闭环专项 | PostgreSQL 17 根安全 harness 定向启动 backend 单文件测试 | 41 个迁移应用成功；1 文件 / 2 测试通过；退出码 0；临时集群正常关闭并清理 |
| checkpoint/session 重建专项 | 包含在上项 | 新 Prisma、app、worker、runner 收到原 `synthetic:<taskId>` sessionRef、合法 `dsh-v1` checkpoint 和首轮 user/assistant + 新 user 历史；最终状态 `succeeded` |
| unavailable、幂等、租户隔离 | 包含在上项 | 重放不重复运行；步骤 `attemptCount=1`；另一教师的详情、事件、续发消息均 404；unavailable 无 driver 调用、无 assistant 成功消息 |
| 后端静态检查 | backend build；目标测试文件 ESLint quiet | 两项退出码均为 0 |
| 既有数据库 Hook 超时复现 | 两次 `npm run check`；全新 PostgreSQL 17 定向复跑 4 个旧套件 | 首轮 4 个旧套件在 `beforeAll` 应用 41 个迁移时超过默认 10 秒；第二轮 `db-routing-workflow` 在 10.788 秒再次复现。A02 两轮均为 2/2 通过，且没有调用这些套件的建库 helper |
| 测试设施修复 | backend Vitest `hookTimeout: 30_000`；定向复跑 4 个旧套件 | 4 文件 / 45 测试全部通过；`db-routing-workflow` 用时 11.529 秒，证明原 10 秒阈值会误杀正常迁移，30 秒仍保留有限超时 |
| 项目完整门禁 | `npm run check` | 退出码 0：治理 25；后端 333 文件 / 2876 测试；前端 58 文件 / 396 测试；管理端 13 文件 / 84 测试；ops 150 通过 / 2 个 Windows 专属按平台跳过；类型、lint、41 个迁移与全部生产构建通过 |

聚焦数据库命令：

```bash
node --input-type=module -e 'import { runTestsWithPostgres } from "./scripts/run-tests-with-postgres.mjs"; process.exitCode = await runTestsWithPostgres({ childCommandFactory: () => ({ command: process.execPath, args: ["packages/backend/scripts/run-tests-isolated.mjs", "tests/e2e/a02-teaching-runtime-http-workflow.test.ts"] }) });'
```

该命令由根安全 harness 创建短生命周期 PostgreSQL 17 集群；测试子进程再创建随机测试数据库并应用同一组 41 个迁移。测试结束后，随机数据库、集群进程和临时目录均由各自安全清理逻辑收口。

完整门禁的首次失败来自四个既有数据库套件的 `beforeAll` 默认 10 秒阈值，而非并行争用：backend 配置本来就有 `fileParallelism: false`。首轮结果为 329 文件通过、4 个套件超时，2836 个测试通过、40 个跳过；A02 新增测试 2/2 通过。全新临时库定向复跑四个套件全部通过，第二次完整门禁又让 `db-routing-workflow` 在 10.788 秒复现同一超时，因而将全局 Hook 阈值明确设为 30 秒。修复后定向 4 文件/45 测试及最终完整门禁全部通过；没有修改生产代码、schema 或迁移。

## 6. 本包之后仍未被证明的事项

即使本包通过，也不能据此推出以下能力已经完成：真实 DSH/DeepSeek 调用、真实微信扫码连接、服务重启后的自动任务扫描恢复、跨设备登录用户验收、正式业务写事务、反馈改文或扣课数量语义、费用结算、生产部署和对外发布。
