# Teach Mode

Teach Mode 单独在本仓库维护，沿用 memmy-plugins 的单插件目录和 MPP ZIP 格式。
其他插件使用各自的远端仓库。

`teach-mode/` 包含清单、运行代码、技能、资源及单元测试；`scripts/` 提供构建和制品服务；
`integration/` 只消费固定版本及 SHA-256 的 Host、插件制品，不读取主仓库源码。

```sh
npm ci --legacy-peer-deps
npm run typecheck -w @memmy/teach-mode-plugin
npm test
npm run build
```

Host 首个适配版本为 1.2.3-rc.8；插件同时探测所需 Host 能力。
`/teach` 加载 Record and Replay，明确开始后才录制。结束后等待用户另行请求
Skill Creator 生成技能，生成成功不代表执行成功。Windows 首发，未安装系统 Node 时使用宿主运行时。

本地 ZIP 是开发制品。正式发布须提供 `MEMMY_HOST_RELEASE_DESCRIPTOR`，并设置
`MEMMY_PLUGIN_RELEASE=1`；构建会拒绝未提交修改或未发布的 Host 描述。
源提交、Host 依赖和 SHA-256 随制品保存。仓库与云端发布、真实 Windows 和模型驱动的完整验收
必须有各自证据，不能由单元测试替代。

旧版录制、证据及生成技能在校验复制后启用新目录，原目录作为备份保留。
停用或卸载撤下活动贡献，保留用户数据。首次安装与授权、卸载在插件管理页完成；录制及生成在当前对话完成。
