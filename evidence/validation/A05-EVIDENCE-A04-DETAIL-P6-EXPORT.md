# A05-EVIDENCE / A04-DETAIL / P6-EXPORT 验证记录

本波起点 main / `1191ceadcbb40181531305380e33fc385c14c3ce`。沿用 V009 F07/F08/F10/F18，真实模型、资料、渠道、费用和发布边界不变。

## A04-DETAIL 专项与实际交互

- 新增按教师、学生和正式记录绑定读取原件的接口；无来源、已删除、不可用分开，deleted 双层遮蔽原文。confirmed 仅在明确改变分享范围且携带所示版本时允许同状态操作，原状态机一般规则不变。
- 同毫秒修改的公开编辑版本按 max(数据库时间,旧版本+1毫秒)严格前进，发生时间不变；独立审阅发现并修复旧版本可复用边界。
- 主 Agent 隔离 PostgreSQL 专项 3 文件/42 项通过：已有服务和路由35项、新详情/分享7项。包括明文解密、教师/学生隔离、已删除状态仍有遗留文本也不暴露、并发一次落库、审计失败回滚、固定同毫秒旧版本拒绝、同时间26条分页稳定。
- 正式工作区接线8项通过；前端 Owner 5文件/30项通过，类型/lint和差异检查通过，主 Agent 另做源码审阅和实际浏览器验证；最终全量入口待追加。
- 主 Agent 构建后端成功，独立 harness 启动正式 backend + Vite。合成 A/B 两教师，A含103条分页记录和2条带原件正式记录；其中一份原件已删除。浏览器登录 A，学生详情显示105条，确实跨100条接口页加载，无省略为旧20条摘要。
- 浏览器打开两条来源，分别显示“来源材料已删除，原文不可查看”和正确可读原文。对另一条明确选择“允许用于家长表达”并保存；刷新页面后及退出/重新登录 A 后，105条及分享状态均保留。B账号只显示自己的1个学生，记录0条，无A姓名/正文。
- 375像素视口 document.scrollWidth=375，截图检查记录全文、分享控件可读；滚动后的首张截图曾捕捉到渲染中间态，后续稳定截图确认完整，非已知页面缺陷。视口已重置，截图在本任务工具记录可追溯。窄屏模拟不代表真实手机或Windows验收。
- 浏览器标签已关闭；合成UI harness由主Agent主动终止，退出143为清理操作，隔离PostgreSQL正常关闭；未使用真实资料或供应商。

## 独立审阅

- A03 Owner 只读复核主 Agent 来源路由、core挂载、分享版本/审计与同毫秒回归。
- 主 Agent 审阅前端修正中文类别/来源类型，业务补充信息与内部追溯编号分开；不把JSON技术字段当教师正文。
- A03 Owner 审阅A05发现初筛到解析间课次/日期改变可能引用错误课次；A02 Owner已增加初始权威投影版本和精确竞争测试，主 Agent已核对永久测试日志：18文件/182项和工具/路由5文件/45项通过；独立审阅已复核修复。
- 主 Agent 审阅P6发现本地源文件/目录符号链接可绕过媒体字符串前缀；Exporter Owner已增加逐级lstat/realpath、O_NOFOLLOW及打开后dev/ino校验，主 Agent审阅代码并核对源文件和目录symlink回归通过；不声称真实Windows junction已验证。

## 原始证据和边界

本波原始输出目录：[V009-next-20260916](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916)。主 Agent日志含 `record-detail-focused.log`（41项）、`record-detail-final.log`（42项）、`connected-records.log`（8项）、`backend-build.log`、`ui-harness.log`。

当前仅专项/交互证据，完整 `npm run check` 尚待本波所有修复收口后运行。A05真实模型效果及P6可读解密导出不以本波存储格式导出测试替代；B01/B02待决定状态不变。

## A05 / P6 最终专项

- A05 服务器权威依据准入、生成前后指纹、保存行锁与原子审计专项18文件/182项通过；工具和路由5文件/45项通过。工具schema正式记录ID必填，类型record/assessment，版本透传；无依据人工草稿及B01现有确认用例仍通过。旧超长测试拆分后保留有效断言。
- P6 明确48模型全部字段分类，导出43张业务表并强制教师过滤；身份歧义和未知字段拒绝。两教师全表实际值、跨库隔离、媒体字节、JSON/ZIP CRC、输出冲突及源symlink覆盖。Ops 40项中38通过、2项Windows PowerShell专属跳过；隐私export API 4项通过（其余5项本次聚焦排除）。
- P6 原始证据：[交接清单](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/P6-EXPORT/review-handoff.md)、同目录final-ops-symlink-fixed.log及final-api-export.log。Manifest v1.1声明stored_encoding；密文仍为密文，不冒充可读导出。
- 完整门禁在所有Owner代码冻结后启动，原始输出V009-next-20260916/check-01.log；运行期间233个已改/新增源码文件SHA256已存，最终需核对未变。

## P6-READABLE 收口

