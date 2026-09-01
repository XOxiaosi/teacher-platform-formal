# MIG-002 基线失败与未覆盖项

> 日期：2026-09-01  
> 当前结论：完整验证 Gate 失败  
> 规则：本文件同时保留失败、局部复验和未运行项；局部通过不得覆盖全量失败。

## 1. 未关闭失败

### BF-001｜根完整测试不自带安全测试数据库

- 命令：在清空业务环境变量的环境中执行 `npm test`
- 退出码：1
- 直接证据：backend runner 返回 `SAFETY_BLOCK: DATABASE_URL 未配置`
- 判断：安全阻断本身正确，证明它没有偷读旧 `.env` 或连接本机已有数据库；但根测试不能在干净环境中一条命令完成，T-029 仍失败。
- 下一步：为正式 Gate 提供明确的 PostgreSQL 17 测试服务或受控临时集群 harness；不得把真实开发库地址写入默认配置。
- 归属：T-029 / T-030

### BF-002｜backend 全量长跑存在一次连接级偶发失败

- 环境：源码树外新建 PostgreSQL 17 临时集群与合成 `teacher_platform` 基库；端口 55439；运行完成后停止并删除。
- 退出码：1
- 结果：275 个测试文件中 274 通过、1 失败；2584 个用例中 2583 通过、1 失败。
- 失败：`tests/functional/admin/feedback-summary.test.ts` 的“未登录 → 401”收到 `socket hang up`。
- 反证：同一文件随后在重新创建的隔离测试库中连续运行 5 次，5 次均退出 0，共 30 个用例全部通过。
- 判断：尚不能稳定复现业务错误，更像长跑中的连接或测试服务生命周期抖动；由于全量命令退出 1，仍保留为未关闭失败，不用定向重跑覆盖。
- 下一步：在自包含 Gate 中重复完整串行回归并保留服务端错误上下文；若再次出现，修复测试服务生命周期或路由异常处理并增加回归。
- 归属：T-030

### BF-003｜ops runner 有 8 项失败

- 命令：清空业务环境变量后执行 `npm -w @teacher-platform/ops run test`
- 退出码：1
- 结果：78 项中 69 通过、8 失败、1 跳过。
- 其中 5 项：备份、恢复、数据库工具、停用教师、导出教师数据在无 `DATABASE_URL` 时被 `SAFETY_BLOCK` 拒绝。
- 其中 3 项：旧 runtime-baseline 测试仍断言 `deploy/runtime-baseline.json`、`.github/workflows/ci.yml` 和 `scripts/gate.mjs` 存在；这些材料已按 MIG-002 明确处置为 H，没有复制进 Active root。
- 判断：前 5 项需要受控临时数据库；后 3 项是旧部署合同与新迁移边界的真实冲突，不能通过复制旧部署材料掩盖。
- 下一步：T-030 决定哪些验证语义迁为新的 Active workspace Gate；纯旧 RC/部署断言留在固定提交历史，由 T-033 清理 legacy runner。

## 2. 已修复的基线阻塞

| 问题 | 修复与回归证据 |
|---|---|
| local-safe 仍可能读取 `.env` 并装配 Ark/provider resolver | local-safe 在构造阶段直接使用 fail-closed provider，不构造 resolver；诱饵 `.env`、resolver 计数和 blocked fetch 测试通过 |
| local-safe 可能挂载 admin/provider-config/usage 路由 | 安全模式不构造相关服务且不挂载路由；安全组合测试通过 |
| smoke 脚本继承 ambient 密钥和 `LOCAL_SAFE_MODE=false` | smoke 复用允许列表环境构造器；回归测试已纳入 `test:local-safe`，2/2 通过 |
| 教师端和管理端端口占用时可能自动换端口 | 两端 `strictPort: true`，配置测试通过 |
| manifest 声明目标存在但实际缺失或 T 内容已改 | 重分类后重新生成；962 个目标路径 0 missing，878 个 T 0 mismatch，5 个分片哈希匹配 |
| 包内 `PRODUCT.md` 形成第二事实源 | 从目标移除并记 H；最终只保留根 `PRODUCT.md` |
| 文件长度 Gate 以目录级豁免掩盖遗留 | 改为 27 个路径、行数、SHA-256 精确例外，新增/修改文件仍受 500 行限制 |

独立工程 Reviewer 在上述修复后未发现仍开放的代码/安全 P0 或 P1；这不改变 BF-001 至 BF-003 的 Gate 失败状态。

## 3. 明确未运行或未通过的 Gate

- 未连接本机已有 5432 或 55432 数据库，也未使用旧 `.data` 或真实用户数据。
- 未在 Windows 11 Edge/Chrome 执行真实浏览器流程；仅保留 legacy Windows controller 的局部测试证据。
- 未验证真实 OCR、ASR、AI、微信、S3、webhook 或任何付费供应商。
- 未执行云端、容器提升、备份恢复演练、跨租户攻击矩阵、150 人容量或成本验证。
- 未通过严格 500 行 Gate：当前有 27 个未改 legacy 精确例外。
- 未退出 legacy-only：当前有 878 个 T 项，统一绑定 T-033。
- 产品仍为 `DRAFT`；旧前端可构建和测试不代表正式 UI、产品闭环或生产可用。

## 4. 关闭条件

只有以下条件同时满足，T-029/T-030 才能改为通过：

1. 干净环境的一条根 Gate 命令能自动获得受控、源码树外、可回收的 PostgreSQL 17 测试实例。
2. backend 完整串行回归退出 0，且不能依赖重跑掩盖偶发失败。
3. ops 中有效的数据库与 Active workspace 合同测试退出 0；旧部署专属断言完成迁移或历史化处置。
4. 安装前后 lockfile 哈希不变，构建、类型、lint、本地安全测试和整洁检查继续退出 0。
5. 失败日志和临时数据库均不含真实密钥、真实数据，运行后无进程、端口和测试文件残留。
