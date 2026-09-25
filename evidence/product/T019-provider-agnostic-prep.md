# T-019 供应商无关识别准备证据

> 2026-09-08 审计更正：下文保留 09-06 的局部验证记录。已验证的是状态、置信度与重试；“供应商无关准备已完成”不能涵盖媒体版本、人工修订、候选确认归档或媒体删除回执。当前 MediaAsset 仍是单值结果，文字 Capture 的回执不覆盖媒体。完整 T-019 Gate 未通过，详见 `../audit/2026-09-08/DELIVERY.md` 与根 `PROJECT_LOG.md`。

日期：2026-09-06
范围：教师网页端的 OCR/ASR 任务状态、重试、结果置信度与失败语义；仅使用本地合成数据和占位适配器。

## 本轮完成

- `MediaAsset` 为 ASR 与 OCR 分别保存 `transcriptionConfidence` / `ocrConfidence`，并通过 DTO 返回；结果允许为空，供应商返回值必须是闭区间 `0..1`。
- 任务进入 pending/retry 时清空旧文本和旧置信度，避免上一次结果在新任务期间被误认为当前结果。
- 适配器返回非法置信度时任务进入 failed，不写入识别文本或置信度；失败不会伪装成成功或低可信成功。
- 本轮局部验证涉及识别状态、重试、置信度与跨教师访问边界；媒体删除回执、识别版本和人工修订不在已完成范围内，也不设置未经确认的低可信阈值。
- 新增迁移 `20260919000000_add_t019_recognition_confidence`；不连接真实 OCR/ASR 供应商，不读取密钥，不上传真实资料，不产生费用。

## 自动化证据

| 命令 | 结果 |
|---|---|
| `DATABASE_URL='postgresql://xiaosi@127.0.0.1:5432/postgres' npm test --workspace packages/backend -- tests/functional/media/media-transcription.test.ts tests/functional/media/media-ocr.test.ts` | 2 files、35 tests 通过，退出码 0 |
| `npm -w @teacher-platform/backend run build` | 通过，退出码 0 |
| `npm -w @teacher-platform/contracts run build` | 通过，退出码 0 |
| `DATABASE_URL='postgresql://xiaosi@127.0.0.1:5432/postgres' npm -w @teacher-platform/contracts run db:verify-empty-migration` | 40 张表、34 次迁移、Prisma CRUD smoke、空库部署与清理全部 PASS |

## 当前 Gate 边界

本文件只证明状态、置信度和重试的局部准备通过，不能宣告供应商无关完整链路或 T-019 的真实接入 Gate 通过。媒体版本、修订、候选归档与删除回执仍须本地实现；真实成功率、供应商失败、生产低可信阈值、费用上限、密钥配置和真实资料验收仍待单独授权；在此之前 placeholder 不能获得正式可用状态。
