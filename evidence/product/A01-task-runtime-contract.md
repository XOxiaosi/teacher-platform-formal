# A01｜教学任务身份、持久化与恢复契约

日期：2026-09-15（洛杉矶）。本文是实现契约与验证输入，不是运行完成证明；实际进度、Gate 和提交由 [PROJECT_LOG](../../PROJECT_LOG.md) 维护。

依据：[PRODUCT V009](../../PRODUCT.md)、[调整方案](V009-ADJUSTMENT-PLAN.md) A01、[DSH 设计修正](V009-DSH-DESIGN-CORRECTION.md)。本契约不确认 B01/B02 或 D01–D10 中尚待决定的产品语义。

## 1. 本批边界与已有基础

首个目标是：教师发出的消息有持久接收回执；跨多轮仍指向同一任务；已完成步骤可找回，失败后只继续未完成部分。

- 复用 Conversation、ConversationTurn、AgentExecution、PendingAction、CaptureEvent/Task/Candidate；不新增消息库或通用工作流引擎。
- 新增两张平台表：TaskRuntime 保存同一教学任务；StepReceipt 保存有稳定身份的步骤及结果引用。
- 新运行入口独立为 `/teaching-tasks`。A01 只实现持久消息、任务查询、租约及只读步骤回执；候选、草稿及 `confirmed_write` 在本批一律拒绝，后续逐项接入。旧正式写 registry 不进入新运行链。
- 新旧 Agent 不处理同一会话。旧会话保留历史阅读；迁移方式见第 9 节。停用新版 AI 不关闭人工业务。
- DSH 运行适配与真实模型能力由 A02 验证；模拟执行、模型不可用和真实生成效果必须区别记录。

直接核查的已有事实：

| 现有实现 | 能复用什么 | 尚不能证明什么 |
|---|---|---|
| [AgentExecution.claim](../../packages/backend/src/features/agent-execution/agent-execution-service.ts) | 教师/clientRequestId 唯一；请求指纹；事务保存 execution 和 user turn；并发重复请求读回 | 没有任务、执行租约或步骤检查点；现有指纹只含 conversation/message |
| 同服务 prepareReplay | 找回原消息并检查失败状态 | 重新发送原消息不是部分完成恢复；不能将其用于新版续做 |
| [Conversation 服务契约](../../packages/backend/src/features/conversation/types.ts)及[路由](../../packages/backend/src/app/routes/conversation.routes.ts) | 会话创建、列表、归档、turn 分页、教师归属、加密字段 | 没有任务关联或严格递增事件游标；只按时间分页不等于事件顺序 |
| [确认用例](../../packages/backend/src/app/use-cases/confirm-pending-action/confirm-pending-action-use-case.ts)与[事务端口](../../packages/backend/src/app/confirmation/confirmation-transaction-port.ts) | 签名、教师归属、数据库时间、claim→业务执行→consumed 的事务 | 已消费状态没有完整结果回执；需显式接入 StepReceipt，不能事后补写当作原子提交 |
| [Capture 契约](../../packages/backend/src/features/capture/types.ts) | 原件、处理任务、候选、正式记录和删除回执分开 | 当前单候选返回值与唯一约束需 A04 兼容升级 |

草案初读时 HEAD 为 `7857826`；本轮实施基线为完成 GOV-003 后的 `eca4af5`。模型已按职责拆分，本轮在此基础上新增 A01 结构。工作区仍有此前未提交业务修改，不能把该源码状态等同于纯 HEAD 的完整产品。

## 2. 身份与最小持久化结构

关系：`teacher → conversation → task → executions/messages + steps`。一次任务可包含多条接收消息；一次消息只有一个 AgentExecution；DSH Session 属于任务，不作为教师身份或业务真源。

### TaskRuntime（新增）

