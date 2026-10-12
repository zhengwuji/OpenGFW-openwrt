// OneWayFW 原生图形界面
//
// 使用 github.com/lxn/walk 的 declarative 子包构建纯 Win32 窗口：
// 不启动 HTTP 服务、不打开浏览器，双击 exe 即可使用。
//
// 线程模型：walk 要求所有控件操作都发生在创建窗口的那个 OS 线程上
// （walk/window.go:547 initWindowWithCfg 会 runtime.LockOSThread）。
// 因此本文件中的定时刷新统一在后台 goroutine 采集数据，再通过
// (*walk.MainWindow).Synchronize 把「更新界面」这一步投递回 UI 线程。
package main

import (
	"fmt"
	"log"
	"strings"
	"syscall"
	"time"

	"github.com/lxn/walk"
	. "github.com/lxn/walk/declarative"
	"github.com/lxn/win"
)

const (
	appTitle = "OneWayFW 单向防火墙"
	// appIconID 是 tools/mkrsrc 写入 rsrc_windows_amd64.syso 的 RT_GROUP_ICON 资源 ID。
	// walk 注册窗口类时固定读取资源 ID 7（walk/window.go:488），两者必须一致。
	appIconID = 7
)

var (
	colorOK   = walk.RGB(0x1B, 0x7F, 0x3B) // 绿：防护已开启
	colorIdle = walk.RGB(0x60, 0x60, 0x60) // 灰：防护未开启
	colorWarn = walk.RGB(0xB0, 0x54, 0x00) // 橙：演练模式 / 权限不足
	colorErr  = walk.RGB(0xB0, 0x2A, 0x2A) // 红：还原不完整
)

// ---------------------------------------------------------------- 表格模型

// whitelistModel 展示程序白名单（store.Whitelist()）。
type whitelistModel struct {
	walk.TableModelBase
	items []WhitelistEntry
}

func (m *whitelistModel) RowCount() int { return len(m.items) }

func (m *whitelistModel) Value(row, col int) interface{} {
	if row < 0 || row >= len(m.items) {
		return nil
	}
	e := m.items[row]
	switch col {
	case 0:
		return e.Name
	case 1:
		return e.Path
	case 2:
		return e.Note
	case 3:
		return e.AddedAt
	}
	return nil
}

func (m *whitelistModel) Set(items []WhitelistEntry) {
	m.items = items
	m.PublishRowsReset()
}

func (m *whitelistModel) Item(i int) (WhitelistEntry, bool) {
	if i < 0 || i >= len(m.items) {
		return WhitelistEntry{}, false
	}
	return m.items[i], true
}

// listenerModel 展示正在监听的端口（带实时过滤检索能力）。
type listenerModel struct {
	walk.TableModelBase
	allItems []Listener
	items    []Listener
	filter   string
}

func (m *listenerModel) RowCount() int { return len(m.items) }

func (m *listenerModel) Value(row, col int) interface{} {
	if row < 0 || row >= len(m.items) {
		return nil
	}
	l := m.items[row]
	switch col {
	case 0:
		return l.Proto
	case 1:
		return l.Addr
	case 2:
		return fmt.Sprintf("%d", l.Port)
	case 3:
		return l.ProcName
	case 4:
		return l.Proc
	case 5:
		return l.Whitelisted
	}
	return nil
}

func (m *listenerModel) Set(items []Listener) {
	m.allItems = items
	m.applyFilter()
}

func (m *listenerModel) SetFilter(f string) {
	m.filter = strings.ToLower(strings.TrimSpace(f))
	m.applyFilter()
}

func (m *listenerModel) applyFilter() {
	if m.filter == "" {
		m.items = m.allItems
	} else {
		var filtered []Listener
		for _, l := range m.allItems {
			kw := m.filter
			if strings.Contains(strings.ToLower(l.ProcName), kw) ||
				strings.Contains(strings.ToLower(l.Proc), kw) ||
				strings.Contains(fmt.Sprint(l.Port), kw) ||
				strings.Contains(fmt.Sprint(l.Pid), kw) ||
				strings.Contains(strings.ToLower(l.Proto), kw) {
				filtered = append(filtered, l)
			}
		}
		m.items = filtered
	}
	m.PublishRowsReset()
}

func (m *listenerModel) Item(i int) (Listener, bool) {
	if i < 0 || i >= len(m.items) {
		return Listener{}, false
	}
	return m.items[i], true
}

// logModel 展示被拦截的入站连接（fwlog.ReadDropLog）。
type logModel struct {
	walk.TableModelBase
	items []DropEntry
}

func (m *logModel) RowCount() int { return len(m.items) }

func (m *logModel) Value(row, col int) interface{} {
	if row < 0 || row >= len(m.items) {
		return nil
	}
	e := m.items[row]
	switch col {
	case 0:
		return e.Time
	case 1:
		return e.Proto
	case 2:
		return e.SrcIP
	case 3:
		return e.SrcPort
	case 4:
		return e.DstPort
	}
	return nil
}

