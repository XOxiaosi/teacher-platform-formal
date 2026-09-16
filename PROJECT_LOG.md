# 项目日志

工作方式见 [AGENTS.md](AGENTS.md)，产品要求见 [PRODUCT.md](PRODUCT.md)。本文件是唯一动态执行账本；详细方案和验证附件只保存设计或证据。

## 当前投影

此区是恢复项目的第一入口；工作包完成、阻塞变化或整体任务结束时同步更新。下方工作记录按时间追加，历史附件不覆盖此区。文档状态必须由实际文件、Git 和验证结果支持。

| 字段 | 当前事实 |
|---|---|
| 项目 | TPF / 教师 AI 工作平台 |
| 更新时间 | 2026-09-16（洛杉矶） |
| 需求版本 | V009；已作为交互设计基线，D/B 待决定项仍未确认 |
| 当前任务 | A06/P2：独立审阅后的正式反馈入口修复、合成业务任务验收与证据收口 |
| 当前任务状态 | 进行中（A06/P2 本地工程、认证 HTTP 和桌面/窄视口浏览器合成 Gate 已收口；真实模型/设备、跨设备和用户验收 Gate 仍未完成） |
| 已有实现 | V008 正式人工业务；A01 持久消息、只读回执和租约恢复基础通过本地验证。A02 已有租约运行器、检查点校验、查询 StepReceipt、失败重试和显式 worker/心跳围栏；A03 已有正式助手任务/事件全分页恢复入口、恢复刷新和按教师清理草稿；A04 已在 Capture 删除事务中清理复制来源原文并保留 deleted 投影。生产 DSH 仍未接入 |
| V009 进度 | 不报完成百分比；P0–P6 工程尚未按新版验收，方案完成不代表实现完成 |
| 历史进度 | V008 工程基线 43%，只供追溯，不换算成 V009 进度 |
| 交付门禁 | 本轮完整工程门禁通过；真实模型/Windows/跨设备/用户验收和发布仍独立未验证 |
| 验证概况 | `check-14-a06-browser-final.log` 对应认证浏览器（含 375×844 窄视口）证据后的完整 `npm run check` 退出 0：后端323文件/2783项、前端47文件/296项、管理端13文件/84项、运维151项中149通过及2项Windows专属跳过；治理、长度、类型、lint、隔离 PostgreSQL 17 和构建通过。A06 定向前端22/22、反馈路由9/9、认证 HTTP 合成1/1通过，P2 桌面与窄视口浏览器合成流程均已留证 |
| 下一步 | 本地 P2 认证浏览器证据已收口；等待并准备真实 Windows/手机、真实 DSH、跨设备和用户验收，均需对应环境与授权 |
| 长任务目标及结束条件 | 持续推进 V009 当前计划已授权本地工程；每包核验、完整门禁、日志和 commit 后立即安排下游。仅整体完成、用户停止，或剩余任务均需决定/外部条件且无独立可执行工作时结束；真实模型和设备验收单列 |
| 当前可执行任务 | 当前没有新增可安全执行的本地功能包；保留现有工程回归证据，待真实设备/DSH/跨设备环境与授权具备后再关闭对应 Gate |
| 被阻塞任务及解除条件 | A02 真实供应商验证：需明确调用授权和预算；真实教师资料/渠道/设备验收：需对应授权与可用环境；A05 状态迁移依赖 B01、P3 计费写入依赖 B02 决定。仅阻塞受影响部分，其他工作仍须核对依赖及授权；详见当前边界和待决定表 |

### 当前授权和运行边界

- 本轮授权：用户要求自主继续推进，并明确要求拆分多个子 Agent 并行、由主 Agent 检查；本轮执行 V009 当前依赖计划，先 A02-ADAPTER/A03-REC3/A04-MULTI，使用本地合成运行时、隔离 PostgreSQL 和正式入口完成可回滚工程改动，测试通过后分别创建 commit 并继续下游。真实 DSH、正式写操作、跨设备、UI 效果和渠道仍分别验收，不能混报完成。保留已有无关源码修改。
- 已有授权：正式认证和后端连接可在本地隔离合成环境验证；独立 preview 保持合成/内存隔离。仅保存模型配置不等于允许真实调用。
- 未获本轮授权：真实供应商调用、真实教师资料、旧密钥读取或迁移、付费、微信真实收发、远端 push、上传、部署、发布及真实数据删除。
- 视觉参考：用户曾明确指定 `/Volumes/老毛桃U盘/claude-style-redesign`，V006 接受整体风格；不能据此认定 V009 AI 交互已验收。其他退役 UI、截图与旧来源不作设计输入。
- 已有入口：正式 `/#/today`；独立合成 `/preview.html#/today`；V009-P1 `/prototype-v009.html#/desk`。历史原型地址为 `http://127.0.0.1:5199`，本轮未启动或验证服务存活。

### 当前阻塞与风险

- GOV-001 改动前的五项长度债务已由 GOV-001/GOV-003 关闭；GOV-003 和 A01 完整 check 均通过，未放宽门禁。历史失败记录保留，下方业务和真实环境风险仍独立存在。
- A01 任务身份、持久消息和只读步骤恢复，以及本轮 A02 运行时桥接和 A03 任务事件分页已通过合成验证；V009 仍待真实 DSH 接入、统一确认写事务、来源失效传播与跨设备用户验收，不能由本地运行时推定真实 AI 已可用。
- 多候选唯一约束与逐项核对已由 A04-MULTI 修复；旧对话完课绕过统一账本、完整来源详情与反馈准入仍待下游关闭，详见调整方案。
- 历史隐私审计发现注销清理、共享库留证和恢复缺口；真实资料开放前须独立关闭。仅用隔离合成数据验证，不能运行真实注销来替代测试。
- DeepSeek 媒体能力、完整微信、跨设备、Windows 11、150 人容量、费用和资料保障均有未验证条件，见 PRODUCT。旧价格和法律调研不作为当前事实。

## 当前执行计划

实施依据：[V009 调整方案](evidence/product/V009-ADJUSTMENT-PLAN.md)、[DSH 设计修正](evidence/product/V009-DSH-DESIGN-CORRECTION.md)。方案负责实施设计，本表维护状态；不因列入计划自动授权真实服务。旧 T 编号继续用于历史证据，A/P 编号沿用既有方案。

阶段编号：P0、P1、P2、P3、P4、P5、P6。分别表示契约验证、助手恢复、记录到反馈、排课课时、全量教学、媒体渠道和试用准备；阶段定义不代表已开始或已通过。

| 任务 | 对应需求 | 范围与验收 | 依赖 | 状态 |
|---|---|---|---|---|
| GOV-001 | 治理（需求 V009 不变） | 文档职责清晰、历史保留、测试和 Git 留痕；全部必须验证通过才可完成 | 用户本轮要求 | 已完成 |
| GOV-002 | 治理（需求 V009 不变） | 明确交互约定、新项目 Git 归属、初始提交及已有仓库保护；相关规则检查通过 | 用户追加要求；沿用 GOV-001 规则 | 已完成 |
| GOV-003 | F05、F18；治理（需求 V009 不变） | 拆分媒体服务/测试/schema，保持业务和数据库结构，校准声明；长度及完整 check 通过 | GOV-001/GOV-002 阻塞收口 | 已完成 |
| GOV-004 | 治理（需求 V009 不变） | 长任务持续调度、阶段检查点和结束条件明确；日志续接字段及治理回归、完整检查通过 | 用户本次要求 | 已完成 |
| A01 | F01、F06、F13、F14、F18 | 稳定任务/消息/确认/回执契约；持久消息、只读步骤与租约恢复基础，正式写事务/来源失效由下游接入 | P0 起步 | 已完成 |
| A02 | F13、F17、F18 | 固定版本教学 DSH 最小执行/恢复；模拟与真实能力分开验收 | A01 | 进行中 |
| A03 | F01、F02、F13、F14 | 正式助手入口、持久消息及任务找回，刷新/重登/重启与隔离验证 | A01；集成依赖 A02 | 进行中 |
| A04 | F05、F06、F07、F08 | 一材料多候选、逐项核对与来源；合成旧数据兼容迁移 | A01；页面依赖 A03 | 进行中 |
| A05 | F10、F13 | 记录到反馈闭环、有效可分享依据、失败续做不重复归档 | A02–A04；状态迁移依赖 B01 | 进行中 |
| A06 | F01、F06、F10、F13 | 每包独立审阅，P2 集成后真实用户任务检查；主 Agent 核验证据 | 对应工作包及 P2 | 进行中 |
| P3 | F04、F11 | 对话和日历同一排课/账本事务、并发确认、补录与独立更正 | P2；数量规则依赖 B02 | 未开始 |
| P4 | F03、F08、F09、F10、F12、F14、F19 | 全量档案、沟通、回顾、偏好及报告；逐项有保存和回看证据 | P2 后独立部分可并行；D05、D09 | 未开始 |
| P5 | F05、F15、F16 | 媒体、多端、完整微信私聊、安装与恢复分别验收 | P0 提前查证；真实接入受授权约束 | 未开始 |
| P6 | F17、F18、F19、F20 | 费用、隐私、运行保障、真实试用及发布准备 | P0 起准备；P4/P5 与外部 Gate | 进行中 |

首个业务验收示例：“整理小雨今天的上课记录，核对课时，再写给家长的反馈。”课时核对只查询，生成反馈不代表发送。P2 通过不代表 V009 全量完成。

### 待决定项的执行影响

