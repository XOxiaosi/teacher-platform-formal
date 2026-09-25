# 教师 AI 工作平台｜旧资产迁移处置规则

> 状态说明（2026-09-08）：整体基线已迁入，legacy/T 类资产仍待 T-033 退出；本文件保存处置规则与历史来源，当前执行状态只写入 `PROJECT_LOG.md`。
>
> 旧运行来源：`/Users/xiaosi/Desktop/OH-WorkSpace/teacher-platform@8673884f57c9d23abdb26715913d6199b1b4d16b`
>
> 旧正式来源：`/Users/xiaosi/Desktop/OH-WorkSpace/teacher-platform-formal`
>
> 唯一目标：`/Users/xiaosi/Developer/active/apps/teacher-platform-formal`
>
> 规则：整个固定快照一次纳入 MIG-002 清单，不再逐能力请求技术批准；逐文件分类后只把正式资产与有退出任务的临时遗留迁入。两个旧来源始终只读。

## 一、六种处置

- **M0｜原样迁移**：已验证且符合正式边界的源码、契约与测试，保留血缘直接迁入。
- **M1｜适配迁移**：业务行为正确，仅因目录、接口或运行边界变化做最小改造。
- **R｜重构迁移**：产品语义有价值，但旧实现占位、冲突或不适合正式版；迁移语义与证据后替换实现。
- **T｜临时遗留**：仅为恢复整体构建或最小可达性暂存，必须有替换任务、精确来源和退出 Gate，默认不可发布。
- **H｜历史参考**：保留在旧 Git 历史，不进入新运行代码。
- **X｜禁止迁入**：与正式产品边界冲突、含敏感/生成内容或会造成错误继承。

MIG-002 manifest 覆盖固定提交的每个受管文件。强制字段为：来源、commit/blob、源路径、处置类别、目标路径、替换任务或排除原因、哈希与状态。正式产品完成状态仍只由 `PROJECT_LOG.md` 的永久任务和 Gate 决定。

本台账同时表达“最终正式架构”和“MIG-002 兼容基线”。下文 R/X 对微信、push、旧前端、旧 contracts 与旧数据模型的限制，是禁止它们进入**正式可达或可发布图**；MIG-002 可把其中为恢复编译、测试和最小可达性所需的源码标为 T 暂存。T 不改变产品范围，必须默认不可达、不可发布，并由 T-033 退出。

## 二、M0 / M1｜优先迁移源码、规则与证据

### W1–W3：基础安全与一致性

| 旧资产 | 迁移内容 | 新位置 |
| --- | --- | --- |
| `packages/backend/src/shared/trusted-clock/**` | 可信服务端时间、教师业务日期和时区边界 | `packages/domain` / `packages/application` |
| `packages/backend/src/shared/ssrf/endpoint-guard.ts` | 外部地址解析与 SSRF 防护规则 | `packages/providers` |
| `packages/backend/src/shared/field-encryption/**` | 字段加密接口、密钥加载失败策略 | `packages/database` / `packages/ops` |
| `packages/backend/src/features/pending-action/**` | 待确认状态、令牌、消费一次、取消和过期 | `packages/application` |
| `packages/backend/src/features/agent-execution/**` | 请求幂等、执行状态和重放边界 | `packages/application` |
| `packages/backend/tests/functional/trusted-clock/**` | 时间源与业务日期证据 | 新领域与集成测试 |
| `packages/backend/tests/functional/confirmation/**` | 高影响操作确认、重复确认和失败协议 | 新用例与契约测试 |
| `packages/backend/tests/boundary/*pending-action*` | 确认流程的边界事故清单 | 新边界 Gate |
| `packages/backend/tests/functional/agent-execution*.test.ts` 及 `agent-execution/**` | 幂等、双写和读取切换案例 | 新集成测试 |

迁移限制：旧租户过滤方式不直接继承；正式版必须增加数据库行级策略和跨租户组合外键测试。

### W4：核心教学领域