func (m *logModel) Set(items []DropEntry) {
	m.items = items
	m.PublishRowsReset()
}

// ---------------------------------------------------------------- GUI 主体

type gui struct {
	mw     *walk.MainWindow
	dryRun bool

	lblStatus *walk.Label
	lblHint   *walk.Label
	btnToggle *walk.PushButton
	cbLan     *walk.CheckBox

	tvWhitelist       *walk.TableView
	tvListeners       *walk.TableView
	tvLog             *walk.TableView
	leFilterListeners *walk.LineEdit

	mWhitelist *whitelistModel
	mListeners *listenerModel
	mLog       *logModel

	sbStatus *walk.StatusBarItem
	sbInfo   *walk.StatusBarItem

	// 系统托盘与后台常驻
	ni              *walk.NotifyIcon
	hasShownTrayTip bool
	forceExit       bool

	// 设置控件
	cbMinimizeToTray *walk.CheckBox
	cbAutoStart      *walk.CheckBox
	cbNotifyOnDrop   *walk.CheckBox
	leCustomSubnets  *walk.LineEdit

	logPath        string
	lastMaxLogTime string
	busy           bool
	closed         bool
}

// runGUI 构建并运行主窗口，返回进程退出码。
func runGUI(dryRun bool, startMinimized bool) int {
	g := &gui{
		dryRun:     dryRun,
		mWhitelist: &whitelistModel{},
		mListeners: &listenerModel{},
		mLog:       &logModel{},
	}

	icon, err := walk.NewIconFromResourceId(appIconID)
	if err != nil {
		icon = nil
	}

	mw := MainWindow{
		AssignTo: &g.mw,
		Title:    appTitle,
		Icon:     icon,
		Size:     Size{Width: 1020, Height: 720},
		MinSize:  Size{Width: 880, Height: 580},
		Layout:   VBox{MarginsZero: false},
		Children: []Widget{
			// ---- 顶部状态条 ----
			Composite{
				Layout: HBox{MarginsZero: true},
				Children: []Widget{
					Label{
						AssignTo:  &g.lblStatus,
						Text:      "正在读取状态…",
						TextColor: colorIdle,
						Font:      Font{Family: "Microsoft YaHei", PointSize: 12, Bold: true},
					},
					HSpacer{},
					CheckBox{
						AssignTo:         &g.cbLan,
						Text:             "允许局域网访问本机（含设备发现与打印机）",
						ToolTipText:      "勾选后局域网内的设备仍可访问本机共享、远程桌面等，并自动放行 SSDP/mDNS/WS-Discovery 设备发现；不勾选则只放行本机主动发起的连接。",
						OnCheckedChanged: func() { g.onLanChanged() },
					},
				},
			},

			// ---- 主操作行 ----
			Composite{
				Layout: HBox{MarginsZero: true},
				Children: []Widget{
					PushButton{
						AssignTo: &g.btnToggle,
						Text:     "开启防护",
						MinSize:  Size{Width: 150},
						MaxSize:  Size{Width: 150},
						OnClicked: func() {
							go g.toggle()
						},
					},
					PushButton{
						Text:    "刷新",
						MinSize: Size{Width: 90},
						MaxSize: Size{Width: 90},
						OnClicked: func() {
							g.refreshStatus()
							g.refreshWhitelist()
							go g.reloadListeners()
							go g.reloadLog()
						},
					},
					HSpacer{},
					Label{AssignTo: &g.lblHint, Text: "", TextColor: colorWarn},
				},
			},

			// ---- 功能页 ----
			TabWidget{
				Pages: []TabPage{
					g.whitelistPage(),
					g.listenerPage(),
					g.logPage(),
					g.settingsPage(),
					g.aboutPage(),
				},
			},
		},
		StatusBarItems: []StatusBarItem{
			{AssignTo: &g.sbStatus, Text: "就绪", Width: 200},
			{AssignTo: &g.sbInfo, Text: "", Width: 3000},
		},
	}

	if err := mw.Create(); err != nil {
		walk.MsgBox(nil, appTitle, "窗口创建失败："+err.Error(), walk.MsgBoxOK|walk.MsgBoxIconError)
		return 1
	}

	// 初始化系统托盘
	g.setupTray(icon)

	// 关闭窗口处理：优先最小化到系统托盘，保持后台防护
	g.mw.Closing().Attach(func(canceled *bool, reason walk.CloseReason) {
		if reason != walk.CloseReasonUser && reason != walk.CloseReasonUnknown {
			return
		}

		if !g.forceExit && globalStore != nil && globalStore.Config().MinimizeToTray {
			*canceled = true
			g.mw.Hide()
			if !g.hasShownTrayTip && g.ni != nil {
				g.hasShownTrayTip = true
				_ = g.ni.ShowInfo("OneWayFW 已最小化到托盘", "单击托盘图标可重新打开主面板，右键托盘图标可查看操作菜单。")
			}
			return
		}

		// 用户主动彻底退出程序时，确认还原防火墙
		if globalEngine != nil && globalStore != nil && !globalEngine.dryRun && globalStore.State().Applied {
			msg := "关闭程序会同时关闭单向防护，并把 Windows 防火墙恢复到开启前的状态。\n\n确定退出程序吗？"
			if walk.MsgBox(g.mw, appTitle, msg, walk.MsgBoxYesNo|walk.MsgBoxIconQuestion) != win.IDYES {
				*canceled = true
				g.forceExit = false
				return
			}
			if err := globalEngine.Stop(); err != nil {
				walk.MsgBox(g.mw, appTitle,
					"还原防火墙时出现问题：\n"+err.Error()+
						"\n\n防护状态已记录，重新启动 OneWayFW 后可再次尝试还原。",
					walk.MsgBoxOK|walk.MsgBoxIconWarning)
			}
		}
	})

	g.installSubclass()
	g.startTimers()

	// 若启动参数指定了 -minimized，则静默隐藏至托盘
	if startMinimized {
		g.mw.Hide()
	}

	return g.mw.Run()
}

