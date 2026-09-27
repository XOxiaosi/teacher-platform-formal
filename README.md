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

### 黑苹果 Docker 部署

生产容器配置位于 `compose.yaml` 与 `deploy/`。部署前在源码根目录准备权限受限的 `.env`，至少包含 `WEB_PORT`、`POSTGRES_PASSWORD`、`ACTION_TOKEN_SECRET`、`ENCRYPTION_KEY`、`MEDIA_ENCRYPTION_KEY`、`PROVIDER_KEY_ENCRYPTION_KEY`、`ADMIN_EMAIL` 和 `ADMIN_PASSWORD_HASH`；绝不复制本地 `.env`、`.data`、真实教师数据库或平台模型凭据。首次部署在空白 PostgreSQL 上执行已有迁移，不运行合成账号/学生 seed。Nginx 通过 HTTPS 服务教师端 `/` 和管理端 `/admin/`，证书仅由部署主机保管；自签证书首次访问时浏览器会提示信任。数据库只在 Compose 私有网络开放并使用持久卷，模型与微信默认关闭。

```sh
docker compose up -d --build
docker compose ps
```

部署前应检查所选主机端口，并通过 `/api/v1/health/ready` 核验数据库就绪。初始管理员只用于签发教师邀请，不是教师账号；不可用默认弱密码或本地验收账号部署。

### Windows 本地恢复

在仓库根目录运行，先准备锁定版本的依赖并完成构建。便携运行时分别位于 `.data/tools/node-v22.19.0-win-x64` 和 `.data/tools/postgresql17/pgsql/bin`，不提交 Git，不替换系统 Node。Node 22.19 满足固定 DSH 的最低版本，配套 npm 保持 10.9.2。

```powershell
$env:Path = "$PWD\.data\tools\node-v22.19.0-win-x64;$PWD\.data\tools\postgresql17\pgsql\bin;$env:Path"
npm.cmd ci --no-audit --no-fund
npm.cmd run build
.\scripts\start-connected-windows.ps1
```

另开终端，在仓库根目录启动前端：

```powershell
& .\.data\tools\node-v22.19.0-win-x64\node.exe .\node_modules\vite\bin\vite.js packages/frontend --host 127.0.0.1
```

打开 `http://127.0.0.1:5173/`，本地初始账号 `123` / `123`（内部邮箱 `123@example.test`），独立工作空间；原验收账号 `a@example.test` / `12345678` 和资料保留。简短账号只在回环地址的开发页面可用，密码仍以带随机盐的 scrypt 哈希存储，初始化不重置已有账号。该弱密码账号仅用于本地验收，禁止将验收账号或数据库直接用于公网发布；生产构建仍使用邮箱和正式邀请密码规则。后端监听本机 3001，持久本地资料及加密配置保存在仓库同级的 `teacher-platform-local-data`；这不是旧机器真实数据库的备份恢复。不要删除该目录或公开其中的配置。外部模型、微信及真实消息默认关闭。

再次启动使用同一目录，保留合成资料；先从原启动终端停止服务再重启，不结束无关进程。Windows 运行 `npm.cmd run check` 或重新构建前先停止后端，避免 Prisma 引擎 DLL 被占用。

### 平台统一 AI（仅由运维配置）

教师页面只显示 AI 服务状态，不提供个人密钥、地址或模型配置表单，演示页面也不收集凭据。平台管理员在源码树外准备固定版本 DSH（`c291e7961a515f6d7af9304e7fd1d257929aef26`）及其锁定依赖，并单独保存仅当前用户可读的 `DEEPSEEK_API_KEY=...` 凭据文件，不将真实值写入仓库或聊天。

在上述持久数据目录新建 `platform-ai.json`，只填写两个绝对路径：`runtimeRoot` 指向 DSH checkout，`apiKeyFile` 指向凭据文件。二者都必须位于本项目源码树外，凭据不能放在 DSH 源码内。重启同一个启动脚本并刷新正式网页；原数据库与会话保留，DSH 会话另存于数据目录的 `dsh-sessions`。开启后教师发送消息会调用平台模型并可能产生费用；微信仍关闭。

没有此配置文件时维持 AI 关闭；配置无效时启动报错，不回退到教师个人凭据。回退到原本地模式时移走该配置文件再重启，不删除数据库。状态可用只代表运行配置就绪，真实连通性需用不含教学资料的最小消息验证。

## 查阅压缩历史

```sh
node scripts/read-project-history.mjs --list
node scripts/read-project-history.mjs PROJECT_LOG-through-20260918.md
```

工具只向终端输出原文，恢复到文件时请使用项目外新路径。归档保持原始哈希，压缩不等于删除 Git 历史，也不提供数据库回滚。
