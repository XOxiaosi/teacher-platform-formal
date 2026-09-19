# 教师 AI 工作平台

教师端、管理端与后端的本地开发仓库。当前范围、状态和授权只从以下入口读取：

- [AGENTS.md](AGENTS.md)：交互、Agent 调度、测试、提交和交付规范。
- [PRODUCT.md](PRODUCT.md)：产品目标、交互验收与待决定项。
- [PROJECT_LOG.md](PROJECT_LOG.md)：当前任务、授权边界、验证证据和续接点。

## 目录

- `packages/frontend`：教师网页；`packages/admin`：管理网页；`packages/backend`：业务服务。
- `packages/contracts`、`api-contracts`、`domain`：数据与接口契约；`packages/ops`：运维工具。
- `scripts`：本地启动、隔离测试和治理；`evidence`：仍有效的设计、验证和压缩历史。
- [历史归档与恢复清单](evidence/project-history/archive-receipt.json)：旧规划已退出根目录；历史不定义现行范围。

## 本地核验

使用项目锁定 Node 22 / npm 10 环境与 PostgreSQL 17 工具。根测试入口自动创建并清理源码树外合成数据库，不借用本机真实资料。

```sh
npm run check
npm run check:governance
npm run test:governance
```

安全本地后端：`npm run start:local-safe`。教师前端：`npm run dev --workspace @teacher-platform/frontend`。前端已有端口被占用时先核对进程，不重复启动或结束用户服务。

正式网页需登录；`/preview.html` 是独立合成体验，不代表真实业务保存。运行时接入、可用能力和真实验收见项目日志，不在本文件维护另一份状态。

## 查阅压缩历史

```sh
node scripts/read-project-history.mjs --list
node scripts/read-project-history.mjs PROJECT_LOG-through-20260918.md
```

工具只向终端输出原文，恢复到文件时请使用项目外新路径。归档保持原始哈希，压缩不等于删除 Git 历史，也不提供数据库回滚。
