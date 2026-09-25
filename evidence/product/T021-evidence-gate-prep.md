# T-021 证据准入与不可用语义准备

> 2026-09-08 审计更正：下文只证明“生成草稿”这一路径的历史聚焦测试，不证明所有反馈写入口已完成证据准入。手工 `POST /feedback` 接受的 evidence 目前只做形状校验，未重新核验来源记录；必须统一服务端来源校验并补回归。T-021 仍未通过完整 Gate，详见 `../audit/2026-09-08/DELIVERY.md`。

日期：2026-09-06
范围：家长反馈草稿的证据组装、AI 生成前置条件与教师确认边界；仅使用本地合成数据和注入式 AI 客户端。

## 已具备的供应商无关边界

- 反馈草稿只从当前教师、当前学生的课程、教学记录和成绩记录组装证据；跨教师学生或课程引用返回 NOT_FOUND。
- 未指定课程时使用该学生近期可信记录；没有任何课程或记录时明确返回“没有可用于生成反馈的课程或学生记录”，不调用模型、不生成空泛内容。
- 指定课程会校验所有课程归属当前教师与学生，并将课程证据替换为选定集合；证据按时间排序并按记录 id 去重。
- AI 草稿返回 `source=ai`、证据列表、时间窗口与 rationale，但只作为候选，不自动创建正式 `ParentFeedback`，也不直接发送给家长。
- 正式反馈仍须经过草稿→reviewed→sent 状态流转；内容编辑受乐观锁保护，已发送或归档内容不可编辑。
- 真实 AI provider、模型、密钥、出域数据和费用尚未启用；缺少可用 provider 时沿统一错误信封返回，不伪造模型结果。

## 自动化证据

| 命令 | 结果 |
|---|---|
| `DATABASE_URL='postgresql://xiaosi@127.0.0.1:5432/postgres' npm test --workspace packages/backend -- tests/functional/use-cases/generate-feedback-draft-use-case.test.ts tests/functional/use-cases/assemble-parent-feedback-context.test.ts` | 2 files、33 tests 通过，退出码 0 |
| `npm test` | 根级 `ROOT_TEST_EXIT=0`；backend 282 files / 2604 tests、frontend 51 files / 379 passed / 4 skipped、admin 13 files / 84、ops 124 passed / 2 skipped |

## 当前 Gate 边界

本文件只记录 T-021 的证据准入和不可用准备，不宣告九部分家长材料、真实 AI 输出质量或任何外部发送完成。接入真实模型前仍需确认供应商、密钥托管、费用月度护栏、出域范围、停用路径和教师确认交互。