// setupTray 初始化 Windows 任务栏系统托盘图标与右键菜单
func (g *gui) setupTray(icon *walk.Icon) {
	ni, err := walk.NewNotifyIcon(g.mw)
	if err != nil {
		log.Printf("创建系统托盘失败: %v", err)
		return
	}
	g.ni = ni
	if icon != nil {
		_ = ni.SetIcon(icon)
	}
	_ = ni.SetToolTip(appTitle)
	_ = ni.SetVisible(true)

	// 单击托盘图标打开主窗口
	ni.MouseDown().Attach(func(x, y int, button walk.MouseButton) {
		if button == walk.LeftButton {
			g.showMainWindow()
		}
	})

	// 托盘右键菜单
	menu := ni.ContextMenu()

	actionShow := walk.NewAction()
	_ = actionShow.SetText("显示主面板")
	actionShow.Triggered().Attach(func() {
		g.showMainWindow()
	})
	_ = menu.Actions().Add(actionShow)

	actionSep1 := walk.NewSeparatorAction()
	_ = menu.Actions().Add(actionSep1)

	actionToggle := walk.NewAction()
	_ = actionToggle.SetText("切换防护状态")
	actionToggle.Triggered().Attach(func() {
		go g.toggle()
	})
	_ = menu.Actions().Add(actionToggle)

	actionRestore := walk.NewAction()
	_ = actionRestore.SetText("紧急还原防火墙")
	actionRestore.Triggered().Attach(func() {
		if walk.MsgBox(g.mw, appTitle, "确定执行紧急还原吗？\n将重置系统默认策略并清除所有 OneWayFW 托管规则。", walk.MsgBoxYesNo|walk.MsgBoxIconQuestion) == win.IDYES {
			go func() {
				err := EmergencyResetDirect(globalStore)
				g.sync(func() {
					g.refreshStatus()
					if err != nil {
						walk.MsgBox(g.mw, appTitle, "紧急还原失败:\n"+err.Error(), walk.MsgBoxOK|walk.MsgBoxIconError)
					} else {
						walk.MsgBox(g.mw, appTitle, "✅ 防火墙已成功紧急还原！", walk.MsgBoxOK|walk.MsgBoxIconInformation)
					}
				})
			}()
		}
	})
	_ = menu.Actions().Add(actionRestore)

	actionSep2 := walk.NewSeparatorAction()
	_ = menu.Actions().Add(actionSep2)

	actionExit := walk.NewAction()
	_ = actionExit.SetText("退出程序")
	actionExit.Triggered().Attach(func() {
		g.exitApp()
	})
	_ = menu.Actions().Add(actionExit)
}

func (g *gui) showMainWindow() {
	g.mw.Show()
	if win.IsIconic(g.mw.Handle()) {
		win.ShowWindow(g.mw.Handle(), win.SW_RESTORE)
	}
	win.SetForegroundWindow(g.mw.Handle())
}

func (g *gui) exitApp() {
	g.forceExit = true
	g.mw.Close()
}

// ---------------------------------------------------------------- 各功能页

func (g *gui) whitelistPage() TabPage {
	return TabPage{
		Title:  "程序白名单",
		Layout: VBox{},
		Children: []Widget{
			Composite{
				Layout: HBox{MarginsZero: true},
				Children: []Widget{
					PushButton{
						Text:      "添加程序…",
						MinSize:   Size{Width: 110},
						MaxSize:   Size{Width: 110},
						OnClicked: func() { g.addProgram() },
					},
					PushButton{
						Text:      "常用服务加白…",
						MinSize:   Size{Width: 125},
						MaxSize:   Size{Width: 125},
						OnClicked: func() { g.showPresetsDialog() },
					},
					PushButton{
						Text:      "移除选中",
						MinSize:   Size{Width: 100},
						MaxSize:   Size{Width: 100},
						OnClicked: func() { g.removeSelectedProgram() },
					},
					HSpacer{},
					Label{Text: "白名单中的程序可以接受外部主动连入（联机游戏、远程工具等）。"},
				},
			},
			TableView{
				AssignTo:            &g.tvWhitelist,
				Model:               g.mWhitelist,
				AlternatingRowBG:    true,
				LastColumnStretched: true,
				Columns: []TableViewColumn{
					{Title: "程序", Width: 170},
					{Title: "路径", Width: 400},
					{Title: "备注", Width: 140},
					{Title: "添加时间", Width: 150},
				},
			},
		},
	}
}

