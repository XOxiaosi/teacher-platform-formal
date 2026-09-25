# 微信未来接口预留契约（不启用）

2026-09-08 V005 补充：用户已明确要求免登录测试版的微信连接流程页面，允许保存合成入口偏好、展示步骤和未接入状态。下文 V003 禁止页面的历史要求不再约束此独立演示；真实登录、绑定、接收、发送、供应商与密钥仍未授权。本轮没有启用或修改任何旧微信路由。

日期：2026-09-07
适用版本：V003
定位：记录未来渠道边界与旧代码锚点，不是新接口已实现或启用授权。2026-09-08 复核：仅 local-safe 保证不挂载；显式关闭安全模式并启用微信仍可装配旧路由/runtime。V003 完整禁用 Gate 尚未通过，T-033 必须收口。

## 预留的接口分层

| 层 | 旧代码锚点（不是 V003 公开 API） | 未来需承担的责任 | 当前状态 |
|---|---|---|---|
| 登录与绑定 | `GET /api/v1/auth/wechat/qrcode`、`POST /api/v1/auth/wechat/callback`、`GET /api/v1/auth/wechat/login/status`、`POST /api/v1/auth/wechat/bind`、`POST /api/v1/auth/wechat/unbind` | 一次性 state、回调验签、绑定/解绑和教师身份隔离 | 路由工厂存在；默认不挂载 |
| 入站消息 | `POST /api/v1/wechat/message` | 验签、IP 白名单、超时背压、持久幂等 claim 后入队 | 路由工厂存在；默认不挂载 |
| 供应商适配 | `CodeExchanger`、`WechatProviderDriver`、`IlinkHttpClient`、`WechatTextAdapter` | 隔离 code 交换、协议解析、长轮询和出站发送 | 只接受注入式 adapter；无凭据时 fail-closed |
| 业务端口 | `LoginStateStore`、`ChannelIdentityService`、`ChannelMessageService`、`QueuePort`、`InboundMessageService`、`WechatConversationResolver`、`WechatAgentLoop`、`WechatOutboundSender` | 把微信身份/消息转换为平台教师、会话和 Agent 请求 | 接口已导出；不代表业务渠道已开放 |

## 固定的幂等与失败语义

- 入站消息以 `(channel, externalMessageId)` 持久唯一；重复 webhook 只返回 duplicate，不重复落库或执行。
- Agent 请求 id 为 `wechat:<botId>:<externalMessageId>`（无 botId 时省略该段）；同一消息不能重复执行工具或写入。
- 出站分片 id 为 `out:<correlationId>:<chunkIndex>`；文本分片上限由配置控制，失败必须落表并可追踪。
- 未绑定消息保持 `new` 挂起，等待恢复扫描；超出挂起期限进入失败，不静默丢弃。
- state 过期、回调验签失败、IP 不在白名单、session 失效、供应商不可用或超时都 fail-closed；不得伪造“已绑定”或“已发送”。

## 当前禁止事项

- V003 不在网页 UI 显示微信入口、绑定占位、灰色按钮或“即将开放”文案。
- `local-safe` 默认即使存在 `WECHAT_ILINK_*` 环境变量也不挂载微信路由、不启动 runtime；有效请求保持 404/未认证语义。
- 现有配置检查不能等同于已通过全部未来 Gate；代码仍接受显式 opt-out，IP 白名单等要求不能仅凭文档声称已被启动阻断。V003 不得靠配置打开旧渠道。
- 不在仓库、日志或普通 DTO 中保存 bot token、app secret 或其他供应商密钥；当前不使用真实账号、真实消息、真实资料或外部费用。

## 未来启用前置 Gate

只有在新产品版本重新确认并完成以下 Gate 后，才允许挂载上述路由：平台/供应商选择与条款、密钥托管、出域字段与留存/删除回执、IP 白名单与重放防护、入站/出站失败和恢复演练、教师确认与撤回路径、月度费用护栏、停用和回滚方案。任一 Gate 未通过，接口继续保持内部预留和默认不可达。

## 代码与验证锚点

- 类型与端口：`packages/backend/src/features/wechat/types.ts`、`packages/backend/src/features/wechat/index.ts`
- 路由工厂：`wechat-login.routes.ts`、`wechat-message.routes.ts`
- 装配开关：`packages/backend/src/index.ts`（`localSafeMode` + `WECHAT_ILINK_ENABLED`）
- 默认关闭与显式启用 smoke：`packages/backend/tests/e2e/local-safe-wechat-assembly.test.ts`、`wechat-mount-smoke.test.ts`

本文件是接口边界证据，不是微信产品上线授权，也不替代未来版本的产品确认。

## 2026-09-08 审计后的内部预留要求

- 保留协议中立的身份解析、入站消息、处理结果端口说明；不得把旧路由、iLink runtime 或主动 notifier 当成“必须保留的接口”。当前只交付文档契约，不新增代码端口或公开路由。
- 未来消息身份须包含渠道、供应商账号命名空间和外部消息 ID，并映射服务器解析的教师空间；旧 `(channel, externalMessageId)` 不能直接视为跨供应商安全的幂等保证。
- 同键同载荷可重放，同键异载荷拒绝；未经身份解析不得进入业务处理；保留取消、解绑和删除影响的回执。
- 出站分片 ID 只是追踪键，不等于供应商恰好发送一次。若未来确认允许关联原请求回复，须验证超时后的不确定结果；仍不得引入主动、定时或家长发送。
- 替身验收应证明：V003 全部启动方式都没有微信公开路由/外发运行时；未来适配器失败不影响网页；此项当前待实现，不能记为通过。
