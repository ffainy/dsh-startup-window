# dsh-startup-window

<img src="icon.png" width="96" align="right" alt="">

DSH 桌面版每次启动都是 1280×820——窗口尺寸写死在壳的 `createWindow()` 里，也不保存 bounds。
这个插件不改 app.asar，让你在设置里填宽高，启动时自动应用并居中。

## 用法

设置 → **启动窗口**，填宽度和高度（DIP / CSS 像素），勾选「启用」。
下次启动 DSH，主窗口就是这个尺寸。「保存并应用」可以立刻生效，不用重启。

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

## 限制

- 只支持 Windows 桌面版：改尺寸靠 PowerShell 调 Win32 `SetWindowPos`，得和主窗口在同一用户会话。
- 尺寸按当前显示器工作区（已扣任务栏）居中；填得比屏幕还大时自动收进工作区，不会跑到屏幕外。
- 只负责「每次启动套用你填的值」，不会记住你手动拖出来的尺寸。
- 宽高下限 520×600，跟壳自己的 `minWidth`/`minHeight` 一致。

## 实现

- **Host**（`lib/index.js`）：Cordis 插件，注册 `POST /api/dsh-startup-window/apply`；启动时读配置，起一个内联 PowerShell 脚本，按 DPI 换算物理像素后 `SetWindowPos` 到工作区居中位置。
- **Client**（`lib/client.js`）：注册 `settings.section` 插槽，渲染设置页；通过 `ctx.connection.rpc` 调上面的路由。

## License

MIT
