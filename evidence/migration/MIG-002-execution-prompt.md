# 教师平台整体迁移｜合并执行提示词

> 用户原始决定：把教师平台从旧工作空间迁入新的 Active Developer Workspace，借迁移梳理旧资产、去除重复和生成物，让新工作区保持干净；本次采用一次委托、整体可运行基线迁入，不再要求用户逐能力批准技术迁移。
>
> 本文件是 MIG-002 的原始执行契约，不替代 `PRODUCT.md` 与 `PROJECT_LOG.md`。

请调用 `teacher-product-development` Skill，直接执行本次“教师平台整体受控迁移”。不要只输出规划；在产品、安全和授权边界内自主完成盘点、合并、验证、基线修复和证据落账。

## 一、任务目标

把两个旧教师平台目录作为只读来源，收敛到新工作空间中的唯一正式项目：

`/Users/xiaosi/Developer/active/apps/teacher-platform-formal`

本轮推进顺序：

固定来源 → 保护新目标 → 三方清单 → 合并旧正式成果 → 整体迁入运行工程 → 安全隔离 → 安装/构建/测试/安全启动 → 集中修复基线阻塞 → 独立审查 → 整洁 Gate。

“整体迁移”是一次用户委托和一个完整运行基线，不等于无差别复制。每项旧资产仍必须分类为：正式保留、临时遗留、提取后替换、历史引用、禁止迁入。

除非遇到会改变产品含义、隐私边界、费用、供应商锁定、使用真实数据、对外发送、部署上线、删除用户文件或其他不可逆操作的阻塞，否则不要停下来询问技术选择；主 Agent 自主判断、记录证据并继续。

## 二、产品契约

### 目标用户与场景

- 面向中国大陆个人教师，第一期按约 150 位教师规划。
- 教师通过网页端和移动网页使用；管理员使用独立后台。
- 最终运行在云服务器，但本轮只建立本地安全基线，不部署。

### 本轮要推进的任务

- 将分散在旧运行仓库、旧正式目录和新目标中的有效资产收敛到唯一新目标。
- 让新目标能够独立安装、构建、测试，并以合成数据安全启动教师端、后端和管理端。
- 暴露真实故障，不以删除测试、降低断言或伪造成功换取绿色结果。
- 保持新工作区只含正式源码、测试、必要配置、事实源和可追溯证据。

### 非范围

- 不发布 `V001`，产品继续保持 `DRAFT / 需求确认中`。
- 不部署公网，不购买服务器、域名或外部服务。
- 不接入真实微信、真实 Bot、真实 OCR/ASR/AI、真实账号、真实密钥或真实数据。
- 不删除、移动、清理、提交、切换分支或推送两个旧来源。
- 不在本轮删除旧工作空间内容；只生成后续“保留/归档/待删除”建议。
- 不把旧前端视觉、旧部署方式或旧实现状态升级为正式产品需求。

## 三、目录角色与唯一目标

### 来源 A｜旧运行仓库，只读

`/Users/xiaosi/Desktop/OH-WorkSpace/teacher-platform`

- 固定来源提交：`8673884f57c9d23abdb26715913d6199b1b4d16b`
- 分支：`main`
- 本地 tag：`m0-windows-rc.2`，执行时必须以 `^{}` peel 后核对到固定提交。
- 文件只能通过 `git ls-tree`、`git show` 或 `git archive` 从固定提交读取。
- 不得以当前工作树、`git ls-files` 或未受管文件作为迁移源。

### 来源 B｜旧正式目录，只读

`/Users/xiaosi/Desktop/OH-WorkSpace/teacher-platform-formal`

- 承载较新的 `PRODUCT.md`、`PROJECT_LOG.md`、MIG-001、`packages/api-contracts`、`packages/domain` 和最小工程。
- 不迁入其 `node_modules`、`dist`、缓存或其他生成物。
- 同名文档不得无差别覆盖新目标，必须先比较后合并。

### 目标 N｜唯一可写、唯一长期开发目录

`/Users/xiaosi/Developer/active/apps/teacher-platform-formal`

- 保护 `.devflow-project.json`、UI 视觉证据、来源记录和现有规划。
- 迁移后 DevFlow 只把 Active root 中的本项目视为教师平台活跃项目。
- 不得创建第四个长期项目副本；临时 staging 必须位于 Active 源码树之外。

