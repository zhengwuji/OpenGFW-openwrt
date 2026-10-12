// OneWayFW — Windows 单向防火墙（只出不进 + 程序白名单）
//
// 从 OpenGFW 路由器插件的「单向防火墙」（外部连入源 IP 防御）移植到 Windows 桌面端：
//   - 入站默认全拦：外部无法主动连入本机，本机对外访问不受任何影响
//   - 程序白名单：手动添加指定程序，允许其接受入站连接（联机游戏、远程工具等）
//   - 局域网放行（可选）：局域网设备仍可访问本机共享/远程桌面等
//   - 拦截日志：展示谁在试图连入
//   - 一键还原：关闭防护时完整恢复开启前的防火墙状态
//
// 底层使用 Windows 自带防火墙引擎（WFP），不安装驱动、不注入进程、不修改代理。
// 回环流量（127.0.0.1）不经过防火墙策略，v2rayN 等本地代理完全不受影响。
//
// 本程序是原生 Win32 图形界面程序（见 gui.go），双击 exe 即可使用，
// 不启动本地 HTTP 服务、不打开浏览器。
package main

import (
	"flag"
	"log"
	"os"

	"github.com/lxn/walk"
	"github.com/lxn/win"
	"golang.org/x/sys/windows"
)

// 版本号，可用 -ldflags "-X main.version=1.2.3" 在打包时注入。
var version = "1.0.0"

// 全局引擎引用，供界面与关机事件还原防火墙使用
var (
	globalEngine *Engine
	globalStore  *Store
)

func main() {
	var (
		noElevate = flag.Bool("no-elevate", false, "不尝试 UAC 提权（管理员能力缺失时功能受限）")
		dryRun    = flag.Bool("dry-run", false, "演练模式：只读与模拟，不改动防火墙")
		restore   = flag.Bool("restore", false, "紧急还原：一键恢复 Windows 防火墙原状并清理托管规则")
		minimized = flag.Bool("minimized", false, "启动后静默最小化到系统托盘（开机自启动使用）")
	)
	flag.Parse()

	// 无控制台窗口（-H windowsgui 构建），日志写入 %ProgramData%\OneWayFW\onewayfw.log
	initLogging()
	defer closeLogging()

	// 紧急还原模式直接执行，无需单实例检测或 GUI 界面
	if *restore {
		startCOMWorker()
		store, err := NewStore()
		if err != nil {
			walk.MsgBox(nil, appTitle, "读取数据目录失败: "+err.Error(), walk.MsgBoxOK|walk.MsgBoxIconError)
			return
		}
		if err := EmergencyResetDirect(store); err != nil {
			walk.MsgBox(nil, appTitle, "紧急还原失败:\n"+err.Error(), walk.MsgBoxOK|walk.MsgBoxIconError)
			return
		}
		walk.MsgBox(nil, appTitle, "✅ 防火墙已成功紧急还原！\n已恢复系统默认入站策略，并清理所有托管规则。", walk.MsgBoxOK|walk.MsgBoxIconInformation)
		return
	}

	// 单实例互斥
	mutexName, _ := windows.UTF16PtrFromString("OneWayFW_SingleInstance_Mutex")
	if _, err := windows.CreateMutex(nil, false, mutexName); err == windows.ERROR_ALREADY_EXISTS {
		bringExistingToFront()
		walk.MsgBox(nil, appTitle, "OneWayFW 已在运行。", walk.MsgBoxOK|walk.MsgBoxIconInformation)
		return
	}

	// UAC 提权：非管理员时以 runas 重新拉起自身
	if !isElevated() && !*noElevate {
		if exe, e := os.Executable(); e == nil {
			verb, _ := windows.UTF16PtrFromString("runas")
			exePtr, _ := windows.UTF16PtrFromString(exe)
			params := ""
			if *minimized {
				params = "-minimized"
			}
			paramPtr, _ := windows.UTF16PtrFromString(params)
			if err := windows.ShellExecute(0, verb, exePtr, paramPtr, nil, 1 /*SW_SHOWNORMAL*/); err == nil {
				return // 已交给提权实例，本进程退出
			}
			// 提权失败：继续以受限模式运行，界面上会给出提示
		}
	}

	// COM 初始化线程（所有 WFP 调用都在该 STA 线程上执行）
	startCOMWorker()

	// 存储与引擎
	store, err := NewStore()
	if err != nil {
		walk.MsgBox(nil, appTitle, "初始化数据目录失败：\n"+err.Error(), walk.MsgBoxOK|walk.MsgBoxIconError)
		return
	}
	globalStore = store
	globalEngine = NewEngine(store, *dryRun)

	log.Printf("OneWayFW v%s 启动，数据目录 %s，dryRun=%v，elevated=%v, minimized=%v",
		version, storeDir(), *dryRun, isElevated(), *minimized)

	os.Exit(runGUI(*dryRun, *minimized))
}

func isElevated() bool {
	var t windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &t); err != nil {
		return false
	}
	defer t.Close()
	return t.IsElevated()
}

// bringExistingToFront 把已在运行的实例窗口置前（单实例提示时使用）。
func bringExistingToFront() {
	title, err := windows.UTF16PtrFromString(appTitle)
	if err != nil {
		return
	}
	if hwnd := win.FindWindow(nil, title); hwnd != 0 {
		if win.IsIconic(hwnd) {
			win.ShowWindow(hwnd, win.SW_RESTORE)
		}
		win.SetForegroundWindow(hwnd)
	}
}