func (g *gui) listenerPage() TabPage {
	return TabPage{
		Title:  "监听端口",
		Layout: VBox{},
		Children: []Widget{
			Composite{
				Layout: HBox{MarginsZero: true},
				Children: []Widget{
					Label{Text: "🔍 检索过滤:"},
					LineEdit{
						AssignTo: &g.leFilterListeners,
						MinSize:  Size{Width: 180},
						MaxSize:  Size{Width: 240},
						ToolTipText: "支持实时按端口、进程名、路径或 PID 过滤检索",
						OnTextChanged: func() {
							if g.mListeners != nil {
								g.mListeners.SetFilter(g.leFilterListeners.Text())
							}
						},
					},
					HSpacer{Size: 8},
					PushButton{
						Text:      "将选中进程加入白名单",
						MinSize:   Size{Width: 170},
						MaxSize:   Size{Width: 170},
						OnClicked: func() { g.whitelistSelectedListener() },
					},
					PushButton{
						Text:      "刷新",
						MinSize:   Size{Width: 90},
						MaxSize:   Size{Width: 90},
						OnClicked: func() { go g.reloadListeners() },
					},
					HSpacer{},
				},
			},
			TableView{
				AssignTo:            &g.tvListeners,
				Model:               g.mListeners,
				AlternatingRowBG:    true,
				LastColumnStretched: true,
				Columns: []TableViewColumn{
					{Title: "协议", Width: 60},
					{Title: "本地地址", Width: 160},
					{Title: "端口", Width: 70, Alignment: AlignFar},
					{Title: "进程", Width: 150},
					{Title: "路径", Width: 340},
					{Title: "已放行", Width: 70, Alignment: AlignCenter,
						FormatFunc: func(v interface{}) string {
							if b, ok := v.(bool); ok && b {
								return "是"
							}
							return ""
						}},
				},
			},
		},
	}
}

func (g *gui) logPage() TabPage {
	return TabPage{
		Title:  "拦截日志",
		Layout: VBox{},
		Children: []Widget{
			Composite{
				Layout: HBox{MarginsZero: true},
				Children: []Widget{
					PushButton{
						Text:      "刷新",
						MinSize:   Size{Width: 90},
						MaxSize:   Size{Width: 90},
						OnClicked: func() { go g.reloadLog() },
					},
					HSpacer{},
					Label{Text: "来自 Windows 防火墙日志（pfirewall.log）的入站拦截记录，最新在最上方。"},
				},
			},
			TableView{
				AssignTo:            &g.tvLog,
				Model:               g.mLog,
				AlternatingRowBG:    true,
				LastColumnStretched: true,
				Columns: []TableViewColumn{
					{Title: "时间", Width: 150},
					{Title: "协议", Width: 70},
					{Title: "来源 IP", Width: 200},
					{Title: "来源端口", Width: 100, Alignment: AlignFar},
					{Title: "目的端口", Width: 100, Alignment: AlignFar},
				},
			},
		},
	}
}