| 字段 | 类型/默认 | 约束与用途 |
|---|---|---|
| id | String，服务端生成 | 主键，也是公开 taskId |
| teacherId、conversationId | String | 必填；创建和所有关联写入检查同一教师 |
| originExecutionId | String? | 唯一；第一条消息的执行，创建事务内补齐后不得变更 |
| currentExecutionId | String? | 当前继续的消息执行；必须属于本 task |
| status | String=`queued` | 第 4 节九种状态；服务端校验 |
| title | String?，加密 | 来自明确请求的简短任务名称；不把标题当正式事实 |
| runtimeVersion | String=`dsh-v1` | 契约/运行适配版本，不表示真实模型已可用 |
| dshSessionRef | String?，唯一 | A01 保持 null；A02 服务端分配并在首次执行前持久绑定，不接受客户端路径 |
| dshCheckpoint | Json?，加密 | 仅 A02 验证过的版本化快照；格式未证明可恢复时保持 null |
| contextEpoch | Int=0 | 来源更正/删除使上下文失效时递增 |
| version | Int=0 | 可见任务状态的乐观并发版本；每次状态/当前消息变更递增 |
| leaseToken | String? | 随机执行者令牌，不向客户端返回 |
| leaseEpoch | Int=0 | 每次认领递增，阻止旧执行者继续落库 |
| leaseExpiresAtTs | DateTime? | 数据库可信时间；与 token 同时设置/清除 |
| attemptCount | Int=0 | 执行认领次数，不是模型调用次数 |
| lastError | Json?，加密 | 结构化 code/message/retryability，不保存密钥或原始供应商响应 |
| resumeFromVersion、resumeExecutionId | Int?、String? | 记录最近恢复命令的原版本/执行，防响应丢失重试再次排队已经失败的新 attempt |
| createdAtTs、updatedAtTs | DateTime | Timestamptz(3)，沿用可信业务时间约定 |

索引：`(teacherId,conversationId,updatedAtTs,id)`、`(status,leaseExpiresAtTs)`；任务 ID/FK 不能替代教师归属校验。删除不得级联删除课时或正式记录。

### StepReceipt（新增）

| 字段 | 类型/默认 | 约束与用途 |
|---|---|---|
| id | String，服务端生成 | 主键 |
| teacherId、taskId、executionId | String | 三者归属必须一致；execution 是产生本逻辑步骤的消息 |
| stepKey | String | 任务内稳定逻辑操作键；唯一 `(teacherId,taskId,stepKey)` |
| kind | String | 预留 `query / capture / draft / confirmed_write`；A01 仅开放 query |
| inputFingerprint | String | 对规范化动作、目标、参数、来源版本计算 SHA-256；不存正文 |
| status | String=`prepared` | `prepared / running / waiting_confirmation / succeeded / failed / uncertain / invalidated` |
| attemptCount | Int=0 | 同一步尝试次数 |
| leaseEpoch | Int | 最近授权执行该步骤的 task leaseEpoch |
| pendingActionId | String?，唯一 | 复用现有具体业务确认；空值不代表允许写正式事实 |
| resultRef | Json?，加密 | 正式记录/候选/草稿/业务回执 ID，或只读查询快照；完整结果可回查 |
| sourceRefs | Json=`[]` | 仅 `{type,id,version}` 元数据，不含正文；用于核验与失效定位 |
| error | Json?，加密 | 错误及是否可重试/需对账；不得仅凭 HTTP 超时断言业务失败 |
| createdAtTs、updatedAtTs | DateTime | Timestamptz(3) |

`stepKey` 由平台在执行前分配并持久化。DSH toolCallId 仅作为输入关联，不能因为模型重试换了 toolCallId 就换一个已执行操作的业务幂等键；同样参数的新明确请求也不能被误当历史重复请求。

### 对已有表的增量

