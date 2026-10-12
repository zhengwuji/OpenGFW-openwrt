// procnet.go — 本机监听端口与进程枚举。
// 用于「监听视图」：谁在本机开了端口等外部连入 —— 这些就是单向防火墙要拦的目标。
package main

import (
	"encoding/binary"
	"fmt"
	"net"
	"sort"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type Listener struct {
	Proto       string `json:"proto"` // TCP / TCP6 / UDP / UDP6
	Addr        string `json:"addr"`
	Port        uint16 `json:"port"`
	Pid         uint32 `json:"pid"`
	Proc        string `json:"proc"`        // exe 完整路径（取不到则为进程名或空）
	ProcName    string `json:"procName"`    // exe 文件名
	Whitelisted bool   `json:"whitelisted"` // 是否在白名单内
}

type ProcInfo struct {
	Pid      uint32 `json:"pid"`
	Name     string `json:"name"`
	Path     string `json:"path"`
	Listener bool   `json:"listener"` // 是否有监听端口
}

var (
	modiphlpapi          = windows.NewLazySystemDLL("iphlpapi.dll")
	procGetExtendedTcp   = modiphlpapi.NewProc("GetExtendedTcpTable")
	procGetExtendedUdp   = modiphlpapi.NewProc("GetExtendedUdpTable")
	modkernel32          = windows.NewLazySystemDLL("kernel32.dll")
	procQueryFullProcImg = modkernel32.NewProc("QueryFullProcessImageNameW")
)

const (
	tcpTableOwnerListener = 3
	udpTableOwnerPid      = 1
	mibTcpStateListen     = 2
	processQueryLimited   = 0x1000

	afInet  = 2  // AF_INET
	afInet6 = 23 // AF_INET6

	// pidPathCache 上限：超过后清理过期项，仍超则整体丢弃（缓存可重建，不占常驻内存）
	pidPathCacheMax = 4096
	pidPathCacheTTL = 10 * time.Second
)

// MIB_TCPROW_OWNER_PID / MIB_UDPROW_OWNER_PID 内存布局（iphlpapi 原生结构）
type mibTcpRowOwnerPid struct {
	State      uint32
	LocalAddr  [4]byte
	LocalPort  uint32
	RemoteAddr [4]byte
	RemotePort uint32
	OwningPid  uint32
}

type mibUdpRowOwnerPid struct {
	LocalAddr [4]byte
	LocalPort uint32
	OwningPid uint32
}

// MIB_TCP6ROW_OWNER_PID —— 注意字段顺序与 v4 不同：State 在 RemotePort 之后
type mibTcp6RowOwnerPid struct {
	LocalAddr     [16]byte
	LocalScopeId  uint32
	LocalPort     uint32
	RemoteAddr    [16]byte
	RemoteScopeId uint32
	RemotePort    uint32
	State         uint32
	OwningPid     uint32
}

type mibUdp6RowOwnerPid struct {
	LocalAddr    [16]byte
	LocalScopeId uint32
	LocalPort    uint32
	OwningPid    uint32
}

var (
	pidPathMu    sync.Mutex
	pidPathCache = map[uint32]pathEntry{}
)

type pathEntry struct {
	path string
	at   time.Time
}

// ntohs MIB 表里的端口按网络字节序存放在低 16 位，需转主机字节序
func ntohs(v uint32) uint16 {
	raw := make([]byte, 4)
	binary.LittleEndian.PutUint32(raw, v)
	return binary.BigEndian.Uint16(raw[:2])
}

// v4Addr 把 4 字节 MIB 地址转成点分十进制
func v4Addr(a [4]byte) string {
	return fmt.Sprintf("%d.%d.%d.%d", a[0], a[1], a[2], a[3])
}

// v6Addr 把 16 字节 MIB 地址转成标准 IPv6 文本；
// 链路本地地址带 scope id 时按 Windows 习惯追加 %scope（否则同一地址无法区分网卡）。
func v6Addr(a [16]byte, scope uint32) string {
	ip := net.IP(a[:])
	s := ip.String()
	if scope != 0 && ip.IsLinkLocalUnicast() {
		s = fmt.Sprintf("%s%%%d", s, scope)
	}
	return s
}

// queryTable 调用 GetExtendedTcpTable / GetExtendedUdpTable 的两段式取表：
// 先问所需字节数，再取数据。返回的切片第 0..3 字节是行数。
func queryTable(proc *windows.LazyProc, family uintptr, tableClass uintptr) ([]byte, bool) {
	var size uint32
	// 第一次调用只问大小，预期返回 ERROR_INSUFFICIENT_BUFFER(122)
	proc.Call(0, uintptr(unsafe.Pointer(&size)), 0, family, tableClass)
	if size < 4 {
		return nil, false
	}
	buf := make([]byte, size)
	r1, _, _ := proc.Call(
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&size)),
		0,
		family,
		tableClass,
	)
	if r1 != 0 {
		return nil, false
	}
	return buf, true
}

