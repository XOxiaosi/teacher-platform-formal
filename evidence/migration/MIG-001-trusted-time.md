# MIG-001：可信业务时间首批迁移证据

## 迁移边界

- 固定旧项目来源：`teacher-platform@8673884f57c9d23abdb26715913d6199b1b4d16b`。
- 本批只迁移通用 `Result`、`CommonError` 和可信时钟领域契约，以及 `Asia/Shanghai` 教师业务时间格式化规则。
- 旧项目仅作为只读来源；本批没有修改旧项目。

## 来源与校验

| 旧项目文件 | SHA-256 | 处理 |
| --- | --- | --- |
| `packages/contracts/src/types.ts` | `3b2cbb0df0125d55c95a7da258aba32b2ee8d344f35d5e9bae481d8c9f68267d` | 迁移最小通用结果与错误语义 |
| `packages/backend/src/shared/trusted-clock/types.ts` | `51253672fa8e09514cadcaa2eb4172b5a1ae8e06e95c54f1e1d6cd45d0a8c05f` | 迁移 `TrustedClock` 接口 |
| `packages/backend/src/shared/trusted-clock/teacher-time-context.ts` | `6d6c63e1094db3522681c796d1806022cda17a819f1555e5d6c695e5aeccae7b` | 迁移教师业务时间格式化 |
| `packages/backend/tests/functional/trusted-clock/teacher-time-context.test.ts` | `b4e13238d685d6e8c8a0eb5229a6090f6175fe66cafc41e339cb0af35760ae6e` | 迁移固定 instant 的旧断言 |
| `packages/backend/tests/functional/edit-command-foundation.test.ts` | `e3ee17c39f6b48040a8f5ba19257e6d90579d4f45227978f2455eeda05121502` | 迁移 `versionConflict()` 固定错误契约断言 |

## 原样保留与必要适配

- 原样保留：`Result` 的 `ok` 判别语义、全部既有通用错误代码及固定字段、可信时间输出文本、上海业务时区、相对日期解释规则。
- 必要适配：原 `contracts` 中的 API 响应、分页和排序类型没有进入本批；它们与可信时间无关，待出现真实消费方时再迁移。
- 必要适配：`TeacherTimeContextInput` 和业务时区类型改为显式导出，便于后续服务层复用。
- 必要适配：测试使用 Node 22 内置测试器，避免为这批纯领域逻辑增加测试框架依赖。

## 明确未迁移

旧项目 `database-trusted-clock.ts` 及其测试留作后续数据库基础设施候选。本批不迁移 Prisma client、SQL 查询或任何数据库 adapter；正式云数据库确定后，再通过 `TrustedClock` 接口接入可信服务器时间，并保留“失败时不回退设备时间”的旧断言。

本批也没有迁入微信代码、旧前端页面、环境变量、日志、真实业务数据或密钥。

## 用户可感知规则

平台中的“今天、明天、下周”等相对日期必须以可信 instant 转换后的 `Asia/Shanghai` 教师业务日期为准，不能依赖教师电脑、浏览器或云服务器设备时区。

## 验收记录

### `npm install`

- 结果：通过（退出码 `0`）。
- 安装：新增 `3` 个包，审计 `6` 个包。
- 漏洞：`0`。
- 完整依赖树：两个本地 workspace 和 `typescript@6.0.3`；没有其他第三方运行时依赖。

### `npm run check`

- 结果：通过（退出码 `0`）。
- 文件大小：检查 `33` 个文本文件，全部不超过 `500` 行。
- 类型检查：`api-contracts`、`domain` 全部通过。
- 测试：`api-contracts` `5/5` 通过；`domain` `2/2` 通过；总计 `7/7`。
- 构建：两个 workspace 的 ESM JavaScript 和声明文件均生成成功。

### 范围审计

- 新工程源码及依赖中没有 Weixin、WeChat、微信或 Prisma 实现及依赖。
- `packages/` 中没有 `.tsx`、`.css` 或 `.html` 旧前端页面产物。
- 根配置、脚本、源码和测试未发现私钥、API key、client secret、密码或 Bearer Token 形态内容。
- 旧项目 HEAD 仍为 `8673884f57c9d23abdb26715913d6199b1b4d16b`，工作树保持干净。

### 主 Agent 独立复验

- 再次执行 `npm run check`：退出码 `0`，7/7 测试、类型检查、构建和 500 行检查全部通过。
- 分别在 `TZ=America/Los_Angeles` 与 `TZ=Asia/Tokyo` 下执行领域测试：两组均为 2/2 通过，证明教师业务日期不随运行设备时区改变。
- 再次检查旧项目：HEAD 仍为固定来源提交，工作树无修改，`git diff --check` 通过。
- 再次扫描新 `packages/`：没有微信、Prisma、旧 TSX/CSS/HTML 或常见密钥赋值形态。
