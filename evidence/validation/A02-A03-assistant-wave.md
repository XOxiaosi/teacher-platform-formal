# A02/A03 助手波次验证记录

## 范围与边界

- A02：固定 `dsh-v1` 运行时端口，提供仅测试用的本地合成 driver；只接受已审计只读教学查询，生产默认 `unavailable`。本记录不把合成 driver 当作真实 DeepSeek/DSH 接通，也不替代 TaskRuntime 数据库恢复验收。
- A03：正式登录工作区挂载持久助手入口，使用教学任务 API 适配层展示任务状态并提供失败/部分完成任务的继续处理入口。真实模型、真实教师资料、凭据、微信和发布仍未接入。

## 子 Agent 分工与主 Agent 检查

| 分块 | 子 Agent 负责 | 主 Agent 检查 |
|---|---|---|
| A02 运行时 | `packages/backend/src/app/teaching-runtime/**`、`scripts/dsh-runtime/**` 及专项测试 | 检查 query 白名单、shell 越权回归、可用性映射、无真实网络/凭据 |
| A03 助手 | `packages/frontend/src/connected/assistant/**` 及专项测试 | 检查 A01 DTO 到 transport 的映射、回执后草稿清除、恢复版本参数、正式入口挂载 |
| 契约审查 | 独立只读审阅 | 发现并修复 synthetic query 未校验 definitions 的 P1；恢复测试范围收窄为 token/checkpoint 传递 |

## 已执行的定向验证

- `npm run test --workspace @teacher-platform/frontend -- --run src/connected/assistant/AssistantWorkspace.test.tsx src/connected/assistant/teaching-task-transport.test.ts`：14 项通过。
- `npm run test --workspace @teacher-platform/frontend -- --run src/connected/ConnectedWorkspace.test.tsx`：7 项通过。
- `npm run lint --workspace @teacher-platform/frontend`：通过。
- 子 Agent 报告：A02 synthetic runtime 与教学工具专项共 10 项通过，backend build 与 teaching-runtime lint 通过；主 Agent 后续完整检查需再次确认。

## 未完成验证与边界

- 根 `npm run check` 已在本批文件收口后由主 Agent 执行，退出码 0：治理 16 项、后端 301 文件/2669 项、前端 38 文件/225 项、管理端 13 文件/84 项、运维 124 项通过；运维 2 项 Windows 专属测试在 macOS 跳过。类型、lint、全量隔离 PostgreSQL 17 测试和构建均通过。
- A02 的真实上游 DSH 脚本只允许固定 SHA、脚本级网络阻断和合成模型；尚未以真实供应商或真实资料验收。
- A02 synthetic driver 尚未接入生产 TaskRuntime claim/finish 流程；`dshSessionRef` 与 checkpoint 的数据库重建恢复仍由后续 A02 集成验收承担。
- A03 当前沿用会话只读投影读取消息，教学任务发送/恢复走独立 API；正式助手的真实 DSH 执行和跨设备用户验收仍未完成。
