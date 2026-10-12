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

// listenerModel 展示本机正在监听的端口（procnet.ListListeners）。
type listenerModel struct {
	walk.TableModelBase
	items []Listener
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
		return l.Port
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
	m.items = items
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

	tvWhitelist *walk.TableView
	tvListeners *walk.TableView
	tvLog       *walk.TableView

	mWhitelist *whitelistModel
	mListeners *listenerModel
	mLog       *logModel

	sbStatus *walk.StatusBarItem
	sbInfo   *walk.StatusBarItem

	logPath string
	busy    bool
	closed  bool
}

// runGUI 构建并运行主窗口，返回进程退出码。
func runGUI(dryRun bool) int {
	g := &gui{
		dryRun:     dryRun,
		mWhitelist: &whitelistModel{},
		mListeners: &listenerModel{},
		mLog:       &logModel{},
	}

	icon, err := walk.NewIconFromResourceId(appIconID)
	if err != nil {
		icon = nil // 资源缺失时退回系统默认图标，不阻断启动
	}

	mw := MainWindow{
		AssignTo: &g.mw,
		Title:    appTitle,
		Icon:     icon,
		Size:     Size{Width: 1000, Height: 700},
		MinSize:  Size{Width: 860, Height: 560},
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
						Text:             "允许局域网访问本机",
						ToolTipText:      "勾选后局域网内的设备仍可访问本机共享、远程桌面等；不勾选则只放行本机主动发起的连接。",
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
					g.aboutPage(),
				},
			},
		},
		StatusBarItems: []StatusBarItem{
			{AssignTo: &g.sbStatus, Text: "就绪", Width: 200},
			// walk 的 StatusBar.updateParts 用「累加右边界」计算各段位置，
			// 只有单段时才会写成 -1（自动延伸到最右）。这里给最后一段一个
			// 足够大的宽度，Windows 会把超出客户区的部分裁掉，效果等同于撑满。
			{AssignTo: &g.sbInfo, Text: "", Width: 3000},
		},
	}

	if err := mw.Create(); err != nil {
		walk.MsgBox(nil, appTitle, "窗口创建失败："+err.Error(), walk.MsgBoxOK|walk.MsgBoxIconError)
		return 1
	}

	// 关闭窗口前先还原防火墙
	g.mw.Closing().Attach(func(canceled *bool, reason walk.CloseReason) {
		if globalEngine == nil || globalStore == nil {
			return
		}
		if globalEngine.dryRun || !globalStore.State().Applied {
			return
		}
		// 关机/注销由子类化窗口过程直接处理，这里只处理用户主动关闭
		if reason == walk.CloseReasonUser || reason == walk.CloseReasonUnknown {
			msg := "关闭窗口会同时关闭防护，并把 Windows 防火墙恢复到开启前的状态。\n\n确定关闭吗？"
			if walk.MsgBox(g.mw, appTitle, msg, walk.MsgBoxYesNo|walk.MsgBoxIconQuestion) != win.IDYES {
				*canceled = true
				return
			}
		}
		if err := globalEngine.Stop(); err != nil {
			walk.MsgBox(g.mw, appTitle,
				"还原防火墙时出现问题：\n"+err.Error()+
					"\n\n防护状态已记录，重新启动 OneWayFW 后可再次尝试还原。",
				walk.MsgBoxOK|walk.MsgBoxIconWarning)
		}
	})

	g.installSubclass()
	g.startTimers()

	return g.mw.Run()
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
						Text:      "移除选中",
						MinSize:   Size{Width: 110},
						MaxSize:   Size{Width: 110},
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
					{Title: "备注", Width: 130},
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
					Label{Text: "列出本机正在监听的端口。若某个程序需要被外部主动连接，请把它加入白名单。"},
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
			Label{Text: "提示：关闭本窗口会还原防火墙设置；若程序被强制结束，"},
			Label{Text: "      防护仍在生效，重新启动本程序点击「关闭防护并还原」即可恢复。"},
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
	} else {
		_ = g.lblStatus.SetText("防护未开启：当前为 Windows 防火墙默认策略")
		g.lblStatus.SetTextColor(colorIdle)
		_ = g.btnToggle.SetText("开启防护")
		_ = g.sbStatus.SetText("防护未开启")
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

	// 日志路径（带 30 秒缓存，失败时保持上一次取值）
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

// reloadLog 在后台读取防火墙日志尾部，再回到 UI 线程刷新表格。
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
		logs := time.NewTicker(15 * time.Second) // 拦截日志
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
	if globalStore == nil {
		return
	}
	added, err := globalStore.AddWhitelist(path, "")
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

// walk 不处理 WM_QUERYENDSESSION / WM_ENDSESSION（全包无引用），
// 而 MainWindow 的窗口类由 walk 自己注册，walk 不会对它做子类化
// （walk/window.go:650 只在未注册过的类上安装 defaultWndProc），
// 因此这里可以安全地自行接管窗口过程并在关机/注销时还原防火墙。
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
		// 允许系统继续关机/注销，真正的还原放在 WM_ENDSESSION
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