- AgentExecution 增加 `taskId String?` 和 `(teacherId,taskId,createdAtTs,id)` 索引。保留原主键、teacher/clientRequestId 唯一、userTurnId 和旧状态；新版 UI 按 TaskRuntime 显示任务状态，不能把旧 `running` 直接翻译成“模型正在运行”。
- Conversation 增加 `runtimeOwner String?`（历史 null，新增会话明确 legacy 或 dsh-v1）；用于原子阻断两种执行器同时接管。版本降级不得偷偷将新版会话交回旧循环。
- 有序增量恢复需要 Conversation 增加 `nextEventSeq Int=0`；ConversationTurn 增加可空 `taskId/executionId/seq/eventKey/eventKind`，并建 `(conversationId,seq)` 与 `(conversationId,eventKey)` 唯一约束。历史 null 行继续可读。
- ConversationTurn 增加 `invalidatedAtTs DateTime?`、`redactedAtTs DateTime?` 以明确来源失效与隐私擦除；失效不等于全部历史都必须隐藏，删除处理则按 F18 过滤并擦除必要内容。
- 原文/content、工具结果/参数、checkpoint 和可识别标题沿用 FieldCipher，缺少 cipher 时零写入。关联 ID 与来源版本元数据可明文，仍受租户权限约束。
- 若本批暂未实现上述有序 turn 增量，可先提供完整任务快照和现有历史分页，但事件顺序/断点增量 Gate 保持未通过，不用时间排序冒充完成。

## 3. 消息接收：先入库，再回复已收到

首次任务创建在一个数据库事务内执行：

1. 验证登录教师、active conversation、runtimeOwner；新版会话只能由 teaching-task 接收。
2. 查询 `(teacherId,clientRequestId)`。相同规范化指纹返回原 task/执行/消息回执；不同指纹返回冲突，不创建第二条消息。
3. 创建 TaskRuntime、AgentExecution、加密 user turn，建立 origin/currentExecutionId；初始化任务 version 和可见事件。
4. 事务提交后返回 202；后台根据 queued 状态认领。提交后响应丢失，客户端重试同一 clientRequestId 得到原回执。

不能在旧 claim 已经独立提交后再创建 TaskRuntime，并把两次提交称为原子接收。应提取其事务内实现供新版服务复用，或在新版事务中保留相同校验与唯一约束；旧 HTTP 循环不得被调用。

新版指纹为版本化规范输入：`{v:1,conversationId,taskId:null|existingId,message,materialRefs}`；初次请求 taskId 保持 null 参与计算，不能重试时改为生成后的 ID。材料引用必须先验证同教师，客户端不提供 teacherId。

继续任务的新消息生成新的 AgentExecution，但保留 taskId。请求的 expectedVersion 与当前任务比较；本批同 task 串行，有效运行租约或 queued 待执行期间返回 `VERSION_CONFLICT`（field=`taskStatus`），客户端保留输入并可重试。其他任务不因此被锁死。后台不能把被拒绝输入显示为“已收到”。

等待补充/确认时可接收新消息；其成为 currentExecutionId。旧待确认动作仍绑定原步骤，不能被新的普通文字自动消费。涉及不同学生或目标的指令，由助手明确定位后推进，不能沿用旧学生上下文猜测归属。

## 4. 状态与失败续做

| TaskRuntime 状态 | 含义与退出 |
|---|---|
| queued | 已持久接收，等待可用执行者；可认领到 running |
| running | 有有效租约的执行者正在推进；退出时保存步骤与可见结果 |
| waiting_input | 缺少对象/信息；保存问题与已有结果，释放租约，等新消息 |
| waiting_confirmation | 有有效的具体待确认动作；保存影响与步骤，释放租约 |
| succeeded | 当前请求已完成，结果可回看；新后续消息可再次变为 queued |
| failed | 当前请求未得到所需结果；是否可继续由步骤及错误决定 |
| partial | 有结果已成功保存，后续尚未完成；不得整体重放 |
| unavailable | 模型/能力关闭、条件不足或达到上限；保持已保存资料与人工入口 |
| cancelled | 执行已终止，不代表撤销已完成的业务；保留回执 |

确认成功后自动接续原任务，但“当前消息回答完毕”和“确认产生的正式写入完成”分别记录。曾成功写入的步骤不会因下游失败被改为 failed；来源失效时可以变为 invalidated，业务事实存在与内容当前有效是两个维度。