## 四、规则与事实源优先级

按以下顺序处理冲突：

1. 用户本次明确决定与安全授权边界。
2. `/Users/xiaosi/Developer/active/AGENTS.md` 和适用的项目规则。
3. `teacher-product-development` Skill。
4. 合并进入新目标后的唯一 `PRODUCT.md` 与 `PROJECT_LOG.md`。
5. 新目标已有的独有成果和视觉/交互契约。
6. 来源 B 的任务历史、MIG-001 和已验证工程事实。
7. 来源 A 固定提交中的代码、测试和历史实现。

来源 A 的代码不能定义产品需求；历史文档不能覆盖当前用户决定。产品含义冲突交给用户，纯技术兼容、文件组织和构建问题由主 Agent决定。

## 五、必须先读取与保护

- `/Users/xiaosi/Developer/active/AGENTS.md`
- `teacher-product-development` Skill 及其独立判断、决策权、路由、持久化和 Gate 规则
- 来源 B 的 `PRODUCT.md`、`PROJECT_LOG.md`、`MIGRATION-LEDGER.md`、`DECISIONS.md`、`VALIDATION-GATES.md`
- 目标 N 的 `.devflow-project.json`、规划文档、UI 证据和校验文件
- 来源 A 固定提交中的根配置、各 workspace `package.json`、应用入口、测试入口和外部能力装配

必须保护并迁入：

- T-001、T-002、T-027 的历史、状态和 Gate 证据
- MIG-001 及其来源锚定
- `packages/api-contracts/**` 和 `packages/domain/**` 的源码、测试与配置
- Result、CommonError、TrustedClock、Asia/Shanghai 业务时间规则
- 新目标中的 `.devflow-project.json`；旧 UI 参考目录已于 2026-09-08 按用户要求退役，恢复信息仅见清场备份

## 六、回退与写入规则

在修改新目标前：

- 为新目标生成文件清单、哈希和 Active 源码树之外的压缩备份。
- 若新目标没有 Git，允许初始化本地 Git，禁止配置远端；先建立迁移前基线提交。
- 主 Agent 是 `PRODUCT.md`、`PROJECT_LOG.md` 和最终迁移证据的唯一写入负责人。
- 同一文件同一阶段只能有一个写入 Owner。
- 所有大批量迁入必须来自清单，不得使用 `cp -R` 覆盖。

## 七、纳入、隔离与排除

### 正式纳入

- 来源 B 的唯一产品/执行事实源、MIG-001、正式源码、测试和工程配置。
- 来源 A 固定提交中的后端、教师端、管理端、contracts、ops 源码及自动化测试。
- 维持本地安装、构建、测试和启动所需的根配置、锁文件和平台无关脚本。
- 与真实运行合同直接相关且无法由 SHA+路径替代的少量文档。

旧运行包可进入 `packages/backend`、`packages/frontend`、`packages/admin`、`packages/contracts`、`packages/ops`；现有 `packages/api-contracts` 和 `packages/domain` 必须同时保留，形成一个统一的 `packages/*` workspace。

### 临时遗留

- 旧教师前端和旧管理端可作为恢复整体构建与最小可达性的临时遗留基线。
- 每项临时遗留必须记录固定 SHA、源路径、目标路径、状态、替换任务 ID 和退出条件。
- 临时遗留不代表正式视觉、正式合同或产品验收通过。
- 固定提交中既有超过 500 行的遗留文件可以登记为精确基线债务；必须记录路径、行数和哈希。新增文件或修改后的文件不得超过 500 行，修改超长遗留文件前必须拆分。

### 提取后替换或历史引用

- 旧 CI、Docker、Nginx、PM2、Windows RC、云端部署和打包配置默认只按 SHA+路径保留历史引用；确属本地基线必需的少量脚本经审查后单独纳入。
- `reports/**`、旧 handoff、RC 过程材料、`PROGRESS.md`、`RECOVERY.md`、旧任务记录不进入活跃事实源。

### 禁止迁入