| 旧资产 | 迁移内容 | 新位置 |
| --- | --- | --- |
| `packages/backend/src/features/students/**` | 学生状态、姓名匹配、资料修改规则 | `packages/domain/students` |
| `packages/backend/src/features/scheduling/**` | 冲突检测、改期、取消、恢复和状态机 | `packages/domain/scheduling` |
| `packages/backend/src/features/lessons/**` | 完课状态和课堂记录修改规则 | `packages/domain/lessons` |
| `packages/backend/src/features/student-records/**` | 来源记录、派生记录、确认与驳回 | `packages/domain/records` |
| `packages/backend/src/features/student-communications/**` | 沟通事实、敏感内容和审核语义 | `packages/domain/communications` |
| `packages/backend/src/features/assessments/**` | 成绩与评估信息规则 | `packages/domain/assessments` |
| `packages/backend/src/features/memos/**` | 备忘创建、修改和状态 | `packages/domain/memos` |
| `packages/backend/src/features/daily-review/**` | 每日回顾的汇总规则 | `packages/application/projections` |
| `packages/backend/src/features/student-timeline/**` | 学生时间线投影 | `packages/application/projections` |
| `packages/backend/tests/functional/{students,scheduling,lessons,student-records,student-communications,memos,agenda}/**` | 领域状态机和异常场景 | 新领域测试 |
| `packages/backend/tests/functional/use-cases/*{student,schedule,lesson,payment,memo,daily-review}*` | 跨模块业务闭环 | 新应用层测试 |

迁移限制：旧 `Payment.amount Float` 和“购买减课程”余额算法不迁移；正式版重新设计金额与课时追加账本。

### W8：家长反馈与受控 AI

| 旧资产 | 迁移内容 | 新位置 |
| --- | --- | --- |
| `packages/backend/src/features/feedback/feedback-evidence-validation.ts` | 证据准入规则 | `packages/domain/feedback` |
| `packages/backend/src/features/feedback/feedback-moderation.ts` | 家长可见与内部内容边界 | `packages/domain/feedback` |
| `packages/backend/src/features/feedback/parent-feedback-content-editor.ts` | 人工修改与版本冲突 | `packages/application` |
| `packages/backend/tests/functional/feedback/**` | 草稿状态、原子审计和编辑冲突 | 新领域与集成测试 |
| `packages/backend/tests/functional/use-cases/{assemble-parent-feedback-context,generate-feedback-draft-use-case,update-parent-feedback-content}.test.ts` | 证据快照与生成闭环 | 新应用层测试 |

迁移限制：不得迁入任何直接发送家长内容的能力；只有确认且允许家长查看的事实能进入草稿。

### W9：数据权利与运维安全

| 旧资产 | 迁移内容 | 新位置 |
| --- | --- | --- |
| `packages/backend/src/shared/file-export/**` | 安全文件生成和下载边界 | `packages/ops` |
| `packages/backend/tests/functional/privacy/**` | 导出、注销和失败语义 | 新隐私集成测试 |
| `packages/ops/scripts/{db-backup,db-restore,export-teacher-data}.mjs` | 目标校验、恢复保护和导出核对规则与可复用实现 | 迁移后的 `packages/ops` |
| `packages/ops/tests/{db-backup,db-restore,db-restore-safety,export-teacher-data}.test.mjs` | 备份恢复事故用例 | 新生产同构 Gate |

迁移限制：正式版备份恢复由受控运维作业执行，不能由 Admin HTTP 直接启动本机命令。

## 三、R｜迁移语义并重构不兼容实现