恢复算法固定为：读取 task/步骤/业务回执 → 核验所有引用与 contextEpoch → 对账 uncertain → 取回成功步骤结果 → 仅执行未完成步骤 → 补可见结果和回复。恢复 API 继续原 execution，不能经 prepareReplay 创建另一条用户消息。

- query：允许重新查询得到最新事实；结果注明读取版本，不将旧余额快照当实时余额。
- capture/draft：创建前登记 StepReceipt；业务服务必须接受稳定操作键，并能由该键查到已创建实体。结果丢失时先查，再补 resultRef，不能重建一份材料。
- confirmed_write：业务写入、PendingAction consumed、StepReceipt succeeded/resultRef 必须同事务；未接入此事务的动作不能进入新 runtime 工具白名单。
- uncertain：业务是否提交未知。默认禁止重新执行写操作，先按业务幂等键/回执查询；无可靠对账接口时保持不可自动恢复，并显示已知结果。
- 生成完成但回复未送达：读取已保存正文和 resultRef，只重发结果；不得重新调用业务写入。微信发送确认属于渠道回执，不能修改教学步骤成功状态。

新一轮模型规划不得直接执行已完成步骤的同义写操作。平台把可恢复步骤清单交给适配器；每次实际写工具调用仍按稳定步骤键、输入指纹与具体确认检查，不能只靠提示词防重复。

## 5. 租约、顺序与 DSH 边界

### 唯一授权执行者

认领使用数据库可信时间和任务行锁/CAS：允许 queued，或 running 且 lease 已过期；设置随机 token、递增 leaseEpoch/attemptCount/version、续期时间。租期和心跳间隔是可配置运行参数，测试用受控时钟验证，不改变用户产品规则。

心跳、步骤状态写入、checkpoint、任务完成均携带 `{taskId,teacherId,leaseToken,leaseEpoch}`，要求 token/epoch 一致且租约未过期。统一先锁 Conversation、再锁 TaskRuntime，校验 active/dsh-v1，并在锁后用同事务 `clock_timestamp()` 读取可信当前时间；业务提交事务中检查授权，再写业务和回执；只在事务外检查一次不足以阻止旧进程落库。

过期执行者收到拒绝后停止续做，丢弃过期模型结果。外部模型请求可能在取消后仍消耗费用，因此保证的是一个有效业务写执行者，而不是未经验证地承诺供应商绝无重叠调用；费用记录仍归到相同 task/step/attempt。

扫描过期任务后先认领和对账，再恢复。等待教师的任务不靠持续持有租约存活；服务重启不能自动把 waiting_confirmation 当成已确认。归档会话与消息接收/任务认领使用相同归属锁，不能归档后继续写入新的 turn。

### 可见事件

对新 runtime turn，在同一事务更新 Conversation.nextEventSeq 并分配 seq；对 conversation/eventKey 去重。最小事件类别：`message_received / task_state / step_result / confirmation_required / assistant_message / task_error / source_invalidated`。

沿用 turn 的 user/assistant/tool/error 角色；额外 eventKind 指明业务类型，结构化内容放已加密 toolResults。向旧模型 buildContext 或新 DSH 投影时显式挑选允许的正文/结果，不能把状态事件、原始参数、模型推理或删除内容全部拼进上下文。

事件必须与其表示的本地状态/回执同事务提交。事务成功后通知失败可重新投影；客户端按 seq 合并、按 eventKey 去重。seq 是会话全局序号；按 task 过滤后自然会有间隔，不能据此判断丢失；需重建时读取任务快照。DSH 内部事件顺序不作为平台业务提交顺序，DSH 事件重放也不能重放正式写操作。

### DSH Session/checkpoint

每个 task 独立 sessionRef、contextEpoch 和恢复检查点；多个任务可共用 Conversation 展示，但不共用可变 DSH 内存。sessionRef 由服务端生成，绝不拼接客户端提供的目录或路径。

建议快照封装为 `{schemaVersion,runtimeVersion,sessionRef,contextEpoch,lastAppliedEventKey,payload}`。payload 仅使用 A02 证明可序列化和恢复的 SessionPersistence 格式；未核实时不把任意 SDK 对象写入 JSON。若 A02 需要专属存储，保持上述关联不变，并单独明确其教师隔离、加密、擦除与恢复测试，不能默默保存无治理的文件副本。