- `.env*`、任何密钥、`.data`、数据库、dump、backup、真实聊天记录、媒体、OCR/ASR 原材料、日志和个人信息。
- `node_modules`、`dist`、build、coverage、缓存、RC zip、旧 `.git`、`.DS_Store` 和浏览器 profile。
- 指向旧工作空间的运行时绝对路径或符号链接。
- 主动推送、定时发送、群发、无入站请求关联的微信外发能力。
- 把 OCR/ASR/AI 占位结果或模拟发送展示为真实成功的路径。

## 八、执行波次

### Wave 0｜三方盘点与提示词固化

- 核对两个来源和目标当前状态。
- 固化本提示词、来源 SHA、回退备份、文件所有权和验收矩阵。
- 建立包含来源、目标、分类、哈希和处理方式的迁移 manifest；大型清单采用索引加分片，单文件保持 500 行以内。

### Wave 1｜事实源和 MIG-001 合并

- 把来源 B 的 `PRODUCT.md`、`PROJECT_LOG.md`、MIG-001、`api-contracts` 和 `domain` 合入目标 N。
- 对 11 个同名规划文档逐文件比较；保留 N 的独有成果，吸收 B 的较新历史和事实。
- 记录“迁移方式从逐能力迁移改为整体可运行基线迁入，之后集中完善、测试和 Debug”。
- 本次只改变工程迁移方法，不改变产品范围，不升级产品版本。

### Wave 2｜整体运行工程迁入

- 从来源 A 固定提交提取纳入清单中的运行源码、测试和必要配置。
- 合并根 `package.json`、lockfile、TypeScript 配置、scripts 与 workspace；不得覆盖 MIG-001 成果。
- 一个根 workspace 承载所有包，不保留两个独立根工程。
- 建立临时遗留清单、超长文件基线和外部能力隔离记录。

### Wave 3｜预启动安全 Gate

在任何服务启动前证明：

- 不读取旧 `.env`，不含真实凭据。
- 默认仅绑定 `127.0.0.1`，端口明确且 `strictPort` 可验证。
- 使用临时合成数据目录或内存/临时数据库，不访问真实数据库。
- 微信、通知、push、cron、AI、OCR、ASR、对象存储、告警 webhook 和其他外部网络默认 fail closed。
- 禁止能力没有从应用启动图、路由或后台任务形成可达外发路径。
- 安装脚本先以安全方式检查；未经审查的生命周期脚本不得自动执行外部动作。

### Wave 4｜建立整体基线并集中 Debug

以 Node.js 22、npm 10 为本地基线：

- 生成/校验统一锁文件。
- 在安全前提下执行 `npm ci`。
- typecheck、build、test、lint 和项目 Gate。
- 用合成数据安全启动并检查教师端、后端、管理端最小可达性。
- 生成真实故障台账，分类为安装、类型、构建、测试、启动、合同漂移、数据模型、安全、隐私、Linux 兼容和 Win11 验证缺口。
- 本轮优先修复阻止安装、构建、测试或安全启动的基线问题；其他缺陷保留为真实未完成项。

禁止删除有效测试、降低断言、吞掉失败、把未运行的 Gate 标绿或用 mock 代替真实合同证据。

### Wave 5｜独立审查与整洁 Gate

- Reviewer 从产品契约、安全边界和实际 diff 独立检查，不接受实现者自报。
- 主 Agent修复 P0/P1 问题并重跑受影响 Gate。
- 更新唯一事实源、进度、任务替代关系、失败和剩余风险。

## 九、已知风险的处理合同

### 微信和外发

- 当前只预留未来教师主动交互入口。
- 不连接真实微信，不使用真实 Bot，不允许主动推送、自动外发、定时发送或群发。
- 旧 notifier、push、morning brief、evening review 和 cron 路径必须不迁入正式可达图，或被硬隔离并默认不可达。

### OCR、ASR、AI

- 无供应商和凭据时必须明确 `unavailable` / fail closed。
- 不得随机返回成功、静态伪造识别结果或让派生内容未经教师确认写成正式事实。

### Windows 启动

- 修正或隔离 `scripts/windows-controller.mjs` 的 Vite cwd/root 问题。
- 验证教师端真实 workspace、`strictPort`、`127.0.0.1` 和端口合同。
- 没有真实 Win11 证据时只能记录缺口，不能宣称通过。

