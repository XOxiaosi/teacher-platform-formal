# A02-WORKER / A03-REC2 / A04-SRC 验证记录

日期：2026-09-15（America/Los_Angeles）
需求基线：V009  受影响范围：F01、F05、F06、F07、F08、F13、F14、F17、F18

## 目标与边界

本波按用户授权并行推进三个局部任务：A02 增加教学任务 worker 的租约心跳围栏，A03 补助手恢复后的事件刷新和登出草稿清理，A04 关闭 Capture 删除后来源副本仍可读的缺口。只使用本地合成运行时和隔离 PostgreSQL；不读取旧凭据、不调用真实 DeepSeek/DSH、不接入真实教师资料或渠道、不上传、发布、部署或远端 push。

A04 只关闭来源失效传播的一部分：删除 Capture 后保留 `StudentSourceRecord` 的来源 ID、哈希和 `deleted` 状态，清掉 `rawText`；已确认的 `StudentRecord` 保留。`CaptureCandidate` 当前的一材料一候选唯一约束、多候选迁移、来源准入和跨设备验收仍未完成。

## 分工与提交

| 任务 | 负责人 | 改动 | 提交 |
|---|---|---|---|
| A02-WORKER | 子 Agent `/root/a01_runtime_impl` | worker 唤醒/单次运行、租约心跳、丢租约中止及专项测试 | `3f8837a feat(A02): add fenced teaching task worker` |
| A03-REC2 | 子 Agent `/root/a03_assistant_frontend` | 恢复事件刷新、按教师登出清理草稿及专项测试 | `9e60ed5 fix(A03-REC2): refresh task events and clear assistant drafts on logout` |
| A03-REC2 测试 | 主 Agent | 认证上下文回归覆盖 | `014d195 test(A03-REC2): cover auth recovery behavior` |
| A04-SRC | 主 Agent | 删除事务清理来源原文、来源读取 deleted 投影及实库回归 | `385f1b5 fix(A04): invalidate deleted capture sources` |

## 验证证据

- A02 worker/运行器：后端专项测试在全量隔离入口通过；worker 2 项、运行器 16 项、synthetic runtime 6 项均为绿色。
- A03 前端：专项 AssistantWorkspace/transport 测试 20 项通过，frontend lint 退出 0；全量前端 39 个测试文件、233 项通过。
- A04 来源失效：`tests/functional/capture/capture-service.test.ts` 10 项通过，覆盖确认记录、复制来源密文存在、删除后数据库行 `captureStatus=deleted`/`rawText=null`、来源服务不再返回原文、StudentRecord 保留。
- 完整隔离回归命令：`node scripts/run-tests-with-postgres.mjs`。首次运行仅出现既有 `tests/e2e/db-routing-workflow.test.ts` 的 10 秒 `beforeAll` 超时（该文件 6 项均为 skip）；同一入口随后重跑退出 0：后端 303 文件/2688 项、前端 39 文件/233 项、管理端 13 文件/84 项、运维 124 项通过，运维 2 项 Windows 专属测试跳过。
- 静态检查：`npm run build --workspace @teacher-platform/backend` 退出 0；A04 三个改动文件 ESLint 退出 0；提交前 `git diff --cached --check` 通过。

## 结论

本波本地工程验证通过，A02/A03 仍为进行中，A04 仅完成来源失效子项。真实 DSH/DeepSeek 适配、真实模型效果、跨设备/Windows、微信渠道、正式写事务、多候选 schema 迁移、来源准入和用户验收不能由上述本地结果替代。文档同步后必须再运行根 `npm run check`，以该次退出码作为交付门禁。