checkpoint 落后于已提交业务回执时，以业务结果为准给 DSH 补工具结果。checkpoint 比可见事件更新也不能宣布业务成功，仍查平台事务回执。来源变化或版本不兼容时作废旧 checkpoint，从有效平台资料重建上下文，已提交业务结果不重做。

## 6. Backend 与前端接口草案

沿用当前 `/api/v1` 前缀、登录 cookie 和 CSRF。服务内部采用 Result；HTTP 成功包装为 `{ok:true,data:...}`，以下表描述 `data` 内容。所有响应过滤租约、内部 checkpoint、原始工具调用、密钥及其他教师对象。

| 接口 | 输入 | 成功响应 |
|---|---|---|
| POST /teaching-conversations | 空对象；身份由认证提供 | 新建 dsh-v1 会话 `{id,createdAt}` |
| POST /teaching-tasks | conversationId, clientRequestId, message；首次不接受 expectedVersion | 202 `{task,receipt,replayed:false}`；幂等读回 200、replayed=true |
| POST /teaching-tasks/:taskId/messages | clientRequestId, message, expectedVersion（必填） | 同上；task/conversation 均由服务端核验 |
| GET /teaching-tasks | conversationId?, cursor?, limit? | `{items:TaskDTO[],nextCursor}`，按更新时间/ID稳定分页 |
| GET /teaching-tasks/:taskId | 无 | `{task,executions,steps}`；已失效正文过滤 |
| POST /teaching-tasks/:taskId/resume | executionId, expectedVersion | `{task,replayed}`；继续 currentExecutionId，不新增用户 turn |
| GET /conversations/:conversationId/turns | 保留现有 before/limit | 增补可空 taskId/executionId/seq/eventKind；旧字段不删除 |
| GET /teaching-tasks/:taskId/events | afterSeq?, limit? | 后续有序增量 `{items,nextSeq}`；未实现时不暴露假订阅接口 |

```ts
type TaskStatus = 'queued' | 'running' | 'waiting_input' | 'waiting_confirmation'
  | 'succeeded' | 'failed' | 'partial' | 'unavailable' | 'cancelled';
type TaskDTO = {
  id: string; conversationId: string; currentExecutionId: string | null;
  title: string | null; status: TaskStatus; version: number;
  createdAt: string; updatedAt: string;
  lastError: { code: string; message: string; retryable: boolean } | null;
  canResume: boolean;
  runtimeAvailability: 'available' | 'unavailable' | 'test_only';
};
type MessageReceipt = {
  executionId: string; userTurnId: string; clientRequestId: string; receivedAt: string;
};
type SourceRef = { type: string; id: string; version: string };
type StepDTO = {
  id: string; executionId: string; kind: string; status: string;
  result: unknown | null; sourceRefs: SourceRef[];
  confirmation: { pendingActionId: string; actionToken: string; impact: unknown } | null;
  error: { code: string; message: string; retryable: boolean } | null;
};
```

`result/impact` 是逐业务校验的判别联合 DTO，不是任意内部 JSON 的透传；A04/A05 补齐各自结构。源版本优先采用已有业务修订号，没有时由受控字段/更新时间计算版本戳，不能仅用展示文本作版本。

resume 在 version/CAS 成功后只排队一次，执行者随后另行认领。持久保存 `resumeFromVersion/resumeExecutionId`；响应丢失后的同命令重试返回当前快照并标 replayed，即使新 attempt 又失败也不再次排队。若已推进到其他消息或源已变更，返回冲突；不能用同一次重试再次启动刚失败的新 attempt。生产能力仍 unavailable 时保持不可用，不伪造排队或执行。

错误语义：未登录 401；不存在或非本教师对象统一 404；指纹不匹配、版本冲突、任务忙返回 409（本批使用既有 `VERSION_CONFLICT`，配合稳定 field 区分原因）；输入错误 400；实际能力不可用返回已保存任务的 unavailable 状态，不能伪造 assistant 成功正文。前端不得按中文文本判断错误类别。