| 旧资产 | 为什么不能直接迁 | 正式版动作 |
| --- | --- | --- |
| `packages/contracts/prisma/schema.prisma` 与 27 个 migrations | 每教师分库、旧索引和旧模型已与单库多租户方向冲突 | 以旧模型清单与行为证据为输入建立正式 baseline |
| `packages/contracts/src/**` | DTO 有价值，但 `index.ts` 重新导出 Prisma Client，前后端边界不干净 | 迁移 DTO 语义并形成运行时可校验的 `api-contracts`，禁止导出 ORM |
| 所有 `*.routes.ts`、应用装配和仓储 | 绑定旧数据库、身份和返回结构 | 先冻结 DTO，再逐项适配或重构不兼容装配 |
| `packages/backend/src/features/auth/**` | Session 思路可参考，正式版租户与 Cookie 边界改变 | 迁移会话语义，适配教师身份、会话撤销、CSRF 和限流 |
| `packages/backend/src/features/admin/**` | 后台合同漂移，总览占位，路由过大，运维命令边界不安全 | 独立身份、默认脱敏、授权支持访问、受控运维作业 |
| `packages/admin/**` | 不是旧教师前端，但 API DTO 已与后端漂移 | 逐项迁移业务语义，并按正式契约原样迁移、适配或重构 |
| `packages/backend/src/features/wechat/**` | 单全局 Token、主要只支持文字、内存队列、扫码交换器不可用，并含主动通知 | 只提取签名、幂等、身份状态和恢复案例；重写绑定/入站/下载/回复四端口 |
| `packages/backend/src/adapters/wechat-bot/**` | 旧供应商假设未证明支持 150 个个人绑定 | 最终供应商确定后写契约适配器和真实测试 |
| `packages/backend/src/features/media/**` | 识别是占位骨架、任务状态在内存、成功后不删原件，核心文件 1115 行 | 重建对象存储、持久化任务、真实 OCR/ASR、版本和删除回执 |
| `packages/backend/src/features/payments/**` | 金额与课时不是可对账账本 | 重建缴费流水和课时增减流水 |
| `packages/frontend/src/api/**` | 部分 Session 语义可参考，但 DTO 手工复制且弱类型 | 由新共享契约生成/实现适配器 |
| `.github/workflows/**`、根 scripts、Docker 和 deploy | 旧 Gate 围绕 Windows、本地分库和 RC 交付 | 迁移仍有效的 Gate，并适配 Linux 同构构建、容器、预发布与正式提升 |
| 根 `package.json`、`package-lock.json` | 旧依赖和 workspace 形状不等于正式版 | 以旧依赖为来源逐项迁移，重新锁定并审计 |

## 四、H｜只作历史参考

- `reports/**`：保留事故、架构和验收经验，不作为当前事实源。
- `docs/product/**`：已提炼进新产品契约，不整目录迁入。
- `PROGRESS.md`、`RECOVERY.md`、`CHANGELOG.md`、根任务记录：状态互相漂移，不进入正式版计划链。
- `reports/handoff/**`、`deploy/windows/**`、Windows RC1/RC2 说明：只作为旧交付历史。
- 本地 tag `m0-windows-rc.1`、`m0-windows-rc.2`：可作为历史锚点，是否推送远端需单独授权。

## 五、T｜MIG-002 临时兼容基线

- 旧 `backend/frontend/admin/contracts/ops` 只作为统一 workspace 内的 legacy-only 包存在；所有包保持 `private`，不得被正式包反向依赖。
- 旧微信、push、morning brief、evening review、OCR/ASR 占位与外部 provider 源码可为编译和测试暂存，但不得进入 local-safe 的路由、调度器、provider 或外发装配图。
- V004 已退役旧教师 UI，`packages/frontend` 仅保留可构建的中性重构入口和业务基础；管理端暂保留。最小可达不代表产品可用。
- 旧超长文件只允许按路径、行数和 SHA-256 精确登记；任何修改都会使豁免失效。
- 每条 T manifest 记录 `exitTask: T-033` 和退出条件；正式模块替换后删除对应 legacy 文件和精确豁免，再复验完整 Gate。

## 六、X｜禁止进入正式层或可达运行图

### 产品冲突

以下资产不得成为正式实现、默认可达能力或发布产物；若 MIG-002 manifest 将源码标为 T，只能适用上一节的隔离与退出规则：

- `packages/backend/src/features/wechat/notifier.ts`；
- `packages/backend/src/features/push/**` 与 `PushRecord`；
- 任意定时、批量、无入站消息关联的微信发送代码和测试；
- 群聊、朋友圈、自动加好友、直接联系家长；
- Telegram、企业微信、天气等 V1 外适配器。

### 旧教师前端实现：禁止成为正式 UI，必须先完成语义迁移

