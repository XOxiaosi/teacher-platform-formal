# MIG-002 基线失败与未覆盖项

> 日期：2026-09-01
>
> 当前结论：BF-001 至 BF-003 已关闭，T-029/T-030 完整验证 Gate 通过
>
> 规则：本文件保留原始失败、关闭证据和未运行项；只有后续同范围完整 Gate 通过才能关闭原失败。

## 1. 已关闭失败与证据

### BF-001｜根完整测试不自带安全测试数据库

- 状态：已关闭（2026-09-01）

- 命令：在清空业务环境变量的环境中执行 `npm test`
- 退出码：1
- 直接证据：backend runner 返回 `SAFETY_BLOCK: DATABASE_URL 未配置`
- 原判断：安全阻断本身正确，证明它没有偷读旧 `.env` 或连接本机已有数据库；但当时根测试不能在干净环境中一条命令完成，T-029 失败。
- 关闭证据：根 `npm test` 现在自动创建源码树外 PostgreSQL 17 临时集群，随机 loopback 端口明确拒绝 5432/55432，迁移 `teacher_platform` 后执行全部套件；最终同范围静默复跑明确打印 `ROOT_TEST_EXIT=0`；内部套件缺少一次性 sentinel 时会在任何测试前阻断；9/9 infrastructure 回归与真实 `--signal-check` 证明 SIGTERM 会终止子进程组、停止 PG 并清理，实际完整运行后进程、端口与临时目录均已清理。
- 安全证据：child 环境使用允许列表，HOME 与 `.npmrc` 指向本次临时目录，不继承 ambient `DATABASE_URL`、`NODE_OPTIONS`、AI、微信、S3、webhook 或平台密钥；backend runner 同时删除旧 `.env` 回退。
- 归属：T-029 / T-030

### BF-002｜backend 全量长跑存在一次连接级偶发失败

- 状态：已关闭（2026-09-01）

- 环境：源码树外新建 PostgreSQL 17 临时集群与合成 `teacher_platform` 基库；端口 55439；运行完成后停止并删除。
- 退出码：1
- 结果：275 个测试文件中 274 通过、1 失败；2584 个用例中 2583 通过、1 失败。
- 失败：`tests/functional/admin/feedback-summary.test.ts` 的“未登录 → 401”收到 `socket hang up`。
- 反证：同一文件随后在重新创建的隔离测试库中连续运行 5 次，5 次均退出 0，共 30 个用例全部通过。
- 原判断：当时尚不能稳定复现业务错误，更像长跑中的连接或测试服务生命周期抖动；由于全量命令退出 1，仍保留为未关闭失败，不用定向重跑覆盖。
- 修复：`feedback-summary` 测试不再读取旧 `.env` 或装配该路由不会使用的真实数据库 pool，保持全部业务断言不变，没有 retry、skip 或吞错。
- 关闭证据：新的临时 PG 中定向连续运行 10 次，10/10 文件、60/60 用例通过；随后根完整 Gate 的 backend 长跑 275/275 文件、2585/2585 用例通过。完整通过而非定向重跑是本项关闭依据。
- 归属：T-030

### BF-003｜ops runner 有 8 项失败

- 状态：已关闭（2026-09-01）

- 命令：清空业务环境变量后执行 `npm -w @teacher-platform/ops run test`
- 退出码：1
- 结果：78 项中 69 通过、8 失败、1 跳过。
- 其中 5 项：备份、恢复、数据库工具、停用教师、导出教师数据在无 `DATABASE_URL` 时被 `SAFETY_BLOCK` 拒绝。
- 其中 3 项：旧 runtime-baseline 测试仍断言 `deploy/runtime-baseline.json`、`.github/workflows/ci.yml` 和 `scripts/gate.mjs` 存在；这些材料已按 MIG-002 明确处置为 H，没有复制进 Active root。
- 原判断：前 5 项需要受控临时数据库；后 3 项是旧部署合同与新迁移边界的真实冲突，不能通过复制旧部署材料掩盖。
- 修复：保留 Node/npm/lock 与数据库、备份、恢复、导出、安全等有效验证；把只针对旧 deploy、CI、`scripts/gate.mjs` 的存在性断言迁为 Active workspace 合同，并明确这些 H 资产不得恢复到新根。
- 关闭证据：在根 harness 的同一合成数据库中，ops 126 项共 124 通过、2 项因 PowerShell/平台条件跳过、0 失败。

