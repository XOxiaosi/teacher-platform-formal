# MIG-002 整体基线迁移报告

> 执行日期：2026-09-01
>
> 工程迁入结论：已完成
>
> MIG-002 当次完整验证 Gate：失败（保留下方历史证据）
>
> 后续关闭：同日正式迁移阶段 0 已关闭 T-029/T-030；当前完整验证 Gate 通过，见第 8 节与 `evidence/validation/BASELINE-FAILURES.md`
>
> MIG-002 执行时产品状态：`DRAFT`；2026-09-01 后续已发布纯网页端 `V001`，但仍不得据此宣称产品、生产或上线完成

## 1. 本轮结果

本轮把两个旧来源收敛到唯一目标 `/Users/xiaosi/Developer/active/apps/teacher-platform-formal`。这里的“整体迁移”是指：固定快照一次纳入同一批次、每个受管文件都有处置、无需再逐能力向用户申请技术批准；它不等于整仓复制，也不把 legacy 资产升级为正式产品能力。

目标现在只有一个 Git 根、一个 npm workspace、一个根 `package-lock.json`、一个 `PRODUCT.md` 和一个 `PROJECT_LOG.md`。正式真源为 `packages/api-contracts` 与 `packages/domain`；旧应用只作为 `legacy-only` 编译和验证基线存在，默认不可发布，由 T-033 永久退出。

## 2. 来源、快照与回退点

| 角色 | 路径或标识 | 固定状态 |
|---|---|---|
| 来源 A：旧运行仓库 | `/Users/xiaosi/Desktop/OH-WorkSpace/teacher-platform` | commit `8673884f57c9d23abdb26715913d6199b1b4d16b`；annotated tag `m0-windows-rc.2` peel 到同一提交；工作树干净 |
| 来源 B：旧正式目录 | `/Users/xiaosi/Desktop/OH-WorkSpace/teacher-platform-formal` | 非 Git；排除 `node_modules`，关键真源哈希复核不变 |
| 唯一目标 N | `/Users/xiaosi/Developer/active/apps/teacher-platform-formal` | 迁移前本地 commit `5d73dd8fc6757aa637084ab88380b6c7003f1cea`；无 remote |
| 外部备份 | `/Users/xiaosi/Developer/migration-backups/teacher-platform-formal/pre-mig-2026-09-01.tar.gz` | SHA-256 `e35c17395a93f788e045e67e96982e3f77b83914e6dca9271f5e8cbda59aac56` |

来源 B 三个关键文件的复核 SHA-256：

- `PRODUCT.md`：`df8c201df48b5203fdc0352d26ea89fb152d264d57e3fb8ccf5a5e24a9fa12b9`
- `PROJECT_LOG.md`：`eb7090b157643029ad2751e35aa6913e918479764861244a63ea0310ed045382`
- `evidence/migration/MIG-001-trusted-time.md`：`a7d4beccdab40549018a42af1d4d077f3d8ad877e684730ffd4066dccb9a1a05`

未修改或删除两个旧来源；未 push、未部署、未读取真实业务数据，也未连接已有的本机 5432/55432 数据库。

## 3. 完整清单与处置数量

主索引为 `evidence/migration/MIG-002-bulk-baseline-manifest.json`，明细拆为 5 个带 SHA-256 的 JSONL 分片。

| 来源 | 总数 | M1 适配迁入 | T 临时兼容 | H 历史保留 | X 排除 | KEEP |
|---|---:|---:|---:|---:|---:|---:|
| A 固定 Git 快照 | 1161 | 21 | 873 | 267 | 0 | 0 |
| B 旧正式目录 | 79 | 37 | 0 | 14 | 28 | 0 |
| N 迁移前基线 | 17 | 0 | 0 | 0 | 0 | 17 |

复核结果：来源 A `1161/1161` 路径唯一覆盖；5 个分片条数和 SHA-256 全部匹配主索引；962 个声明目标路径全部存在；873 个 T 项全部绑定 `T-033`，且当前内容与固定源一致；本阶段修改的 backend runner、数据库边界、feedback-summary 测试、微信进程 smoke 和 ops runtime 合同 5 项已重分类为 M1；没有 missing、重复处置或未登记的 T 内容漂移。

## 4. 冲突与安全处理

- 保留根 `PRODUCT.md` 和 `PROJECT_LOG.md` 为唯一事实源；旧 `packages/frontend/PRODUCT.md` 只在固定提交中保留历史，不进入目标。
- 排除旧 `.env`、`.env.example`、`.data`、`node_modules`、`dist`、部署包、CI 和旧 Windows RC 材料；没有从旧工作树复制生成物或凭据。
- 本地安全入口只向子进程传允许列表，强制 loopback、`LOCAL_SAFE_MODE=true`、不可连接数据库和外部能力关闭；不会加载诱饵 `.env`，不会装配真实 AI provider、教师 provider resolver、管理路由、微信推送、S3 或 webhook。
- 后端安全冒烟使用同一环境构造器，不继承宿主数据库、供应商或密钥变量。
- 教师端和管理端 Vite 均启用 `strictPort`，端口占用时明确失败，不静默切换端口。
- 文件长度检查对新增或修改文件执行 500 行上限；另有 27 个按路径、行数和 SHA-256 精确绑定的未改 legacy 例外，统一由 T-033 清零。此结果不等于严格 500 行 Gate 已通过。
- 正式 `api-contracts/domain` 不反向依赖 legacy 包；普通根命令不再暴露会读取 `.env`、迁移数据库或继承环境密钥的旧启动器。

## 5. 最终验证证据