func (g *gui) settingsPage() TabPage {
	cfg := defaultConfig()
	if globalStore != nil {
		cfg = globalStore.Config()
	}

	return TabPage{
		Title:  "偏好设置",
		Layout: VBox{Margins: Margins{Top: 12, Left: 12, Bottom: 12, Right: 12}},
		Children: []Widget{
			GroupBox{
				Title:  "运行与交互设置",
				Layout: VBox{Margins: Margins{Top: 10, Left: 10, Bottom: 10, Right: 10}},
				Children: []Widget{
					CheckBox{
						AssignTo: &g.cbMinimizeToTray,
						Text:     "点击关闭 [X] 时最小化到系统托盘，保持后台守护",
						Checked:  cfg.MinimizeToTray,
						OnCheckedChanged: func() {
							if globalStore != nil {
								c := globalStore.Config()
								c.MinimizeToTray = g.cbMinimizeToTray.Checked()
								_ = globalStore.SaveConfig(c)
							}
						},
					},
					CheckBox{
						AssignTo: &g.cbAutoStart,
						Text:     "开机自动启动（免 UAC 弹窗提示，静默进入托盘）",
						Checked:  cfg.AutoStart,
						OnCheckedChanged: func() {
							if globalStore == nil {
								return
							}
							enable := g.cbAutoStart.Checked()
							if err := SetAutoStart(enable); err != nil {
								walk.MsgBox(g.mw, appTitle, "设置开机启动失败:\n"+err.Error(), walk.MsgBoxOK|walk.MsgBoxIconError)
								g.cbAutoStart.SetChecked(!enable)
								return
							}
							c := globalStore.Config()
							c.AutoStart = enable
							_ = globalStore.SaveConfig(c)
						},
					},
					CheckBox{
						AssignTo: &g.cbNotifyOnDrop,
						Text:     "检测到外部连接被拦截时，在托盘弹出气泡通知",
						Checked:  cfg.NotifyOnDrop,
						OnCheckedChanged: func() {
							if globalStore != nil {
								c := globalStore.Config()
								c.NotifyOnDrop = g.cbNotifyOnDrop.Checked()
								_ = globalStore.SaveConfig(c)
							}
						},
					},
				},
			},
			VSpacer{Size: 6},
			GroupBox{
				Title:  "高级网络与多网卡扩展",
				Layout: VBox{Margins: Margins{Top: 10, Left: 10, Bottom: 10, Right: 10}},
				Children: []Widget{
					Label{Text: "自定义局域网扩展网段（可选，多个网段用逗号分隔，如: 192.0.2.0/24, 198.51.100.0/24）:"},
					Composite{
						Layout: HBox{MarginsZero: true},
						Children: []Widget{
							LineEdit{
								AssignTo: &g.leCustomSubnets,
								Text:     cfg.CustomSubnets,
							},
							PushButton{
								Text:    "保存网段",
								MinSize: Size{Width: 90},
								MaxSize: Size{Width: 90},
								OnClicked: func() {
									if globalStore == nil {
										return
									}
									c := globalStore.Config()
									c.CustomSubnets = strings.TrimSpace(g.leCustomSubnets.Text())
									if err := globalStore.SaveConfig(c); err != nil {
										walk.MsgBox(g.mw, appTitle, "保存失败:\n"+err.Error(), walk.MsgBoxOK|walk.MsgBoxIconError)
									} else {
										walk.MsgBox(g.mw, appTitle, "已保存自定义网段！已即时更新规则。", walk.MsgBoxOK|walk.MsgBoxIconInformation)
										if globalEngine != nil && globalEngine.Running() {
											go func() { _ = globalEngine.ReloadWhitelist(g.cbLan.Checked()) }()
										}
									}
								},
							},
						},
					},
					Label{Text: "适用于拥有虚拟网卡（Hyper-V / WSL2 / VMware）或虚拟内网（Tailscale/ZeroTier）的环境。"},
				},
			},
			VSpacer{Size: 6},
			GroupBox{
				Title:  "容灾与应急重置",
				Layout: VBox{Margins: Margins{Top: 10, Left: 10, Bottom: 10, Right: 10}},
				Children: []Widget{
					Label{Text: "如果系统发生断电或意外强杀导致入站端口无法访问，可随时在此执行一键重置："},
					Composite{
						Layout: HBox{MarginsZero: true},
						Children: []Widget{
							PushButton{
								Text:    "🚨 一键紧急重置防火墙",
								MinSize: Size{Width: 180},
								OnClicked: func() {
									if walk.MsgBox(g.mw, appTitle, "确定要执行紧急还原吗？\n\n将重置 Windows 防火墙默认入站策略，并清理所有 OneWayFW 托管规则。", walk.MsgBoxYesNo|walk.MsgBoxIconWarning) == win.IDYES {
										go func() {
											err := EmergencyResetDirect(globalStore)
											g.sync(func() {
												g.refreshStatus()
												if err != nil {
													walk.MsgBox(g.mw, appTitle, "紧急还原失败:\n"+err.Error(), walk.MsgBoxOK|walk.MsgBoxIconError)
												} else {
													walk.MsgBox(g.mw, appTitle, "✅ 防火墙已成功紧急还原！", walk.MsgBoxOK|walk.MsgBoxIconInformation)
												}
											})
										}()
									}
								},
							},
							HSpacer{},
						},
					},
				},
			},
			VSpacer{},
		},
	}
}

func (g *gui) aboutPage() TabPage {
	return TabPage{
		Title:  "关于",
		Layout: VBox{},
		Children: []Widget{
			Label{Text: fmt.Sprintf("%s  v%s", appTitle, version),
				Font: Font{Family: "Microsoft YaHei", PointSize: 12, Bold: true}},
			Label{Text: "Windows 单向防火墙：入站默认全拦，本机对外访问不受影响。"},
			Label{Text: "底层使用 Windows 自带的 WFP 防火墙引擎，不安装驱动、不注入进程、不修改代理。"},
			Label{Text: "回环流量（127.0.0.1）不经过防火墙策略，v2rayN 等本地代理不受影响。"},
			VSpacer{Size: 8},
			Label{Text: "数据目录：" + storeDir()},
			Label{AssignTo: nil, Text: "日志文件：%ProgramData%\\OneWayFW\\onewayfw.log"},
			VSpacer{Size: 8},
			Label{Text: "提示：可在【偏好设置】开启开机静默启动与托盘常驻守护；"},
			Label{Text: "      若遇异常，随时可通过 OneWayFW.exe -restore 或界面一键紧急还原。"},
		},
	}
}

// ---------------------------------------------------------------- 状态刷新

