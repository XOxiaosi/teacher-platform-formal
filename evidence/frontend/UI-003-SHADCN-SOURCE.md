# UI-003 shadcn/ui 实际来源与集成证据

日期：2026-09-20。GitHub 项目：https://github.com/shadcn-ui/ui 。官方 Vite 文档：https://ui.shadcn.com/docs/installation/vite 。

本次通过官方 npm CLI `shadcn@4.21.0` 与官方 registry 获取真实源码，不是仅在需求中提到项目，也未克隆整个仓库。

执行命令：

```sh
npx --yes shadcn@latest add button input textarea badge card separator tabs dialog dropdown-menu tooltip sheet -y -c packages/frontend
```

11 个组件在 `packages/frontend/src/components/ui/`，版权保留于该目录 LICENSE.md（官方仓库 MIT License）。Sheet 的默认关闭文本已本地化为“关闭导航”；其余组件保持 CLI 生成实现。配置在 `packages/frontend/components.json`，主题在 `src/design-system/theme.css`，Vite 已接入 Tailwind 4。

| 实际使用处 | 组件 |
|---|---|
| 导航、账号、移动导航、业务弹窗 | Button、Separator、Tooltip、DropdownMenu、Sheet、Dialog |
| 登录、今日、学生、日程、缴费、反馈、设置 | Card、Button、Input、Textarea、Badge |
| AI 会话、输入和确认 | Card、Button、Textarea、Badge、Separator、Tooltip |

Tabs 已获取作为组件库文件，目前未迁移原有筛选/分段按钮；不把已下载称为已使用。

组件依赖 `radix-ui`、`cn`、`lucide-react` 均来自本次官方 CLI 输出。组件源代码生成时使用 `cn` 包；本地 `lib/utils.ts` 为后续自有组件的标准工具函数。

完整 CLI 日志、版本、组件 SHA-256 和安装后审计原文位于源码树外：`/Users/xiaosi/Developer/active/releases/teacher-ui-redesign-20260920/`。

依赖审计：npm 报告的 3 个 high 均为已有 Prisma → @prisma/config → deepmerge-ts 链；备份 lock 与当前 lock 的版本相同（6.19.3 / 6.19.3 / 7.1.5）。没有为本次 UI 工作强行降级数据库工具，不能把它们称为已消除。
