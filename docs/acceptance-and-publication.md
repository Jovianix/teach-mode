# 验收与发布

## 独立制品测试

本仓库不导入主仓库源码，也不读取同级目录。Host 仓库构建 `plugin-host-conformance-<version>.zip`，其中包含真实基线服务组合、通用原生服务、Skill Creator 校验器、迁移及运行依赖。

```sh
MEMMY_HOST_KIT_URL=https://.../plugin-host-conformance-1.2.3-rc.8.zip \
MEMMY_HOST_KIT_SHA256=<固定哈希> \
MEMMY_PLUGIN_ZIP_URL=https://.../teach-mode-0.4.0.zip \
MEMMY_PLUGIN_SHA256=<固定哈希> \
node scripts/download-conformance-inputs.mjs
npm run test:conformance
```

在本地也可显式提供 `MEMMY_HOST_KIT_DIR`、`MEMMY_PLUGIN_ZIP`、`MEMMY_PLUGIN_SHA256`。任一输入缺失、哈希不符或制品来源未提交，测试失败。开发期间须显式设置 `MEMMY_ALLOW_DIRTY_HOST=1` / `MEMMY_ALLOW_DIRTY_PLUGIN=1` 才允许脏制品，正式流程不设置这两个变量。报告在 `.cache/conformance-report.json`。

此测试使用受控事件及草稿，验证下载、权限、真实 MCP 进程、四步接口、Skill Creator 校验、技能撤下恢复和异常清理。它不提供真实桌面或模型验收结论。

## 真实 Windows 验收

在未安装系统 Node 的 Windows x64 测试机安装指定 Host 版本，使用固定插件 ZIP、来源提交及 SHA-256。使用与用户日常数据分离的测试配置、对话和输出目录。不要运行第二个竞争采集器；通过现有 Computer History 的采集器订阅。

1. 未登录进入插件商店，测试拒绝授权、重复安装、断网及坏哈希；恢复后手动安装授权。
2. 在对话发送 `/teach`，核对没有采集；另发开始及范围授权。操作网页与 Notepad，留存实际事件和截图。结束后核对没有生成。
3. 另发生成请求，由真实模型调用 `create_skill`，保存 Skill Creator 的校验与生成技能。下一轮发现技能，另发试运行请求，独立读取编辑器与输出文件，比较预期内容。
4. 分别测试后台 History 原为运行、暂停、停止时的意图恢复；其他录制任务互斥；双对话归属隔离；刷新恢复；取消、插件崩溃、Host 崩溃、停用及卸载释放资源。
5. 用旧版数据校验迁移和备份；停用后技能消失、重装恢复；录制期间推迟更新、更新失败回滚及新权限确认。

将证据放在一个目录，清理账号密钥等与验收无关的信息。入口 `report.json` 使用 `memmy.teach-mode-windows-acceptance/v1`：

- `status: "passed"`；`platform: {os: "win32", arch: "x64"}`。
- `runtime: {bundledHostNode: true, systemNodeInstalled: false, installedApplication: true}`。
- `host: {version, sourceCommit}`、`plugin: {version, sourceCommit, sha256}` 必须等于最终制品。
- `checks` 覆盖 `scripts/release-validation.mjs` 导出的全部 `acceptanceChecks`。
- `evidence` 为 `{kind, file, sha256}` 数组，文件均在报告目录中，哈希对应原始字节。

必需的证据：

| kind | 内容 |
| --- | --- |
| conversation-trace | JSON 有序数组，`sequence` 从 1 连续递增。五个独立用户消息 `{kind:"user", phase:"invoke/start/stop/generate/trial", messageId}`；模型事件含 provider/model/requestId；工具事件含 kind:"tool"、pluginId、capabilityId、input、output。保留实际调用次序。 |
| capture-boundaries | JSON：source:"computer-history/native"、sessionId、startedAt、endedAt、eventCount、eventsSha256、checkpoints.start.complete / checkpoints.stop.complete。未确认完整的片段不得填 complete:true。 |
| capture-events | 结束时固定的实际事件 JSONL，与 eventsSha256 相符。 |
| skill | 实际生成的 SKILL.md。 |
| execution-result | JSON：status:"passed"、userMessageId（试运行请求）、sessionId、skillSha256，以及实际执行摘要。旧版执行另留计划哈希和执行结果。 |
| output-verification | 独立核验 JSON：independent:true、editorMatches:true、expectedSha256、actualSha256，说明读取编辑器及文件的核验方式。 |
| output-file | 实际用户输出文件，与独立核验哈希一致。 |
| screenshot | 实际桌面及编辑器核验截图。 |

`npm run verify:release` 校验这些来源、阶段边界和文件哈希；人工仍需审阅原始轨迹、截图与异常矩阵。Windows Host Node smoke 使用独立 schema，并明确 realDesktopCapture:false、modelDrivenConversation:false，因此不能通过此门槛。

## 发布顺序

1. Host PR 通过兼容验收并发布正式版本。Host 的 release.published 工作流读取 GitHub 实际 release 与标签提交，生成 `host-release.json`；开发包的 release 为 null。
2. 提交插件全部源码，固定标签 `v0.4.0`。构建时提供已发布 Host 描述，`MEMMY_PLUGIN_RELEASE=1 npm run build`。同一提交和描述会产生固定 ZIP；开发包不冒充正式发布。
3. 在各平台完成真实验收，打包证据。触发 `publish.yml`，输入固定 Host kit、Windows 与 Mac 证据 ZIP 的 HTTPS URL 和 SHA-256。流水线重新构建、核验、运行跨仓测试，再发布匹配源码的标签。证据缺失时不会发布；Mac 格式见 [macOS Teach Mode](macos-teach-mode.md)。
4. 通过实际云服务的发布入口上传 ZIP、版本描述和 catalog；可信官方 Registry 允许该原生版本。该仓库不虚构云端写入 API。配置 `MEMMY_PLUGIN_REGISTRY_URL` 后运行 `npm run verify:registry`，匿名回读 catalog、来源提交、下载及哈希。

首次安装为手动，后续自动更新。云端写入权限、GitHub 凭据、Host 正式发布和真实 Windows/Mac 证据属于实际发布前置条件；本地构建成功不能替代。