// rowCount 取表头的行数
func rowCount(buf []byte) int {
	return int(*(*uint32)(unsafe.Pointer(&buf[0])))
}

// ListListeners 返回当前所有监听中的 TCP/UDP 端口（v4 + v6），附带进程路径与白名单标记
func ListListeners(isWhitelisted func(string) bool) []Listener {
	var out []Listener

	addTcp4 := func() {
		buf, ok := queryTable(procGetExtendedTcp, afInet, tcpTableOwnerListener)
		if !ok {
			return
		}
		rowSize := unsafe.Sizeof(mibTcpRowOwnerPid{})
		for i := 0; i < rowCount(buf); i++ {
			row := (*mibTcpRowOwnerPid)(unsafe.Pointer(&buf[4+uintptr(i)*rowSize]))
			if row.State != mibTcpStateListen {
				continue
			}
			out = append(out, buildListener("TCP", v4Addr(row.LocalAddr), ntohs(row.LocalPort), row.OwningPid, isWhitelisted))
		}
	}

	addTcp6 := func() {
		buf, ok := queryTable(procGetExtendedTcp, afInet6, tcpTableOwnerListener)
		if !ok {
			return
		}
		rowSize := unsafe.Sizeof(mibTcp6RowOwnerPid{})
		for i := 0; i < rowCount(buf); i++ {
			row := (*mibTcp6RowOwnerPid)(unsafe.Pointer(&buf[4+uintptr(i)*rowSize]))
			if row.State != mibTcpStateListen {
				continue
			}
			out = append(out, buildListener("TCP6", v6Addr(row.LocalAddr, row.LocalScopeId), ntohs(row.LocalPort), row.OwningPid, isWhitelisted))
		}
	}

	addUdp4 := func() {
		buf, ok := queryTable(procGetExtendedUdp, afInet, udpTableOwnerPid)
		if !ok {
			return
		}
		rowSize := unsafe.Sizeof(mibUdpRowOwnerPid{})
		for i := 0; i < rowCount(buf); i++ {
			row := (*mibUdpRowOwnerPid)(unsafe.Pointer(&buf[4+uintptr(i)*rowSize]))
			out = append(out, buildListener("UDP", v4Addr(row.LocalAddr), ntohs(row.LocalPort), row.OwningPid, isWhitelisted))
		}
	}

	addUdp6 := func() {
		buf, ok := queryTable(procGetExtendedUdp, afInet6, udpTableOwnerPid)
		if !ok {
			return
		}
		rowSize := unsafe.Sizeof(mibUdp6RowOwnerPid{})
		for i := 0; i < rowCount(buf); i++ {
			row := (*mibUdp6RowOwnerPid)(unsafe.Pointer(&buf[4+uintptr(i)*rowSize]))
			out = append(out, buildListener("UDP6", v6Addr(row.LocalAddr, row.LocalScopeId), ntohs(row.LocalPort), row.OwningPid, isWhitelisted))
		}
	}

	addTcp4()
	addTcp6()
	addUdp4()
	addUdp6()

	sortListeners(out)
	return out
}

// listeningPids 一次取全部监听表，汇总成 PID 集合。
// 单独抽出来是因为 ListProcesses 需要对成百上千个进程判断「有没有监听」，
// 若每个 PID 都重跑一遍取表，就是 O(进程数 × 取表) 的平方级开销。
func listeningPids() map[uint32]bool {
	set := map[uint32]bool{}

	// TCP：只统计 Listen 状态的行（4 个表结构两两成对，分别处理）
	collectTcp := func(family uintptr, is6 bool) {
		buf, ok := queryTable(procGetExtendedTcp, family, tcpTableOwnerListener)
		if !ok {
			return
		}
		if is6 {
			rowSize := unsafe.Sizeof(mibTcp6RowOwnerPid{})
			for i := 0; i < rowCount(buf); i++ {
				row := (*mibTcp6RowOwnerPid)(unsafe.Pointer(&buf[4+uintptr(i)*rowSize]))
				if row.State == mibTcpStateListen {
					set[row.OwningPid] = true
				}
			}
			return
		}
		rowSize := unsafe.Sizeof(mibTcpRowOwnerPid{})
		for i := 0; i < rowCount(buf); i++ {
			row := (*mibTcpRowOwnerPid)(unsafe.Pointer(&buf[4+uintptr(i)*rowSize]))
			if row.State == mibTcpStateListen {
				set[row.OwningPid] = true
			}
		}
	}

	// UDP：没有连接状态，绑定即视为监听
	collectUdp := func(family uintptr, is6 bool) {
		buf, ok := queryTable(procGetExtendedUdp, family, udpTableOwnerPid)
		if !ok {
			return
		}
		if is6 {
			rowSize := unsafe.Sizeof(mibUdp6RowOwnerPid{})
			for i := 0; i < rowCount(buf); i++ {
				row := (*mibUdp6RowOwnerPid)(unsafe.Pointer(&buf[4+uintptr(i)*rowSize]))
				set[row.OwningPid] = true
			}
			return
		}
		rowSize := unsafe.Sizeof(mibUdpRowOwnerPid{})
		for i := 0; i < rowCount(buf); i++ {
			row := (*mibUdpRowOwnerPid)(unsafe.Pointer(&buf[4+uintptr(i)*rowSize]))
			set[row.OwningPid] = true
		}
	}

	collectTcp(afInet, false)
	collectTcp(afInet6, true)
	collectUdp(afInet, false)
	collectUdp(afInet6, true)
	return set
}

