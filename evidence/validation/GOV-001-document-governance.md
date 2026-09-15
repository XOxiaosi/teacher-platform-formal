# GOV-001｜三文档治理验证记录

日期：2026-09-15（洛杉矶）。任务状态以 [PROJECT_LOG.md](../../PROJECT_LOG.md) 为准；本文是本轮证据快照，不另行维护进度。

## 范围与结果

- AGENTS 维护工作规则：启动读取、职责边界、协作、测试、Git 与交付；旧版本产品要求退出现行规则。
- PRODUCT 维护需求和待决定项，仍为 V009；B01/B02 从调整方案汇入待决定表，不增加已确认功能或授权。
- PROJECT_LOG 维护当前投影、任务/阶段、决定依赖、验证与后续工作；43% 明确归于 V008 历史，不用作 V009 进度。
- 新增 `check:governance` 与 `test:governance`，接入根 `check` 和 `test`。一致性检查不能替代实际业务测试，也不会自动创建 commit 或授权外部操作。
- 历史日志和规则原文保留；日志从 599 行整理为当前短日志及两个只读历史附件。拼接还原原日志 SHA-256 为 `74c2df9c2484f9dcae169d7922bbb70709980e0fb53f4d0d46345c9700949ad1`；三附件指纹固定于检查器和清单。

## 本地验证

环境：Node v22.16.0，npm 10.9.2；已有脏工作区基线 HEAD `4acb7a6`。本次运行基于当前完整工作区，不把结果宣称为旧 HEAD 或仅治理 commit 的完整产品验证。全量数据库测试由项目 harness 创建临时 PostgreSQL 17 合成库，不复用用户资料。

| 命令或检查 | 结果 | 说明 |
|---|---|---|
| `npm run check:governance` | 通过 | 唯一入口、需求/决定引用、版本/任务状态、阶段依赖、链接、必需规则、入口接线及历史指纹 |
| `npm run test:governance` | 通过 | 最新 14 项，包含删规则、假完成、未知决定/阶段、历史改写和清单篡改等负例 |
| `npm run check` | 失败，退出 1 | 治理检查通过后在原文件长度门禁停止；日志超长已消除，仍有四项既有业务文件超长 |
| `npm run typecheck` | 通过，退出 0 | 根级类型检查 |
| `npm run lint` | 通过，退出 0 | 根级 lint |
| `npm run test` | 通过，退出 0 | 后端 2622、前端 210、管理员 84；运维 124 通过，2 项 Windows 专用测试跳过 |
| `npm run build` | 通过，退出 0 | 全工作区构建，在完整测试结束后顺序执行 |
| 独立审阅 | 通过 | 两次 delta 审阅，主 Agent 修复规则正文、阶段依赖及历史清单检查缺口；独立复跑 14 项测试通过 |
| 暂存内容独立复验 | 通过 | 将本次 13 个暂存文件导出到源码树外，治理检查和 14 项测试通过，不依赖未提交业务文件；不代表完整产品快照已验证 |

根测试启动时包含当时的 11 项治理测试；独立审阅后补充至 14 项，最终定向重跑通过。业务代码没有随治理检查修订而变化。运维跳过项为 `--zip` 导出解包与 PowerShell Expand-Archive，测试源码明确限定 Windows；本机未运行，不能称 Windows 验收通过。

根门禁剩余失败清单（本轮未修改这些业务文件，也未修改长度限制或旧例外）：

- `packages/backend/src/features/media/media-asset-service.ts`：1135 行。
- `packages/backend/tests/functional/media/media-ocr.test.ts`：524 行。
- `packages/backend/tests/functional/media/media-transcription.test.ts`：583 行。
- `packages/contracts/prisma/schema.prisma`：991 行。

实际运行日志：[根检查](</Users/xiaosi/Developer/artifacts/teacher-platform-formal/governance-2026-09-15/check.log>)、[类型检查](</Users/xiaosi/Developer/artifacts/teacher-platform-formal/governance-2026-09-15/typecheck.log>)、[lint](</Users/xiaosi/Developer/artifacts/teacher-platform-formal/governance-2026-09-15/lint.log>)、[全量测试](</Users/xiaosi/Developer/artifacts/teacher-platform-formal/governance-2026-09-15/test.log>)、[命令退出码](</Users/xiaosi/Developer/artifacts/teacher-platform-formal/governance-2026-09-15/results.json>)。日志留在源码树外，本地证据链接不代表上传。

## Git 与交付边界

暂存快照及实际输出见 [独立复验证据](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/governance-2026-09-15/index-validation.json)。最终文档格式检查通过；历史拆分边界已调整以避免新增文件尾部空行，原日志拼接指纹保持不变。

- 原仓库已有历史；本次保留当前需求、日志历史、规则及引用方案的文档基线，不伪造此前逐次修改的提交。
- 本次暂存范围只包括三文档、治理脚本/测试、package 脚本、历史快照/清单、引用的调整方案/DSH 设计说明及本证据；已有无关业务改动不提交、不撤销。
- 提交关联 GOV-001。根门禁仍失败时只能创建 `checkpoint(GOV-001)` 留痕；不标记合格交付、产品全绿或已验证回滚点。实际 SHA 在 Git 和本次最终回复查询，正文不预填同次提交 SHA。
- 本轮没有 UI 或业务行为修改，未执行真实模型、微信、真实设备/资料、计费、发布或部署验收。V009 业务任务与外部 Gate 保持原状态。
