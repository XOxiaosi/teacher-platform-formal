# V009 核心交互对应的后端缺口

2026-09-14。范围：当前源码静态核查，不代表接口实测通过；由独立 Agent 核查，主 Agent 抽查关键路由和服务。产品要求以 PRODUCT.md 为准。

> 后续合并：用户指定的 [前后端 32 项审计](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/frontend-backend-audit-2026-09-14.md) 已纳入 [DSH 重设计 R2](./V009-DSH-DESIGN-CORRECTION.md) 第 5–8 节。本文保留较早的核心后端静态证据；当前整体执行顺序以 PROJECT_LOG.md 和 R2 为准，不能把局部有基础当成完整任务已交付。

## 结论

已有后端可作为保留基础。不能从“路由已经存在”推导“用户完整任务已经完成”；新一轮应围绕原型确认后的任务补缺，不先重写整套后端，也不把旧接口形状固定成前端操作。

| 用户任务 | 当前已有基础 | 需要补齐或验证 | 当前源码证据 |
|---|---|---|---|
| AI 对话后交付教学结果 | Agent 会话、工具执行、待确认及失败/重试结构 | 逐任务实际结果闭环、开发者统一 DeepSeek 服务、跨端任务恢复 | `packages/backend/src/app/routes/agent.routes.ts`；`app/use-cases/agent-converse/agent-converse-use-case.ts`；`app/routes/conversation.routes.ts` |
| 增加、重复、改期、取消 | 单次/规则创建、规则替换/暂停、例外、冲突、乐观锁及幂等 | 2 小时初始值/复用交互可先由界面组合；须核对新旧课程分离、不复制完课或账本 | `packages/backend/src/app/routes/scheduling-web.routes.ts:11`；`features/scheduling-web/scheduling-web-service.ts` |
| 拖动与节假日临时处理 | 修改单次课程可承接拖动；单次例外基础存在 | 新旧值与范围预览，取消恢复，冲突整次拒绝，临时新增不影响每周规则的端到端验收 | 同上 |
| 历史补录并完课 | 单次保存与完课分别存在 | 显式日期/查重、保存与完课的状态及幂等关联、确认前逐学生拟扣与余额预览、录入与发生时间区分 | `features/scheduling-web/scheduling-web-service.ts:310`；`app/use-cases/schedule-complete/schedule-complete-use-case.ts` |
| 逐学生核对出勤 | 完课事务、Lesson、扣课流水，独立出勤更正/冲销基础 | 当前 Web 完课命令未接逐学生出勤，不能满足选择缺席后的核对流程；补齐统一确认内容与实际扣课结果 | `app/routes/scheduling-web.routes.ts:32`；`features/payments/lesson-ledger-service.ts` |
| 材料变为候选并核对 | 原始文本保存、记录/来源、候选确认拒绝、版本冲突 | 图片/音频真实识别及扫描存在占位接入点；逐项来源/表达者/计划与效果字段及任务恢复须按流程验证 | `app/routes/ai-input.routes.ts`；`app/routes/student-records.routes.ts`；`features/media/media-asset-service.ts` |
| 不设旧媒体数量/大小/时长上限 | 现有媒体校验及作业状态 | 当前 image 10 MB、audio 30 MB 限制与新产品要求冲突。需重新设计大材料提交与处理恢复并验证真实服务能力，不得静默恢复旧限制，也不能声称任意大小已支持 | `packages/backend/src/features/media/types.ts`；`features/media/media-asset-service.ts` |
| 课后家长反馈 | 可信上下文、已确认且可对家长表达的筛选、草稿生成、正文编辑和证据快照 | 生成到可接续草稿的闭环、修改后核对状态、多端接续；九部分报告另待栏目确定 | `app/routes/feedback.routes.ts:24`；`app/use-cases/generate-feedback-draft/generate-feedback-draft-use-case.ts:34`；`app/use-cases/assemble-parent-feedback-context/assemble-parent-feedback-context-use-case.ts`；`features/feedback/feedback-service.ts` |

证据表中省略前缀的路径均相对于 `packages/backend/src/`。前端即可组合的交互不自动判定为必须新增后端命令；最终以确认后的任务语义和端到端证据决定。

## 后续按流程推进的顺序

1. 先验收对话任务和确认结果在界面中的表达，重点排课补录、逐学生完课与记录核对。
2. 将已经稳定的确认内容、失败恢复和返回结果对照现有业务服务，补真实缺口；完整保留教师隔离、幂等和账本历史。
3. 正式前端与后端按任务并行对接，先完成一个纵向闭环，再扩大到其他功能。
4. 开发者统一 AI 服务、用量统计、跨端、WeChat 及桌面安装各自设实际验收；费用/Bot/小程序范围未定项不靠猜测落成生产行为。

本轮不调用真实模型或微信，不提交真实教学资料，不迁移/清空数据库，不发布部署。现有 V008 的工程完成比例不代表 V009 全量完成比例。