// sync 把界面更新投递回 UI 线程（窗口已关闭则丢弃）。
func (g *gui) sync(f func()) {
	if g.closed {
		return
	}
	g.mw.Synchronize(f)
}

func (g *gui) refreshStatus() {
	if globalEngine == nil || globalStore == nil {
		return
	}

	running := globalEngine.Running()
	lan := globalEngine.LANAllow()

	if running {
		_ = g.lblStatus.SetText("防护已开启：外部无法主动连入本机")
		g.lblStatus.SetTextColor(colorOK)
		_ = g.btnToggle.SetText("关闭防护并还原")
		_ = g.sbStatus.SetText("防护运行中")
		if g.ni != nil {
			_ = g.ni.SetToolTip("OneWayFW 单向防火墙 - 防护已开启")
		}
	} else {
		_ = g.lblStatus.SetText("防护未开启：当前为 Windows 防火墙默认策略")
		g.lblStatus.SetTextColor(colorIdle)
		_ = g.btnToggle.SetText("开启防护")
		_ = g.sbStatus.SetText("防护未开启")
		if g.ni != nil {
			_ = g.ni.SetToolTip("OneWayFW 单向防火墙 - 防护未开启")
		}
	}

	if g.cbLan.Checked() != lan {
		g.cbLan.SetChecked(lan)
	}

	st := globalStore.State()
	switch {
	case st.PartialRestore:
		_ = g.lblHint.SetText("⚠ 上次还原未完全成功，可重新开启后再关闭以重试")
		g.lblHint.SetTextColor(colorErr)
	case g.dryRun:
		_ = g.lblHint.SetText("演练模式（-dry-run）：不会真正修改防火墙")
		g.lblHint.SetTextColor(colorWarn)
	case !isElevated():
		_ = g.lblHint.SetText("⚠ 当前非管理员权限，无法修改防火墙规则")
		g.lblHint.SetTextColor(colorWarn)
	default:
		_ = g.lblHint.SetText("")
	}

	// 日志路径（带缓存）
	if _, p, err := GetFwLogStateCached(); err == nil && p != "" {
		g.logPath = p
	}
	_ = g.sbInfo.SetText("数据目录：" + storeDir())
}

func (g *gui) refreshWhitelist() {
	if globalStore == nil {
		return
	}
	g.mWhitelist.Set(globalStore.Whitelist())
	if g.tvWhitelist != nil {
		_ = g.tvWhitelist.Invalidate()
	}
}

// reloadListeners 在后台枚举监听端口，再回到 UI 线程刷新表格。
func (g *gui) reloadListeners() {
	if globalStore == nil {
		return
	}
	ls := ListListeners(globalStore.InWhitelist)
	g.sync(func() {
		g.mListeners.Set(ls)
		if g.tvListeners != nil {
			_ = g.tvListeners.Invalidate()
		}
	})
}

// reloadLog 在后台读取防火墙日志尾部，再回到 UI 线程刷新表格并触发气泡提醒。
func (g *gui) reloadLog() {
	path := g.logPath
	if path == "" {
		if _, p, err := GetFwLogStateCached(); err == nil {
			path = p
		}
	}
	if path == "" {
		return
	}
	entries, _ := ReadDropLog(path, 300)
	g.sync(func() {
		// 检测是否有新丢弃条目产生，按需弹气泡通知
		if len(entries) > 0 {
			newest := entries[0]
			if g.lastMaxLogTime != "" && newest.Time > g.lastMaxLogTime {
				if globalStore != nil && globalStore.Config().NotifyOnDrop && g.ni != nil {
					_ = g.ni.ShowInfo("OneWayFW 拦截提醒",
						fmt.Sprintf("已拦截来自 %s:%s 的外部连入请求 (目的端口 %s, %s)",
							newest.SrcIP, newest.SrcPort, newest.DstPort, newest.Proto))
				}
			}
			g.lastMaxLogTime = newest.Time
		}

		g.mLog.Set(entries)
		if g.tvLog != nil {
			_ = g.tvLog.Invalidate()
		}
	})
}

func (g *gui) startTimers() {
	go func() {
		fast := time.NewTicker(3 * time.Second)  // 状态
		slow := time.NewTicker(8 * time.Second)  // 监听端口
		logs := time.NewTicker(12 * time.Second) // 拦截日志
		defer fast.Stop()
		defer slow.Stop()
		defer logs.Stop()

		g.sync(func() {
			g.refreshStatus()
			g.refreshWhitelist()
		})
		g.reloadListeners()
		g.reloadLog()

		for {
			select {
			case <-fast.C:
				g.sync(func() {
					g.refreshStatus()
					g.refreshWhitelist()
				})
			case <-slow.C:
				g.reloadListeners()
			case <-logs.C:
				g.reloadLog()
			}
		}
	}()
}

// ---------------------------------------------------------------- 操作

func (g *gui) setBusy(b bool) {
	g.busy = b
	g.btnToggle.SetEnabled(!b)
}