前端发送前保留本地输入；拿到持久 MessageReceipt 后才能标“已收到”。切账号清除/隔离本地待发送草稿，不自动发给新教师。刷新恢复以服务端 task/turns 为准；查询可直接用现有接口先实现，发送不调用旧 `/agent` 循环。本批 test_only 仅用于隔离验收入口，不在正式教师界面假装真实 AI 可用。

后续确认复用 PendingAction 身份，但入口需核验 task/step/teacher、当前影响版本和有效期，并执行第 4 节原子回执。旧 actionToken 只绑定 pendingActionId；它的签名不能证明参数版本和任务归属，需服务端检查不可变参数包。不得直接复用旧确认路由绕过新 runtime 约束。

## 7. 教师隔离、来源失效与删除

- API 身份仅来自认证；后台 worker 从已验证 TaskRuntime 派生 teacher scope，不采用模型的 teacherId。所有 task/session/step/turn/capture/pendingAction/resultRef 查询均检查教师与父对象归属。
- 新增关联用同事务检查；数据库复合约束能表达时同步添加，不能只靠对象 ID 全局唯一。管理员默认不读取 checkpoint、正文、学生名或媒体；故障日志只记任务/错误/成本元数据。
- sourceRefs 记录每步实际读到的版本；正式来源在生成前、落库前、对外投影前重新核验归属、分享范围、删除与当前版本。内部记录和未确认候选不得作为可分享事实。
- 更正/删除正式记录时，同事务使受影响 task 的 contextEpoch/version 递增、相关步骤/turn 标失效、旧 checkpoint 禁用；主业务投影立即不再显示已删除的派生内容。需要擦除的正文和副本由受控清理执行；失败有回执并可重试。
- 初期可按 teacherId 扫描本教师的 sourceRefs 定位依赖，不能为了扫描方便读取全平台正文。无引用元数据的历史摘要不可信：新 runtime 不导入；无法证明来源的旧上下文不可作为正式事实继续喂给模型。
- 原件到期删除与正式记录删除不同：原件删除后保留有效正式记录及“原件已删除”标记；删除正式记录则阻止派生内容重新作为有效事实。不得因为清理原件而删账本或已确认记录。
- 对话追加日志的不可修改约定不阻止隐私擦除；redacted turn 仅保留必要 ID/时刻/原因，不保留可解密正文。通常更正保留可追溯历史，但从后续模型输入中排除失效内容。
- 恢复备份时先应用删除/失效台账，再对外开放查询或认领任务；不能先上线旧 checkpoint，再异步补删。A01 只定义整合点，真实删除能力不能在该链路未实现时标通过。
- 媒体/缓存/备份期限继续按 F18：24 小时临时缓存，成功原件默认 30 天，失败原件默认 7 天，备份最多 30 天。DSH 会话保留策略不擅自套用媒体期限。

## 8. 不改变的产品决定和本批拒绝入口

本批没有通用 Shell、插件安装、旧供应商回退、直接发家长、自动扣课或批量删除工具。DeepSeek 不可用时保持明确 unavailable；测试适配器不构成产品供应商替代。

B01 的反馈改文核对状态、B02 的时长/扣课数量仍待决定；候选和草稿保存不能自动把这些语义冻结。D03/D10 的具体额度与多端权益保持待定；预留 task/step/attempt 费用归属不等于确认计费规则。

微信首次交付完整私聊、端内确认与长材料查看继续是产品目标；当前接口是其共用任务基础，不声称真实微信已连接。D02 Bot 形式、D04 电脑关闭后独立服务及额外端待决定，不能用本契约反推产品已选部署形态。

媒体沿用 F05 格式和一次一组图片/一段音频，不混合批处理、不擅设大小/张数/时长上限。没有真实识别能力时只读或拒绝对应能力，不将材料上传成功当识别完成。真实资料外发前仍需书面保障、费用/凭据/传输相应授权。

