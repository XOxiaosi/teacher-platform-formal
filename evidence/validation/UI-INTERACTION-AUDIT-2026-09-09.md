# 教师平台全站 UI 与交互审查

- 日期：2026-09-09；产品 V006；关联 T-036。静态审查证据，动态任务状态只在 PROJECT_LOG.md。
- 用户原话：“检查一下所有UI的设计，色调没问题，但是好多地方的交互还有展示有问题”。
- 结论：保留现有色调和视觉语言；本轮交互验收不通过。存在 3 个严重布局缺陷及 1 个核心反馈流程缺口，另有 10 项需修正的问题。没有修改业务源码或提交任何有效业务保存。
- 覆盖当前免登录教师前端全部 11 个页面路由（今日、学生列表/档案、日程、缴费、反馈、AI、工作室/模型/微信/隐私），外加弹窗、周历/列表、跨月和未保存切页。管理员、正式登录、旧 UI 和真实服务不在本轮。
- 方法：Product Design audit，先捕获当前页面再检查流程；Terra/Luna 做独立只读代码审查，主 Agent 实际浏览器复现。未使用旧截图作为本轮证据，也未用旧测试绿灯推断体验合格。
- 视口：桌面1440×1000，手机390×844；日程列表另核375/430×844。当前会话原合成数据保持，未刷新页面；仅编辑未保存偏好、筛选、打开/取消表单。最终恢复原学生页面与默认视口。
- 40张接受截图保存在 /Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09，全部从当前内置浏览器截图并回读检查。01-students.png 是最初被裁切的拒绝截图，不用于报告；其余以 jpg 为准。切页/视口瞬时未绘制完成的截图已重采同名文件。

## 按流程覆盖

| 步骤 | 页面/流程 | 健康度 | 现场发现 |
|---|---|---|---|
| 1 | 学生列表与编辑 | 异常 | 学生资料链接未命中原 grid 样式，姓名、年级、余额堆叠且出现原生下划线；编辑弹窗本身可打开和取消。 |
| 2 | 学生档案与记录 | 异常 | 手机查看详情按钮遮挡地点；未来 30 天课程全部铺开，将新增记录推至约 1514px。 |
| 3 | 日程周历与列表 | 异常 | 手机周历初始只看得到周一、周二及部分周三；列表操作列占 160px，姓名和地点被挤成竖排；跨页面回来还会重置周/列表选择。 |
| 4 | 新建课程与每周重复 | 需改进 | 学生和所在周未带入新建表单；一对一仍显示可多选名单；跨月标题缺结束月份。必填校验会聚焦地点，未提交有效课程。 |
| 5 | 已完成课程详情 | 基本可用，历史待补 | 已完成状态、原扣课记录和编辑入口可见；修订历史显示范围与取消恢复缺口另列为只读代码发现。 |
| 6 | 今日工作台 | 需改进 | 三项摘要清楚，但完成与待完成课程视觉完全相同；待完成入口只跳普通周历；手机统计块占首屏较多。 |
| 7 | 缴费课时 | 异常 | 王浩然筛选后只剩空表头；统计仍是全体，登记也未带入所选学生；手机四块统计竖排且姓名断行。 |
| 8 | 家长反馈 | 流程不完整 | 只能编辑或复制预置草稿，没有为另一学生新增草稿入口；列表折叠正文换行，编辑框却保留换行。 |
| 9 | AI 助手 | 状态诚实，引导不闭环 | 未配置与禁用输入是正确边界，但“先完成模型配置”引向只能保存响应偏好的页面，用户无法完成这个指令。 |
| 10 | 模型设置 | 异常 | 未保存选择切到微信再返回即丢失；禁用保存按钮仍是主色和 pointer 光标，未保存状态不够清楚。 |
| 11 | 微信连接 | 需改进 | “查看连接步骤”只展开“连接服务尚未开放”，没有步骤；不应以隐藏真实未连接状态来解决此问题。 |
| 12 | 工作室与隐私 | 基本清楚，导航需整理 | 名称编辑入口可达，数据操作不可用诚实展示；从通用设置进入也显示“返回助手”，不符合进入路径；手机七项底栏可用但主次不清。 |

## 按影响排序的问题与建议

### F01 · P1 · 学生列表样式失效

- 证据：步骤 1；01/24。
- 复现与原因：Students.tsx:18 新增 student-row 包裹后，preview-components.css:150 仍只匹配 .student-list > a；students-edit.css:3 只有 flex/min-width。
- 建议：将学生行作为单一组件定义布局、点击区和编辑动作；电脑与手机均验证姓名/年级/余额对齐及 hover/focus，不只测无溢出。