| 验证 | 结果 | 证据摘要 |
|---|---|---|
| `npm ci` | PASS / 0 | 安装前后 lock SHA-256 均为 `66025d5240b8bde503ea88a370041fa503ee418ee743db5c2668040f7d214067` |
| `npm run check:file-size` | PASS / 0 | 新增/修改文件通过；27 个精确 legacy 例外如实输出 |
| `npm run typecheck` | PASS / 0 | 六个 workspace 的类型路径通过 |
| `npm run build` | PASS / 0 | 正式包、后端、教师端、管理端均构建通过 |
| `npm run lint` | PASS / 0 | 后端、教师端和管理端通过 |
| `npm run test:local-safe` | PASS / 0 | 2/2；含安全入口环境与安全 smoke 环境回归 |
| `npm run smoke:backend` | PASS / 0 | `BUILT_BACKEND_SMOKE_PASS` |
| 正式 api-contracts 测试 | PASS / 0 | 5/5 |
| 正式 domain 测试 | PASS / 0 | 2/2；可信业务时间语义保留 |
| legacy 教师端测试 | PASS / 0 | 45 文件、361 用例全部通过 |
| legacy 管理端测试 | PASS / 0 | 13 文件、89 用例全部通过 |
| 本地安全后端可达 | PASS | `/api/v1/health` 为 200；`/api/v1/health/ready` 为 503，符合故意不可连接数据库的降级预期；进程随后关闭 |
| 教师端与管理端最小可达 | PASS | 教师端根路径 200；管理端 `/admin` 200；进程随后关闭 |
| `npm test`（无数据库环境） | FAIL / 1 | 后端明确返回 `SAFETY_BLOCK: DATABASE_URL 未配置`，没有偷连本机数据库 |
| backend 全量测试（独立 PostgreSQL 17 临时集群） | FAIL / 1 | 275 文件中 274 通过；2584 用例中 2583 通过；1 次 `feedback-summary` 未登录请求出现 `socket hang up` |
| 失败项定向重复复验 | PASS / 0 | 同一文件连续 5 次、共 30 个用例全部通过；仍不据此覆盖全量失败 |
| ops 测试（无数据库环境） | FAIL / 1 | 78 项中 69 通过、8 失败、1 跳过；5 项为数据库安全阻断，3 项依赖本轮明确 H 处置的部署/CI/旧 Gate 材料 |

完整故障与未覆盖项见 `evidence/validation/BASELINE-FAILURES.md`。

## 6. 整洁复核

- 目标中 `PRODUCT.md`、`PROJECT_LOG.md`、`package-lock.json` 各一份；Git 根和 npm 根各一个。
- 无项目内非 `node_modules` 符号链接；生成的空 `.data`、测试互斥锁和临时数据库文件已清理。
- Git 未跟踪 `.env`、`.data`、`node_modules`、`dist` 或 coverage。
- 运行代码和脚本不依赖两个旧工作空间的绝对路径。
- 目标 Git 无 remote；两个旧来源完整性复核不变。

## 7. MIG-002 当次 Gate 与下一步（历史快照）

- T-012、T-028：通过。整个固定快照已有唯一处置，统一工程已经迁入 Active root。
- T-029：失败。根完整测试尚不能在无外部准备的干净环境内通过。
- T-030：进行中且 Gate 失败。已关闭本地安全入口、凭据读取、provider 旁路、端口漂移、manifest 漂移等 P1，但完整测试自包含性和一次连接级偶发失败尚未关闭。
- T-033：未开始。当次历史快照共有 878 个 legacy-only 文件和 27 个超长文件精确例外；其中 5 个文件后来在阶段 0 安全适配并重分类为 M1，剩余原样 T 仍须随正式模块替换退出。

因此本轮可以声明“整体工程迁入已执行完成”，不能声明“完整测试通过”“产品完成”“生产就绪”或“可以上线”。

## 8. 后续阶段 0 关闭记录

MIG-002 当次报告中的失败保持为历史快照，没有用定向测试覆盖失败。随后按 T-030 修复并重新执行同范围根 Gate：

- 根 `npm test` 新增源码树外 PostgreSQL 17 harness，自动初始化、迁移、执行和回收；拒绝已有 5432/55432，不读取旧 `.env` 或 ambient 凭据；最终同范围静默复跑明确打印 `ROOT_TEST_EXIT=0`；一次性 sentinel 阻断内部套件直跑，9/9 infrastructure 回归和真实 SIGTERM 检查证明子进程、PG、端口与目录均可清理。
- backend runner 删除 `.env` 数据库回退；`feedback-summary` 删除无关 pool 装配，定向连续 10 次共 60 个断言通过；微信进程 smoke 的外层预算与两段内部有界等待对齐；随后完整 backend 275/275 文件、2585/2585 用例通过。
- ops 把旧 deploy/CI/gate 存在性断言迁为 Active workspace 合同，旧 H 资产没有恢复；完整结果为 124 通过、2 项平台条件跳过、0 失败。
- 教师端 45/45 文件、361/361 用例，管理端 13/13 文件、89/89 用例通过；api-contracts、domain、local-safe 同时通过。
- `npm ci` 前后 lock SHA-256 均为 `66025d5240b8bde503ea88a370041fa503ee418ee743db5c2668040f7d214067`；typecheck、lint、build、file-size 与 built backend smoke 均退出 0；临时端口和目录已清理。

因此 T-029/T-030 当前为通过，但结论仍不扩张为“产品完成”“严格 500 行通过”“生产就绪”或“可以上线”。MIG-002 执行时 `PRODUCT.md` 仍为 DRAFT，现已发布纯网页端 V001；873 个原样 legacy-only 项、5 个 M1 安全适配 legacy 项、27 个精确超长例外、Windows 11 子进程树、local-safe 非生产身份 fallback 的错误信息卫生、外部服务、云端、容量和供应链 audit 告警仍由后续 Gate 处理。
