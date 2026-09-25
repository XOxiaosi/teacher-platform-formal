# V008 模型与 API 入口验收

日期：2026-09-09。此文件记录本轮证据；唯一产品事实为 PRODUCT.md，唯一进度为 PROJECT_LOG.md。

## 入口与范围

- 正式入口：http://127.0.0.1:5173/#/settings/models；可由设置首页或 AI 助手进入。
- 正式页复用 ProviderConfig 的列表、新增、编辑与默认选择接口，具体 model 进入已有 provider resolver 选择链；不再把 default/fast/deep 偏好冒充模型选择。
- 已配置模型可选择为默认，也可修改模型 ID、地址、名称或更换密钥；留空新密钥保留原值。没有模型目录接口，不虚构供应商型号、价格或性能；已有相同协议/地址的模型作为输入建议。
- 仅开放配置管理；本机安全模式仍不装配模型 resolver、真实 provider 或用量执行，保存不触发 DNS、HTTP、连通测试或教学资料发送。
- 新 capabilities 明确 configurationEnabled=true、runtimeEnabled=false、connectionTestEnabled=false、endpointValidation=static。无 probe 的 test 端点返回 ok:false，不能将本地解密成功冒充连通成功。
- 非安全运行模式保留原 DNS/CIDR fail-closed 与运行时 SSRF 守卫；本轮不启用该运行模式。

## 数据与凭据

- 实施前只统计当前隔离库 ProviderConfig 行数：0。项目保留 API 代码，不等于当前合成账号有已保存配置；没有据此判断其他环境不存在配置。
- 未读取 .env、旧空间或其他环境的凭据，不自动搬入用户原有密钥。
- 本地启动脚本从现有验收加密根通过域分离 HMAC 派生独立配置加密键，不打印键、不覆盖旧标记；同一目录重启保持解密能力。
- 密钥仅由用户表单手工提交，后端 AES-GCM 加密，响应仅掩码；前端仅暂存于表单，成功后清空，不写入浏览器持久存储。
- 浏览器只在隔离账号 B 新建了两条明确合成配置（example.test 地址与无效合成 Key），账号 A 保持无 API 配置；不删除用户资料。

## 实际浏览器证据

产物：/Users/xiaosi/Developer/artifacts/teacher-platform-formal/model-entry-v008

1. 私网 API 地址保存被拒绝；首次新增表单、模型 ID 与输入保留，可修正后重试。
2. 新增两条合成配置，第二条设为默认；刷新后第二条仍是默认。
3. 修改第二条模型为 acceptance-model-two-revised，不填写新 Key；模型更新且 Key 掩码仍为原值。
4. 停止并重启同一持久目录后，两条配置、默认选择、修改后的模型及密钥掩码均保留。
5. 375px 视口 document scrollWidth=375，编辑表单宽290px、x=35；手机与1280px电脑截图已人工查看。mobile-model-config.jpg、desktop-model-config.jpg。
6. 新版本中选非默认配置并输入未保存模型，取消默认选择被阻止，输入完整保留；取消编辑后才可切换，未写入该草稿。
7. B 退出后登录 A，A 不显示 B 的两条配置，仍为真实空态；teacher-a-isolation.jpg。交付停留在 A 的正式模型入口。

## 工程验证与修复

- 修复主配置 count→create 并发竞态：同教师 create/update/remove 共用事务 advisory lock，首条并发创建、并发选择及删除补位交错均保持唯一默认；不新增迁移。
- 同次设置默认与修改 model 均生效；空模型拒绝，停用配置不能设默认。
- 前端拒绝重复提交；保存失败保留输入，已保存但回读失败锁定后续写；教师切换丢弃旧响应，未调用的连接不报告成功。
- 主集成后端定向：12 文件 / 83 用例通过，覆盖 provider CRUD、SSRF、local-safe、LLM 接口、用量及兼容 runtime；日志 model-entry-v008-backend.log。
- 独立复核：后端 5 文件 / 26 用例通过，包含三种并发默认模型回归；前端初次定向 27/27，发现的 P2 已修复并复核。
- 前端最终全量：34 文件 / 197 用例，退出0；覆盖空态首次创建失败保留、已写入后身份刷新失败不重复创建、脏编辑组合操作、跨教师异步回写等。日志 model-entry-v008-frontend-final.log。
- 根 build/lint、最终前端 build 与 diff 检查通过；新增身份核验和写后失败路径经独立 reviewer 再次只读复核，无 P1/P2。
- 架构与核心路由边界：隔离 harness 2 文件 / 16 用例通过。
- 直接运行边界测试曾被 DATABASE_URL 未配置安全闸拒绝，没有运行测试或连接现有库；改用独立 PostgreSQL harness 复验，保留 boundary 与 boundary-final 两份日志。

本轮不重新宣称整个平台完成：真实 AI、识别、微信、云端与试用仍未验收，原有文件长度门禁债务未在本轮消除。teacher-product-development 的独立审查推动了并发默认选择及失败状态修复。
