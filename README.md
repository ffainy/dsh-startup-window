# dsh-startup-window

<img src="icon.png" width="96" align="right" alt="">

DSH 桌面版每次启动都是 1280×820——窗口尺寸写死在壳的 `createWindow()` 里，也不保存 bounds。
这个插件不改 app.asar，让你在设置里填宽高，启动时自动应用并居中。

> **状态：参考实现，建议改用上游。**
> 同样的痛已经有更完整的做法：在渲染进程里于首帧前 `resizeTo`，不需要 PowerShell、跨平台、且能看到
> "上次的尺寸"和位置。实际使用请见 [jue5hen/dsh-window-size](https://github.com/jue5hen/dsh-window-size)
> （npm `dsh-window-size`，支持固定/记忆两模式、比例预设、位置记忆）。
> 这个仓库保留下来作为"Host 侧 PowerShell 改窗口"路线的参考，不再主动维护。

## 用法

设置 → **窗口大小** / **Window size**，填宽度和高度（DIP / CSS 像素）。
下次启动 DSH，主窗口就是这个尺寸。「保存并应用」可以立刻生效，不用重启。

设置页的标题和文案跟随 DSH 的界面语言（中文 / English）自动切换，切语言不用重启。
插件列表里显示的包名 `dsh-startup-window` 来自 `package.json`，不随语言变化。

## 安装

目前得手动装（桌面版的 profile 不接受 CLI 直接管理）：

1. 下载或 clone 这个仓库
2. 整个目录复制到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-startup-window`
3. 打开 `%USERPROFILE%\.dsh\profiles\desktop\package.json`，在 `dsh.profile.bundles` 数组末尾加一项 `"dsh-startup-window"`
4. 重启 DSH

## 配置

写在 `~/.dsh/startup-window/config.json`，插件会自己维护，也可以手改：

```json
{ "enabled": true, "width": 2000, "height": 1200 }
```

文件解析失败时插件会回退到默认值，并把原文件改名成 `config.json.broken-<时间戳>` 保留下来，设置页也会提示。

## 限制

- 只支持 Windows 桌面版：改尺寸靠 PowerShell 调 Win32 `SetWindowPos`，得和主窗口在同一用户会话。
- 尺寸按当前显示器工作区（已扣任务栏）居中；填得比屏幕还大时自动收进工作区，不会跑到屏幕外。
- 只负责「每次启动套用你填的值」，不会记住你手动拖出来的尺寸。
- 宽高下限 520×600，跟壳自己的 `minWidth`/`minHeight` 一致；上限 7680。
- 同时开多个 DSH 实例时，只调整插件自己所在的实例：先按进程祖先链定位，找不到才退回按进程名全机匹配。

## 实现

- **Host**（`lib/index.js`）：Cordis 插件，注册 `POST /api/dsh-startup-window/apply`；启动时读配置，起一个内联 PowerShell 脚本，按 DPI 换算物理像素后 `SetWindowPos` 到工作区居中位置。
- **Client**（`lib/client.js`）：注册 `settings.section` 插槽，渲染设置页；通过 `ctx.connection.rpc` 调上面的路由。
- 语言：客户端插件向 `locale` 服务注册 `startupWindow` 字典（可选——服务不在时退回 `navigator.language`）；不把 `locale` 写进 `exports.inject`，避免服务缺失时整个页面因 inject 门槛而不激活。

## License

MIT