### Admin 合同漂移

- 核对 backup 确认参数、restore 字段、createTeacher 返回、teacher status 和 backup status。
- 以后端真实合同和集成测试为准，Admin mock 测试不能单独作为通过证据。

## 十、唯一事实源与任务记录

- `PRODUCT.md` 保持 `DRAFT`，只维护产品需求，不写工程流水账。
- `PROJECT_LOG.md` 保留全部历史任务和记录；被替代任务标记取消并说明替代关系，不复用编号。
- 为整体基线迁入、基线验证、集中 Debug、旧前端替换、云端准备和外部服务建立永久任务 ID。
- 当前有效任务权重合计为 100；只有 Gate 通过的有效任务计入进度。
- 每次实际工作追加每日记录，不重写历史，不制造虚假完成率。
- README、迁移台账、决策、路线和下一步文档必须同步消除与本次策略冲突的过期口径；历史决定保留并标记被替代。

## 十一、必须生成的证据

目标 N 内至少生成：

- `evidence/migration/MIG-002-execution-prompt.md`
- `evidence/migration/MIG-002-bulk-baseline-manifest.json`
- `evidence/migration/MIG-002-bulk-baseline-report.md`
- `evidence/validation/BASELINE-FAILURES.md`
- 需要分片时，增加 `evidence/migration/MIG-002-manifest-parts/**`，主 manifest 只作索引和汇总。

至少记录：来源 commit、两个来源和目标路径、纳入/排除/临时遗留数量、源目标映射、冲突处理、关键哈希、回退点、命令和退出码、失败与未覆盖项、敏感文件排除、旧来源未修改复核、隔离能力、临时遗留退出任务和下一轮优先级。

## 十二、多 Agent 与文件所有权

- explorer：只读盘点、来源清单和风险证据；不写项目。
- architect：事实源、workspace、隔离和迁移契约；不写事实源。
- integration_engineer：工程合并、依赖、配置和基线修复；不得写 `PRODUCT.md`、`PROJECT_LOG.md`。
- QA/测试 Agent：运行测试、启动与收集故障证据；默认不修改实现。
- reviewer/final_reviewer：独立检查产品边界、敏感数据、外发路径、旧来源完整性、工作区整洁和假绿测试。
- 主 Agent：唯一编排者，负责共享文件、事实源、任务状态、证据定稿与最终结论。

只并行依赖稳定、文件不重叠的任务；事实源、根配置、lockfile、入口和 Gate 脚本各自只能有一个 Owner。

## 十三、整洁 Gate

本轮结束至少证明：

- 目标 N 是 Active root 中唯一教师平台长期开发目录。
- 新目标没有依赖旧工作空间的绝对路径、符号链接、配置或运行时文件。
- 新目标可脱离旧工作空间独立安装、构建、测试和安全启动，或把真实失败明确记入台账。
- 版本控制不包含依赖、缓存、构建产物、发布包、临时研究、密钥或真实数据。
- 所有迁入资产有处置分类；所有临时遗留有替换/删除任务与退出条件。
- DevFlow 读取 Active root 和新目标的唯一事实源。
- 两个旧来源保持原 SHA、原状态且未被修改。
- 验证通过前不删除旧副本；后续清理必须另获用户授权。

## 十四、禁止事项

未经用户再次明确授权，不得：

- 修改或删除两个旧来源及旧工作空间其他内容。
- 配置远端、push、创建 PR 或发布仓库。
- 部署公网、购买资源、产生费用。
- 使用真实密钥、账号、用户数据或外部服务。
- 连接微信或对外发送任何消息。
- 删除用户数据或执行不可逆清理。
- 宣称未实际验证的平台、Win11、微信、OCR、ASR、AI、云端或容量已经可用。

## 十五、最终回报

向用户说明：

1. 合并后的提示词保存位置。
2. 实际迁入、排除和临时遗留内容。
3. 安装、构建、测试、启动和整洁 Gate 的真实结果。
4. 已修复的基线阻塞与仍失败的真实原因。
5. 已隔离的危险或不适合正式版能力。
6. 产品进度变化及可追溯依据。
7. 下一轮最优先的五个问题。
8. 证据文件和本地回退点的绝对路径。

请现在执行，不停留在方案描述。
