# macOS Teach Mode 接入与验收

0.4.1 开发候选为同一 MPP ZIP 增加 `darwin`，保留 `win32`。Mac 使用当前对话中的 Record and Replay 与 Skill Creator，最低系统为 Host 原生运行时要求的 macOS 14；旧 Web → Notepad 执行仅限 Windows。

## Host 与权限

Host 版本下限为 `1.2.3-rc.8`，还必须提供清单全部 `requiredHostCapabilities`，包括 `memmy.event-checkpoints/v1`。相同预发布版本号不替代能力检查。

Host 需同时更新 Mac 源码录制器、打包的 History kit 和 app-agent：checkpoint 经控制管道和双向 socket 到达原生 enrichment 队列，返回有序标记；归一化队列写入记录、刷盘并确认精确字节位置。插件复用 Computer History，采集器及权限由 Host 统一管理。

2026-10-26 同步补充：浏览器标签移出教学窗口后立即撤销页面采集，并等待旧页面收尾；桌面录制跨十分钟分段时，在原生 checkpoint 处切换输出文件，保持同一个原生采集会话。Host、打包的 History kit 和插件应使用下列同一批开发分支。

- Host：`Jovianix/memmy-agent` 的 `codex/teach-pxlin-dev`。
- 插件：`Jovianix/teach-mode` 的 `codex/teach-mode-macos-sync-20261026`。

插件的 `events` / `read_events` 支持 `view: "teaching"`，在保留原始索引和来源哈希的同时压缩重复状态；`raw` 仍可读取原始证据。

按 Host 提示为实际原生应用授予“辅助功能”和必要的“输入监控”。事件录制不要求视频或屏幕录制授权；后续技能使用截图等工具时，按该工具处理权限。敏感输入过滤及应用、站点观察规则继续生效；浏览器教学拒绝隐私窗口。

开发编译需要 Node 22 和 Host 项目要求的 Swift 工具链；终端用户无需额外安装 Node、Python 或 Swift。

## 用户操作

1. 插件页下载安装并授权。对话 `/teach` 只说明流程并待命。
2. 对话中明确目标并要求开始；服务确认后展示计时条。
3. 实际操作后在对话或计时条结束，检查事件范围和限制。结束不生成 skill。
4. 另行要求生成，由 Skill Creator 使用指定事件片段、澄清并保存；生成返回 `execution:not_run`。
5. 后续另行请求使用技能，核验实际结果。停用在对话处理，卸载在插件页完成；重装重新校验保留数据。

## 构建与合同测试

```sh
npm ci --legacy-peer-deps
npm run typecheck -w @memmy/teach-mode-plugin
npm test
npm run build

MEMMY_HOST_KIT_DIR=/path/to/macos-host-kit \
MEMMY_PLUGIN_ZIP=/path/to/teach-mode-0.4.1.zip \
MEMMY_PLUGIN_SHA256=<实际固定哈希> \
npm run test:conformance
```

Host kit 的 `platform` / `arch` 应匹配运行机器。脏开发制品仅在显式设置 `MEMMY_ALLOW_DIRTY_HOST=1`、`MEMMY_ALLOW_DIRTY_PLUGIN=1` 时允许；正式流程不设置这些变量。

Mac CI 执行插件类型检查、测试和构建，固定制品 conformance 可选择 Mac runner。Host CI 另执行原生队列/管道测试与 Swift app 构建，Host kit 文件名使用实际架构。受控事件测试不代表真实桌面验收。

## 真实 Mac 验收与发布

在隔离配置的 Mac 上安装固定 Host 和插件，留存以下证据：

- 无系统 Node 时的宿主启动；TCC 拒绝和恢复；旧 app-agent 更新识别。
- 真实四步对话、事件、毫秒边界和持久化位置；停止不自动生成。
- Chrome/Edge 教学标签移出后旧页面收尾、禁止继续采集；移回及快速停止时边界正确，未确认的结束仍返回不完整。
- 桌面录制跨十分钟边界、连续操作无缺口，前后 `nativeSessionId` 相同；轮转后的完整 AX 快照、页面上下文、停止热键和后台意图恢复。
- 真实模型生成、下一轮技能发现、另行试运行、独立核验输出。
- 对话隔离、刷新恢复、后台意图保留、其他录制互斥、取消和崩溃清理、停用/卸载、重装与更新。

报告使用 `memmy.teach-mode-macos-acceptance/v1`，`platform: {os:"darwin", arch:"arm64"或"x64"}`。运行时字段除 Windows 共用项外要求 `nativeAppAgent:true`；`checks` 覆盖 `macAcceptanceChecks`，包括 `macPermissionsDenied`、`macPermissionRecovery`、`macAppAgentRestart`。

其余来源、证据种类及哈希沿用 [验收与发布](acceptance-and-publication.md)。`MEMMY_MACOS_ACCEPTANCE_REPORT` 指向报告；发布工作流同时要求 Windows 和 Mac 原始验收 ZIP URL 与 SHA-256，缺少任一已声明平台证据时不能通过。

本轮开发环境为 Linux/WSL，未执行 Mac 原生编译、TCC 和真实桌面验收。云端接入仍暂缓，本地包及 Registry 不作为正式发布结果。
