Teach Mode 0.4.0 开发候选增加 macOS 对话式教学，保留 Windows 流程。

- 同一包声明 Windows、macOS，要求 Host 有序事件 checkpoint 能力。
- 共享 Computer History；结束固定事件片段，用户另行调用 Skill Creator。
- 浏览器教学使用新建窗口，沿用日常资料登录态；只纳入该窗口及浏览器证明的弹窗，不混入后台 History。需要新版 Host 的 `memmy.browser-event-sessions/v1` 与 Memmy 扩展 1.1.0。
- 浏览器来源独立采集点击、当次新增输入、提交与导航；保留窗口外输入及敏感字段排除、停止确认、断连撤销和对话内状态。
- 保留平台权限与采集限制；旧 Web → Notepad 执行器仅支持 Windows。
- CI 增加 Mac，正式发布同时要求两平台的独立真实验收证据。

开发检查不等同 Mac 实机验收。本候选需完成原生编译、安装版权限、真实对话与执行验证后才能正式发布；云端接入仍暂缓。