## 9. 兼容迁移与实施顺序

1. GOV-003 已关闭；本轮主 Agent 统一修改 schema/迁移、旧运行链隔离与核心接线，服务及路由在稳定接口后并行实现。本文与代码职责不同，进度仍只在 PROJECT_LOG 维护。
2. 只新增表/可空字段；保留所有旧 ID、明文双读兼容及现有加密数据，不搬家、不清空。空库与含合成旧会话/执行/候选/确认的数据升级都须检查。
3. 新会话指定 runtimeOwner=dsh-v1；新运行链不接收 null/legacy 会话，不自动创建 DSH Session 或升级旧确认。旧入口继续自身既有行为，首次认领旧 null 会话时固定为 legacy，不能接管 dsh-v1。跨执行器迁移不纳入本批默认路径。
4. 创建消息接收、列表、详情与纯本地 unavailable 分支；先证明消息保存而非生成效果。复用 claim 行为，但统一到新版接收事务。
5. 实现租约与只读步骤回执；A02 以模拟模型和合成工具验证启动、中断、恢复。A03 对接稳定 DTO 与真实本地保存接口。
6. A04 处理一材料多候选迁移及接口兼容；已有单 candidate 字段不能静默变为数组。优先新增 candidates 版本接口或明确版本化投影，保留旧 ID 和确认幂等关系。
7. A05 接反馈草稿和证据准入；正式写操作需逐项进入统一事务，未满足条件保持工具不可用。完成该依赖后才能宣称记录到反馈闭环。
8. 回滚代码前关闭新 runtime 的任务认领；保留新表和已有数据，不能让旧服务自动认领新任务。代码回滚不等于数据回滚，仍需读取兼容和恢复验证。

## 10. 分阶段验证的具体结果

A01 必须验证原子接收、幂等、教师与执行器隔离、租约、只读步骤恢复、事件和 unavailable。下表同时保留后续整合验收；涉及正式写、来源失效、DSH checkpoint 或页面的条目由对应下游任务验证，不属于 A01 已实现能力。

| 检查 | 可观察通过条件 |
|---|---|
| 原子接收 | 任意插入点故障后不存在孤立 task/执行/user turn；提交后丢响应重试得到同一三元组 |
| 幂等冲突 | 同教师同 requestId 同输入无重复；换正文/任务冲突；不同教师相同 requestId互不读取 |
| 隔离 | 伪造 conversation/task/execution/step/source/pendingAction ID 均被拒；DB scope 与后台 worker 同样拒绝 |
| 竞争与过期租约 | 两 worker 只一人成功认领；过期旧 epoch 无法提交步骤、checkpoint、业务或最终回复 |
| 部分完成 | 合成步骤一已提交，步骤二失败；重启只执行步骤二；已成功记录 ID 和步骤一调用次数不变 |
| 回执不确定 | 业务成功但通知失败可查回；无法查回的 uncertain 不自动再次写入 |
| 确认竞争（A04/P3） | 旧/过期/变更影响拒绝；两端确认同一动作只有一次业务和一个有效回执；本批未上架时记未验证 |
| 事件重放 | 重放相同 eventKey 无重复；同会话 seq 不冲突；断点恢复无丢失的已提交结果 |
| 上下文失效（A02/A04/F18 整合） | 生成期间更正/删除来源，旧 checkpoint 与旧正文不能再次交付为有效事实 |
| 旧数据兼容 | 迁移后旧会话/候选/账本可回看；没有自动调用旧 Key、旧循环或消费旧确认 |
| 前端恢复（A03） | 接收前后断网分别显示未送达/已收到；刷新和切任务可找回；切账号旧草稿不可见 |
| unavailable | 未配置真实能力仍保存消息/任务并如实显示不可用，人工业务可用，不生成假结果 |

主 Agent 实现后先做本批适用的聚焦检查，再按 AGENTS 运行完整 `npm run check`，记录环境、输出、未验证项和实际 commit。本文的结构/引用检查不代替数据库迁移、运行恢复或真实模型验收。
