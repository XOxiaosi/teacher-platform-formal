# P3-STUDENT-PROFILE-LEDGER-READBACK-02｜学生档案课时余额权威投影验收

日期：2026-09-21（America/Los_Angeles）

## 验收目标

学生档案中的课时情况必须与独立余额接口读取同一份不可变课时账本投影，固定返回已购、已用、赠送/退款/人工调整净值和剩余课时。服务上下文重建后结果保持一致；未认证或其他教师不能读取；全部档案读取不产生业务写入。

本包只统一读取口径。它不修改数据库 schema、迁移、流水写入、完课计费或 B02 尚未决定的课时数量规则，也不调用真实 DeepSeek、微信、发送或部署路径。

## 修复范围

- `StudentProfileUseCase` 不再自行汇总 Payment 和 attended Lesson，改为调用正式 `LessonLedgerService.calculateBalance`。
- 后端 `StudentProfileView.lessonBalance` 增加必填 `adjustments`，档案与 `/students/:id/balance` 使用相同的四字段结构。
- 最终暂存复核发现，已提交的 composition 与 `/balance` 用例早已引用 `createLessonLedgerService`，但服务文件、账本类型块和公开导出遗漏在未提交基线中。本包一并补齐这三个直接依赖；不纳入 `payment-service`、支付路由、完课或状态更正的写入接线。
- 保留近期课程与教学历史原有查询、教师归属检查，以及尚未关联正式流水的历史 Payment/Lesson 兼容投影。
- 前端当前类型已容忍 `adjustments`，现有消费者只读取 `remaining`，本包不改前端页面或写入流程。

## 验收场景

- 旧数据只有 Payment 与 attended Lesson 时，档案继续返回原余额，并显式返回 `adjustments: 0`。
- 正式账本含 purchase、attendance deduction、gift 等条目时，档案返回与独立余额接口相同的权威净值。
- 通过真实 invitation/session 读取档案；新的 `PrismaClient` 与新的 Express 应用复用持久 session 后结果一致。
- 未认证请求返回 `401`，另一教师读取返回 `404 NOT_FOUND`。
- 首次读取、新服务上下文读取、跨教师读取和重复 GET 前后，相关教师范围业务表计数不变。

## 实际验证

短生命周期 PostgreSQL 17 应用 41 个正式迁移后运行：

- `tests/functional/use-cases/student-profile.test.ts`
- `tests/e2e/p3-student-profile-ledger-readback.test.ts`
- `tests/e2e/api-core-workflow.test.ts`
- `tests/e2e/p3-readonly-ledger-http-workflow.test.ts`

结果：4 个文件、28 个测试全部通过，退出码 0；临时数据库集群已清理。档案 HTTP 返回的 `lessonBalance` 同时与独立 `/balance` 响应作等值断言。

同时通过：

- `npm -w @teacher-platform/backend run build`
- `npm -w @teacher-platform/backend run lint`
- 相关文件 `git diff --check`
- 冻结根 `npm run check`：治理 25、后端 331 文件/2860 测试、前端 56 文件/388 测试、管理端 13 文件/84 测试、ops 152（150 通过、2 个 Windows 专属按平台跳过），类型、lint、41 个迁移及三端生产构建全部通过，退出码 0
- 从 `HEAD + 暂存区` 导出独立快照后，对账本服务、余额用例和学生档案用例执行定向 TypeScript 编译，退出码 0；账本工厂、类型与导出闭包已完整进入暂存区

第一次受限环境执行在分配临时本机端口时由 `SAFETY_BLOCK` 终止，尚未创建数据库或运行测试；随后使用获准的本机隔离权限执行上述成功套件。独立实现复核未发现 P1/P2。第一次最终暂存区复核发现账本服务的直接依赖未进入暂存区，阻止了提交；随后只补入服务、账本类型块和导出，独立依赖复核确认读取路径不启用 B02 写入，未发现 P1/P2。独立快照的完整后端构建仍会遇到当前仓库已接受的其他未提交基线缺口（workspace、scheduling、provider），因此只将与本包直接相关的定向编译记为提交闭包证据，不把无关缺口冒充本包通过。修复后的最终暂存区复核确认依赖闭包、租户隔离、兼容投影、零写入、暂存范围和文档证据一致，未发现 P1/P2，可提交。

## 完成边界

本证据只覆盖合成隔离数据库中的学生档案课时只读投影，不证明真实教师资料、真实模型、微信、设备/Windows、发送或部署通过。教师页面如何呈现完整流水、非法日期参数校验和 P3 写事务属于后续独立工作包；B02 继续阻塞正式计费数量写入。
