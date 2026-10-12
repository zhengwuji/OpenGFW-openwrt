// fwlog.go — Windows 防火墙「丢弃包日志」开关与读取。
//
// 重要：日志开关必须走系统支持的 API（Set-NetFirewallProfile / Get-NetFirewallProfile）。
// 直接写注册表 HKLM\...\FirewallPolicy\<Profile>\LogDroppedPackets 会被防火墙服务忽略
// （实测 LogBlocked 不随注册表变化），因此这里通过 PowerShell 调用官方 API 读写。
// 日志文件本身是 W3C 扩展格式，解析"连入本机被丢弃"的记录供界面展示。
package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/windows/registry"
)

const defaultFwLogPath = `C:\Windows\system32\LogFiles\Firewall\pfirewall.log`

// fwLogStateTTL 状态查询缓存有效期。
// 界面每 4 秒轮询一次 /api/status，若每次都起一个 powershell.exe 子进程（冷启动约 200-500ms，
// 还会弹 CPU），代价过高且无必要 —— 日志开关是低频变化的状态，缓存 30 秒足够。
const fwLogStateTTL = 30 * time.Second

type DropEntry struct {
	Time    string `json:"time"`
	Proto   string `json:"proto"`
	SrcIP   string `json:"srcIp"`
	SrcPort string `json:"srcPort"`
	DstPort string `json:"dstPort"`
}

type fwProfileLog struct {
	Name       string // Domain / Private / Public
	LogBlocked bool
	LogFile    string
}

var (
	localIPMu  sync.Mutex
	localIPSet = map[string]bool{}
	localIPAt  time.Time
)

var (
	fwLogStateMu    sync.Mutex
	fwLogStateCache fwLogStateEntry
)

type fwLogStateEntry struct {
	enabled bool
	path    string
	err     error
	at      time.Time
}

// localIPs 本机全部单播 IPv4/IPv6 地址（10s 缓存），用于把日志条目判定为"连入本机"
func localIPs() map[string]bool {
	localIPMu.Lock()
	defer localIPMu.Unlock()
	if time.Since(localIPAt) < 10*time.Second {
		return localIPSet
	}
	set := map[string]bool{}
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if ipnet, ok := a.(*net.IPNet); ok && !ipnet.IP.IsLoopback() && !ipnet.IP.IsMulticast() {
				set[ipnet.IP.String()] = true
			}
		}
	}
	localIPSet = set
	localIPAt = time.Now()
	return set
}

func runPS(script string) (string, error) {
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	out, err := cmd.Output()
	return string(out), err
}

// expandWinEnv 展开 Windows 风格的环境变量引用。
// 注册表里的 LogFilePath 常见形式是 "%systemroot%\system32\LogFiles\Firewall\pfirewall.log"，
// 直接当路径 os.Open 必然失败，所以两种写法都要支持。
func expandWinEnv(p string) string {
	if p == "" {
		return ""
	}
	// %VAR% 形式：逐段替换
	if strings.Contains(p, "%") {
		var b strings.Builder
		rest := p
		for {
			i := strings.Index(rest, "%")
			if i < 0 {
				b.WriteString(rest)
				break
			}
			j := strings.Index(rest[i+1:], "%")
			if j < 0 {
				b.WriteString(rest)
				break
			}
			name := rest[i+1 : i+1+j]
			b.WriteString(rest[:i])
			b.WriteString(os.Getenv(name))
			rest = rest[i+1+j+1:]
		}
		p = b.String()
	}
	// $VAR / ${VAR} 形式
	return os.ExpandEnv(p)
}

// queryProfiles 经 Get-NetFirewallProfile 读取三个配置文件的日志状态与日志路径
func queryProfiles() ([]fwProfileLog, error) {
	out, err := runPS(`Get-NetFirewallProfile | Sort-Object Name | ForEach-Object { "{0}|{1}|{2}" -f $_.Name,$_.LogBlocked,$_.LogFileName }`)
	if err != nil {
		return nil, err
	}
	var list []fwProfileLog
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		f := strings.SplitN(strings.TrimSpace(line), "|", 3)
		if len(f) != 3 {
			continue
		}
		list = append(list, fwProfileLog{
			Name:       f[0],
			LogBlocked: f[1] == "True",
			LogFile:    f[2],
		})
	}
	if len(list) == 0 {
		return nil, fmt.Errorf("Get-NetFirewallProfile 无输出")
	}
	return list, nil
}

// GetFwLogState 读取丢弃包日志状态（实时查询，供引擎改动前取原值）。
// enabled 表示所有配置文件都已开启。
func GetFwLogState() (enabled bool, path string, err error) {
	list, err := queryProfiles()
	if err != nil {
		// 兜底：注册表只读（仅供显示，不作为写入通道）
		return readLogStateRegistry()
	}
	enabled = true
	for _, p := range list {
		if !p.LogBlocked {
			enabled = false
		}
		if path == "" && p.LogFile != "" {
			path = p.LogFile
		}
	}
	path = normalizeLogPath(path)
	return enabled, path, nil
}

