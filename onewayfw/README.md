# OneWayFW — Windows 单向防火墙（只出不进 + 程序白名单）

从本项目路由器版「单向防火墙」（外部连入源 IP 防御）移植的 Windows 桌面版：
**本机可以正常上网/下载/联机，但外部无法主动连入本机；白名单程序例外。**

程序是原生 Win32 图形界面（`github.com/lxn/walk`），双击 exe 即用：
不启动本地 HTTP 服务、不打开浏览器、不常驻托盘后台。

## 功能

| 功能 | 说明 |
| --- | --- |
| 入站单向拦截 | 一键开启：所有网络配置文件（域/专用/公用）默认入站动作设为「阻止」，并停用现存的其他程序「入站放行」规则 |
| 程序白名单 | 手动添加指定程序（文件选择框 / 运行中进程选择），白名单程序允许被外部连入（联机游戏、远程工具、投屏等） |
| 局域网放行（可选） | 创建 `LocalSubnet` 范围的入站放行规则，局域网设备仍可访问本机共享/远程桌面等，互联网方向依旧全拦 |
| 本机监听端口视图 | 实时列出谁在本机开端口等待连入（PID→程序路径解析），一键加入白名单 |
| 入站拦截日志 | 自动开启防火墙「丢弃包日志」，展示谁试图连入被拦（来源 IP/端口/协议/目标端口） |
| 一键完整还原 | 关闭防护时：恢复默认入站策略、按「指纹+序号」精确恢复被停用的规则实例、删除托管规则、还原防火墙总开关与日志开关 |

## 实现原理（不装驱动、不注入、不动代理）

底层完全使用 **Windows 自带防火墙引擎（WFP，经 COM 接口 `INetFwPolicy2` 管理）**：

- Windows 防火墙判定优先级：显式 Block > 显式 Allow > 默认策略。因此「白名单可入站、其余全拦」采用
  「默认入站=阻止 + 停用其他入站放行规则 + 白名单程序创建托管 Allow 规则」实现；
- 白名单程序的原有放行规则保留不动，并额外创建 `OneWayFW Allow TCP/UDP - 程序名` 托管规则兜底；
- **回环流量（127.0.0.1）不经过防火墙策略**：v2rayN、WARP 等本地代理监听与出站流量完全不受影响；
- **出站方向零改动**；
- 所有改动记录在 `%ProgramData%\OneWayFW\state.json`，异常退出后再次启动仍可「关闭防护」完整还原；
- 停用/恢复按「规则指纹（名称+Profiles+协议+端口+远程地址+程序路径）+ 同指纹实例序号」逐实例精确操作，
  避免同名规则在不同配置文件下的多实例被误启用/误停用。

## 编译

```
cd onewayfw
go build -trimpath -ldflags "-H windowsgui -s -w -X main.version=1.0.0" -o OneWayFW.exe .
```

要求：Windows 10/11，Go ≥ 1.24。依赖 `github.com/go-ole/go-ole`、`golang.org/x/sys`、
`github.com/lxn/walk`（均纯 Go，无 CGO，`CGO_ENABLED=0` 可构建）。

`-H windowsgui` 是必需的：它让链接器把子系统标记为 GUI，双击 exe 不会弹出黑色控制台窗口。
运行时日志写入 `%ProgramData%\OneWayFW\onewayfw.log`。

窗口图标来自 `rsrc_windows_amd64.syso`（由 `OneWayFW.ico` + `OneWayFW.manifest` 生成）。
**注意 `tools/mkrsrc` 把 RT_GROUP_ICON 资源 ID 固定为 7**，因为 walk 注册窗口类时写死了
`win.LoadIcon(hInst, win.MAKEINTRESOURCE(7))`（`walk/window.go:488`）。重新生成：

```
cd onewayfw/tools/mkrsrc
go run . -manifest ../../OneWayFW.manifest -ico ../../OneWayFW.ico -o ../../rsrc_windows_amd64.syso
```

## 使用

1. 双击 `OneWayFW.exe`（自动请求管理员权限，UAC 点「是」）；
2. 在「程序白名单」页添加需要被外部连入的程序；
3. 点「开启防护」。需要局域网设备继续访问本机时，勾选「允许局域网访问本机」；
4. 不用时点「关闭防护并还原」，或在「关闭窗口」时确认还原，防火墙回到开启前原样。

命令行参数：`-no-elevate`（不尝试 UAC 提权）、`-dry-run`（演练：只读+模拟，不改防火墙）。

## 注意事项

- 需要 Windows 防火墙服务正常运行；被关闭的配置文件总开关会在开启防护时自动启用（还原时恢复原状）；
- 修改的是系统防火墙策略，与第三方杀软的防火墙模块相互独立、不冲突也不替代；
- **防护状态保存在 Windows 防火墙自身**，因此程序不必常驻后台：即使 exe 被强制结束，防护依然生效；
  重新启动后点「关闭防护并还原」即可恢复。但界面、拦截日志、监听端口视图、白名单热更新需要程序在运行；
- 关机/注销时会自动还原防火墙（窗口子类化拦截 `WM_QUERYENDSESSION`/`WM_ENDSESSION`）；
- 默认入站策略若原本就是「阻止」（NotConfigured 继承默认），本工具不做任何改动（零改动原则）。