### F02 · P1 · 手机日程表格不可扫读

- 证据：步骤 3；27/39/40。
- 复现与原因：375px 下地点和姓名 td 各 56px，操作 td 为 display:flex、宽 160px；preview-components.css:307-311 的通用 table-actions 破坏表格列分配，行分隔线也不齐。430px 仍明显断行。
- 建议：手机改成三项课程摘要卡或显式可横滚表格；操作区收窄/全行进入详情。td 保持 table-cell，flex 放内部容器。

### F03 · P1 · 手机档案按钮遮住地点

- 证据：步骤 2；25。
- 复现与原因：Students.tsx:36 的绝对定位详情按钮与换行标签重叠；students-edit.css:8-11 和 preview-components.css:227 的 padding 规则，以及手机按钮高度共同造成空间不足。
- 建议：改为正常文档流/网格布局，去绝对定位；断言标签与按钮矩形不相交，地点完整可见。

### F04 · P2 · 跨页操作丢失学生、日期与筛选上下文

- 证据：步骤 2/4/7；03→05、11→12、37→38。
- 复现与原因：王浩然档案的安排排期只跳普通日程；9月28日所在周新建却默认9月9日；缴费选王浩然后登记对象为空。Students.tsx:33、SchedulePage.tsx:49-52、ScheduleForm.tsx:86、Workflows.tsx:26/32。
- 建议：让操作带入学生与所选日/周；初始字段在保存前清楚显示；返回时恢复原周、列表和筛选，而不是重新开始。

### F05 · P2 · 主要视图无法辨认已完成课程

- 证据：步骤 5/6；07→09、08。
- 复现与原因：详情已显示李雨桐9点课已完成并扣7→6，但今日、周历、列表与待完成课程呈现一样。Today.tsx:8-13、SchedulePage.tsx:31/40 无完成状态语义。
- 建议：保持摘要三项不增加备注，按待上课/已完成/已取消分区或筛选，并让状态可读屏识别；不要只加颜色。

### F06 · P2 · 学生档案将高频记录埋在未来排期后

- 证据：步骤 2；03/25。
- 复现与原因：九条未来小班排期逐条显示后才有新增记录；390px 初始页面记录框 top 约1514px。Students.tsx:30-33。
- 建议：将记录入口提前；未来课程只显示最近几次并可展开；教学记录、排课和课时流水分组，不混成一个长列表。

### F07 · P2 · 缴费空态和统计范围不清

- 证据：步骤 7；11/31。
- 复现与原因：选择王浩然后空 tbody 无说明，上方仍显示全部4人/2笔/20课时；手机四张统计卡把记录推到首屏下部。Workflows.tsx:27-28。
- 建议：显示该学生暂无缴费记录和登记入口；明确全体统计或随筛选变化；手机统计用紧凑摘要，展示个人余额及可追溯入口。

### F08 · P1流程缺口 · 反馈页无法从零开始工作

- 证据：步骤 8；13/32。
- 复现与原因：只有一份预置李雨桐草稿，可编辑/复制，无新增按钮、学生选择或从学生档案进入的反馈动作。FeedbackSettings.tsx:5-16。
- 建议：补人工新建草稿与选择学生流程，不依赖真实AI；零草稿要有空态。此项属于补齐既定产品流程，不是接入或发送授权。

### F09 · P2 · 反馈正文换行丢失且编辑框过小

- 证据：步骤 8；13/14。
- 复现与原因：列表将“本周课堂情况/后续安排”合并为一段，textarea中却是多段；preview-components.css:369 未保留换行。
- 建议：正文使用 pre-wrap 或明确段落；编辑区域按材料长度扩展，标题/正文空白校验和保存反馈保持一致。

### F10 · P2 · 模型草稿切页静默丢失

- 证据：步骤 10；17→18→20。
- 复现与原因：实际选深入分析、不保存、切到微信再返回，变回平台默认，无离开提示。SettingsConfiguration.tsx:46-50 仅局部 state。
- 建议：保留未保存草稿或离开前说明；明确未保存/已保存，不能把刷新还原的既定边界扩大成切页丢失。

### F11 · P2 · 禁用按钮看起来仍可点击

- 证据：步骤 10/11；16/34/35。
- 复现与原因：保存设置 disabled=true 时 computed opacity=1、cursor=pointer、背景rgb(204,120,92)，与启用状态近似。
- 建议：补统一 disabled 视觉和光标，不改主色体系；同时提供为何不能保存的可见状态。

