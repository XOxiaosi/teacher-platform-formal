# A02-INT / A03-REC 恢复波次验证

日期：2026-09-15（America/Los_Angeles）
项目：TPF / 教师 AI 工作平台
范围：本地合成运行时、隔离 PostgreSQL、正式助手任务/事件恢复；不包含真实供应商或真实教师资料。

## 分工与提交

- A02-INT：后端运行器、租约/检查点/StepReceipt 围栏及专项测试。
- A03-REC：前端任务/事件 cursor 分页、去重和助手恢复展示及专项测试。
- 独立审阅：只读复核契约、租约、历史隔离、恢复和分页边界；主 Agent 核对实际 diff、命令输出并提交。
- 后端提交：`62e2e88 feat(A02): run fenced teaching tasks through runtime`
- 前端提交：`e95db72 feat(A03): paginate teaching task recovery`

## 验证结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 前端专项 | `npm -w @teacher-platform/frontend exec vitest run src/connected/assistant/AssistantWorkspace.test.tsx src/connected/assistant/teaching-task-transport.test.ts` | 20/20 通过，退出 0 |
| 前端 lint | `npm run lint --workspace @teacher-platform/frontend` | 退出 0 |
| 运行器专项 | `npm -w @teacher-platform/backend exec vitest run tests/functional/teaching-runtime/task-runtime-runner.test.ts tests/functional/teaching-runtime/synthetic-runtime-driver.test.ts tests/functional/composition/teaching-query-tools.test.ts` | 14 项运行器测试及组合测试在完整入口通过 |
| 完整门禁 | `npm run check` | 退出 0；治理 16 项；后端 302 文件/2683 项；前端 38 文件/231 项；管理端 13 文件/84 项；ops 124 通过、2 项 Windows 专属测试跳过；类型、lint、长度检查和构建通过 |

完整入口使用项目隔离 PostgreSQL harness，测试结束后临时集群已清理。初始专项运行曾暴露恢复路径和跨 execution receipt 复用问题，已修复并重新通过；失败输出保留在运行环境日志中，未被覆盖。

## 已验证的边界

- production `unavailable` 路径不 claim、不调用 driver，缺少加密密钥时 fail-closed。
- 运行器只读取当前任务历史，检查点校验 runtime/version/epoch，输出检查点、租约有效期和 token/epoch 均受数据库围栏保护。
- query 步骤记录 StepReceipt；同一 execution 可重放成功 receipt，新 execution 必须重新查询；错误的 retryable 策略不会伪造可恢复状态。
- 任务和事件分页会继续读取 cursor，重复 cursor 停止，重复 eventKey 去重；刷新后按 seq 重建任务进展，任务 21 可展示。

## 未验证与下一步

真实 DeepSeek/DSH adapter、真实教师资料、Windows 设备、跨设备/重登用户验收、微信渠道、正式写事务和发布仍未验证。A02/A03 继续保持“进行中”；在获得明确凭据、预算和外部验收授权前不调用真实供应商、不上传、不发布。