// toggle 开启或关闭防护。引擎调用会走 COM，放到后台 goroutine 执行。
func (g *gui) toggle() {
	if g.busy || globalEngine == nil || globalStore == nil {
		return
	}
	running := globalEngine.Running()
	lan := g.cbLan.Checked()

	if running {
		msg := "关闭防护会把 Windows 防火墙恢复到开启前的状态：\n" +
			"  • 入站默认策略\n  • 防火墙日志设置\n  • 被本程序停用的已有规则\n\n确定关闭吗？"
		if walk.MsgBox(g.mw, appTitle, msg, walk.MsgBoxYesNo|walk.MsgBoxIconQuestion) != win.IDYES {
			return
		}
	}

	g.sync(func() { g.setBusy(true) })

	go func() {
		var err error
		if running {
			err = globalEngine.Stop()
		} else {
			err = globalEngine.Start(lan)
		}
		g.sync(func() {
			g.setBusy(false)
			g.refreshStatus()
			g.refreshWhitelist()
			if err != nil {
				walk.MsgBox(g.mw, appTitle, "操作失败：\n"+err.Error(),
					walk.MsgBoxOK|walk.MsgBoxIconError)
			}
		})
	}()
}

// onLanChanged 局域网开关变化：防护运行中则热更新规则。
func (g *gui) onLanChanged() {
	if globalEngine == nil || !globalEngine.Running() {
		return
	}
	lan := g.cbLan.Checked()
	go func() {
		err := globalEngine.ReloadWhitelist(lan)
		g.sync(func() {
			g.refreshStatus()
			if err != nil {
				walk.MsgBox(g.mw, appTitle, "更新局域网规则失败：\n"+err.Error(),
					walk.MsgBoxOK|walk.MsgBoxIconError)
			}
		})
	}()
}

// addProgram 通过系统文件对话框选择可执行文件并加入白名单。
func (g *gui) addProgram() {
	dlg := &walk.FileDialog{
		Title:       "选择要放行的程序",
		Filter:      "可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*",
		FilterIndex: 1,
	}
	ok, err := dlg.ShowOpen(g.mw)
	if err != nil {
		walk.MsgBox(g.mw, appTitle, "打开文件对话框失败：\n"+err.Error(), walk.MsgBoxOK|walk.MsgBoxIconError)
		return
	}
	if !ok || dlg.FilePath == "" {
		return
	}
	g.addPath(dlg.FilePath)
}

func (g *gui) addPath(path string) {
	g.addPathWithNote(path, "")
}

func (g *gui) addPathWithNote(path, note string) {
	if globalStore == nil {
		return
	}
	added, err := globalStore.AddWhitelist(path, note)
	if err != nil {
		walk.MsgBox(g.mw, appTitle, "添加失败：\n"+err.Error(), walk.MsgBoxOK|walk.MsgBoxIconError)
		return
	}
	if !added {
		walk.MsgBox(g.mw, appTitle,
			"未能添加：\n"+path+"\n\n文件不存在，或该程序已在白名单中。",
			walk.MsgBoxOK|walk.MsgBoxIconWarning)
		return
	}
	g.refreshWhitelist()
	g.applyWhitelist()
}

func (g *gui) removeSelectedProgram() {
	idx := g.tvWhitelist.CurrentIndex()
	e, ok := g.mWhitelist.Item(idx)
	if !ok {
		walk.MsgBox(g.mw, appTitle, "请先在列表中选择一行。", walk.MsgBoxOK|walk.MsgBoxIconInformation)
		return
	}
	if walk.MsgBox(g.mw, appTitle,
		"确定把下面的程序移出白名单吗？\n\n"+e.Name+"\n"+e.Path,
		walk.MsgBoxYesNo|walk.MsgBoxIconQuestion) != win.IDYES {
		return
	}
	if _, err := globalStore.RemoveWhitelist(e.Path); err != nil {
		walk.MsgBox(g.mw, appTitle, "移除失败：\n"+err.Error(), walk.MsgBoxOK|walk.MsgBoxIconError)
		return
	}
	g.refreshWhitelist()
	g.applyWhitelist()
}

func (g *gui) whitelistSelectedListener() {
	idx := g.tvListeners.CurrentIndex()
	l, ok := g.mListeners.Item(idx)
	if !ok {
		walk.MsgBox(g.mw, appTitle, "请先在列表中选择一行。", walk.MsgBoxOK|walk.MsgBoxIconInformation)
		return
	}
	if l.Proc == "" {
		walk.MsgBox(g.mw, appTitle,
			fmt.Sprintf("无法取得进程 %s（PID %d）的可执行文件路径。", l.ProcName, l.Pid),
			walk.MsgBoxOK|walk.MsgBoxIconWarning)
		return
	}
	if l.Whitelisted {
		walk.MsgBox(g.mw, appTitle, l.ProcName+" 已在白名单中。", walk.MsgBoxOK|walk.MsgBoxIconInformation)
		return
	}
	g.addPath(l.Proc)
}

