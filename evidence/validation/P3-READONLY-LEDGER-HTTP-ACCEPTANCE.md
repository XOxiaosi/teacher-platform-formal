# P3-READONLY-LEDGER-HTTP-01｜只读课时余额与流水认证验收

日期：2026-09-21（America/Los_Angeles）

## 验收目标

证明教师可以通过正式认证 HTTP 接口读取学生课时余额和不可变流水；服务上下文重建后仍能用持久会话得到相同结果；其他教师无法读到该学生的余额或流水；全部读取不产生业务写入。

本包只处理读取。测试数据由 Prisma 直接写入隔离合成数据库，业务请求全部使用 `GET`，没有调用缴费、完课、调整确认、真实 DeepSeek、微信、发送或部署路径，也没有冻结 B02 尚未决定的计费数量规则。

## 本次修复

独立契约复核发现，底层账本已经计算赠课、退款与人工调整净值，但余额 HTTP 投影只返回已购、已用和剩余。存在 `gift +2` 时会出现“已购 8、已用 1、剩余 9”却无法解释多出的 2 课时，未满足 PRODUCT F11 的只读展示要求。

余额投影现固定返回：

```json
{
  "purchased": 8,
  "attended": 1,
  "adjustments": 2,
  "remaining": 9
}
```

`adjustments` 为必填净值；没有赠送、退款或人工调整时返回 `0`，保持单一稳定响应结构。没有修改数据库 schema、迁移、流水写入或计费规则。

## 认证与隔离证据

- 未认证读取余额返回 `401`。
- 教师 A 读取自己的合成学生：余额返回已购 8、已用 1、调整 +2、剩余 9；流水返回 purchase、attendance_deduction、gift 三条正式条目。
- 新建 `PrismaClient` 和新 Express 应用后复用数据库持久 session，余额与流水响应和原服务上下文完全一致。
- 教师 B 查询教师 A 的余额返回 `404 NOT_FOUND`。
- 流水是教师范围的集合查询；教师 B 带教师 A 的学生 ID 查询时返回 `200 { ok: true, data: [] }`，既不泄露条目，也不暴露该学生是否存在。
- 在首次读取、新服务上下文读取、跨教师读取和三轮并发重复读取前后，Student、Lesson、Payment、LessonLedgerEntry、LessonLedgerAdjustmentConfirmation、ScheduleCompletionSnapshot、ChangeLog 的教师范围计数完全不变。

## 实际验证

短生命周期 PostgreSQL 17 在 41 个正式迁移后运行以下四个文件：

- `tests/e2e/p3-readonly-ledger-http-workflow.test.ts`
- `tests/functional/use-cases/balance-calc.test.ts`
- `tests/e2e/api-core-workflow.test.ts`
- `tests/e2e/core-teacher-workflow.test.ts`

结果：4 个文件、28 个测试全部通过，退出码 0；临时数据库集群已清理。

同时通过：

- `npm -w @teacher-platform/backend run build`
- `npm -w @teacher-platform/backend run lint`
- 相关文件 `git diff --check`

冻结根 `npm run check` 退出码 0：治理测试 25 项、后端 330 个文件/2858 项、前端 56 个文件/388 项、管理端 13 个文件/84 项全部通过；运维 152 项中 150 项通过、2 项 Windows 专属测试按当前平台条件跳过；类型检查、lint、41 个正式迁移和全部生产构建通过。独立契约及最终暂存区复核均未发现 P1/P2 阻塞。

## 完成边界

本证据只证明当前工作树中合成认证 HTTP 的只读闭环。它不证明真实教师数据、真实模型、微信、设备/Windows、发送或部署通过。普通完课如何按时长换算计费课时、是否允许修改数量及步长仍由 B02 阻塞，本包没有新增或确认相应写入行为。

流水日期参数的非法输入校验、教师页面浏览器验收和 P3 写事务属于后续独立工作包，不由本次 HTTP 读取验收替代。
