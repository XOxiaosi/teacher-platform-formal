# UI-004 助手对话窗口审阅证据

- 需求来源：2026-09-20 用户要求以 Codex、豆包、WorkBuddy 一类完整会话窗口承接任务；接受范围见 PRODUCT F13/F14，执行状态统一见 PROJECT_LOG。
- 组件来源：继续使用 UI-003 已通过官方 CLI 获取的 shadcn/ui 组件；来源和许可证见 [UI-003-SHADCN-SOURCE.md](UI-003-SHADCN-SOURCE.md)。本次不重复下载组件，也不引入另一套任务系统。
- 交互设计：完整消息主区；直接输入首发；历史会话按需展开；新对话不预先创建记录；任务过程默认折叠，具体写入确认保留在所属消息中。
- 正式入口：`ConnectedWorkspace` 经 `Workflows` 装配 `AssistantWorkspace` 和 `createTeachingTaskTransport`；教学任务 API 的持久接收回执继续作为发送成功依据。
- 预览入口：`http://127.0.0.1:5188/design-review.html#/agent`；与正式页复用助手组件，仅 transport 换成内存合成数据。预览输入不会调用真实模型或保存教学资料；刷新会重置演示记录。
- 本轮不增加附件、语音、模型选择或“记忆已启用”等缺少实际接入依据的控件。上下文与记忆由既有服务端能力负责，本轮界面变化不代表长期记忆系统已验收。
- 验证原始材料保存于 `/Users/xiaosi/Developer/active/releases/teacher-chat-ui-004-20260920/`；真实模型、真实教师资料、真实手机虚拟键盘及发布不在本轮合成验收内。

## 接入依据

- `packages/frontend/src/connected/assistant/teaching-task-transport.ts` 校验回执 requestId、executionId、userTurnId 和 conversationId；`useAssistantMessages.ts` 在请求前保存原始草稿及请求标识，丢失回执时复用标识重试。
- `packages/backend/src/app/teaching-runtime/task-runtime-runner.ts` 的 `conversationHistory()` 从当前会话取截至当前用户消息的有效 user/assistant 历史，执行时传给 runtime；资料读取使用教师作用域的 `createTeachingQueryTools()`。
- `packages/backend/src/features/teaching-tasks/teaching-task-service.ts` 用教师及 clientRequestId 查找幂等回执，并校验请求 fingerprint。本轮继续依赖该正式接口；合成预览不会验证模型理解效果。
- 当前证据支持“会话历史接续及查询现有教学资料”。长期偏好、语义记忆和超长会话治理仍按 PRODUCT F14 与原执行日志界定，不能通过一个前端标识宣布完成。

## 浏览器实测

使用 Codex 内置浏览器和合成 transport，不连接真实教师数据。桌面 1280×720、窄屏 375×667：

- 空态直接输入并按 Enter，创建会话后显示用户消息及演示回复；继续发第二条消息仍在同一会话，输入区位于消息下方。
- 历史抽屉打开、选择已有会话、自动收起；当前会话中的待确认操作可演示确认，并显示“未写入正式资料”。
- 失败会话展开处理过程后“继续处理”，出现“演示恢复完成”新回复；预览恢复是纯内存流程，单元测试另验证不发 HTTP。
- 归档后保留消息并隐藏发送输入区。
- 375×667 的文档宽度为 375；活跃会话输入区 bottom 为 667，空态发送按钮 bottom 约 553，均在视口内。
- 截图：`empty-desktop.png`、`conversation-desktop.png`、`empty-mobile.png`、`conversation-mobile.png`、`history-mobile.png`、`recovery-mobile.png`，位于上列外部目录。

开发热更新会重置纯内存预览会话，可能让新建会话链接暂时显示无法读取；使用“新对话”或固定的预置历史示例可继续审阅。正式服务的持久化会话不使用此预览存储。

- 最终浏览器补测：历史 Sheet 按 Esc 关闭后焦点为“历史”按钮；新会话发送后重新打开列表显示最新时间。原预览窗口已回到 `#/agent` 空态。
- 独立审查通过，关键问题修复后复跑 5 文件/50 测试；主 Agent 冻结代码后的最终根门禁前端 54 文件/351 测试通过，完整根门禁结果以 PROJECT_LOG 及外部 full-check-final.log 为准。

- 最终干净标签页加载及首发之后 error/warn 为 0，原始记录为 `browser-console-final.json`；开发期间旧标签页曾记录热更新换 Hook/短暂缺失样式的错误，刷新后不再复现，不把历史日志清空冒充无错误。

## 最终工程验证

`npm run check` 最终退出 0，包含治理、文件长度、类型、lint、隔离数据库全量测试和生产构建。后端 2834、前端 351、管理端 84、ops 149 测试通过；2 项 Windows 专属测试按当前 macOS 平台跳过。首次后台单次 `socket hang up`、专项 8/8 通过及完整复测通过的原始日志均保留，详情见 PROJECT_LOG UI-004。
