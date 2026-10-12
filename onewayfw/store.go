// store.go — 白名单与防火墙改动状态的本地持久化。
// 文件保存在 %ProgramData%\OneWayFW\ 下，exe 被移动/删除也不影响还原。
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type WhitelistEntry struct {
	Path    string `json:"path"`    // exe 完整路径（白名单匹配键，不区分大小写）
	Name    string `json:"name"`    // 显示名（exe 文件名）
	Note    string `json:"note"`    // 备注（来源：手动/进程选择）
	AddedAt string `json:"addedAt"` // 添加时间
}

// RuleFingerprint 规则实例指纹：同名规则在不同配置文件下有多个实例，
// 指纹 = 名称 + Profiles 位掩码 + 协议 + 端口 + 远程地址 + 程序路径。
type RuleFingerprint struct {
	Name        string `json:"name"`
	Profiles    int32  `json:"profiles"`
	Protocol    int32  `json:"protocol"`
	LocalPorts  string `json:"localPorts"`
	RemoteAddrs string `json:"remoteAddrs"`
	AppPath     string `json:"appPath"`
}

// DisabledRuleRecord 一组被本工具停用的同名同指纹实例
type DisabledRuleRecord struct {
	Fp       RuleFingerprint `json:"fp"`
	Ordinals []int           `json:"ordinals"` // 同指纹实例序列中，原本处于启用态的序号（0 基）
}

type AppliedState struct {
	Applied               bool                 `json:"applied"`
	AppliedAt             string               `json:"appliedAt"`
	DisabledRules         []DisabledRuleRecord `json:"disabledRules"`         // 被停用的规则实例（指纹+序号）
	DisabledInstanceCount int                  `json:"disabledInstanceCount"` // 被停用实例总数（仅展示用）
	OrigDefaultIn         map[string]int32     `json:"origDefaultInbound"`    // 各 profile 原默认入站动作
	OrigFirewallEnabled   map[string]bool      `json:"origFirewallEnabled"`   // 原本被关闭、由本工具启用的 profile
	OrigLogDropped        map[string]bool      `json:"origLogDropped"`        // 各 profile 原丢弃包日志开关（仅在被改动时记录）
	OrigLogFilePath       string               `json:"origLogFilePath"`       // 原日志路径（还原校验用）
	LanRuleAdded          bool                 `json:"lanRuleAdded"`          // 是否创建过局域网放行规则
	// PartialRestore 为 true 表示上一次「关闭防护并还原」未能完整还原，
	// 原始记录被完整保留以便重试；此时 Applied 仍为 true，界面必须提示用户。
	PartialRestore bool   `json:"partialRestore"`
	LastError      string `json:"lastError"` // 上一次还原失败的原因（PartialRestore 为 true 时有效）
}

type Config struct {
	MinimizeToTray bool   `json:"minimizeToTray"`
	AutoStart      bool   `json:"autoStart"`
	NotifyOnDrop   bool   `json:"notifyOnDrop"`
	CustomSubnets  string `json:"customSubnets"` // 自定义局域网扩展网段，如 "192.0.2.0/24,198.51.100.0/24"
}

func defaultConfig() Config {
	return Config{
		MinimizeToTray: true,
		AutoStart:      false,
		NotifyOnDrop:   true,
		CustomSubnets:  "",
	}
}

type Store struct {
	mu  sync.Mutex
	dir string
	wl  []WhitelistEntry
	st  AppliedState
	cfg Config
}

func storeDir() string {
	base := os.Getenv("ProgramData")
	if base == "" {
		base = "."
	}
	return filepath.Join(base, "OneWayFW")
}

func NewStore() (*Store, error) {
	s := &Store{dir: storeDir(), cfg: defaultConfig()}
	if err := os.MkdirAll(s.dir, 0755); err != nil {
		return nil, err
	}
	if err := loadJSON(filepath.Join(s.dir, "whitelist.json"), &s.wl); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("读取白名单失败: %w", err)
	}
	// 兼容旧数据：统一把路径规范成反斜杠形式（COM 的 ApplicationName 只认反斜杠）
	for i := range s.wl {
		s.wl[i].Path = normalizeWinPath(s.wl[i].Path)
	}
	if err := loadJSON(filepath.Join(s.dir, "state.json"), &s.st); err != nil && !os.IsNotExist(err) {
		// 旧格式/损坏的状态文件直接忽略（防护视为未开启，避免无法启动）
		s.st = AppliedState{}
	}
	if err := loadJSON(filepath.Join(s.dir, "config.json"), &s.cfg); err != nil && !os.IsNotExist(err) {
		s.cfg = defaultConfig()
	}
	// 同步实际计划任务状态
	s.cfg.AutoStart = CheckAutoStart()
	return s, nil
}

