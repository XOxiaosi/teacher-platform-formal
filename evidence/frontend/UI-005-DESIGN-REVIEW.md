# UI-005 配置与微信反馈设计证据

日期：2026-09-20。范围：用户认可 UI-003/004 视觉后补齐前端设计，不安装插件或接入真实微信。

## GitHub 来源核验

- 官方内核：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。官方 [模型配置说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md) 的 DeepSeek 配置为单 API-key 字段；正式密钥只写入 Host 凭据存储，页面读取脱敏描述。
- 本轮微信设计参考：[xmanrui/dsh-im](https://github.com/xmanrui/dsh-im)，社区维护的 DSH 插件，并非 DeepSeek 官方代码仓库。已实际只读获取源码，固定提交 `eb31631e9e91f7c6bcc6d5ff6d21f4f922fc6d74`。
- [README](https://github.com/xmanrui/dsh-im/blob/eb31631e9e91f7c6bcc6d5ff6d21f4f922fc6d74/README.md) 描述微信扫码及 iLink 长轮询；[微信控制器](https://github.com/xmanrui/dsh-im/blob/eb31631e9e91f7c6bcc6d5ff6d21f4f922fc6d74/src/channels/weixin/weixin-controller.mjs) 第 17–25 行定义 starting/pending/scanned/needs_verification/connecting 及 connected/expired/failed/cancelled；第 424–480 行处理扫码、配对数字、过期和手机确认，校验授权结果后建立连接。
- [旧 dsh-weixin](https://github.com/xmanrui/dsh-weixin) README 已标记不维护并指向 dsh-im，因此未选旧仓库作为新接入目标。
- 仅参考交互状态与接口边界，未复制执行插件代码，未执行安装或远端脚本。仓库外源码和证据：`/Users/xiaosi/Developer/active/releases/teacher-ui-005-20260920/`。
- 后续接入需要教学权限收敛、教师身份隔离、消息去重、材料核对、确认及结果投影；插件通用远程执行和主动推送能力不自动纳入教师平台。

## 需求对照与本轮边界

| 需求 | 现状与补齐 | 剩余接入 |
|---|---|---|
| F13 DeepSeek | 设计页固定 DSH/DeepSeek，只保留 API Key 输入，演示输入清空且不持久化 | 正式教师入口只读呈现现有 runtimeAvailability；通用供应商写配置已移出教师可达路由，预览不代表已配置密钥 |
| F16 微信连接 | 扫码弹窗、确认、可选配对、成功/过期/失败/取消/重连，均明确演示 | 真实 iLink 授权、消息收发、账号隔离与失效验证 |
| F06/F08/F16 学生情况 | 今日工作台微信反馈收件与逐项详情、核对及结果状态 | 当前 capture DTO 仅有 web 来源，无微信专用读取投影；正式页面不得从普通资料猜测微信来源 |
| F14 教学偏好 | 设置提供查看、修改、清除的演示，以及学生记忆依据说明 | 正式偏好存储与助手消费链路；不声称记忆已经写入 |
| F19 帮助与反馈 | 连接、保存失败、AI 不可用、隐私说明；演示问题可保留再编辑 | 真正客服提交、问题编号及处理回复 |
| F18 隐私 | 预览数据导出不发真实 API 请求 | 正式导出沿用现有服务，其他删除/保留策略不因设计即宣称完成 |

已有待核对材料组件可供后续真实微信候选复用；现有后端微信二维码仍为占位流程，不能据此宣称渠道已经打通。学生时间线沟通明细、真实用量、媒体识别、完整学生长期档案等仍按 PROJECT_LOG A/P 任务推进，本次不以新设计替代功能验收。

## 验证

- 第一轮完整前端：56 文件中 54 通过、2 失败；361 测试中 356 通过、5 失败。原因均为旧预览断言禁止演示/密钥占位及已移除的单选项 CSS，原日志 frontend-check.log 保留。
- 已将正式页面断言与设计预览断言分开：正式页面继续禁止开发说明，设计页面必须明确模拟边界；全预览仍禁止业务网络、持久存储和外部资源，密钥输入仅允许在指定组件本地状态中。专项 boundary-recheck.log 3 文件/27、isolation-recheck.log 1 文件/6 通过。
- 独立审查发现正式教师路由仍可达旧通用 provider 配置，已改为 PlatformAIStatus，只读消费现有服务端 runtimeAvailability；不新增凭据接口，不暴露其他供应商或写配置表单。
- 浏览器发现成功后空扫码弹窗、关闭焦点及确认后摘要状态不一致，已修复并补测试。最终独立审查与完整根门禁均通过。

## 最终交互检查

- 主 Agent 在 1280×720 桌面及 375×667 窄屏实际操作：DeepSeek 合成输入提交后清空；二维码过期刷新、失败重试、扫码与可选数字输入、手机确认成功、X 关闭取消；成功回焦重连按钮，取消回焦打开二维码。
- 今日首屏可进入微信学生反馈；未知学生不能确认；拒绝后待核对数减少；修改拟记录并确认后列表摘要更新且不再提供重复确认；保存状态与微信回复状态分开。
- 教学偏好跨设置页保留；问题反馈明确未提交且可继续编辑；隐私预览点击不会声称导出成功。所有资料为合成内容。
- 窄屏发现反馈弹窗横向溢出，已修为两列次要按钮与独占行确认按钮；复验 dialog clientWidth=scrollWidth=326，无横向滚动。微信扫码弹窗 clientWidth=scrollWidth=351，top=68.9/bottom=598.1 位于667高视口内。
- 干净标签页最终控制台 error/warn 为0。真实手机键盘、真实扫码、真实模型、用户新增交互认可与部署未验证。
- 截图保存在外部证据目录：deepseek-desktop.png、wechat-qr-desktop.png、wechat-connected-desktop.png、today-desktop.png、feedback-inbox-desktop.png、feedback-review-desktop.png、today-mobile.png、feedback-review-mobile.png、wechat-qr-mobile.png。
- 独立审查最终无遗留阻塞；独立运行 ConnectedWorkspace 11/11 及5个预览文件36/36通过。主 Agent 最终修正专项5文件44/44及类型检查通过，完整根门禁最终通过。

## 完整门禁失败与复验

- 首轮根 npm run check 在后端阶段退出 1：326 文件/2833 测试通过；llm-line-workflow 的未认证请求预期401、实际404。原 full-check.log 保留。
- 同一隔离 PostgreSQL harness 定向复验 1 文件/7 测试通过，backend-isolated-recheck.log 退出0；没有修改后端或降低断言。只读核对路由同步挂载，首轮失败响应体未保留，具体根因未知。完整重跑日志为 full-check-final.log。

- 最终根 `npm run check` 退出0：治理25、后端327文件/2834、前端56文件/368、管理端13文件/84、ops149通过；2项Windows专属测试按macOS平台跳过。文件长度、类型、lint与全部生产构建通过。原日志 full-check-final.log；第一次404未再现，具体根因仍未知。
- 完整检查期间21份源码指纹一致；最终仅文档收口并复验治理与长度。浏览器原始控制台证据 browser-console-final.json 为[]。
