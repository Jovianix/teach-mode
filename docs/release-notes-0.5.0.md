# Teach Mode 0.5.0 — 事件教学链路

状态：本地阶段一源码修改，未发布。运行测试、制品联测及真机验收待阶段二完成后统一执行。

- Windows 与 macOS 均使用 Computer History／浏览器扩展事件，经现有 Skill Creator 生成技能。
- 移除旧 Web → Notepad 执行器、`teach_session`、旧面板及插件视频录制适配器；插件不再声明 `recording`、`collector`、`window-focus` 服务。
- 启动时撤下旧执行器生成的技能注册，保留原技能、证据和录像文件；已有事件技能继续按原方式恢复。
- 打包移除旧浏览器、Notepad 脚本和 Playwright 运行依赖。旧 `outputDirectory` 配置不再使用。
- App 的用户主动录屏及系统录屏权限保留。结束教学不自动生成技能，生成不自动执行。

这是旧技能执行入口的退役版本。旧 Web → Notepad 技能需重新通过事件教学生成后使用。
本版本仍要求清单声明的宿主事件、checkpoint、浏览器事件和技能服务能力。