func buildListener(proto, addr string, port uint16, pid uint32, isWhitelisted func(string) bool) Listener {
	l := Listener{Proto: proto, Addr: addr, Port: port, Pid: pid}
	l.Proc, l.ProcName = pathOfPid(pid)
	l.Whitelisted = l.Proc != "" && isWhitelisted(l.Proc)
	return l
}

func sortListeners(ls []Listener) {
	sort.Slice(ls, func(i, j int) bool { return listenerLess(ls[i], ls[j]) })
}

func listenerLess(a, b Listener) bool {
	if a.ProcName != b.ProcName {
		return a.ProcName < b.ProcName
	}
	if a.Port != b.Port {
		return a.Port < b.Port
	}
	return a.Proto < b.Proto
}

// pathOfPid 进程 PID → exe 完整路径（带 10s 缓存）
func pathOfPid(pid uint32) (path, name string) {
	if pid == 0 {
		return "", ""
	}
	pidPathMu.Lock()
	if e, ok := pidPathCache[pid]; ok && time.Since(e.at) < pidPathCacheTTL {
		pidPathMu.Unlock()
		return e.path, lastPathSegment(e.path)
	}
	pidPathMu.Unlock()

	if h, err := windows.OpenProcess(processQueryLimited, false, pid); err == nil {
		buf := make([]uint16, 1024)
		size := uint32(len(buf))
		r1, _, _ := procQueryFullProcImg.Call(
			uintptr(h),
			0,
			uintptr(unsafe.Pointer(&buf[0])),
			uintptr(unsafe.Pointer(&size)),
		)
		windows.CloseHandle(h)
		if r1 != 0 && size > 0 && int(size) <= len(buf) {
			path = windows.UTF16ToString(buf[:size])
		}
	}
	if path == "" {
		// 取不到路径（权限/系统进程），用进程名兜底
		if e := procImageFallback(pid); e != "" {
			path = e
		}
	}
	pidPathMu.Lock()
	// 有上限地写缓存：过期项优先清，仍满则整体重建，避免长期运行后无限增长
	if len(pidPathCache) >= pidPathCacheMax {
		for k, v := range pidPathCache {
			if time.Since(v.at) >= pidPathCacheTTL {
				delete(pidPathCache, k)
			}
		}
		if len(pidPathCache) >= pidPathCacheMax {
			pidPathCache = map[uint32]pathEntry{}
		}
	}
	pidPathCache[pid] = pathEntry{path: path, at: time.Now()}
	pidPathMu.Unlock()
	return path, lastPathSegment(path)
}

// procImageFallback 用 Toolhelp 快照取进程名（无路径）
func procImageFallback(pid uint32) string {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(snap)
	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	if err := windows.Process32First(snap, &pe); err != nil {
		return ""
	}
	for {
		if pe.ProcessID == pid {
			return windows.UTF16ToString(pe.ExeFile[:])
		}
		if err := windows.Process32Next(snap, &pe); err != nil {
			return ""
		}
	}
}

// ListProcesses 枚举全部运行中进程（供「从运行中的进程添加白名单」选择），有监听端口的排前面
func ListProcesses() []ProcInfo {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snap)

	// 先一次性取全部监听 PID，避免对每个进程重复取表
	listening := listeningPids()

	var out []ProcInfo
	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	if err := windows.Process32First(snap, &pe); err != nil {
		return nil
	}
	for {
		p := ProcInfo{Pid: pe.ProcessID, Name: windows.UTF16ToString(pe.ExeFile[:])}
		p.Path, _ = pathOfPid(p.Pid)
		if p.Path == "" {
			p.Path = p.Name
		}
		p.Listener = listening[p.Pid]
		p.Name = lastPathSegment(p.Path)
		out = append(out, p)
		if err := windows.Process32Next(snap, &pe); err != nil {
			break
		}
	}
	sortProcs(out)
	return out
}

func sortProcs(ps []ProcInfo) {
	sort.Slice(ps, func(i, j int) bool { return procLess(ps[i], ps[j]) })
}

func procLess(a, b ProcInfo) bool {
	if a.Listener != b.Listener {
		return a.Listener // 有监听的排前面
	}
	return strings.ToLower(a.Name) < strings.ToLower(b.Name)
}