- 新增 `packages/ops/lib/teacher-export-readable.mjs` 与 `scripts/export-teacher-readable.mjs`：显式字段/JSON 映射、当前与旧字段密文双读、媒体原件严格解密及 sha256/size 校验；未知或损坏输入 fail-closed。输出 manifest `version=1.2`、`representation=readable`、`scope=records_and_media`、`complete=true`，可选 ZIP 只收录已校验的可读记录和媒体。
- 隐私 API 新增 `format=readable`，状态/下载沿用 owner 隔离与一次性清理；JSON 下载响应附 `scope=records`、`mediaDelivery=manifest_only`。前端设置页完成按钮、状态轮询和 Blob 下载；A05-SAVE 新增字段已加入导出策略，迁移计数为 39。
- 证据：`p6-readable-ops-03.log` 为 ops 隔离 PostgreSQL 17.10 全回归 151 项，149 通过、2 项 Windows PowerShell 专属跳过，退出 0；readable 单测 4/4，前端隐私 API/设置 18/18，后端构建、文件长度、治理、差异检查通过。`p6-readable-privacy.log` 中既有 privacy 测试因当前未跟踪邀请夹具重复写共享 TeacherRegistry，4 项失败、5 项通过；该夹具失败未修改本包逻辑，未将隐私 API 全流程标为通过。
- 根门禁：本包提交后的 `npm run check`（`/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/check-04.log`）退出 0；治理 19 项、后端 320 文件/2775 项、前端 47 文件/294 项、管理端 13 文件/84 项、运维 151 项中 149 通过且 2 项 Windows 专属跳过，长度、类型、lint、隔离 PostgreSQL 17 和全部构建通过。真实 Windows、真实媒体存储、真实教师资料、模型/渠道与发布未验证。P6-EXPORT 的 stored_encoding 与本包 readable 表示严格区分。
- 追加修复：preview 原型隔离测试发现设置页直接引用 `/api/` 路径，已将隐私 API 适配层移到 preview 外部（`1365665c3e73da3d0f5acd27010eed08d662273a`）；前端隔离/隐私/设置 24/24 与构建通过。

## TASK-INVALIDATION

