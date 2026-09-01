# 教师 AI 工作平台｜旧资产迁移台账

> 状态：W0 首版，只读审计结果
>
> 旧仓库：`/Users/xiaosi/Desktop/OH-WorkSpace/teacher-platform`
>
> 规则：台账中的“迁移”是逐文件重读、提取不变量、在新结构中重新实现并重新验收，不是复制目录。旧仓库当前保持未修改。

## 一、四种处置

- **M｜迁移规则与证据**：高价值业务不变量和测试场景，优先进入正式版。
- **R｜提取后重写**：需求有价值，但旧实现、数据结构或部署边界不适合正式版。
- **H｜历史参考**：保留在旧 Git 历史，不进入新运行代码。
- **X｜禁止迁入**：与正式产品边界冲突、含敏感/生成内容或会造成错误继承。

## 二、M｜优先迁移规则与证据

### W1–W3：基础安全与一致性

| 旧资产 | 提取内容 | 新位置 |
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

| 旧资产 | 提取内容 | 新位置 |
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

| 旧资产 | 提取内容 | 新位置 |
| --- | --- | --- |
| `packages/backend/src/features/feedback/feedback-evidence-validation.ts` | 证据准入规则 | `packages/domain/feedback` |
| `packages/backend/src/features/feedback/feedback-moderation.ts` | 家长可见与内部内容边界 | `packages/domain/feedback` |
| `packages/backend/src/features/feedback/parent-feedback-content-editor.ts` | 人工修改与版本冲突 | `packages/application` |
| `packages/backend/tests/functional/feedback/**` | 草稿状态、原子审计和编辑冲突 | 新领域与集成测试 |
| `packages/backend/tests/functional/use-cases/{assemble-parent-feedback-context,generate-feedback-draft-use-case,update-parent-feedback-content}.test.ts` | 证据快照与生成闭环 | 新应用层测试 |

迁移限制：不得迁入任何直接发送家长内容的能力；只有确认且允许家长查看的事实能进入草稿。

### W9：数据权利与运维安全

| 旧资产 | 提取内容 | 新位置 |
| --- | --- | --- |
| `packages/backend/src/shared/file-export/**` | 安全文件生成和下载边界 | `packages/ops` |
| `packages/backend/tests/functional/privacy/**` | 导出、注销和失败语义 | 新隐私集成测试 |
| `packages/ops/scripts/{db-backup,db-restore,export-teacher-data}.mjs` | 目标校验、恢复保护和导出核对思路 | 重写后的 `packages/ops` |
| `packages/ops/tests/{db-backup,db-restore,db-restore-safety,export-teacher-data}.test.mjs` | 备份恢复事故用例 | 新生产同构 Gate |

迁移限制：正式版备份恢复由受控运维作业执行，不能由 Admin HTTP 直接启动本机命令。

## 三、R｜必须提取后重写

| 旧资产 | 为什么不能直接迁 | 正式版动作 |
| --- | --- | --- |
| `packages/contracts/prisma/schema.prisma` 与 27 个 migrations | 每教师分库、旧索引和旧模型已与单库多租户方向冲突 | 从新 baseline 建 Account、Tenant、原始事件、处理版本、账本、RLS |
| `packages/contracts/src/**` | DTO 有价值，但 `index.ts` 重新导出 Prisma Client，前后端边界不干净 | 重建运行时可校验的 `api-contracts`，禁止导出 ORM |
| 所有 `*.routes.ts`、应用装配和仓储 | 绑定旧数据库、身份和返回结构 | 先冻结 DTO，再按模块化单体重写 |
| `packages/backend/src/features/auth/**` | Session 思路可参考，正式版租户与 Cookie 边界改变 | 重写教师身份、会话撤销、CSRF 和限流 |
| `packages/backend/src/features/admin/**` | 后台合同漂移，总览占位，路由过大，运维命令边界不安全 | 独立身份、默认脱敏、授权支持访问、受控运维作业 |
| `packages/admin/**` | 不是旧教师前端，但 API DTO 已与后端漂移 | 保留业务需求，全部按新契约重写 |
| `packages/backend/src/features/wechat/**` | 单全局 Token、主要只支持文字、内存队列、扫码交换器不可用，并含主动通知 | 只提取签名、幂等、身份状态和恢复案例；重写绑定/入站/下载/回复四端口 |
| `packages/backend/src/adapters/wechat-bot/**` | 旧供应商假设未证明支持 150 个个人绑定 | 最终供应商确定后写契约适配器和真实测试 |
| `packages/backend/src/features/media/**` | 识别是占位骨架、任务状态在内存、成功后不删原件，核心文件 1115 行 | 重建对象存储、持久化任务、真实 OCR/ASR、版本和删除回执 |
| `packages/backend/src/features/payments/**` | 金额与课时不是可对账账本 | 重建缴费流水和课时增减流水 |
| `packages/frontend/src/api/**` | 部分 Session 语义可参考，但 DTO 手工复制且弱类型 | 由新共享契约生成/实现适配器 |
| `.github/workflows/**`、根 scripts、Docker 和 deploy | 旧 Gate 围绕 Windows、本地分库和 RC 交付 | 重写为 Linux 同构构建、容器、预发布与正式提升 Gate |
| 根 `package.json`、`package-lock.json` | 旧依赖和 workspace 形状不等于正式版 | 新工作区初始化后重新锁定并审计 |