// showPresetsDialog 常用服务加白快捷对话框
func (g *gui) showPresetsDialog() {
	var dlg *walk.Dialog

	d := Dialog{
		AssignTo: &dlg,
		Title:    "常用服务一键加白",
		MinSize:  Size{Width: 380, Height: 240},
		Layout:   VBox{Margins: Margins{Top: 14, Left: 14, Bottom: 14, Right: 14}},
		Children: []Widget{
			Label{Text: "点击下方按钮，快速将常见服务/联机工具加入放行白名单：", Font: Font{Bold: true}},
			VSpacer{Size: 6},
			PushButton{
				Text: "🖥️ 放行远程桌面 (RDP 3389 / svchost.exe)",
				OnClicked: func() {
					dlg.Accept()
					g.addPresetRDP()
				},
			},
			PushButton{
				Text: "🌐 放行当前监听中的 Web 开发服务 (80/443/8080/3000)",
				OnClicked: func() {
					dlg.Accept()
					g.addPresetWeb()
				},
			},
			PushButton{
				Text: "🎮 放行 Steam 游戏平台客户端",
				OnClicked: func() {
					dlg.Accept()
					g.addPresetSteam()
				},
			},
			VSpacer{},
			PushButton{
				Text:      "取消",
				OnClicked: func() { dlg.Cancel() },
			},
		},
	}
	_, _ = d.Run(g.mw)
}

func (g *gui) addPresetRDP() {
	rdpPath := `C:\Windows\System32\svchost.exe`
	if fileExists(rdpPath) {
		g.addPathWithNote(rdpPath, "Windows 远程桌面服务 (RDP 3389)")
	} else {
		walk.MsgBox(g.mw, appTitle, "未定位到系统 svchost.exe 路径", walk.MsgBoxOK|walk.MsgBoxIconWarning)
	}
}

func (g *gui) addPresetWeb() {
	if globalStore == nil {
		return
	}
	ls := ListListeners(globalStore.InWhitelist)
	count := 0
	targetPorts := map[uint16]bool{80: true, 443: true, 8080: true, 3000: true, 5173: true}
	for _, l := range ls {
		if targetPorts[l.Port] && l.Proc != "" && !l.Whitelisted {
			if added, _ := globalStore.AddWhitelist(l.Proc, fmt.Sprintf("Web服务 (端口 %d)", l.Port)); added {
				count++
			}
		}
	}
	if count > 0 {
		g.refreshWhitelist()
		g.applyWhitelist()
		walk.MsgBox(g.mw, appTitle, fmt.Sprintf("已成功放行 %d 个 Web 开发进程！", count), walk.MsgBoxOK|walk.MsgBoxIconInformation)
	} else {
		walk.MsgBox(g.mw, appTitle, "当前未检测到监听 80/443/8080/3000/5173 的未放行进程。\n若服务已启动，可在【监听端口】标签中直接选中加白。", walk.MsgBoxOK|walk.MsgBoxIconInformation)
	}
}

func (g *gui) addPresetSteam() {
	paths := []string{
		`C:\Program Files (x86)\Steam\steam.exe`,
		`C:\Program Files\Steam\steam.exe`,
		`D:\Steam\steam.exe`,
		`E:\Steam\steam.exe`,
	}
	for _, p := range paths {
		if fileExists(p) {
			g.addPathWithNote(p, "Steam 平台")
			return
		}
	}
	walk.MsgBox(g.mw, appTitle, "未在常见路径中检测到 Steam 安装路径，请使用【添加程序…】手动选择 steam.exe。", walk.MsgBoxOK|walk.MsgBoxIconInformation)
}

// applyWhitelist 在防护运行中把白名单变更热更新到防火墙规则。
func (g *gui) applyWhitelist() {
	if globalEngine == nil || !globalEngine.Running() {
		return
	}
	lan := g.cbLan.Checked()
	go func() {
		if err := globalEngine.ReloadWhitelist(lan); err != nil {
			g.sync(func() {
				walk.MsgBox(g.mw, appTitle, "应用白名单失败：\n"+err.Error(),
					walk.MsgBoxOK|walk.MsgBoxIconError)
			})
		}
	}()
}

// ---------------------------------------------------------------- 关机/注销拦截

var (
	mainWndProcPrev     uintptr
	mainWndProcCallback = syscall.NewCallback(mainWndProc)
)

func (g *gui) installSubclass() {
	hwnd := g.mw.Handle()
	if hwnd == 0 {
		return
	}
	mainWndProcPrev = win.SetWindowLongPtr(hwnd, win.GWLP_WNDPROC, mainWndProcCallback)
}

func mainWndProc(hwnd win.HWND, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case win.WM_QUERYENDSESSION:
		return 1
	case win.WM_ENDSESSION:
		if wParam != 0 {
			emergencyRestore()
		}
	}
	return win.CallWindowProc(mainWndProcPrev, hwnd, msg, wParam, lParam)
}

// emergencyRestore 在系统关机/注销时同步还原防火墙（尽力而为）。
func emergencyRestore() {
	if globalEngine == nil || globalStore == nil {
		return
	}
	if globalEngine.dryRun || !globalStore.State().Applied {
		return
	}
	_ = globalEngine.Stop()
}