- 来源版本变化现在会在事务内使 StepReceipt 失效，同时递增 TaskRuntime `contextEpoch`、清除 DSH session/checkpoint 并递增任务版本；旧租约和旧上下文不能继续写入。固定 DSH 宿主要求平台 resume 围栏与历史匹配；缺少围栏的已完成旧回合返回 `DSH_OUTCOME_UNKNOWN`，失败回合可明确恢复。
- 隔离 PostgreSQL 17.10 聚焦验证：教学任务恢复 + runtime runner 20/20，证据 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/a05-task-invalidation-focused.log`。固定上游提交 `c291e7961a515f6d7af9304e7fd1d257929aef26` 的 DSH 适配器 11/11 场景通过，证据 `/Users/xiaosi/Developer/research/teacher-platform-dsh-runtime-20260915/.a02/adapter-2026-09-16T08-09-38.259Z/summary.json`。后端 build、workspace lint、文件长度与差异检查通过。
- 本包仍只使用 synthetic/mock 数据；未执行真实供应商、真实教师资料、Windows 或跨设备验收。P6-READABLE 的 `check-04.log` 是本包之前的根门禁，本包新增改动尚未重跑完整入口。

## A05-FEEDBACK-CONTEXT

- 教学 registry 仅接入 `feedback.list` 只读工具，查询固定绑定认证教师并支持状态/分页；`feedback.create` 与 `feedback.updateStatus` 不进入教学 runtime。反馈列表的更新时间被映射为 `ParentFeedback` 来源引用，继续接受来源版本重查。
- 隔离 PostgreSQL 17.10 联动测试 24/24 通过（`/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/a05-feedback-context-integration.log`），含上下文准入 4 项、任务恢复 3 项、runtime runner 17 项；后端 lint/build、文件大小与 diff 检查通过。
- 该包只证明只读上下文准入，不证明自动保存或真实反馈发送；真实模型、教师资料、Windows、跨设备和渠道仍未验证。

## A05-TASK-SOURCES 专项

- 教学查询工具按工具名映射来源模型，结果中只采集带版本标记的服务端对象；StepReceipt 保存 `sourceRefs`，DTO 原样返回引用。完成步骤前、成功回执同执行重放前均在事务内按教师和 `updatedAtTs` 重查，来源删除/版本变化会写入 `invalidated` 并拒绝复用。
- `a05-task-sources.log`：隔离 PostgreSQL 17.10 下教学任务恢复 3 项 + runtime runner 17 项，共 20/20 通过；新增回归明确验证 Student 版本变化后缓存步骤失效。后端 build、文件长度、治理、diff 检查通过。
- 本包不扩展查询白名单，不接真实模型或外部资料；TASK-INVALIDATION、反馈上下文准入和明确保存命令仍在后续工作包。

## 首轮完整门禁未通过

- `npm run check`（check-01.log）退出1：后端319文件中315通过，2771项中2767通过、4失败；前端/管理端/运维和最终构建因入口短路未执行。治理19项、长度、类型和lint已通过。233个源码文件指纹在该轮结束后核对未变。
- A05三失败：缺ENCRYPTION_KEY时安全错误被一般错误遮蔽；旧加密测试仍将原始lesson直接当反馈事实；旧快照加密测试使用虚构依据。由A05 Owner修复错误分类并按正式依据更新合成fixture，保留密文往返和来源准入断言。
- 第四项为admin/invitations撤销预期200实际404，独立Owner定向复现调查，不据单轮异常推定根因或放宽断言。修复后重新完整检查。

## 首轮失败后的修复与排查

- A05 3项修复经主 Agent代码审閱：固定脱敏SAFETY_BLOCK标识，借用事务仍抛回滚；时间线解密断言保留，反馈仅用有效关联正式记录；快照真实依据密文往返和损坏来源零写入。关联专项23文件/229项通过，ESLint/差异检查通过，永久日志a05-encryption-regression-tests.log。
- 主 Agent独立运行完整前端测试47文件/293项，退出0（frontend-full.log）。
- 邀请404未复现，代码无净改动。独立1文件/3项退出0；默认认证组合4文件/14项退出0。额外shuffle seed1609组合6文件30项断言通过，但admin-actions afterAll清理外键失败，整体退出1；不能称该组合通过，也不能据此认定原404根因。原始记录invitations-repro-01/02/03.log；未修改或纳入此前未跟踪邀请基线。
- 第二次默认完整check启动，236项源码指纹保存check-02-hashes.json；等待实际退出码，尚未标全量通过。

## 最终完整门禁

- 第二次 `npm run check`（check-02.log）实际退出0：后端319文件/2772项、前端47文件/293项、管理端13文件/84项全部通过；运维139项通过、2项Windows专属跳过。治理19项、文件长度、类型、lint及最终构建全部通过。
- 236项源码指纹在结束后核验一致，check-02-hashes.json留证；最终文档另外运行治理/长度/差异检查。
- 首轮邀请404在本轮3项全部通过，但原因未知；额外shuffle afterAll失败未被包装成通过。P6仅存储格式导出完成，后续可读导出和30天保留仍待实现。A05真实模型效果、Windows和真实用户验收未执行。

## 第三波 A05-SAVE

- ParentFeedback 采用可选 `clientRequestId`（租户内唯一）、不可变 SHA-256 请求指纹和 `enc:v1` 创建回执；回执中只保存原始创建响应，重放在时钟、归属和来源重查之前完成，指纹变化返回 VERSION_CONFLICT。FeedbackEvidence 记录 `sourceVersion` 与 `originalDeletedAtSave`，旧行保持 nullable 兼容。
- 实现覆盖服务、HTTP 路由、workspace-web、feedback.create 工具和 Prisma 第39项增量迁移；同事务完成回执、反馈、审计、快照及证据写入，旧无键调用不产生回执。
- 隔离 PostgreSQL 17.10 证据：A05-SAVE 3/3 通过（`a05-save-idempotency.log`），既有 feedback.create 5/5 通过；后端 TypeScript build 退出0。测试使用 harness 合成教师/学生和随机密钥，未使用真实资料、模型或外部服务。
- 当前边界：完整 `npm run check` 尚未因 P6-READABLE 未收口而重跑；P6-EXPORT 当前只证明 stored_encoding，不能当作可读解密 ZIP；TASK-SOURCES/TASK-INVALIDATION 仍未完成。

## A05-DRAFT-SAVE

- `packages/frontend/src/prototype-v009/App.tsx` 的反馈准备/编辑现在只更新浏览器会话 `localDrafts`；“保存草稿”和“确认已核对”共用显式保存路径，写入 canonical `feedbacks` 后移除对应临时草稿。学生和课次切换按 scope 保留未保存内容。
- 证据：原型测试 13/13（`/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/a05-feedback-save-command-prototype.log`）；完整门禁重跑 `check-05-rerun.log` 退出 0，后端 321/2780、前端 47/294、管理端 13/84 通过，运维 151 中 149 通过、2 项 Windows 专属跳过。
- 边界：只验证本地合成原型的显式保存交互，不声称真实 AI 草稿生成、正式 API/渠道发送、真实教师资料、Windows 或跨设备行为已完成。

## A05-E2E-DRAFT

- 新增后端端到端回归串联“当前课次依据 → mock AI 草稿 → 显式保存 → 手工编辑 → 确认 → 快照读取”，并验证同请求编号重放不重复写入。专项 1/1 通过，证据 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/a05-feedback-draft-save-e2e.log`。
- 完整门禁 `check-06.log` 退出 0：后端 322/2781、前端 47/294、管理端 13/84 通过；运维 151 中 149 通过，2 项 Windows 专属跳过。
- 仅验证隔离 PostgreSQL 与合成/mock 路径，不声称真实模型、真实资料、实际渠道发送、Windows、跨设备或用户验收已完成。