产品问题及建议只在 [PRODUCT 待决定表](PRODUCT.md#待你决定与修改的内容) 维护；这里仅记录阻塞位置。用户决定后先更新 PRODUCT，再同步受影响任务；不自动采用建议答案。

| 决定编号 | 最迟影响的工作 |
|---|---|
| B01 | P2/A05 反馈正文修改后的核对状态迁移；草稿生成保存可先做 |
| B02 | P3 正式计费数量写入；不阻塞只读对账和逐人出勤准备 |
| D01、D08 | 新增端或后台视觉实施前 |
| D02 | P5 具体 Bot 绑定与真实渠道实现前 |
| D03、D10 | 首次真实付费调用前明确测试预算；真实试用前确定权益规则 |
| D04 | 部署拓扑和跨端可用性承诺前 |
| D05 | P4 阶段报告模板验收前 |
| D09 | P4 自动学习偏好行为实施前 |

D06 为范围约束；D07 已明确完整微信私聊，不重复列为待用户决定。

## 执行记录约定

任务状态：未开始、进行中、等待确认、被阻塞、已完成、已取消。验证状态：未验证、通过、失败、不适用。工程、真实效果、设备渠道、用户验收分别记录；必需项未验证或失败时不可标已完成。

每条新记录使用以下字段，简单任务可合并叙述，但不能省略证据与结果：

- 任务编号 / 日期 / 对应需求版本与 F、D、B 编号（治理任务注明需求不变）。
- 用户要求与授权来源 / 本次范围 / 改动文件 / 决定与影响。
- 新增或更新的测试 / 实际命令 / 环境 / 结果及退出码 / 失败、跳过与未验证项 / 证据位置。
- Git 关联：沿用 AGENTS 的任务编号和提交标题，记录已知基线 SHA；最终 SHA 在交付消息与 Git 查询获得。不可预填未产生的 SHA。
- 完成边界 / 阻塞 / 下一步。失败重试追加新结果，不覆盖旧失败证据。

V009 是产品语义版本，不为每个实现 commit 升版；同一任务允许多个修复 commit。历史没有逐次提交时只能保存现状，不能声称补齐过去的回滚点。

## 历史索引

以下是本轮整理前的只读历史快照，不再维护当前状态。历史叙述保留原文，包含当时已失效的范围、授权和进度；不能用于恢复旧设计。

- [截至 2026-09-14 的投影、旧任务表与需求变更记录](evidence/project-history/baseline-through-20260914.md)
- [截至 2026-09-14 的每日工作记录](evidence/project-history/journal-through-20260914.md)
- [整理前的 Agent 规则](evidence/project-history/agent-rules-through-20260914.md)
- [历史完整性清单](evidence/project-history/manifest.json)：按记录顺序拼回原日志并校验 SHA-256；历史内容不重写，纠错在当前日志追加说明。

## 工作记录

### GOV-001｜2026-09-15｜三份文档职责与 Git、验证追踪

- 用户要求：先优化 Agent、产品与项目日志三者关系；沿用每次修改更新相关测试、交付前全部测试验证通过、创建对应 commit 的要求。PRODUCT 仍为 V009，本轮不改 F01–F20 已确认业务含义。
- 变更：AGENTS 改为工作规则，移出旧版功能与进度；PRODUCT 增加使用约定，将方案中的 B01/B02 集中为待决定；日志改为当前投影、当前任务、决定依赖与追加记录。旧日志和旧规则保留为只读快照并校验原文完整性。
- 测试更新：新增三文档治理检查及负例回归，覆盖需求/决策引用、任务依赖、完成与验证状态、附件链接和历史完整性；接入 npm 测试与完整检查入口。
- 改动前验证：`npm run check:file-size` 输出五项超长，门禁失败；Node v22.16.0、npm 10.9.2。本轮最终结果见下方补记，不沿用历史通过结果。
- Git 基线：`4acb7a6`。该基线之后已有大量未提交业务修改；本次仅提交治理范围、相关文档现状及引用方案，其他修改保留。提交标题关联任务 GOV-001，实际 SHA 以 Git 查询和最终交付消息为准，不预写同次提交 SHA。
- 启动时边界：文档治理实现与验证进行中，未接模型/微信、真实资料或部署；以下追加最终验证结果。

- 最终验证：治理测试 14/14、类型检查、lint、根 `npm run test` 和构建均退出 0；后端 285 文件/2622 项、前端 36 文件/210 项、管理员 13 文件/84 项通过；运维 124 通过、2 项因仅支持 Windows 而跳过，未作真实 Windows 验收。根测试启动时治理为 11 项，独立审阅后补至 14 项并定向复跑通过；业务代码未因本轮审阅改动。
- 完整门禁：`npm run check` 退出 1，日志长度问题已消除，仍有四项既有业务文件超长；不变更门禁阈值或例外，不把该结果标为全绿。独立审阅通过，主 Agent 已核对实际运行输出。
- 证据：[GOV-001 验证记录](evidence/validation/GOV-001-document-governance.md)，包含命令、环境、结果、剩余失败与原始日志位置；历史逐段及拼接指纹验证通过。
- 提交与完成边界：采用 `checkpoint(GOV-001): clarify document ownership and validation tracking` 保存治理改动。GOV-001 仍为被阻塞，完整交付门禁仍为失败；该检查点不是已验证产品回滚点，原有无关业务修改保留未提交。后续需修复既有长度债务并复验后才能关闭交付门禁；V009 业务和真实能力验收不因本次文档优化推进。

### GOV-002｜2026-09-15｜交互方式与新项目 Git 管理

- 用户要求：在平台 Agent 规则中规定交互方式，创建项目必须 Git 管理。只更新本项目 AGENTS、治理检查、相关测试及本日志；PRODUCT V009 和已确认业务规则不变。
- 改动：集中规定中文产品沟通、行动请求直接推进、关键问题澄清、进展反馈、中途补充与停止、交付说明；新项目先核对仓库归属，独立项目初始化 Git，已有仓库保留历史，设置忽略规则及验证入口后完成初始提交。
- 测试更新：新增交互和 Git 建仓规则正文被删除或弱化的负例；原假完成用例改为读取当前任务编号与状态，避免后续任务切换时失效。
- Git 基线：`7c004ca`。只提交本轮四个相关文件，保留已有无关修改；实际提交关联 GOV-002，不预填同次 SHA。完整门禁失败时只创建 checkpoint，不标记合格交付。
- 验证与边界：`npm run test:governance` 16/16 通过、退出 0；`npm run check` 先通过治理检查，再因既有 media-asset-service、两份媒体测试及 Prisma schema 超过 500 行而退出 1。后续类型、lint、全量业务测试和构建被入口短路，本轮未另行复跑，不把上一轮结果当本轮通过。
- 证据：[治理测试日志](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/governance-2026-09-15/GOV-002/governance.log)、[根检查日志](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/governance-2026-09-15/GOV-002/check.log)。检查点标题为 `checkpoint(GOV-002): require interaction rules and Git for new projects`；任务保持被阻塞，不宣称全部验证通过。本轮未创建项目、调用真实服务或进行外部写入。

### GOV-003｜2026-09-15｜恢复工作与长度门禁收口

- 用户要求：恢复工作，接续 GOV-001/GOV-002 的四项长度门禁债务；沿用每次改动补测试、完整验证及本地 commit 规则。需求仍为 V009，关联 F05/F18，不推进 V009 业务验收状态。
- 改动：媒体服务分为职责模块；OCR/ASR 测试分为服务与适配器两组；46 个 Prisma 模型分为六个文件，迁移和静态验证入口统一读取完整目录。没有修改 500 行阈值、旧例外或只读历史。
- 验证中发现并修复：新拆分测试的初始化导入遗漏；迁移数量写死；两处生命周期时间类型和三条长索引名未与既有 SQL 对齐。后者仅补 Prisma native type/map 声明，没有新增迁移、转换数据或改写历史 SQL。纯拆分等价证据与最终五处声明差异分别留存，不混称逐字完全一致。
- 测试更新：保留原有 35 项 OCR/ASR 断言，更新七份模型边界测试，新增目录读取、动态迁移数量、时间类型及实际索引名称回归；独立审阅与主 Agent 实际执行相互核对。
- 迁移实证：隔离 PostgreSQL 17.10 下，36 项迁移、47 张表及 CRUD 通过；校准后的库副本检查无待执行 SQL，15 张源表计数及 10 类关系校验通过，退出 0，临时集群已清理。此前的缺环境、漏导入及声明不一致失败均保留，见 [GOV-003 验证记录](evidence/validation/GOV-003-modularization.md)。完整门禁最终结果待下方追加。
- Git 基线：`7857826`。按清单保存本轮变更及直接依赖的旧基线：46-model 声明、20260913–20260921 九项既有迁移、媒体 confidence 字段、模型审计矩阵和测试/验收脚本。关联内容在本轮开始前已存在，不能视为本轮新增业务；其他无关修改保留未提交。完整验证针对当前工作区，不等同于已提交全部产品或验证独立检出的产品回滚点。
- 运行边界：只使用本地合成测试，未接真实模型、微信、凭据、教学资料或外部发布；Windows 等真实设备验收另列，不能由本轮工程验证替代。
- 最终验证：`npm run check` 第三轮完整运行退出 0，文档治理、长度、类型、lint、全量测试和构建均通过；治理 16 项、后端 291 文件/2633 项、前端 37 文件/221 项、管理员 13 文件/84 项、运维 124 项通过。运维 2 项 Windows ZIP/PowerShell 专属测试因 macOS 跳过，未作真实 Windows 验收。证据为源码树外 `GOV-003/check-03.log`；最终文档再跑治理、治理测试、长度和差异检查。
- 完成与提交：GOV-003 关闭 GOV-001/GOV-002 的本地工程门禁阻塞，历史 checkpoint 记录不改写。提交标题关联 `refactor(GOV-003)`，实际 SHA 通过 Git 查询及交付消息获得；V009 实现和用户验收仍从 P0/A01 接续。


### A01｜2026-09-15｜教学任务持久接收与恢复基础

- 用户要求与边界：用户说“你自己往下推进”，按 V009 既定 A01 依赖继续；关联 F01/F06/F13/F14/F18。本批完成后端持久消息、任务和只读步骤恢复基础，真实 DSH、UI、正式写事务、来源清理和渠道由后续任务验收；没有改变 PRODUCT 业务语义。
- 实现：新增 TaskRuntime/StepReceipt 和第 37 项增量迁移；消息/执行/事件同事务保存；精确原文与请求幂等、分页及事件恢复、新旧运行入口隔离、会话归档保护、数据库锁后时钟、租约 token/epoch、部分结果保存和恢复命令幂等。生产装配默认 unavailable，HTTP 不开放内部执行开关；只读 query 之外的步骤及非空材料/来源引用均拒绝。
- 协作与修复：独立审阅发现并修复锁前时钟、归档旧 worker 写、并发回执冲突、步骤错误抛出及分页遗漏；主 Agent 接管最终整合，拆分 context/receive/reader/lease/steps，新增代码文件均低于 500 行，未放宽门禁。
- 测试更新：9 个 A01 文件共 30 项专项测试；覆盖迁移旧值、真实 core 挂载、原文加密、初始与续消息并发、事务回滚、教师隔离、旧执行器拒绝接管、锁后过期、成功步骤保持、仅失败步骤重试、恢复旧命令、失效/uncertain 护栏和兼容 turn DTO。模型时间审计矩阵增加 7 项；迁移校验和运维计数更新。
- 实际验证：隔离 PostgreSQL 17 下，空库 37 项迁移/49 表/CRUD 与复制库零结构差异通过；合成旧字段保持。综合聚焦第二轮 9 文件/30 项通过，退出 0。首轮 pg_sleep void 解码和两项不正确测试预期已修复，失败输出保留；完整 `npm run check` 正在执行，最终结果下方追加。
- 证据：[A01 验证记录](evidence/validation/A01-task-runtime.md)，原始日志目录 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/A01`。数据库全部使用项目隔离 harness，临时集群结束清理；没有使用真实资料、模型凭据或外部服务。
- Git：基线 `eca4af5`；提交关联 `feat(A01)`。只保存 A01 新文件、直接相关旧表/DTO/隔离改动和 core 接线 hunk，运维计数包含此前完整迁移基线；其余已有业务修改保留。完整验证针对当前工作区，不把它等同于独立检出的完整产品回滚点。

- 完整检查首轮：后端 299 文件/2662 项通过，1 项旧 ToolTurnDto 严格比较因新增四个 null 关联字段失败，`npm run check` 退出 1。更新现有 `conversation-api-workflow.test.ts` 的完整 DTO 预期后启动第二轮完整入口；没有删除原断言，首轮输出保留在 `A01/check.log`。

- 完整检查第二轮：后端 300 文件/2663 项全部通过；前端 36 文件/220 项通过，1 项既有 V006 完整操作因 5 秒超时失败，入口退出 1。该文件隔离复跑 9/9 通过、测试段 1.25 秒。收敛 jsdom 并行进程到 2 个并新增配置回归，保留 5 秒时限和零自动重试；仅纳入该配置 hunk，旧预览与代理改动仍留工作区。第三轮完整验证前先复跑全前端；第二轮输出保留在 `A01/check-02.log`。

- 最终验证：第三轮完整 `npm run check` 退出 0；治理、500 行门禁、类型、lint、隔离全量测试与全部构建通过。后端 300 文件/2663 项、前端 37 文件/222 项、管理端 13 文件/84 项、运维 124 项通过，治理 16 项通过。运维 2 项 Windows ZIP/PowerShell 专属测试在 macOS 跳过，未作真实 Windows 验收；完整输出见 `A01/check-03.log`。
- 完成与提交：A01 后端基础完成，最终文档再跑治理、治理测试、长度和差异检查。提交标题 `feat(A01): persist teaching tasks and fenced recovery`，实际 SHA 由 Git 与交付消息提供；下一依赖为 A02/A03。真实 DSH/模型效果、正式写与来源清理、界面和渠道均未以本轮通过替代验收。

### A02/A03｜2026-09-15｜并行助手运行时与正式入口波次

- 用户要求与授权：用户要求将后续工作拆成多个子 Agent 并行执行，由主 Agent 检查后继续推进；沿用 V009 已确认范围和 A01 依赖，不改变 PRODUCT 业务语义。
- 分工：A02 子 Agent 负责 `packages/backend/src/app/teaching-runtime/**`、`scripts/dsh-runtime/**` 及专项测试；A03 子 Agent 负责 `packages/frontend/src/connected/assistant/**` 及专项测试；独立审阅 Agent 只读检查契约。主 Agent 负责 A01 DTO 适配、正式入口挂载、文档、全量验证和提交。
- 实现：A02 增加显式 `TeachingRuntimeDriver` 端口、生产 `unavailable` 和本地 synthetic driver；synthetic 每次 query 同时校验固定教学查询名、definitions、只读属性和无需确认，输出 checkpoint/session token 与零模型成本元数据。A03 增加任务状态/失败恢复 UI、教学任务 API transport，并将正式 `/#/agent` 接入登录工作区；消息回执后才清除草稿，恢复使用服务端 execution/version。
- 契约修复：独立审阅发现 synthetic driver 原先可能直接执行伪造的 shell 定义，已在 driver 与回归测试中修复；恢复测试明确只证明 token/checkpoint 传递，不声称 TaskRuntime 数据库重建恢复。runtime availability 显式映射 `ready→available`、`test→test_only`、`unavailable→unavailable`。
- 定向验证：A02 synthetic runtime 与教学查询测试 10 项通过（子 Agent 报告，主 Agent 已审读源码和测试）；A03 `AssistantWorkspace` 与 transport 共 14 项通过；`ConnectedWorkspace` 挂载测试 7 项通过；frontend lint 通过。证据见 [A02/A03 波次验证记录](evidence/validation/A02-A03-assistant-wave.md)。
- 最终验证：主 Agent 执行根 `npm run check` 退出 0；治理 16 项、后端 301 文件/2669 项、前端 38 文件/225 项、管理端 13 文件/84 项、运维 124 项通过，运维 2 项 Windows 专属测试在 macOS 跳过。类型、lint、全量隔离 PostgreSQL 17 测试和构建均通过；证据见 [A02/A03 波次验证记录](evidence/validation/A02-A03-assistant-wave.md)。
- 完成边界：本波本地工程适配和正式入口挂载通过，A02 真实 DeepSeek/DSH、TaskRuntime 持久 checkpoint 重建、真实教师资料、跨设备、微信和用户验收仍未完成；A02/A03 保持“进行中”，不能据此宣称 V009 或真实 AI 已交付。

### A02-INT/A03-REC｜2026-09-15｜恢复运行时与全量分页波次

- 用户要求与授权：用户要求继续安排任务，明确由多个子 Agent 并行执行、主 Agent 独立检查；沿用 V009 既定 A02/A03 范围，不新增产品目标或外部数据源。A02-INT 由后端 Agent 负责，A03-REC 由前端 Agent 负责，独立审阅 Agent 只读复核，主 Agent 负责整合、验证和提交。
- A02-INT 实现：新增 `task-runtime-runner`，在生产不可用时不 claim、不调用 driver；可用运行时先以 teacher/task/lease token/epoch/expiry 领取，再只读取当前任务的用户/助手历史。检查点使用 `schemaVersion=1`、`runtimeVersion=dsh-v1`、`contextEpoch`、`lastEventKey` 严格校验；driver 错误携带 `retryable`，不可重试错误会关闭恢复入口。查询工具经 `prepareStep → execute → completeStep/failStep` 包装，StepReceipt 按 execution 复用，新的用户消息生成新 execution 并重新查询；租约失效、异常、无效输出检查点均 fail-closed，不能伪造成功。
- A03-REC 实现：教学任务 API 支持 cursor/limit，助手 transport 拉取全部任务页和事件页；重复 cursor 与重复 eventKey 有停止/去重护栏。会话刷新按事件 seq 重建任务进展，保留每个任务的最大 seq，任务 21 及其事件可恢复展示。
- 审阅与修复：独立审阅发现并推动修复两类关键问题：恢复测试不能用错误的 `resume(waiting_input)` 路径，已改为服务端接收新消息继续；同一任务跨 execution 的查询 receipt 不能误复用，已将 stepKey 绑定 executionId。审阅复核后 P0/P1 清零；重复 cursor 可能带来一次重复 task item 的低优先级边界不阻塞本轮。
- 测试更新：新增运行器生命周期/检查点/租约/错误可恢复性/查询 receipt/历史隔离测试，以及任务查询工具组合测试；新增助手任务和事件分页、重复 cursor、重复 eventKey、21 个任务恢复测试。改动文件均通过 500 行长度门禁。
- 实际验证：专项 frontend `AssistantWorkspace.test.tsx` 与 `teaching-task-transport.test.ts` 共 20 项通过，frontend lint 退出 0；运行器专项在完整入口中 14 项通过。最终根 `npm run check` 退出 0：后端 302 文件/2683 项、前端 38 文件/231 项、管理端 13 文件/84 项、运维 124 项通过，运维 2 项 Windows ZIP/PowerShell 专属测试跳过；治理 16 项、长度、类型、lint、隔离 PostgreSQL 测试和全部构建均通过。数据库使用项目隔离 harness，临时集群已清理。
- 证据：[本波验证记录](evidence/validation/A02-INT-A03-REC-wave.md)。完整检查中出现的初始专项失败已保留在外部运行日志，修复后以最终退出 0 的结果作为交付门禁依据，不覆盖失败事实。
- Git：沿用基线 `462d02c`；后端运行时与测试提交为 `62e2e88 feat(A02): run fenced teaching tasks through runtime`，前端恢复分页与测试提交为 `e95db72 feat(A03): paginate teaching task recovery`。文档和证据另行提交；其他工作区既有修改未纳入本波提交。
- 完成边界与下一步：本地运行时桥接、租约围栏、检查点和助手恢复分页已验证；真实 DeepSeek/DSH adapter、真实教师资料、跨设备/Windows、微信、真实用户验收及正式写事务仍未完成，A02/A03 保持“进行中”。下一步先在明确凭据和测试预算后接入真实 DSH，再做跨设备用户验收；未授权前不调用真实供应商或发布。

### A02-WORKER/A03-REC2/A04-SRC｜2026-09-15｜任务 worker、助手恢复与来源失效

- 用户要求与授权：用户要求恢复项目并由多个子 Agent 并行推进、主 Agent 检查整合；沿用 V009 既定 A02/A03/A04 范围，不改变 PRODUCT 业务语义。A02 worker、A03 助手恢复由对应子 Agent 负责，A04 契约由独立审阅，主 Agent 负责来源失效修复、文档、验证和提交。
- A02-WORKER：新增显式、进程内 `TeachingTaskRuntimeWorker`，支持 `wake`/`runOnce` 去重；运行器增加租约心跳、丢租约中止和无完成写入护栏。生产运行时不可用时保持 pending，不 claim、不调用外部 driver；没有偷偷增加后台循环或真实网络调用。
- A03-REC2：恢复任务后立即增量刷新事件，并按 `eventKey` 去重；成功登出清理当前教师的助手草稿，保留其他账号草稿。草稿仍是浏览器本地未发送状态，跨设备未作真实浏览器验收。
- A04-SRC：Capture 删除事务同时清理按 `CaptureEvent` 复制的 `StudentSourceRecord.rawText` 并标记 `captureStatus=deleted`；来源读取保留来源 ID、哈希和 deleted 状态而不返回原文，已确认的 StudentRecord 不删除。未改 CaptureCandidate 单候选唯一约束，也未声称多候选迁移完成。
- 测试更新：新增 worker 不可用/唤醒去重测试、运行器心跳和丢租约测试、助手恢复事件可见及登出草稿隔离测试、Capture 删除后的来源失效回归；相关专项 lint、后端构建均通过。
- 实际验证：首次全量隔离回归记录 1 个既有 `db-routing-workflow` beforeAll 10 秒超时（其 6 项测试均 skip），后续同一入口重跑退出 0。最终重跑后端 303 文件/2688 项、前端 39 文件/233 项、管理端 13 文件/84 项、运维 124 项通过，运维 2 项 Windows 专属测试跳过；Capture 来源失效用例 10/10 通过。完整门禁仍需在本日志提交后再次执行 `npm run check`。
- 文档同步后的最终门禁：`npm run check` 退出 0；治理 16 项、长度门禁、类型检查、lint、隔离 PostgreSQL 17 全量测试和全部构建均通过。后端 303 文件/2688 项、前端 39 文件/233 项、管理端 13 文件/84 项、运维 124 项通过；运维 2 项 Windows 专属测试跳过。首轮 `auth-boundary` 生产模式断言曾因环境变量竞态出现 401/404 单项失败，随后 `npm run test` 与本次完整门禁均重跑通过，失败事实保留。
- Git：A02 worker 为 `3f8837a feat(A02): add fenced teaching task worker`；A03 恢复/登出清理为 `9e60ed5 fix(A03-REC2): refresh task events and clear assistant drafts on logout`，配套认证测试为 `014d195 test(A03-REC2): cover auth recovery behavior`；A04 来源失效为 `385f1b5 fix(A04): invalidate deleted capture sources`。每个提交只纳入对应文件，其他已有工作区修改保留。
- 完成边界与下一步：本地 worker/心跳、助手恢复刷新/登出清理和来源原文失效已通过；真实 DeepSeek/DSH、跨设备/Windows、真实教师资料、渠道及用户验收仍未完成。下一步先完成真实 DSH adapter 的受控契约和授权，再安排跨设备验收；A04 多候选 schema/兼容迁移和来源准入继续单独设计。

### GOV-004｜2026-09-15｜长任务连续调度规则

- 用户要求：根据分享对话中完成工作包后反复等待“继续”的问题，修改已讨论的规则和日志结构。本次仅治理改动，PRODUCT V009、业务状态及真实服务授权保持原有含义。
- 改动：AGENTS 明确工作包检查点、主 Agent 接收复核和续派、局部阻塞处理、最终回复前检查和整体结束条件；日志增加三个续接字段，保留现有任务表和历史，不新建执行账本。
- 回归：检查器约束连续执行规则和当前投影的非空续接字段；新增规则移除、缺失/空字段及历史字段不能代替当前状态的负例。该检查验证文档约束，不声称静态测试能证明 Agent 在未来会持续执行。
- Git 基线：`41f5b03`；本次仅提交 AGENTS、PROJECT_LOG 和两份治理脚本，关联 `GOV-004`，保留工作区其他既有修改。
- 验证：聚焦 `npm run test:governance` 19/19、`npm run check:governance` 和 `git diff --check` 通过。首轮完整 `npm run check` 退出 1：后端 302/303 文件、2687/2688 项通过，媒体上传未认证测试预期 401 实际 404；后续前端/管理端/运维测试及最终构建未执行。失败记录：[check.log](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/GOV-004/check.log)。
- 失败复查：通过 `runTestsWithPostgres` 的 `childCommandFactory` 启动 `packages/backend/scripts/run-tests-isolated.mjs tests/functional/media/media-asset-service.test.ts`，新的隔离 PostgreSQL 下 21/21 通过、退出 0；未修改业务代码或断言，暂未复现，原因尚未确定。证据：[media-focused.log](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/GOV-004/media-focused.log)。第二轮完整检查结果见下；本次不启动 V009 业务任务、真实服务或外部写入。

- 最终验证：第二轮 `npm run check` 退出 0；治理 19 项、后端 303 文件/2688 项、前端 39 文件/233 项、管理端 13 文件/84 项通过，类型、lint、文件长度和最终构建通过。运维 124 项通过、2 项 Windows 专属用例在 macOS 跳过，未作真实 Windows 验收。媒体测试在本轮全量中 21/21 通过，但不据此宣称首轮失败根因已修复。证据：[check-02.log](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/GOV-004/check-02.log)。
- 完成边界：GOV-004 规则与治理验证完成，最终文档的治理测试 19/19、治理检查、长度和差异检查均通过；提交关联 `docs(GOV-004): continue long tasks after work package checkpoints`，实际 SHA 由 Git 和最终交付提供。未来 Agent 的实际持续执行行为仍需在后续长任务中观察，不将静态检查等同于运行保障。

### A02-ADAPTER / A03-REC3 / A04-MULTI｜2026-09-15｜V009 连续执行恢复

- 用户要求：按 V009 当前计划连续推进，多 Agent 并行，由主 Agent 核验、更新日志、完整测试并按工作包提交后立即续派。范围为本地合成资料工程，需求 V009 不变，关联 F01/F05–F08/F13/F14/F17/F18；真实服务、预算、资料、渠道与发布边界继续有效。
- 恢复核对：分支 main，HEAD `1f9e8db`，暂存区为空；此前大量未提交业务修改保留。启动差异保存于源码树外 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-resume-20260916/initial-tracked.patch`、`initial-status.txt`；不能视为本次新增功能。
- 分工：A02 Agent 负责 runtime/probe；A03 Agent 负责 assistant 恢复，完成后独立审阅并接手材料草稿修复；A04 Agent 负责 capture/schema/迁移；主 Agent 负责材料入口/API、共享连接、运维迁移计数、实际交互、日志与最终检查。A04 草稿独立审阅发现切换/版本刷新可能丢输入，已安排修复；每包同阶段单写入负责人。
- 当前验证：主 Agent 材料收件箱与正式工作区基础测试 2 文件/12 项通过；治理检查通过。完整检查未执行，工作包保持进行中；真实 DSH 效果、真实设备、微信及发布未验证。

- 本波补充：主 Agent 重跑固定 DSH 11 场景与完整迁移验证均退出 0；真实浏览器验证三候选独立处理、刷新保留输入、A/B 登录隔离、重登状态恢复、归档后直接回学生档案和 375/390/430 宽度。完整门禁首轮发现启动前失租竞态，确定性复现后补运行前围栏，最终检查仍待完成；不标全量通过。详情见 [本波验证记录](evidence/validation/A02-ADAPTER-A03-REC3-A04-MULTI.md)。

- 首轮完整检查：`npm run check` 退出 1；后端 305/306 文件、2723/2724 项通过，唯一失败为旧运行中失租用例 5 秒超时；前端/管理端/运维与最终构建因入口短路未执行。修复在该轮已加载测试后落地，Vitest 末尾源码行显示当前文件，不代表新回归当时已执行。主 Agent 已审查新增运行前围栏与确定性测试，专项 runner 17 项/worker 2 项通过；第二轮以全部代码冻结后的完整入口核验。

- 本波最终门禁：第二轮 `npm run check` 退出 0；后端 306 文件/2725 项、前端 43 文件/268 项、管理端 13 文件/84 项、运维 124 项通过，2 项 Windows 专属测试在 macOS 跳过。治理 19 项、文件长度、类型、lint、隔离数据库与全部构建通过；原始日志 `V009-resume-20260916/check-02.log`。本波 39 个交付文件指纹在完整检查后复核一致。
- A02-ADAPTER 收口：运行前失租围栏和确定时序回归通过；固定 DSH 实际循环配合成模型 11 场景通过，真实供应商效果未验证。A03-REC3 助手回执恢复 35 项与 A04-MULTI 材料恢复 21 项均纳入全量；已保存后的刷新失败不会提示重复保存，首次明确拒绝与网络未决状态分别处理。
- Git 保存范围：A02 9 文件、A03 6 文件、A04 24 文件，另含本日志及证据；A04 包含原有未提交的 capture index/types/routes/API 直接依赖基线，不视为本轮全新业务。保留其余既有修改。完整验证针对当前工作区，不等于干净检出已包含全部旧业务的产品回滚点；迁移恢复须遵循数据兼容验证。
- 提交与续接：A02-ADAPTER 本地适配包采用 `feat(A02-ADAPTER)`，本波通过不结束长任务；随后依次提交 A03-REC3/A04-MULTI，并直接启动反馈依据准入、记录详情和隐私导出范围工程。

- A03-REC3 收口提交：助手发送前保存原文与请求身份，刷新/重进沿用未决请求，严格匹配回执后清稿；35 项专项包含于本波完整通过，未决消息期间编辑/归档护栏保留。提交关联 `fix(A03-REC3)`；共用上述本轮完整验证，下一包 A04-MULTI 立即提交。

- A04-MULTI 收口提交：逐项候选版本/确认/拒绝/暂留及完整收件箱、兼容迁移和原件删除回执通过本波完整检查与实际浏览器验收；提交关联 `feat(A04-MULTI)`。A04 仍有完整记录详情/分享范围等下游，不将子包完成写成 V009 完成。后续 A05-EVIDENCE、A04-DETAIL、P6-EXPORT 已完成只读接口与文件归属核对，提交后立即开工。

### A05-EVIDENCE / A04-DETAIL / P6-EXPORT｜2026-09-15｜记录依据与资料边界

- 前波提交已核验：A02-ADAPTER `f04c32a1be87aecd5c01c722a133df7a1a9e2b79`、A03-REC3 `4d473f34a72d3d88259816ce9fde139d8e8013b0`、A04-MULTI `1191ceadcbb40181531305380e33fc385c14c3ce`。不是长任务结束点。
- A05 Owner 单写反馈 feature、assemble/generate 用例与相关测试：统一服务器 confirmed/parent_shareable 当前有效依据，显式课次关联、生成前后指纹校验、保存事务重查，原件删而有效正式记录保留，人工无依据草稿保留；不改变 B01。
- A04 Owner 单写记录前端/API/preview slot；主 Agent 单写记录来源路由、分享范围变更、core/Connected 接线与测试。已确认记录只在明确变更分享范围且提供当前版本时允许同状态操作；原件已删除/无来源/读取失败分开。
- P6 Owner 单写导出脚本、分类和媒体护栏、合成 fixture 与回归：全部模型和列显式分类、tenant 强制过滤、凭据/租约令牌排除、媒体教师路径和非空输出目录校验。发现现有 SELECT* 含 ProviderConfig.apiKeyEnc，现包修复；可读解密导出另包，不调用真实导出。
- 文件归属已明确，三 Agent 并行，日志/整合/完整检查/commit 由主 Agent 负责；修改超长旧文件必须拆分保持断言，不放宽门禁。本波未执行真实服务、资料传输或费用操作。

- A04-DETAIL 阶段核验：主 Agent后端42项与正式接线8项通过；Owner前端30项通过。真实浏览器合成A含105条完整记录，两份来源可读/已删区分，分享保存刷新重登保持，B账号记录0条；375px无横向溢出。独立审阅补同毫秒编辑版本递增；发生时间不变。合成浏览器服务已清理。
- A05/P6 独立审阅分别发现筛选到解析间课次变更窗口、媒体输入symlink可绕过tenant路径前缀，已分派原Owner修复；未完成最终核验前不标整包完成。详见 [本波验证记录](evidence/validation/A05-EVIDENCE-A04-DETAIL-P6-EXPORT.md)。

- 第二波首轮完整check退出1：后端315/319文件、2767/2771项通过；3项反馈加密/旧事实fixture回归和1项邀请撤销404已分派修复调查，断言不放宽。后续包待修复并重新全量验证提交后启动。源码233项指纹本轮未变；证据见本波check-01.log。

- 首轮回归修复：A05密钥错误/加密依据三项修复经主审与23文件229项通过；前端完整47文件293项通过。邀请独立和默认组合未复现404，根因未知，无源码净修改；额外shuffle组合另有既有清理外键失败，保留独立失败证据。第二次默认完整check已以冻结代码启动，不提前标通过。

- 下一波准备（未实现）：A05-SAVE采用教师范围请求键、不可变加密创建回执及来源版本快照，兼容旧无键调用/B01；P6-READABLE严格解析字段/媒体并提供完整ZIP，主Agent接正式隐私下载页面；P6-RETENTION以实际UTC年龄最多30天，合成清单/内存存储验证，不运行真实清理。三Owner在完整验证期间只读准备。
- A05-TASK前置缺口：当前StepReceipt复用未校验来源，sourceRefs仅允许空数组且reader返回空；contextEpoch无来源变化递增，DSH宿主从JSONL恢复而不采用传入history，已完成执行可直接重放。必须依次完成TASK-SOURCES、TASK-INVALIDATION（旧租约和DSH会话围栏）、反馈工具准入，再接明确的草稿保存命令；不能只加context白名单就称闭环通过。真实模型事实效果仍单列Gate。

- 第二波最终完整check-02退出0：后端319文件/2772项、前端47文件/293项、管理端13文件/84项、运维139项通过，2项Windows专属跳过；治理19项、长度、类型、lint及全部构建通过。236项源码SHA256冻结核验一致。邀请3项在本轮通过，原404原因仍未知，不声称已修复；非默认shuffle清理失败单独留证。
- A04-DETAIL提交范围为18个完整文件及core.routes/api.types两处精确增量；Students.tsx包含本轮接线直接依赖的此前未跟踪页面基线。A05-EVIDENCE为35文件，P6-EXPORT为9文件；其他既有未提交修改保留。验证针对当前工作区，不把局部提交冒充全部旧业务均已入库的干净回滚点。
- A04-DETAIL工作包通过工程及合成实际交互，提交关联feat(A04-DETAIL)；A05/P6同波门禁通过后依次独立提交，完成子包不结束V009长任务。

- A05-EVIDENCE收口提交：服务器权威依据、生成前后版本校验、事务内重查和加密/审计回滚通过同波最终完整门禁；工具要求真实正式记录ID和透传版本。A04-DETAIL已提交a2e5fcaa129bf8c2d055696a9db20a9b38477850，本包35个源码/测试文件，提交关联feat(A05-EVIDENCE)；下一项立即提交P6-EXPORT。

- P6-EXPORT收口提交：48模型全部字段分类、43业务表强制教师隔离、凭据排除、媒体源路径及输出/ZIP保护通过同波完整门禁；stored_encoding边界明确。A05-EVIDENCE已提交30722ebca9b96a5573a702370064b94b4b1bd740；本包9文件，提交关联feat(P6-EXPORT)。下一波A05-SAVE/P6-READABLE/P6-RETENTION依赖已满足，立即开工；不启用真实调用、资料或清理。

- 第三波 P6-RETENTION：新增纯 `planRetention`，按可信 UTC 年龄达到 30 天过期，支持 dump/manifest/media 关联组；未知格式、未来时间、无效日期和组内异常 fail-closed。`applyRetention(maxAgeDays)` 的 dry-run 只列 keys，不调用 get/put/delete；db-backup 已切换 30 天年龄入口。合成 retention-policy + 兼容 retention 测试 13/13 通过。P6-READABLE 和 A05-SAVE 尚未完成，完整 check 需待三包收口后重跑。

- 第三波 A05-SAVE：ParentFeedback 增加可选租户请求编号、请求指纹和加密创建回执；FeedbackEvidence 保存服务器来源版本及保存时原件删除状态。创建事务先以教师/请求编号 advisory lock 查找回执，再执行时钟、学生/课次归属和依据锁定；同指纹只解密不可变回执重放并标记 `replayed=true`，指纹冲突零写入，旧无请求编号调用保持兼容。HTTP、workspace-web 和 feedback.create 工具均透传请求编号，快照读取返回保存时来源元数据。
- A05-SAVE 验证：后端构建通过；隔离 PostgreSQL 17.10 下 A05-SAVE 3 项（同键重放/加密回执、指纹冲突、旧调用兼容）通过，既有 feedback.create 5 项通过。证据日志待写入 `V009-next-20260916/a05-save-idempotency.log`；完整 `npm run check` 需在 P6-READABLE 收口后重跑。
- A05-SAVE 提交：仅提交保存回执服务、类型/路由/工具透传、Prisma schema/迁移、聚焦测试和本日志；实现提交为 `27f2261235faedbe24fb12633b81e03da08d2e17`，本行在后续日志校准提交中补记。P6-READABLE 仍未实现，TASK-SOURCES/TASK-INVALIDATION 仍是后续依赖；不调用真实模型、资料或外部服务。

### P6-READABLE｜2026-09-16｜可读教师资料导出

- 实现：新增严格 fail-closed 的字段/JSON/媒体解密转换器与 `export-teacher-readable` CLI。字段映射显式维护，支持当前 `enc:v1`、旧 `v1` 双读；坏密文、未知版本、媒体哈希/大小不一致、缺失原件均阻断，旧明文仅在兼容条件下保留。导出 manifest 标记 `representation=readable`、`scope=records_and_media`、`complete=true`，ZIP 包含解密业务表和媒体原件；认证资料、凭据、租约/claim token 继续排除。
- 接线：隐私 API 接受 `format=readable`，后台启动可读 CLI 并以 ZIP 下载；JSON 下载响应明确 `scope=records`、`mediaDelivery=manifest_only`。设置页新增导出按钮、状态轮询、Blob 下载与错误提示。P6-EXPORT 策略补齐 A05 新字段，迁移计数更新至 39。
- 验证：ops 隔离 PostgreSQL 17.10 全回归 151 项中 149 通过、2 项 Windows PowerShell 专属跳过，退出 0（`/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/p6-readable-ops-03.log`）；readable 单测 4/4，前端隐私 API/设置测试 18/18，后端构建、文件长度、治理和 diff 检查通过。隐私 API 聚焦回归另有 4 项既有邀请测试因测试夹具在共享 TeacherRegistry 重复写入而失败、5 项通过；该失败与本包路线无关，保留在 `p6-readable-privacy.log`，不据此宣称 API 全流程已验证。
- 根门禁：本包提交后的 `npm run check`（`/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/check-04.log`）退出 0；治理 19 项、后端 320 文件/2775 项、前端 47 文件/294 项、管理端 13 文件/84 项、运维 151 项中 149 通过且 2 项 Windows 专属跳过，长度、类型、lint、隔离 PostgreSQL 17 和全部构建通过。真实 Windows、真实媒体存储、真实教师资料、模型/渠道和发布均未验证。TASK-SOURCES/TASK-INVALIDATION 仍是下一依赖。

### A05-TASK-SOURCES｜2026-09-16｜教学查询来源版本闭环

- 实现：教学查询结果按工具显式映射为 `Student/Schedule/Lesson/Payment/ParentFeedback/Memo` 来源引用，保存 `id + version` 到 StepReceipt；完成写入前重查当前教师归属与 `updatedAtTs`，同一执行回放成功回执时再次重查，发现来源删除、越权或版本变化即标记 `invalidated` 并返回版本冲突。无版本标记的聚合结果不伪造来源版本。
- 兼容：旧空 `sourceRefs` 回执继续可读；StepDTO 返回真实来源引用；未知/损坏引用 fail-closed。未改变查询工具白名单和外部模型/写操作边界。
- 验证：隔离 PostgreSQL 17.10 下教学任务恢复与 runtime runner 20/20 通过（`/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/a05-task-sources.log`），新增用例覆盖来源版本变化后回执失效；后端 build、文件长度、治理与 diff 检查通过。
- 提交：实现包 `ef12452550e6851be985d5bf7f8ea2073c1c101e`；日志校准另行提交。TASK-INVALIDATION（contextEpoch/旧租约与 DSH 会话）、反馈上下文准入和明确草稿保存命令仍未完成；真实 DSH、真实资料和 Windows 未验证。
- 提交：实现包 `63d1f49c113c2e86b99c7d7898a64fbbccf1a2c4`，preview 依赖围栏修复 `1365665c3e73da3d0f5acd27010eed08d662273a`；本条日志校准另行提交。保留其他未提交工作区修改，不调用真实服务或外部写入。

### TASK-INVALIDATION｜2026-09-16｜来源变化与 DSH 会话结果围栏

- 实现：来源引用失效时，在同一事务内将 StepReceipt 标记为 `invalidated`，递增 TaskRuntime `contextEpoch`，清除 DSH session/checkpoint 并递增版本；旧租约无法继续写入。固定 DSH 宿主只在平台提供 resume 围栏时校验持久会话历史，已完成旧回合在缺少 resume 围栏时返回 `DSH_OUTCOME_UNKNOWN`；失败回合仍允许明确恢复，平台历史不匹配也 fail-closed。
- 兼容：DSH session ID 继续由教师、任务和 `contextEpoch` 派生；旧空 `sourceRefs` 回执保持可读，未知或损坏引用拒绝复用。适配器探针同步覆盖完成回放、带 checkpoint 恢复、拒绝工具恢复和结果待核对路径。
- 验证：隔离 PostgreSQL 17.10 下教学任务恢复与 runtime runner 20/20 通过；固定上游 DSH `c291e7961a515f6d7af9304e7fd1d257929aef26` 的 11 场景全部通过（`/Users/xiaosi/Developer/research/teacher-platform-dsh-runtime-20260915/.a02/adapter-2026-09-16T08-09-38.259Z/summary.json`）；后端 build、workspace lint、文件长度和 `git diff --check` 通过。完整根门禁沿用 P6-READABLE 的 `check-04.log`，本包新增改动尚未重新执行完整 `npm run check`。
- 边界：仅合成数据与 mock adapter；未调用真实 DSH/模型、教师资料、渠道或外部服务。真实 Windows、真实供应商结果与跨设备恢复仍未验证。下一项为反馈上下文准入，随后再处理明确草稿保存命令。

### A05-FEEDBACK-CONTEXT｜2026-09-16｜教学反馈只读上下文准入

- 实现：教学 registry 新增 `feedback.list` 只读工具，固定使用认证教师范围，支持状态和分页过滤；`feedback.create`、`feedback.updateStatus` 等写工具不注册到教学运行时，仍由平台确认或明确保存命令承载。反馈列表返回的 `updatedAt` 进入 `ParentFeedback` 来源引用并沿用来源版本重查围栏。
- 验证：隔离 PostgreSQL 17.10 下反馈上下文、教学任务恢复与 runtime runner 共 24/24 通过（`/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/a05-feedback-context-integration.log`）；后端 lint/build、文件长度和 `git diff --check` 通过。测试明确覆盖租户过滤、状态/分页透传、来源版本提取及写工具拒绝。
- 边界：只读上下文接入不等于反馈草稿自动保存；未调用真实模型、教师资料、渠道或外部服务，真实 Windows/跨设备未验证。下一项为明确草稿保存命令，需继续保持证据版本与显式教师动作。

### A05-DRAFT-SAVE｜2026-09-16｜明确草稿保存命令

- 实现：原型反馈准备与编辑只写浏览器会话内的 `localDrafts`，按学生和课次隔离；只有“保存草稿”或“确认已核对”才写入 canonical `feedbacks`，保存后清除临时草稿。切换学生或课次时保留未保存输入，避免无意自动保存。
- 验证：原型专项 13/13 通过（`/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/a05-feedback-save-command-prototype.log`）；前端 lint/typecheck 通过；重跑完整 `npm run check` 退出 0（`/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/check-05-rerun.log`），治理通过、长度门禁通过，后端 321 文件/2780 项、前端 47 文件/294 项、管理端 13 文件/84 项通过，运维 151 项中 149 项通过、2 项 Windows 专属跳过，类型、lint、隔离 PostgreSQL 17 和全部构建通过。此前一次全量仅有微信状态上限用例 `ECONNRESET`，专项重跑 22/22 后未复现。
- 边界：仅本地合成 prototype；未接真实模型生成、真实教师资料、真实渠道、Windows/跨设备，也不代表正式反馈发送或发布授权。下一项继续处理 A05 端到端草稿/API 证据整合与剩余 Gate，不因本包完成结束 V009。

### A05-E2E-DRAFT｜2026-09-16｜反馈生成到保存闭环

- 实现/验证：新增端到端合成回归 `packages/backend/tests/e2e/a05-feedback-draft-save-workflow.test.ts`，串联当前课次的已确认可分享依据、mock AI 草稿、显式 `createFeedback` 保存回执、手工正文编辑、`reviewed` 确认和依据快照读取；同一 `clientRequestId` 重放只返回不可变回执，不重复写入。
- 证据：隔离 PostgreSQL 17.10 下专项 1/1 通过（`/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/a05-feedback-draft-save-e2e.log`）；随后完整 `npm run check`（`/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/check-06.log`）退出 0，后端 322 文件/2781 项、前端 47 文件/294 项、管理端 13 文件/84 项通过，运维 151 项中 149 项通过、2 项 Windows 专属跳过，类型、lint、长度、治理、隔离数据库与构建均通过。
- 边界：AI 使用 mock、资料为合成数据；不代表真实模型效果、真实教师资料、渠道发送、Windows/跨设备或用户验收。A06 独立审阅与 P2 实际用户任务仍待执行。

### A06-REVIEW / P2-ACCEPTANCE｜2026-09-16｜正式入口修复与合成任务验收

- 独立审阅：A03 Owner 只读检查了 `ConnectedWorkspace`、反馈 API、A05 E2E 与日志证据。未发现 P0；指出正式入口未透传生成结果的课次/依据版本/时间窗口/请求编号，原型离开反馈页会丢暂存，且 E2E 缺少生成不落库、依据变化和发送分离断言。
- 修复：`ConnectedWorkspace` 现在通过正式 `generateFeedbackDraft` API 生成待核对结果，显式保存走 `/feedback` 并携带 `lessonId`、`evidence`、`windowStart/windowEnd` 和稳定 `clientRequestId`；编辑既有反馈仍走版本保护的内容更新。预览原型把 `localDrafts` 提升至 App 会话级，导航离页后仍可回到同一学生/课次草稿，明确保存后才清理。
- 回归：新增正式入口单测覆盖生成、证据/窗口/请求编号透传；原型新增导航离页保留测试；A05 E2E 新增生成不落库、依据版本变化拒绝保存且零写、核对后 `sentAt=null` 断言。定向前端 22/22 通过；完整 `npm run check`（`/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/check-10-a06-final.log`）退出 0：后端322文件/2782项、前端47文件/296项、管理端13文件/84项通过，运维151项中149通过、2项 Windows 专属跳过，治理/长度/类型/lint/隔离 PostgreSQL 17/构建通过。
- 浏览器证据：本地 Vite 合成页面按“逐项确认三条可分享记录 → 准备反馈 → 手工修改 → 切换学生返回 → 明确保存 → 复制”执行；AX 状态显示依据范围和保存/复制回执，375×844 截图显示编辑区与底部导航，DOM `scrollWidth=375`。原始记录见 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/a06-browser-feedback.log`。
- 边界：A06/P2 目前仅完成合成工程和本地浏览器任务证据；真实模型效果、正式认证 HTTP 的真实浏览器登录、Windows/真实手机、跨设备草稿恢复、真实教师资料、渠道发送与用户验收仍未验证。生成结果与发送严格分离，未调用外部服务。

### A06-P2-HTTP-CONTRACT｜2026-09-16｜正式反馈路由契约收口

- 补充正式 `POST /feedback` 路由回归：成功路径同时断言 `lessonId`、`channel`、`parentName`、`clientRequestId`、`evidence` 及 `windowStart/windowEnd` 完整透传，认证教师身份仍来自请求上下文。专项 `feedback-generate.routes.snapshot.test.ts` 9/9 通过。
- 验收矩阵集中记录于 [A06/P2 正式入口与合成任务证据](evidence/validation/A06-P2-HTTP-ACCEPTANCE.md)，与现有 A05 服务层、A06 ConnectedWorkspace、原型离页回归及浏览器日志相互引用；没有新增真实服务调用或产品范围。
- 当前投影仍为进行中：正式认证 HTTP 的真实登录浏览器、真实模型/DSH、真实 Windows/手机、跨设备草稿恢复、真实教师资料、渠道发送及用户验收 Gate 尚未关闭。下一步继续做可在本地完成的 HTTP/设备验收准备，并在代码冻结后重跑完整 `npm run check`。

### A06-P2-GATE-RECHECK｜2026-09-16｜全量瞬时失败复核

- 新增路由契约后的首次完整 Gate 在后端 322 文件/2782 测试中通过 321/2781，唯一失败为 `tests/e2e/teaching-tasks.routes.test.ts` 一次 `socket hang up`；原始日志保留在 `V009-next-20260916/check-11-a06-http-contract.log`，不将该轮标为通过。
- 同一隔离 PostgreSQL 17 harness 单独重跑该文件 5/5 通过，证据为 `V009-next-20260916/teaching-tasks-rerun-11.log`，暂未发现可复现源码缺陷。完整 Gate 仍需在本次复核后重新执行并以最终退出码为准。

### A06-P2-FINAL-GATE｜2026-09-16｜正式入口契约后的最终本地门禁

- 第二次完整 `npm run check` 退出 0，证据为 `V009-next-20260916/check-12-a06-final.log`：后端 322 文件/2782 测试、前端 47 文件/296 测试、管理端 13 文件/84 测试全部通过；运维 151 项中 149 通过、2 项 Windows 专属跳过；治理、文件长度、类型、lint、隔离 PostgreSQL 17 与全部构建均通过。
- 新增 `POST /feedback` 路由契约回归在全量中 9/9 通过；首次全量的 `teaching-tasks.routes.test.ts` 瞬时 `socket hang up` 未复现，不能据此标记为源码缺陷。
- A06/P2 仍只关闭本地合成工程证据；真实认证浏览器、真实模型/DSH、Windows/手机、跨设备草稿、真实资料、渠道发送和用户验收仍是未关闭 Gate。

### A06-P2-AUTH-HTTP｜2026-09-16｜认证正式 HTTP 合成闭环

- 新增 `packages/backend/tests/e2e/a06-feedback-http-workflow.test.ts`：通过真实邀请认证 cookie 进入正式 Express 应用，执行生成草稿、明确保存、同 `clientRequestId` 重放和依据快照读取；生成后无 `ParentFeedback`，保存后只保留一条 `draft`，且 `sentAt=null`。
- 隔离 PostgreSQL 17 harness 专项 1/1 通过，证据为 `V009-next-20260916/a06-feedback-http-workflow.log`；`CreateAppOptions.coreDependencies` 只用于注入合成 mock AI，默认生产组合不变。backend lint/build、文件长度和差异检查通过。
- 该包仍不替代真实模型、真实 Windows/手机、跨设备和用户验收；下一步只在相应环境与授权具备时执行这些 Gate，继续保留现有本地工程证据。

### A06-P2-AUTH-HTTP-FINAL-GATE｜2026-09-16｜认证闭环后的最终本地门禁

- 代码与测试冻结后重新执行完整 `npm run check`，退出 0；证据为 `V009-next-20260916/check-13-a06-auth-http.log`。后端 323 文件/2783 测试、前端 47/296、管理端 13/84 全部通过；运维 151 项中 149 通过、2 项 Windows 专属跳过；治理、文件长度、类型、lint、隔离 PostgreSQL 17 与构建全部通过。
- A06/P2 本地合成实现、正式认证 HTTP 合成闭环和浏览器合成任务证据已收口。真实认证浏览器、真实模型/DSH、Windows/手机、跨设备草稿恢复、真实教师资料、渠道发送和用户验收仍未关闭。

### A06-P2-AUTH-BROWSER-FINAL-GATE｜2026-09-16｜桌面与窄视口浏览器证据后的最终门禁

- 在桌面认证浏览器流程和 `375×844` viewport override 流程均完成后重新执行完整 `npm run check`，退出 0；证据为 `V009-next-20260916/check-14-a06-browser-final.log`。后端 323 文件/2783 测试、前端 47/296、管理端 13/84 全部通过；运维 151 项中 149 通过、2 项 Windows 专属跳过；治理、文件长度、类型、lint、隔离 PostgreSQL 17 与全部构建通过。
- 本次 Gate 未改变产品代码，只确认 A06/P2 文档证据更新与现有实现保持一致。浏览器仍为本地合成账号、fake AI 和隔离数据库；实体手机、Windows 和真实服务不在本次范围内。

### A06-P2-AUTH-BROWSER｜2026-09-16｜认证浏览器合成任务核对

- 使用本地隔离后端和 Vite 页面，以合成邀请账号 `a06-browser@example.com` 登录正式工作区，进入 `/#/feedback`，选择合成学生并生成反馈。页面显示生成说明、1 条已核对依据和时间范围；生成结果保持待核对状态。
- 手工编辑正文为“浏览器核对后的反馈：小雨主动验算，下一次继续保持。”后点击“保存草稿”，列表显示标题、合成学生、草稿状态、编辑后的正文和“已保存”回执。点击“复制草稿”后剪贴板读回标题与正文，页面显示“已复制”。
- 桌面视口实测 `innerWidth=1278`、`innerHeight=1235`、`scrollWidth=1278`、`scrollHeight=1235`；另以浏览器 viewport override `375×844` 完成同一生成→编辑→保存→复制流程，窄视口 `bodyWidth=375`、`scrollWidth=375`、`scrollHeight=844`，均未观察到横向溢出。完整步骤、AX/UI 结果和边界记录见 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/a06-auth-http-browser.log`。
- 验证边界：本包仍只使用 fake AI、隔离数据库和合成账号；真实模型/DSH、Windows/手机、跨设备草稿、真实教师资料、渠道发送和用户验收未验证。下一步在不新增外部授权的前提下保留工程回归，等待相应环境再做真实设备 Gate。

### WEB-CONTENT-DEBUG-01｜2026-09-16｜网页端内容与窄屏复核

- 问题：反馈生成依据把 RFC3339 原始时间直接展示给教师，例如 `2026-08-17T17:28:13.335Z`，与平台其他中文日期不一致。
- 修复：`FeedbackSettings` 统一使用共享 `formatDate`（Asia/Shanghai）展示反馈依据时间窗和已保存反馈更新时间；数据提交仍保留原始 RFC3339 值，不改变接口契约。
- 浏览器证据：本地隔离 PostgreSQL、合成邀请账号和 fake AI 下完成反馈生成→明确保存；页面显示“本次使用 1 条已核对依据，范围 2026年8月18日 至 2026年9月17日”，保存列表显示“2026年9月17日”。同一轮审计了今日、学生、日程、缴费、AI 助手、反馈、设置和模型设置页；375×844 viewport 下 `body.scrollWidth=375`、`preview-main.scrollWidth=375`，未观察横向溢出。原始记录见 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/web-content-debug-01.log`。
- 验证：反馈组件专项 3/3、前端完整 47 文件/297 测试通过，`git diff --check` 通过；本包完整根门禁退出 0，证据见 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/check-15-web-content.log`（后端 323/2783、前端 47/297、管理端 13/84、运维 149/151，2 项 Windows 专属跳过，构建通过）。真实 DeepSeek、Windows、实体手机、真实资料和渠道仍未进入范围。

### WEB-CONTENT-DEBUG-02｜2026-09-16｜DeepSeek 平台提供边界文案

- 问题：正式教师网页的模型设置页仍以“手动填写供应商、地址和模型 ID”描述空状态，容易让教师误以为需要自行准备 API Key，与 V009 的平台统一 DeepSeek 约束不一致。
- 修复：连接工作区模型页改为“已接入的模型服务”，明确正式 AI 由平台统一提供 DeepSeek、教师无需填写 API Key；兼容配置和未启用运行时的状态继续如实展示；保留的新增 API 表单标注为“本地开发测试”，并提示不要粘贴真实密钥。设置入口同步改为平台 DeepSeek 服务状态文案，未改变接口或真实调用边界。
- 浏览器证据：本地隔离后端、合成账号和无真实运行时下，桌面模型设置页显示新文案，`innerWidth=1278`、`scrollWidth=1278`；375×844 viewport 下显示新文案且 `bodyWidth=375`、`scrollWidth=375`，未观察横向溢出。原始记录见 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/web-content-debug-02.log`。
- 验证：`ModelConfiguration`、设置入口和 unavailable 文案专项 25/25 通过；修改后的完整根门禁退出 0，证据见 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/check-16-web-content.log`：治理 19/19，后端 323 文件/2783 测试，前端 47 文件/297 测试，管理端 13 文件/84 测试，运维 151 项中 149 通过、2 项 Windows PowerShell 专属跳过，类型、lint、隔离 PostgreSQL 与构建通过。真实 DeepSeek、Windows、实体手机、真实资料和渠道仍未进入范围。

### WEB-CONTENT-DEBUG-03｜2026-09-16｜网页日期显示统一

- 问题：日程列表/详情、重复规则、学生时间线和缴费表仍把存储用的 `YYYY-MM-DD` 直接展示给教师；编辑确认弹窗也直接展示原始日期，和网页其他中文日期格式不一致。
- 修复：上述教师可见日期统一使用共享 `formatDate`（Asia/Shanghai）输出中文年月日；日程时间、`<input type=date>` 的值、接口提交和排序比较继续保留原始 ISO 字符串，不改变数据契约。
- 浏览器证据：本地 `preview.html` 合成数据在桌面 1278px 与 375×844 下核验日程列表/详情、重复规则、学生时间线和缴费记录；页面显示中文日期，原始记录见 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/web-content-debug-03.log`。桌面 body/document `scrollWidth=1278`，窄视口 body/document `scrollWidth=375`，未观察横向溢出。
- 测试：网页相关专项 4 文件/26 项通过；代码冻结后完整 `npm run check` 退出 0，证据为 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/check-18-web-date-format.log`：治理 19/19，后端 323 文件/2783 测试，前端 47 文件/297 测试，管理端 13 文件/84 测试，运维 151 项中 149 通过、2 项 Windows PowerShell 专属跳过，类型、lint、隔离 PostgreSQL 与构建通过。
- 边界与下一步：网页内容调试继续进行；真实 DeepSeek/DSH、Windows、实体手机、跨设备、真实教师资料、渠道和正式发布仍未进入范围。只有网页 Gate 成熟后才进入 Windows 与手机开发；真实模型验证前需要安全注入平台 DeepSeek 配置，不把 API Key 粘贴到聊天或提交到仓库。

### WEB-CONTENT-DEBUG-04｜2026-09-16｜连接版网页时间显示统一

- 问题：助手会话、任务进展、材料收件箱和学生记录各自使用 `toLocaleString` 或独立 `Intl` 格式，设备语言或实现差异可能造成教师看到的时间不一致。
- 修复：`TurnContent`、`ConversationPanel`、`AssistantWorkspace`、`CaptureInbox` 和学生记录 `displayTime` 统一复用 `shared/date-format.ts` 的 `formatDateTime`（Asia/Shanghai）；原始 ISO 值继续用于 `dateTime` 属性、排序、表单和接口提交，无效学生记录时间继续显示“时间未知”。
- 测试：连接版助手、材料、学生记录专项 3 文件/34 项通过；完整 `npm run check` 退出 0，证据为 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/check-19-connected-date-format.log`：治理 19/19，后端 323 文件/2783 测试，前端 47 文件/298 测试，管理端 13 文件/84 测试，运维 151 项中 149 通过、2 项 Windows PowerShell 专属跳过，类型、lint、隔离 PostgreSQL 与构建通过。
- 浏览器证据：正式连接版本地隔离后端以合成账号登录，学生档案页面显示 `2026年9月15日 18:00`、`2026年9月17日 02:36` 等中文北京时间；375×844 viewport 下 DOM `innerWidth=375`、`body.scrollWidth=375`、`document.documentElement.scrollWidth=375`，默认视口已恢复。完整记录见 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/web-content-debug-04.log`。
- 边界与下一步：继续网页端内容调试；真实 DeepSeek/DSH、真实教师资料、Windows、实体手机、跨设备、渠道和正式发布仍未进入范围。网页 Gate 成熟后才进入 Windows 与手机开发；真实模型验证前需要安全注入平台 DeepSeek 配置，不把 API Key 粘贴到聊天或提交到仓库。

### WEB-CONTENT-DEBUG-05｜2026-09-16｜预览版修订历史时间显示

- 问题：预览版已完成课程的修订历史仍使用独立 `Intl.DateTimeFormat` 输出斜杠日期（如 `2026/09/10 03:30`），与同一网页其他教师可见时间的中文北京时间不一致。
- 修复：`ScheduleDetails.revisionTimeLabel` 改用共享 `formatDateTime`（Asia/Shanghai）；原始 ISO 值继续用于数据、排序和接口语义，仅统一展示格式。回归断言覆盖 UTC 跨日转换及实际修订记录渲染。
- 测试：预览版 `ui-repair` 与 `schedule-interaction` 专项 2 文件/15 项通过；代码冻结后完整 `npm run check` 退出 0，证据为 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/check-20-preview-revision-date.log`：治理 19/19，后端 323 文件/2783 测试，前端 47 文件/298 测试，管理端 13 文件/84 测试，运维 151 项中 149 通过、2 项 Windows PowerShell 专属跳过，类型、lint、文件长度、隔离 PostgreSQL 与构建通过。
- 浏览器证据：本地 `preview.html` 合成数据桌面端实际完成已完成课程编辑并查看修订记录，时间显示为中文北京时间，原扣课记录保留；375×844 下排期列表/详情显示中文日期，`innerWidth=375`、body/document `scrollWidth=375`，无横向溢出，默认视口已恢复。完整步骤见 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/web-content-debug-05.log`。
- 边界与下一步：继续网页端内容与交互成熟度核对；真实 DeepSeek/DSH、真实教师资料、Windows、实体手机、跨设备、渠道和正式发布仍未进入范围。网页 Gate 成熟后才进入 Windows 与手机开发；真实模型验证前需要安全注入平台 DeepSeek 配置，不把 API Key 粘贴到聊天或提交到仓库。

### WEB-CONTENT-DEBUG-06｜2026-09-16｜学生详情课时流水日期

- 问题：学生详情“历史完成 → 课时流水”直接显示存储日期 `YYYY-MM-DD`，与同页排期及网页其他教师可见日期不一致。
- 修复：`packages/frontend/src/preview/Students.tsx` 的课时流水日期改用共享 `formatDate`（Asia/Shanghai）；余额、排序、数据契约和内部业务日期计算不变。`ui-repair.test.tsx` 增加中文日期回归断言。
- 稳定性修复：既有 `v006-flow.test.tsx` 已完成课程编辑用例在整套 Vitest 并行负载下超过默认 5 秒，单跑 9/9 通过；将该用例测试预算调整为 15 秒，仅改变测试等待预算，不改变产品行为。
- 测试：课时流水相关专项 2 文件/11 项通过；网页全套 47 文件/299 项通过。首次根门禁因既有 v006 超时失败；调整测试预算后第二次根门禁网页测试通过，但后端出现 3 个与本包无关的并行抖动（capture-api-contract socket hang up、media-transcription-adapter 状态仍 running、admin interactions-health 返回 404），后端 320/323 文件、2780/2783 项通过，根门禁未标记为通过。完整日志见 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/check-23-student-completion-date.log`；专项与浏览器证据见 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/web-content-debug-06.log`。
- 浏览器证据：预览版学生详情桌面端显示“完成课时记录 · 2026年9月17日”；375×844 下同样显示中文日期，`innerWidth=375`、`bodyScrollWidth=375`、`documentScrollWidth=375`，未观察横向溢出，默认视口已恢复。
- 边界与下一步：本包网页专项和真实浏览器内容验收通过；根门禁 0 退出仍待后端并行抖动消除或下一轮完整复跑。真实 DeepSeek/DSH、真实教师资料、Windows、实体手机、跨设备、渠道和正式发布仍未进入范围；网页 Gate 成熟后才进入 Windows 与手机开发，真实模型验证前需安全注入平台 DeepSeek 配置。

### WEB-CONTENT-DEBUG-06-FINAL-GATE｜2026-09-16｜课时流水日期包最终根门禁

- 代码冻结后以 `set -o pipefail; npm run check` 完整复跑，退出 0；证据为 `/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-next-20260916/check-24-web-content-final.log`。
- 本轮治理、文件长度、类型检查、lint、隔离 PostgreSQL 17 全量测试、三端构建均通过：后端 323 文件/2783 测试，前端 47 文件/299 测试，管理端 13 文件/84 测试，运维 151 项中 149 通过、2 项 Windows PowerShell 专属跳过。
- 上一轮出现的三个后端并行抖动（capture-api-contract、media-transcription-adapter、interactions-health）本轮均未复现；不将偶发复跑等同于根因修复。真实 DeepSeek、Windows/手机、跨设备和用户体验验收仍未验证。