### F12 · P2 · AI/微信操作文案承诺了走不通的路径

- 证据：步骤 9/10/11；15/16/19。
- 复现与原因：AI要求完成配置，但模型页只能存响应偏好；微信“连接步骤”只显示尚未开放；检查状态只重复原文。Workflows.tsx:19、SettingsConfiguration.tsx:51/60/64。
- 建议：明确区分响应偏好与服务接入；移除没有步骤的“查看连接步骤”或换成准确动作；保留未接入事实，不伪造连接/检测成功。

### F13 · P2 · 跨月周历标题漏月份

- 证据：步骤 4；37。
- 复现与原因：实际9月28日—10月4日显示“2026年9月28日—4日”；SchedulePage.tsx:13 只取结束日号。
- 建议：同月可省月份，跨月/年必须显示完整终点；增加跨月和跨年用例。

### F14 · P2 · 重复规则管理缺少对象与可修改入口

- 证据：步骤 3/4；08/06。
- 复现与原因：规则列表仅显示星期、日期、时间、地点和暂停，无法看到是一对一谁/哪个小班，也不能从规则卡进入编辑；新增星期选择仍是表单，不够贴近闹钟式管理。SchedulePage.tsx:43-45。
- 建议：规则卡显示时间/对象/地点、重复日和启停；提供规则详情/编辑入口，暂停前说明影响范围；小班名单仍只在详情展示。

## 只读代码补查，未在本轮执行状态写入

- 取消课会留在今日投影且无状态标记：Today.tsx:18/27-29；已取消详情无恢复入口：ScheduleDetails.tsx:36-39。这是代码确认的流程缺口，本轮没有取消课程，不声称浏览器完成取消/恢复验证。
- 已完课修订仅显示最后一次原日期/时间，地点、名单、形式、备注的旧值不可见：ScheduleDetails.tsx:38-39。本轮打开已有完课记录，未再次修订用户当前数据。
- <=30分钟周历不创建地点span：SchedulePage.tsx:31。先前接受为紧凑例外，但与PRODUCT三项摘要存在差距；本轮没有创建短课，用源码证据记录，不能复用上轮截图冒充本轮验证。
- 空教学记录保存直接return、没有提示：Students.tsx:32；反馈零数据无空态：FeedbackSettings.tsx:16。未注入隐藏状态或改内存构造空数据。

## 优点与无障碍边界

- 色调、侧栏、卡片与标题语言整体一致，可继续使用；本轮不建议另起视觉风格。
- 备注已移到详情，小班列表未暴露名单；完课详情区分原扣课，编辑入口可见。
- 课程表单缺地点会阻止提交并聚焦对应字段；实测 Tab/Shift+Tab 从关闭键进入/返回首选项，Escape关闭并回到新建按钮。取消未产生数据写入。
- 导航具有可访问名称，模型未配置/微信未连接不是假成功。本轮读取当前tab捕获的warn/error日志返回空，不代表所有环境均无错误。
- 可见风险：F02/F03影响重排与遮挡，F05状态语义、F11禁用视觉、手机底栏七项的小文字均需再测；截图不能证明完整读屏/对比度/触控或WCAG合规。
- 未验证真实手机软键盘、VoiceOver/NVDA、200%缩放、长姓名/大数据量、断网/持久化、真实模型与微信。真实服务未接入是既定边界，不能通过假连接或隐藏不可用事实来解决界面问题。

## 推荐修复顺序与验收口径

1. 先修学生列表、手机日程和学生卡片遮挡（F01–F03），逐页检查字段可读、行对齐、按钮不覆盖，不只检查scrollWidth。
2. 补齐任务上下文、状态区分、草稿保护和真实空态（F04–F07、F10–F14），让用户知道操作对象、当前状态和下一步。
3. 完成反馈人工新建/编辑/复制闭环和正文排版（F08–F09），保持不接AI、不外发。
4. 修复后按“学生建档→排课→改课/完课→记录→课时核对→反馈草稿”重新做电脑/手机任务验收；此前159项测试和55组无溢出检查不能替代此项。

本轮是检查报告，不是已实施修复；PRODUCT仍为V006，整体进度仍34%。旧design-qa通过结论只适用当时限定对照，不能覆盖本次发现；T-036不能按全站体验通过交付。

## 截图证据（按流程组织）

### 步骤 1 · 学生列表与编辑 · 异常

学生资料链接未命中原 grid 样式，姓名、年级、余额堆叠且出现原生下划线；编辑弹窗本身可打开和取消。

![01-students](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/01-students.jpg)