func loadJSON(path string, v interface{}) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func saveJSON(path string, v interface{}) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	// 备份原文件
	bak := path + ".bak"
	if _, err := os.Stat(path); err == nil {
		if old, err := os.ReadFile(path); err == nil {
			_ = os.WriteFile(bak, old, 0644)
		}
	}
	return os.Rename(tmp, path)
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

func (s *Store) Config() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg
}

func (s *Store) SaveConfig(cfg Config) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cfg = cfg
	return saveJSON(filepath.Join(s.dir, "config.json"), s.cfg)
}

// ---------------------------------------------------------------------------
// 开机自启动计划任务（免 UAC 提示）
// ---------------------------------------------------------------------------

const autoStartTaskName = "OneWayFW"

func CheckAutoStart() bool {
	cmd := exec.Command("schtasks", "/query", "/tn", autoStartTaskName)
	return cmd.Run() == nil
}

func SetAutoStart(enable bool) error {
	if enable {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		tr := fmt.Sprintf(`"%s" -minimized`, exe)
		cmd := exec.Command("schtasks", "/create", "/tn", autoStartTaskName, "/tr", tr, "/sc", "onlogon", "/rl", "highest", "/f")
		out, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("创建开机启动任务失败: %s (%w)", strings.TrimSpace(string(out)), err)
		}
		return nil
	} else {
		cmd := exec.Command("schtasks", "/delete", "/tn", autoStartTaskName, "/f")
		_ = cmd.Run()
		return nil
	}
}

// ---------------------------------------------------------------------------
// 白名单
// ---------------------------------------------------------------------------

func (s *Store) Whitelist() []WhitelistEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]WhitelistEntry, len(s.wl))
	copy(out, s.wl)
	return out
}

func (s *Store) WhitelistPaths() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.wl))
	for _, e := range s.wl {
		out = append(out, e.Path)
	}
	return out
}

func (s *Store) InWhitelist(path string) bool {
	if path == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.wl {
		if equalFoldPath(e.Path, path) {
			return true
		}
	}
	return false
}

// AddWhitelist 添加程序（幂等，按路径去重）；返回是否为新添加
func (s *Store) AddWhitelist(path, note string) (bool, error) {
	path = normalizeWinPath(path)
	if path == "" || !fileExists(path) {
		return false, fmt.Errorf("程序文件不存在: %s", path)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.wl {
		if equalFoldPath(e.Path, path) {
			return false, nil
		}
	}
	s.wl = append(s.wl, WhitelistEntry{
		Path:    path,
		Name:    lastPathSegment(path),
		Note:    note,
		AddedAt: time.Now().Format("2006-01-02 15:04:05"),
	})
	return true, saveJSON(filepath.Join(s.dir, "whitelist.json"), s.wl)
}

func (s *Store) RemoveWhitelist(path string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.wl[:0]
	found := false
	for _, e := range s.wl {
		if equalFoldPath(e.Path, path) {
			found = true
			continue
		}
		out = append(out, e)
	}
	if !found {
		return false, nil
	}
	s.wl = out
	return true, saveJSON(filepath.Join(s.dir, "whitelist.json"), s.wl)
}

// ---------------------------------------------------------------------------
// 应用状态（用于停用后还原防火墙）
// ---------------------------------------------------------------------------

func (s *Store) State() AppliedState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st
}

func (s *Store) SaveState(st AppliedState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.st = st
	return saveJSON(filepath.Join(s.dir, "state.json"), s.st)
}

// equalFoldPath Windows 路径不区分大小写的比较。
// 用 strings.EqualFold（Unicode 感知）而不是手写 ASCII 折叠，
// 否则路径里出现非 ASCII 字符（如「桌面」）时大小写判定会出错。
func equalFoldPath(a, b string) bool {
	return strings.EqualFold(a, b)
}

// normalizeWinPath 规范化 Windows 程序路径：去引号、正斜杠转反斜杠、折叠多余分隔符。
// 开头的 UNC 前缀（\\server\share）保持不变。
func normalizeWinPath(p string) string {
	p = strings.TrimSpace(strings.Trim(strings.TrimSpace(p), `"`))
	if p == "" {
		return ""
	}
	p = strings.ReplaceAll(p, "/", "\\")
	// 从第 2 个字符开始折叠连续反斜杠（保留开头的 UNC 前缀与盘符）
	for {
		rest := p[1:]
		i := strings.Index(rest, `\\`)
		if i < 0 {
			break
		}
		p = p[:1+i] + p[2+i:]
	}
	return p
}

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}