## 四、H｜只作历史参考

- `reports/**`：保留事故、架构和验收经验，不作为当前事实源。
- `docs/product/**`：已提炼进新产品契约，不整目录迁入。
- `PROGRESS.md`、`RECOVERY.md`、`CHANGELOG.md`、根任务记录：状态互相漂移，不进入正式版计划链。
- `reports/handoff/**`、`deploy/windows/**`、Windows RC1/RC2 说明：只作为旧交付历史。
- 本地 tag `m0-windows-rc.1`、`m0-windows-rc.2`：可作为历史锚点，是否推送远端需单独授权。

## 五、X｜禁止迁入

### 产品冲突

- `packages/backend/src/features/wechat/notifier.ts`；
- `packages/backend/src/features/push/**` 与 `PushRecord`；
- 任意定时、批量、无入站消息关联的微信发送代码和测试；
- 群聊、朋友圈、自动加好友、直接联系家长；
- Telegram、企业微信、天气等 V1 外适配器。

### 旧教师前端

- `packages/frontend/src/features/**` 中的旧 Page 组件和页面 CSS；
- `packages/frontend/src/app/{App.tsx,AppShell.tsx,routes.ts}` 的内存路由实现；
- 旧视觉 token、静态 CSS 字符串测试和绑定旧文件路径的边界测试；
- `StudentDetailPage.tsx`、`LlmConfigPage.tsx` 等超 500 行页面。

正式版只在新 `apps/teacher-web` 中重建真实 URL 路由、Session 壳、Today、Students / Student detail 和上下文 AI。

### 敏感、生成和机器状态

- `.env*`、`.data/**`、数据库、dump、backup、真实媒体、密钥和日志；
- `node_modules/**`、所有构建 `dist/**` 和 RC zip；
- 旧仓库 `.git/**`；
- `.DS_Store` 和本机缓存。

## 六、迁移前的必做检查

每次从旧项目选择资产时：

1. 记录旧提交 SHA、源路径和选择原因；
2. 完整阅读源文件及其直接依赖，不只复制单个函数；
3. 找到对应测试，区分真实行为测试、全部 mock 和静态字符串测试；
4. 先把业务不变量写成新测试，再写新实现；
5. 删除旧数据库、旧路由、旧全局状态和旧供应商假设；
6. 文件超过 500 行时先拆分；
7. 由独立审查者核对产品契约、禁止能力和失败路径；
8. 只有新 Gate 通过后，才把该项标记为“已迁移”。

## 七、已发现的硬漂移

- 旧微信 notifier 明确支持主动推送，与正式产品边界冲突。
- 旧 OCR/ASR 适配器是占位实现，不能算真实识别。
- 旧媒体作业使用内存状态，重启会丢；处理成功也不会按新规则删除原件。
- 旧规模文档混有 100、200、500 名教师，不等于正式版 150 名。
- 旧 Admin 的备份、恢复和教师 DTO 与后端合同不一致。
- 旧教师网页是内存路由，并按大屏固定布局，不能支持正式版深链和手机验收。
- 旧 Windows 本地启动、RC 包和三件套不等于中国大陆云端 Linux 交付。
- 多个生产文件超过 500 行：媒体服务 1115 行、Prisma schema 668 行、Admin 反馈页 652 行、Admin 样式 646 行、Admin 路由 549 行、学生记录路由 543 行、Gate 540 行、反馈服务 509 行、隐私路由 508 行；都不得整文件迁入。