## 2. 已修复的基线阻塞

| 问题 | 修复与回归证据 |
|---|---|
| local-safe 仍可能读取 `.env` 并装配 Ark/provider resolver | local-safe 在构造阶段直接使用 fail-closed provider，不构造 resolver；诱饵 `.env`、resolver 计数和 blocked fetch 测试通过 |
| local-safe 可能挂载 admin/provider-config/usage 路由 | 安全模式不构造相关服务且不挂载路由；安全组合测试通过 |
| smoke 脚本继承 ambient 密钥和 `LOCAL_SAFE_MODE=false` | smoke 复用允许列表环境构造器；回归测试已纳入 `test:local-safe`，2/2 通过 |
| 教师端和管理端端口占用时可能自动换端口 | 两端 `strictPort: true`，配置测试通过 |
| manifest 声明目标存在但实际缺失或 T 内容已改 | 重分类后重新生成；阶段 0 再把 5 个已安全适配 legacy 文件从 T 改为 M1；962 个目标路径 0 missing，873 个 T 0 mismatch，5 个分片哈希匹配 |
| 包内 `PRODUCT.md` 形成第二事实源 | 从目标移除并记 H；最终只保留根 `PRODUCT.md` |
| 文件长度 Gate 以目录级豁免掩盖遗留 | 改为 27 个路径、行数、SHA-256 精确例外，新增/修改文件仍受 500 行限制 |

独立工程 Reviewer 的本轮结论记录在最终交付复核中；BF-001 至 BF-003 的关闭不改变下列未运行项与产品风险。

## 3. 明确未运行或未通过的 Gate

- 未连接本机已有 5432 或 55432 数据库，也未使用旧 `.data` 或真实用户数据。
- 未在 Windows 11 Edge/Chrome 执行真实浏览器流程；仅保留 legacy Windows controller 的局部测试证据。
- 未验证真实 OCR、ASR、AI、微信、S3、webhook 或任何付费供应商。
- 未执行云端、容器提升、备份恢复演练、跨租户攻击矩阵、150 人容量或成本验证。
- 未通过严格 500 行 Gate：当前有 27 个未改 legacy 精确例外。
- 未退出 legacy-only：当前有 873 个原样 T 项，统一绑定 T-033；本阶段修改的 5 个 legacy 文件已如实记为 M1。
- local-safe 仍只是非业务安全入口：宿主、数据库和外部能力均被隔离，但携带非生产 `x-teacher-id` fallback 访问核心路由时，兼容层可能返回含底层 Prisma 本机路径的 500；后续正式替换需拒绝该 fallback 或统一成无底层信息的 503/500。
- Windows 子进程树信号转发尚未在 Windows 11 runner 实测；POSIX 进程组终止与清理已通过真实信号检查。
- 产品仍为 `DRAFT`；旧前端可构建和测试不代表正式 UI、产品闭环或生产可用。
- `npm audit --omit=dev` 仍报告 Prisma CLI / `@prisma/config` / `deepmerge-ts` 依赖链 3 项 high；`npm audit fix --force` 会强制降级 Prisma，本轮没有用破坏性版本变化制造审计绿灯。

## 4. 关闭条件

T-029/T-030 已按以下条件通过：

1. 干净环境的一条根 Gate 命令能自动获得受控、源码树外、可回收的 PostgreSQL 17 测试实例。
2. backend 完整串行回归退出 0，且不能依赖重跑掩盖偶发失败。
3. ops 中有效的数据库与 Active workspace 合同测试退出 0；旧部署专属断言完成迁移或历史化处置。
4. 安装前后 lockfile 哈希不变，构建、类型、lint、本地安全测试和整洁检查继续退出 0。
5. 失败日志和临时数据库均不含真实密钥、真实数据，运行后无进程、端口和测试文件残留。

这项通过仅覆盖迁移后的本地工程基线。严格 500 行、legacy 退出、Windows 11、外部供应商、云端、容量、真实数据与生产发布仍由后续 Gate 单独验收。