// GetFwLogStateCached 带缓存的日志状态查询，供界面轮询使用（见 fwLogStateTTL 说明）
func GetFwLogStateCached() (enabled bool, path string, err error) {
	fwLogStateMu.Lock()
	if time.Since(fwLogStateCache.at) < fwLogStateTTL {
		e := fwLogStateCache
		fwLogStateMu.Unlock()
		return e.enabled, e.path, e.err
	}
	fwLogStateMu.Unlock()

	// 查询在锁外执行：PowerShell 冷启动可能几百毫秒，持锁会让并发请求全部排队
	enabled, path, err = GetFwLogState()

	fwLogStateMu.Lock()
	fwLogStateCache = fwLogStateEntry{enabled: enabled, path: path, err: err, at: time.Now()}
	fwLogStateMu.Unlock()
	return enabled, path, err
}

// invalidateFwLogState 改动日志开关后立刻失效缓存，避免界面 30 秒内显示旧状态
func invalidateFwLogState() {
	fwLogStateMu.Lock()
	fwLogStateCache = fwLogStateEntry{}
	fwLogStateMu.Unlock()
}

// normalizeLogPath 展开环境变量并校验；取不到有效路径时回落默认值
func normalizeLogPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return defaultFwLogPath
	}
	path = strings.TrimSpace(expandWinEnv(path))
	if path == "" || !strings.ContainsAny(path, `\/`) {
		return defaultFwLogPath
	}
	return path
}

// SetDroppedLog 将三个配置文件的丢弃包日志统一开/关（Set-NetFirewallProfile -All）。
// orig 首次改动时记录各 profile 原值（还原用）；全部已处于目标状态时不做任何改动。
func SetDroppedLog(on bool, orig *map[string]bool) error {
	if orig == nil {
		return fmt.Errorf("orig 不能为空")
	}
	list, err := queryProfiles()
	if err != nil {
		return err
	}
	needChange := false
	snapshot := map[string]bool{}
	for _, p := range list {
		snapshot[p.Name] = p.LogBlocked
		if p.LogBlocked != on {
			needChange = true
		}
	}
	if !needChange {
		return nil // 全部已是目标状态
	}
	if *orig == nil {
		*orig = snapshot
	}
	flag := "false"
	if on {
		flag = "true"
	}
	_, err = runPS(`Set-NetFirewallProfile -All -LogBlocked ` + flag)
	invalidateFwLogState()
	return err
}

// RestoreDroppedLog 按快照逐 profile 还原日志开关（未记录的 profile 不碰）
func RestoreDroppedLog(orig map[string]bool) error {
	if len(orig) == 0 {
		return nil
	}
	allTrue, allFalse := true, true
	for _, v := range orig {
		if v {
			allFalse = false
		} else {
			allTrue = false
		}
	}
	if allFalse {
		_, err := runPS(`Set-NetFirewallProfile -All -LogBlocked false`)
		invalidateFwLogState()
		return err
	}
	if allTrue {
		_, err := runPS(`Set-NetFirewallProfile -All -LogBlocked true`)
		invalidateFwLogState()
		return err
	}
	for name, v := range orig {
		flag := "false"
		if v {
			flag = "true"
		}
		if _, err := runPS(`Set-NetFirewallProfile -Name ` + name + ` -LogBlocked ` + flag); err != nil {
			invalidateFwLogState()
			return err
		}
	}
	invalidateFwLogState()
	return nil
}

// readLogStateRegistry 注册表兜底读取（不作为写入通道）
func readLogStateRegistry() (bool, string, error) {
	enabled := true
	path := ""
	for _, key := range []string{"DomainProfile", "PrivateProfile", "PublicProfile"} {
		k, err := registry.OpenKey(registry.LOCAL_MACHINE,
			`SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\`+key, registry.QUERY_VALUE)
		if err != nil {
			enabled = false
			continue
		}
		if v, _, err := k.GetIntegerValue("LogDroppedPackets"); err == nil && v == 0 {
			enabled = false
		}
		if path == "" {
			if v, _, err := k.GetStringValue("LogFilePath"); err == nil {
				path = v
			}
		}
		k.Close()
	}
	return enabled, normalizeLogPath(path), nil
}

// ReadDropLog 读取日志文件尾部最近 n 条"连入本机被丢弃"的记录
func ReadDropLog(path string, n int) ([]DropEntry, error) {
	path = normalizeLogPath(path)
	if path == "" {
		return nil, fmt.Errorf("日志未启用或路径为空")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	// 日志可能很大，只读尾部 512KB 再解析
	const tail = 512 * 1024
	truncated := false
	if st, err := f.Stat(); err == nil && st.Size() > int64(tail) {
		if _, err := f.Seek(-int64(tail), io.SeekEnd); err != nil {
			return nil, err
		}
		truncated = true
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}

	ips := localIPs()
	var out []DropEntry
	lines := strings.Split(string(data), "\n")
	for i := len(lines) - 1; i >= 0 && len(out) < n; i-- {
		line := strings.TrimRight(lines[i], "\r")
		// 从文件中间截断读取时，第一行必然是半截行（可能被截在字段中间），
		// 直接丢弃以免把残缺记录当成合法条目。
		if truncated && i == 0 {
			continue
		}
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		// W3C 字段序: date time action protocol src-ip src-port dst-ip dst-port ...
		if len(fields) < 8 || fields[2] != "DROP" {
			continue
		}
		if !ips[fields[6]] { // 目的地址不是本机 → 非连入流量，跳过
			continue
		}
		proto := fields[3]
		if proto == "TCP" || proto == "UDP" {
			out = append(out, DropEntry{
				Time:    fields[0] + " " + fields[1],
				Proto:   proto,
				SrcIP:   fields[4],
				SrcPort: fields[5],
				DstPort: fields[7],
			})
		}
	}
	return out, nil
}