![02-student-edit](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/02-student-edit.jpg)

![24-mobile-students](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/24-mobile-students.jpg)

### 步骤 2 · 学生档案与记录 · 异常

手机查看详情按钮遮挡地点；未来 30 天课程全部铺开，将新增记录推至约 1514px。

![03-student-detail](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/03-student-detail.jpg)

![25-mobile-student-detail](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/25-mobile-student-detail.jpg)

### 步骤 3 · 日程周历与列表 · 异常

手机周历初始只看得到周一、周二及部分周三；列表操作列占 160px，姓名和地点被挤成竖排；跨页面回来还会重置周/列表选择。

![04-schedules](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/04-schedules.jpg)

![08-schedule-list](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/08-schedule-list.jpg)

![26-mobile-week](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/26-mobile-week.jpg)

![27-mobile-list](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/27-mobile-list.jpg)

![39-list-375](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/39-list-375.jpg)

![40-list-430](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/40-list-430.jpg)

### 步骤 4 · 新建课程与每周重复 · 需改进

学生和所在周未带入新建表单；一对一仍显示可多选名单；跨月标题缺结束月份。必填校验会聚焦地点，未提交有效课程。

![05-course-form](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/05-course-form.jpg)

![06-repeat-form](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/06-repeat-form.jpg)

![28-mobile-course-form](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/28-mobile-course-form.jpg)

![29-mobile-form-validation](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/29-mobile-form-validation.jpg)

![37-cross-month](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/37-cross-month.jpg)

![38-new-course-context](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/38-new-course-context.jpg)

### 步骤 5 · 已完成课程详情 · 基本可用，历史待补

已完成状态、原扣课记录和编辑入口可见；修订历史显示范围与取消恢复缺口另列为只读代码发现。

![07-completed-details](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/07-completed-details.jpg)

### 步骤 6 · 今日工作台 · 需改进

三项摘要清楚，但完成与待完成课程视觉完全相同；待完成入口只跳普通周历；手机统计块占首屏较多。

![09-today](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/09-today.jpg)

![30-mobile-today](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/30-mobile-today.jpg)

### 步骤 7 · 缴费课时 · 异常

王浩然筛选后只剩空表头；统计仍是全体，登记也未带入所选学生；手机四块统计竖排且姓名断行。

![10-finance](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/10-finance.jpg)

![11-finance-empty](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/11-finance-empty.jpg)

![12-payment-form](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/12-payment-form.jpg)

![31-mobile-finance](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/31-mobile-finance.jpg)

### 步骤 8 · 家长反馈 · 流程不完整

只能编辑或复制预置草稿，没有为另一学生新增草稿入口；列表折叠正文换行，编辑框却保留换行。

![13-feedback](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/13-feedback.jpg)

![14-feedback-edit](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/14-feedback-edit.jpg)

![32-mobile-feedback](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/32-mobile-feedback.jpg)

### 步骤 9 · AI 助手 · 状态诚实，引导不闭环

未配置与禁用输入是正确边界，但“先完成模型配置”引向只能保存响应偏好的页面，用户无法完成这个指令。

![15-agent](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/15-agent.jpg)

![33-mobile-agent](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/33-mobile-agent.jpg)

### 步骤 10 · 模型设置 · 异常

未保存选择切到微信再返回即丢失；禁用保存按钮仍是主色和 pointer 光标，未保存状态不够清楚。

![16-models](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/16-models.jpg)

![17-model-unsaved](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/17-model-unsaved.jpg)

![20-model-draft-lost](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/20-model-draft-lost.jpg)

![34-mobile-models](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/34-mobile-models.jpg)

### 步骤 11 · 微信连接 · 需改进

“查看连接步骤”只展开“连接服务尚未开放”，没有步骤；不应以隐藏真实未连接状态来解决此问题。

![18-wechat](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/18-wechat.jpg)

![19-wechat-steps](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/19-wechat-steps.jpg)

![35-mobile-wechat](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/35-mobile-wechat.jpg)

### 步骤 12 · 工作室与隐私 · 基本清楚，导航需整理

名称编辑入口可达，数据操作不可用诚实展示；从通用设置进入也显示“返回助手”，不符合进入路径；手机七项底栏可用但主次不清。

![21-studio](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/21-studio.jpg)

![22-privacy](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/22-privacy.jpg)

![23-mobile-settings](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/23-mobile-settings.jpg)

![36-mobile-studio](/Users/xiaosi/Developer/artifacts/teacher-platform-formal/ui-audit-2026-09-09/36-mobile-studio.jpg)
