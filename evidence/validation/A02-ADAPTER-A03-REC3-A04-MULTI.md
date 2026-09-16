# A02-ADAPTER / A03-REC3 / A04-MULTI 验证记录

日期：2026-09-15（洛杉矶）。需求 V009，工作区起点 main / `1f9e8db`。

## 范围与实现

- A02：固定上游 DSH `c291e7961a515f6d7af9304e7fd1d257929aef26`，教学工具白名单、教师/任务/上下文身份、执行恢复和计量未知语义；上游真实循环配脚本模拟模型。生产保持 unavailable，不读取凭据、不调用真实供应商。
- A03：发送前持久保存待回执原文和 requestId；刷新/切换后原请求重试，严格核对服务器回执身份；未取得回执前禁止修改造成重复提交。
- A04：增量多候选迁移保留旧 ID、确认幂等与已保存记录；分页列表、逐项编辑/确认/拒绝/暂留、行锁和版本绑定；正式材料入口 `/#/captures`、原文与候选对照、按教师隔离草稿和未决确认、版本冲突保留输入。
- 删除立即隐藏原件和来源副本；并发首次删除重放同一回执，实际擦除失败不恢复可读性。已确认正式记录按产品要求保留。

## 本轮实际证据

1. 主 Agent 运行 `node scripts/dsh-runtime/run-adapter.mjs /Users/xiaosi/Developer/research/teacher-platform-dsh-runtime-20260915 /Users/xiaosi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`，首轮 9 场景退出 0。之后独立审阅发现不合法结果未知计量及失败工具恢复问题，需修复后重跑；首轮不能替代最终结果。
2. 主 Agent 初版收件箱与正式工作区 12 项通过；API/认证/正式连接 3 文件 16 项通过。子 Agent 助手 35 项、材料 13 项通过；其结果须由主 Agent 全量入口核验。
3. A04 后端子 Agent 用项目隔离 PostgreSQL 17 执行 capture 专项，5 文件/30 项通过，包含空库迁移、合成旧数据升级、确认并发/幂等、删除并发及锁后时钟。原始日志：[capture-focused.log](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/A04-MULTI/capture-focused.log)。
4. 主 Agent 使用独立 PostgreSQL harness 和合成 a/b 教师启动正式 backend + Vite；本地服务关闭外部供应商与微信。实际浏览器从登录、待核对材料进入同一材料三候选；修改第一项、刷新再打开确认草稿仍在、保存修改并归档第一项、拒绝第二项、暂留第三项。页面分别显示已保存/已拒绝/暂留，待核对计数为 1，没有一键全归档。
5. 375、390、430 像素浏览器视口实际测量 document.scrollWidth 分别为 375、390、430；375 截图检查原文和候选可读、控件未横向越界。视口模拟不代表真实手机/跨设备验收，截图在当前任务工具交互中可追溯。
6. 首轮 `npm run check` 正在运行；最终结果在日志追加，未得结果前不标完整通过。运行日志目录：[V009-resume-20260916](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-resume-20260916)。

## 独立审阅与修复

- A03 Owner 独立审阅主 Agent 初版材料 UI，指出切换/版本刷新丢输入；移交该目录给 A03 Owner 修复 scoped session 草稿、稳定材料/候选身份和未决确认快照。主 Agent 实际浏览器复验刷新保留。
- A02 Owner 审阅 A04，指出首次并发删除 NOT_FOUND 而非回执重放；A04 已补同/异键 barrier 回归。
- A04 Owner 审阅 A02，指出不合法 host 输出遗漏未知计量、failedTool 已结束 turn 恢复问题；修复及最终验证结果待追加。

## 交付限制

本轮工程不代表真实 DeepSeek 效果、真实教学资料保障、媒体识别、Windows、多端渠道、用户最终验收或发布。材料草稿仅在当前浏览器会话保留；跨浏览器可恢复的是服务端已保存材料/候选。未决定的 B01/B02 和真实服务/预算/发布边界维持。

## 主 Agent 补充复验

- 修复后再次执行固定 DSH probe，11 场景退出 0；包括失败工具后继续、成功后零模型重放和异常计量。原始输出 `V009-resume-20260916/dsh-adapter-final.log`，实际证据目录 `.a02/adapter-2026-09-16T04-39-02.944Z`。
- 独立迁移 harness 执行 `verify-empty-migration.mjs` 与 `verify-existing-baseline.mjs`，退出 0：38 迁移、49 表、CRUD，通过复制库零结构差异、15 表计数及 10 类关系检查；所有合成临时库清理。证据 `V009-resume-20260916/migration.log`。
- 正式浏览器退出 A 后登录 B，B 收件箱为空且无 A 内容；再次登录 A 后，已保存/已拒绝/暂留状态仍一致。继续确认第三项后直接进学生档案，无需手动刷新即可看到两条已确认记录，已拒绝内容未归档，10 课时余额不变。
- 全量检查发现既有任务运行器失租测试超时。已定位：心跳在读取执行上下文期间失租，但调用 driver 前未再检查；事件只监听后续 abort 的 driver 因漏掉已发生事件而挂起。需修复运行前围栏并做确定时序回归，保留首轮失败日志，不放宽超时。

## 最终完整门禁

第二轮 `npm run check` 退出 0：治理 19 项；后端 306 文件/2725 项、前端 43 文件/268 项、管理端 13 文件/84 项、运维 124 项通过，2 项 Windows 专属测试因 macOS 跳过。长度、类型、lint、隔离 PostgreSQL 17 全量测试和全部构建通过。首轮仅租约用例失败（2723 通过/1 失败）保留；补足启动前失租围栏与确定时序回归后，运行器 17 项已在第二轮通过。未修改超时或放宽断言。

最终原始日志：[check-02.log](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/V009-resume-20260916/check-02.log)。39 个 scoped 文件的检查前后 SHA256 相同；指纹清单在同目录。最终助手恢复 35 项、材料恢复 21 项包含在全量测试。浏览器合成服务已关闭、隔离数据库清理；没有进行真实模型/教师资料/渠道/设备或发布验收。
