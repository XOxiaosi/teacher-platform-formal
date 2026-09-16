# P6-RETENTION：按实际年龄保留备份

## 范围

本包把生产备份清理切换为可信 UTC 时间的年龄策略：达到 30 天即进入过期计划；日备份、月备份和注销媒体归档都按同一上限核对。纯函数 `planRetention` 对每个对象返回 `retain`、`expire` 或 `blocked`，并支持 `groupKey` 将同一备份运行的 dump、清单和媒体一起处理。

无法解析的格式、无效日期、未来时间或含有此类成员的关联组全部阻塞，不删除部分产物。`dryRun` 只调用 `list`，不会读取、写入或删除备份正文。旧的按数量轮转函数仍保留给未切换的兼容调用方。

## 验证

在 macOS 的 Node 22 隔离文件环境执行：

```sh
node --test packages/ops/tests/retention-policy.test.mjs packages/ops/tests/retention.test.mjs
```

结果：13/13 通过，退出码 0。覆盖精确 30 天过期、29 天保留、关联组共同过期、未知/未来/无效日期阻塞、dry-run 不读写删除，以及实际删除只作用于过期键。

完整 `npm run check` 将在 A05-SAVE 与 P6-READABLE 收口后重新执行；当前工作区已有未提交的反馈 schema 和历史 UI 基线变更，未纳入本包。
