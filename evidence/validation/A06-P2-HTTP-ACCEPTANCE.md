# A06 / P2：反馈正式入口与合成业务任务验收证据

日期：2026-09-16（洛杉矶）

本记录把 P2 首个完整示例的本地合成证据集中到同一处：
“整理小雨今天的上课记录，核对课时，再写给家长的反馈”。合成资料、mock AI 和本地 Vite 页面均不代表真实模型、真实教师资料或正式发送。

## 验收矩阵

| P2 条件 | 当前证据 | 结论 |
| --- | --- | --- |
| 逐项确认后才能进入正式记录 | `packages/backend/tests/e2e/agent-records-capture-confirmation-workflow.test.ts`、`packages/backend/tests/e2e/a05-feedback-draft-save-workflow.test.ts` | 通过合成回归；确认/拒绝/暂留和未确认内容不入正式事实均有断言 |
| 反馈只使用当前教师、当前学生的有效可分享依据 | `packages/backend/tests/e2e/a05-feedback-draft-save-workflow.test.ts`、`packages/backend/tests/functional/routes/feedback-generate.routes.snapshot.test.ts` | 通过服务层与路由契约；依据带 `sourceVersion`，版本变化保存返回 `VERSION_CONFLICT` 且零反馈写入 |
| 生成结果是待核对草稿，明确保存后才写入 | `packages/frontend/src/connected/ConnectedWorkspace.test.tsx`、`packages/frontend/src/prototype-v009/App.test.tsx`、`packages/backend/tests/e2e/a05-feedback-draft-save-workflow.test.ts` | 通过；正式入口携带课次、依据、窗口和 `clientRequestId`，生成本身不创建 `ParentFeedback` |
| 保存可重放且不重复归档/写入 | `packages/backend/tests/e2e/a05-feedback-draft-save-workflow.test.ts` | 通过；同一请求编号返回原回执，数据库仅一条反馈 |
| 反馈与发送分离 | `packages/backend/tests/e2e/a05-feedback-draft-save-workflow.test.ts`、`a06-browser-feedback.log` | 通过；保存/核对后 `sentAt=null`，复制只提示教师自行发送 |
| 离页后仍能继续编辑未保存草稿 | `packages/frontend/src/prototype-v009/App.test.tsx`、`a06-browser-feedback.log` | 通过本地原型回归和 375×844 浏览器任务；草稿保存在当前浏览器会话 |

## 正式入口契约补充

`POST /feedback` 的路由回归现在明确覆盖 `lessonId`、`channel`、`parentName`、`clientRequestId`、`evidence` 和时间窗口的完整透传；路由只从认证上下文取得 `teacherId`。正式 `ConnectedWorkspace` 的单测覆盖生成→显式保存，并断言相同字段进入 API 调用。

## 未关闭 Gate

- 真实认证 HTTP 登录后的浏览器任务尚未执行；当前 API 证据来自路由契约、服务层隔离数据库和正式入口单测。
- 真实模型/DeepSeek Harness 效果、真实 Windows/手机、跨设备草稿恢复、真实教师资料、渠道发送和用户体验验收仍待相应环境与授权。
- 本记录不授予发送、发布、部署或读取真实资料的权限。

原始浏览器日志：`/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/a06-browser-feedback.log`。

## Gate 复核

首次在新增路由契约之后运行完整 `npm run check` 时，后端 322 个文件中 321 个通过、2782 个测试中 2781 个通过；唯一失败是 `tests/e2e/teaching-tasks.routes.test.ts` 的一次 `socket hang up`。随后用同一隔离 PostgreSQL 17 harness 单独重跑该文件，5/5 通过，原始日志为 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/teaching-tasks-rerun-11.log`。第二次完整 Gate 已退出 0，最终日志为 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/check-12-a06-final.log`：后端 322/2782、前端 47/296、管理端 13/84 全部通过，运维 149/151 通过且 2 项 Windows 专属跳过。加入认证 HTTP 合成闭环后再次执行的最终 Gate 为 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/check-13-a06-auth-http.log`，后端 323/2783、前端 47/296、管理端 13/84 全部通过，运维仍为 149/151 通过且 2 项 Windows 专属跳过。

## 认证 HTTP 合成闭环

`packages/backend/tests/e2e/a06-feedback-http-workflow.test.ts` 在隔离 PostgreSQL 17 harness 下 1/1 通过（`/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/a06-feedback-http-workflow.log`）。用例通过真实邀请认证 cookie 进入正式 Express 应用，依次调用生成草稿、明确保存、同请求编号重放和依据快照；生成后 `ParentFeedback` 为 0，保存后只产生一条 `draft` 且 `sentAt=null`。测试通过 `CreateAppOptions.coreDependencies` 注入合成 mock AI，未启用外部供应商。
