# T-014 账号与隔离能力实施证据

## 结论

T-014 已按 V003 产品合同实现并通过本地合成数据 Gate：首批教师只能通过一次性邀请进入，自行设定密码；管理员不能代设密码或冒充教师；停用账号会在同一事务中清除会话；两名合成教师的跨空间读取、写入和对象引用均被拒绝。

本结论是开发阶段的逻辑租户隔离验收，不等于生产云环境、每教师物理独立数据库、Windows 11 或上线就绪。

## 产品结果

- 公开注册关闭：`POST /auth/register` 硬返回 404，无测试或环境开关后门。
- 邀请制：管理员可创建、查看、撤销邀请；原始 token 只在创建响应出现一次，数据库只保存 `tokenHash`。
- 教师自主密码：教师从 URL fragment 取得邀请 token，页面立即清除地址中的 token，由教师本人设定密码和显示名。
- 一次消费：接受邀请在数据库事务内用状态条件原子消费；过期、撤销、已使用 token 不能重放。
- 停用生效：教师状态改为 `disabled` 时同步删除全部会话，之后的登录和旧会话校验均被拒绝。
- 管理员最小权限：默认只开放邀请、教师列表、停用/恢复、用量与健康摘要；教师业务详情、反馈内容、备份与恢复等旧高敏路由默认 404 门禁关闭，只有旧专项测试显式启用。

## 隔离与安全证据

- 新增攻击矩阵 `packages/backend/tests/e2e/t014-tenant-isolation-attack-matrix.test.ts`，在 `NODE_ENV=production` 下使用两个邀请创建的合成教师与真实 session cookie。
- 教师 B 读取教师 A 的学生：404。
- 教师 B 修改教师 A 的学生资料：404。
- 教师 B 在新日程中引用教师 A 的学生：404。
- 教师 B 取消教师 A 的日程：404。
- 伪造 `x-teacher-id` 不能覆盖 session 归属；生产模式仅提供 header 无 session 时返回 401。
- 教师导出仅允许导出当前 owner 的已有边界由 `packages/backend/tests/functional/privacy/privacy-api.test.ts` 继续锁定。
- 本轮审计曾发现管理员登录的已知 dummy 密码绕过风险；已在开放 T-014 管理面前修复为“邮箱必须匹配且密码必须通过”，并加入字面量 dummy 密码回归测试。

## 数据与迁移

- `TeacherInvitation` 模型与 `20260913000000_add_t014_teacher_invitation` 迁移已加入唯一 Prisma schema 链。
- 空库基线现为 33 张 public 表、28 次已完成迁移；ops 冒烟和空库迁移完整性检查已同步。
- 当前是统一合成测试库内的 `teacherId` / TeacherScope 逻辑隔离。代码中现有 database router 是防御补强，本任务没有实施或证明每教师物理建库和云上库生命周期。

## Gate 记录

- 干净环境根 `npm test`：退出码 0。
- infrastructure 9/9；local-safe 2/2；api-contracts 5/5；domain 2/2。
- backend 277/277 文件、2580/2580 用例。
- frontend 47/47 文件、361/361 用例。
- admin 13/13 文件、84/84 用例。
- ops 124 通过、0 失败、2 个 Windows 条件用例跳过。
- `npm run typecheck`、`npm run lint`、`npm run build` 均退出 0。
- `npm run check:file-size` 退出 0；管理路由已拆分，Prisma schema 作为精确哈希锁定的遗留结构文件例外继续绑定 T-033。
- 根测试的临时 PostgreSQL 17 使用随机非保留端口，结束后 fast shutdown；`/tmp` 无 `teacher-platform-pg17-*` 残留。未连接或操作旧工作区保留的 55432 验证库。
- 独立只读 Reviewer 复核账号、权限、攻击矩阵、账本、manifest、文件例外和最终根 Gate，结论为 P0=0、P1=0、无需修改的 P2，可提交。

## 未授权与剩余边界

- 没有使用真实教师账号、真实资料、旧 `.env`、外部密钥或付费服务。
- 没有部署、push、公开试用、上线或删除旧来源。
- Windows 11 真实流程、云上账号生命周期、备份恢复与生产监控分别属于后续 T-022 和发布 Gate。