- `packages/frontend/src/features/**` 中的旧 Page 组件和页面 CSS；
- `packages/frontend/src/app/{App.tsx,AppShell.tsx,routes.ts}` 的内存路由实现；
- 旧视觉 token、静态 CSS 字符串测试和绑定旧文件路径的边界测试；
- `StudentDetailPage.tsx`、`LlmConfigPage.tsx` 等超 500 行页面。

2026-09-08 用户要求旧教师页面及设计资料全部退出。退役清单与删除前哈希见 `evidence/migration/UI-RESET-retired-files.json`；完整脏工作树备份在源码树外，旧来源不变。保留 `packages/frontend` 的构建入口、API 和必要业务基础；新原型确认后在此重建教师网页，不创建平行应用目录。旧 UI 历史不再作为设计依据；清场不等于 T-018/T-033 完整 Gate 通过。

### 敏感、生成和机器状态

- `.env*`、`.data/**`、数据库、dump、backup、真实媒体、密钥和日志；
- `node_modules/**`、所有构建 `dist/**` 和 RC zip；
- 旧仓库 `.git/**`；
- `.DS_Store` 和本机缓存。

## 七、已锚定的首批迁移来源

| 迁移编号 | 永久任务 | 旧仓库与提交 | 源文件 | 直接依赖 | 对应测试 | 处置 | 目标位置 | Gate 与证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MIG-001 | T-027 | `teacher-platform@8673884f57c9d23abdb26715913d6199b1b4d16b` | `packages/contracts/src/types.ts`；`packages/backend/src/shared/trusted-clock/{types,teacher-time-context}.ts` | 旧 `@teacher-platform/contracts`；运行时仅依赖标准 `Intl` | `packages/backend/tests/functional/trusted-clock/teacher-time-context.test.ts`；`packages/backend/tests/functional/edit-command-foundation.test.ts` | M1：保留结果、错误与可信时间语义，适配为独立契约和领域包 | `packages/api-contracts/src/**`；`packages/domain/src/trusted-clock/**` | `npm run check`；`evidence/migration/MIG-001-trusted-time.md` |

MIG-001 不包含旧 `database-trusted-clock.ts`、Prisma 或 SQL adapter。数据库可信时间仍是后续候选，必须在数据库基线确定后单独锚定并保留“失败时不回退设备时间”的 Gate。执行状态与完成日期只记录在 `PROJECT_LOG.md`。

## 八、迁移前的必做检查

每次从旧项目选择资产时：

1. 记录旧提交 SHA、源路径和选择原因；
2. 完整阅读源文件及其直接依赖，不只复制单个函数；
3. 找到对应测试，区分真实行为测试、全部 mock 和静态字符串测试；
4. 先迁移能证明行为的测试；兼容源码优先原样迁移，不兼容部分才适配或重构；
5. 在正式迁移目标实现中拒绝携带旧数据库、旧路由、旧全局状态和旧供应商假设；旧仓库及历史保持只读，不在迁移过程中删除；
6. 文件超过 500 行时先拆分；
7. 由独立审查者核对产品契约、禁止能力和失败路径；
8. 只有新 Gate 通过后，才在 `PROJECT_LOG.md` 把对应永久任务标记为“已完成”。

## 九、已发现的硬漂移

- 旧微信 notifier 明确支持主动推送，与正式产品边界冲突。
- 旧 OCR/ASR 适配器是占位实现，不能算真实识别。
- 旧媒体作业使用内存状态，重启会丢；处理成功也不会按新规则删除原件。
- 旧规模文档混有 100、200、500 名教师，不等于正式版 150 名。
- 旧 Admin 的备份、恢复和教师 DTO 与后端合同不一致。
- 旧教师网页是内存路由，并按大屏固定布局，不能支持正式版深链和手机验收。
- 旧 Windows 本地启动、RC 包和三件套不等于中国大陆云端 Linux 交付。
- 多个旧文件超过 500 行：媒体服务 1115 行、Prisma schema 668 行、Admin 反馈页 652 行、Admin 样式 646 行、Admin 路由 549 行、学生记录路由 543 行、Gate 540 行、反馈服务 509 行、隐私路由 508 行；不得进入正式完成基线。MIG-002 仅能按精确哈希作为 T 暂存，修改前先拆分，并由 T-033 清零。
