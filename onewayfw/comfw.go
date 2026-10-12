// comfw.go — Windows 防火墙 (Windows Filtering Platform / Windows Defender 防火墙)
// COM 接口封装。
//
// 单向防火墙的底层实现原理：
//
//	Windows 防火墙的规则判定优先级为：显式 Block 规则 > 显式 Allow 规则 > 默认策略。
//	因此「白名单程序可入站、其余全拦」无法用"加一条 Block 全部 + 白名单 Allow"实现
//	（Block 会压过 Allow）。唯一可靠的方式是：
//	  1. 把所有配置文件的「默认入站动作」设为 Block（本来就是默认）；
//	  2. 把现存的所有"入站 Allow"规则（程序规则/端口规则）停用（记录下来以便还原）；
//	  3. 为白名单程序创建我们托管的"入站 Allow"规则（Allow 优先于默认 Block）；
//	  4. 可选：创建一条 LocalSubnet 范围的"入站 Allow"规则放行局域网。
//	回环流量（127.0.0.1，如 v2rayN 本地代理）不经过防火墙策略判定，完全不受影响。
//
// 所有 COM 调用都在单个专用 OS 线程上串行执行（COM STA 要求），并复用同一个
// INetFwPolicy2 会话；会话在任一步出错时被丢弃并在下次调用时重建，
// 既省掉反复 CreateObject 的开销，又不会复用状态异常的对象。
package main

import (
	"fmt"
	"log"
	"runtime"
	"strings"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

const (
	fwGroup = "OneWayFW" // 我们托管规则的分组标记，用于统一识别与清理

	clsidNetFwPolicy2 = "{E2B3C97F-6AE1-41AC-817A-F6F92166D7DD}"
	iidINetFwPolicy2  = "{98325047-C671-4174-8D81-DEFCD3F03186}"
	clsidNetFwRule    = "{2C5BC43E-3369-4C33-AB0C-BE9469677AF4}"
	iidINetFwRule     = "{AF230D27-BABA-4E42-ACED-F524F22CFCE2}"
)

// 配置文件类型
const (
	profileDomain  = 1 // 域网络
	profilePrivate = 2 // 专用网络（家庭/办公局域网）
	profilePublic  = 4 // 公用网络
	profileAll     = 0x7FFFFFFF
)

// 规则方向 / 动作 / 协议
const (
	dirIn    = 1
	actBlock = 0
	actAllow = 1
	protoTCP = 6
	protoUDP = 17
)

// FwRuleInfo 防火墙规则的只读快照
type FwRuleInfo struct {
	Name        string `json:"name"`
	AppPath     string `json:"appPath"`
	Grouping    string `json:"grouping"`
	Enabled     bool   `json:"enabled"`
	Direction   int32  `json:"direction"` // 1=入站 2=出站
	Action      int32  `json:"action"`    // 0=阻止 1=允许
	Protocol    int32  `json:"protocol"`  // 6=TCP 17=UDP 256=任意
	LocalPorts  string `json:"localPorts"`
	RemoteAddrs string `json:"remoteAddrs"`
	Profiles    int32  `json:"profiles"` // 位掩码：1=域 2=专用 4=公用
}

// ---------------------------------------------------------------------------
// COM 线程模型：所有防火墙 COM 调用经 callCOM 派发到专用 STA 线程串行执行
// ---------------------------------------------------------------------------

var comQueue chan func()

func startCOMWorker() {
	comQueue = make(chan func(), 256)
	go func() {
		runtime.LockOSThread()
		_ = ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED)
		defer ole.CoUninitialize()
		for f := range comQueue {
			f()
		}
	}()
}

// callCOM 把 f 派发到专用 STA 线程串行执行并等待完成。
//
// 关键：f 内部 panic 时必须仍然释放等待方。若只在 f 正常返回后 close(done)，
// 一次 panic 就会让调用方（通常是 HTTP handler）永久阻塞，同时泄漏 goroutine。
func callCOM(f func()) {
	done := make(chan struct{})
	comQueue <- func() {
		defer close(done) // 最后执行
		defer func() {
			if r := recover(); r != nil {
				log.Printf("COM 线程捕获 panic（已忽略，避免整条 COM 通道失效）: %v", r)
			}
		}()
		f()
	}
	<-done
}

// callCOMErr 与 callCOM 类似，但把返回值与 panic 都收敛成 error。
func callCOMErr(f func() error) (err error) {
	done := make(chan struct{})
	comQueue <- func() {
		defer close(done)
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("COM 调用异常: %v", r)
			}
		}()
		err = f()
	}
	<-done
	return
}

// ---------------------------------------------------------------------------
// VARIANT 取值辅助
// ---------------------------------------------------------------------------

func vString(v *ole.VARIANT) string {
	defer v.Clear()
	switch t := v.Value().(type) {
	case string:
		return strings.TrimSpace(t)
	case nil:
		return ""
	default:
		return strings.TrimSpace(fmt.Sprintf("%v", t))
	}
}

func vInt(v *ole.VARIANT) int32 {
	defer v.Clear()
	switch t := v.Value().(type) {
	case int32:
		return t
	case int:
		return int32(t)
	case int64:
		return int32(t)
	case uint32:
		return int32(t)
	default:
		return 0
	}
}

func vBool(v *ole.VARIANT) bool {
	defer v.Clear()
	b, ok := v.Value().(bool)
	return ok && b
}

// ---------------------------------------------------------------------------
// INetFwPolicy2 会话
// ---------------------------------------------------------------------------

type fwPolicy struct {
	policy *ole.IDispatch
	rules  *ole.IDispatch
}

// openFwPolicy 创建 COM 会话；用完必须 Release()
func openFwPolicy() (*fwPolicy, error) {
	unk, err := oleutil.CreateObject(clsidNetFwPolicy2)
	if err != nil {
		return nil, fmt.Errorf("创建防火墙策略 COM 对象失败: %w", err)
	}
	defer unk.Release()
	policy, err := unk.QueryInterface(ole.NewGUID(iidINetFwPolicy2))
	if err != nil {
		return nil, fmt.Errorf("查询 INetFwPolicy2 接口失败（需要管理员权限）: %w", err)
	}
	v, err := oleutil.GetProperty(policy, "Rules")
	if err != nil {
		policy.Release()
		return nil, fmt.Errorf("获取防火墙规则集合失败: %w", err)
	}
	return &fwPolicy{policy: policy, rules: v.ToIDispatch()}, nil
}

func (f *fwPolicy) Release() {
	if f.rules != nil {
		f.rules.Release()
		f.rules = nil
	}
	if f.policy != nil {
		f.policy.Release()
		f.policy = nil
	}
}

// comPolicy 复用中的会话。仅在 COM 专用线程上访问，无需加锁。
var comPolicy *fwPolicy

// withPolicy 在 COM 线程上执行 fn，复用同一个 INetFwPolicy2 会话。
// 一次 Start() 会触发 6 次以上规则枚举，复用可省掉反复 CreateObject +
// GetProperty("Rules") 的开销；任一步返回错误即丢弃会话，下次重建。
func withPolicy(fn func(*fwPolicy) error) error {
	return callCOMErr(func() error {
		if comPolicy == nil {
			p, err := openFwPolicy()
			if err != nil {
				return err
			}
			comPolicy = p
		}
		if err := fn(comPolicy); err != nil {
			comPolicy.Release()
			comPolicy = nil
			return err
		}
		return nil
	})
}

// ---------------------------------------------------------------------------
// 规则枚举 / 增删改
// ---------------------------------------------------------------------------

// ruleSelect 控制枚举每条规则时读取哪些 COM 属性。
// 系统防火墙常有数百至上千条规则，而每条属性的 GetProperty 都是一次跨进程
// COM 调用；按需读取（例如只清理托管规则时只需 Name + Grouping）能显著缩短枚举耗时。
type ruleSelect struct {
	name, appPath, grouping, localPorts, remoteAddrs bool
	enabled, direction, action, protocol, profiles   bool
}

var (
	selAll          = ruleSelect{true, true, true, true, true, true, true, true, true, true}
	selNameGrouping = ruleSelect{name: true, grouping: true}
)

// forEachRule 遍历防火墙内全部规则；sel 决定每条规则读取哪些属性。
// 回调返回错误则中断并向上传递。
func (f *fwPolicy) forEachRule(sel ruleSelect, fn func(disp *ole.IDispatch, info FwRuleInfo) error) error {
	vEnum, err := oleutil.GetProperty(f.rules, "_NewEnum")
	if err != nil {
		return fmt.Errorf("获取规则枚举器失败: %w", err)
	}
	enum, err := vEnum.ToIUnknown().IEnumVARIANT(ole.IID_IEnumVariant)
	if err != nil {
		vEnum.Clear()
		return fmt.Errorf("查询 IEnumVARIANT 失败: %w", err)
	}
	vEnum.Clear()
	defer enum.Release()

	for {
		item, length, err := enum.Next(1)
		if err != nil || length == 0 {
			return nil // 正常遍历结束
		}
		disp := item.ToIDispatch()
		info, err := readRule(disp, sel)
		if err != nil {
			disp.Release()
			continue // 个别系统规则读不了属性，跳过
		}
		if e := fn(disp, info); e != nil {
			disp.Release()
			return e
		}
		disp.Release()
	}
}

// readRule 按 sel 读取规则属性；Name 始终读取（读不到视为无效规则）
func readRule(disp *ole.IDispatch, sel ruleSelect) (FwRuleInfo, error) {
	var info FwRuleInfo
	v, err := oleutil.GetProperty(disp, "Name")
	if err != nil {
		return info, err
	}
	info.Name = vString(v)

	// 快速路径：先读取最轻量且区分度最高的属性
	if sel.grouping {
		if v, e := oleutil.GetProperty(disp, "Grouping"); e == nil {
			info.Grouping = vString(v)
		}
	}
	if sel.direction {
		if v, e := oleutil.GetProperty(disp, "Direction"); e == nil {
			info.Direction = vInt(v)
		}
	}
	if sel.action {
		if v, e := oleutil.GetProperty(disp, "Action"); e == nil {
			info.Action = vInt(v)
		}
	}
	if sel.enabled {
		if v, e := oleutil.GetProperty(disp, "Enabled"); e == nil {
			info.Enabled = vBool(v)
		}
	}

	// 性能关键优化：在全量规则扫描（selAll）判定被停用实例时，
	// 若非托管规则且不是「已启用的入站允许规则」（系统中绝大部分为出站或禁用规则），
	// 无需继续反射读取 ApplicationName、Protocol、LocalPorts 等 5 个耗时属性，节约成千上万次 COM 调用
	if sel.protocol && sel.localPorts && sel.remoteAddrs && sel.profiles {
		if info.Grouping != fwGroup && (info.Direction != dirIn || info.Action != actAllow || !info.Enabled) {
			return info, nil
		}
	}

	if sel.appPath {
		if v, e := oleutil.GetProperty(disp, "ApplicationName"); e == nil {
			info.AppPath = vString(v)
		}
	}
	if sel.protocol {
		if v, e := oleutil.GetProperty(disp, "Protocol"); e == nil {
			info.Protocol = vInt(v)
		}
	}
	if sel.localPorts {
		if v, e := oleutil.GetProperty(disp, "LocalPorts"); e == nil {
			info.LocalPorts = vString(v)
		}
	}
	if sel.remoteAddrs {
		if v, e := oleutil.GetProperty(disp, "RemoteAddresses"); e == nil {
			info.RemoteAddrs = vString(v)
		}
	}
	if sel.profiles {
		if v, e := oleutil.GetProperty(disp, "Profiles"); e == nil {
			info.Profiles = vInt(v)
		}
	}
	return info, nil
}

// ListRules 返回全部规则完整快照
func ListRules() ([]FwRuleInfo, error) {
	var out []FwRuleInfo
	err := withPolicy(func(f *fwPolicy) error {
		return f.forEachRule(selAll, func(_ *ole.IDispatch, info FwRuleInfo) error {
			out = append(out, info)
			return nil
		})
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// removeRulesByName 按名称删除规则（同名全部删除），返回删除条数
func removeRulesByName(name string) (int, error) {
	n := 0
	err := withPolicy(func(f *fwPolicy) error {
		var names []string
		err := f.forEachRule(selNameGrouping, func(_ *ole.IDispatch, info FwRuleInfo) error {
			if info.Name == name {
				names = append(names, info.Name)
			}
			return nil
		})
		if err != nil {
			return err
		}
		var firstErr error
		for _, nm := range names {
			if _, err := oleutil.CallMethod(f.rules, "Remove", nm); err != nil {
				if firstErr == nil {
					firstErr = fmt.Errorf("删除规则[%s]失败: %w", nm, err)
				}
				continue
			}
			n++
		}
		return firstErr
	})
	return n, err
}

// MutateRuleInstances 遍历全部规则实例；回调对每个实例返回目标启用状态
// （nil=不动，true=启用，false=停用），需要变更的实例逐个精确设置。
// 注意：同名规则可能存在多个实例（不同 Profiles），务必按实例指纹判断，
// 严禁按名称批量操作（会把同名但原本就停用的实例误启用）。
func MutateRuleInstances(decide func(info FwRuleInfo) *bool) error {
	return withPolicy(func(f *fwPolicy) error {
		return f.forEachRule(selAll, func(disp *ole.IDispatch, info FwRuleInfo) error {
			want := decide(info)
			if want == nil {
				return nil
			}
			if _, err := oleutil.PutProperty(disp, "Enabled", *want); err != nil {
				return fmt.Errorf("修改规则[%s]失败: %w", info.Name, err)
			}
			return nil
		})
	})
}

// removeManagedRules 删除本工具托管（Grouping == OneWayFW）的全部规则
func removeManagedRules() (int, error) {
	n := 0
	err := withPolicy(func(f *fwPolicy) error {
		var names []string
		err := f.forEachRule(selNameGrouping, func(_ *ole.IDispatch, info FwRuleInfo) error {
			if info.Grouping == fwGroup {
				names = append(names, info.Name)
			}
			return nil
		})
		if err != nil {
			return err
		}
		var firstErr error
		for _, name := range names {
			if _, err := oleutil.CallMethod(f.rules, "Remove", name); err != nil {
				if firstErr == nil {
					firstErr = fmt.Errorf("删除托管规则[%s]失败: %w", name, err)
				}
				continue
			}
			n++
		}
		return firstErr
	})
	return n, err
}

// AddManagedAllowRule 添加一条托管入站放行规则
func AddManagedAllowRule(name, appPath string, proto int32, lanOnly bool) error {
	remote := "*"
	if lanOnly {
		remote = "LocalSubnet,239.255.255.250,224.0.0.251,224.0.0.252"
	}
	return AddManagedAllowRuleScope(name, appPath, proto, remote)
}

// AddManagedAllowRuleScope 添加一条托管入站放行规则，支持自定义 RemoteAddresses 范围
func AddManagedAllowRuleScope(name, appPath string, proto int32, remoteAddresses string) error {
	return withPolicy(func(f *fwPolicy) error {
		// 已存在同名托管规则则跳过（幂等）
		exists := false
		err := f.forEachRule(selNameGrouping, func(_ *ole.IDispatch, info FwRuleInfo) error {
			if info.Grouping == fwGroup && info.Name == name {
				exists = true
			}
			return nil
		})
		if err != nil {
			return err
		}
		if exists {
			return nil
		}

		unk, err := oleutil.CreateObject(clsidNetFwRule)
		if err != nil {
			return fmt.Errorf("创建规则对象失败: %w", err)
		}
		rule, err := unk.QueryInterface(ole.NewGUID(iidINetFwRule))
		if err != nil {
			unk.Release()
			return fmt.Errorf("查询 INetFwRule 失败: %w", err)
		}
		unk.Release()

		protoName := "TCP"
		if proto == protoUDP {
			protoName = "UDP"
		}
		scope := "任意来源"
		if remoteAddresses != "" && remoteAddresses != "*" {
			scope = "指定来源 (" + remoteAddresses + ")"
		}

		// 每个属性都必须检查返回值：Grouping 写失败会让这条规则不被
		// removeManagedRules 识别，还原时就在系统防火墙里留下垃圾规则，
		// 且用户完全无从察觉。因此任何一步失败都整体中止。
		set := func(prop string, value interface{}) error {
			if _, err := oleutil.PutProperty(rule, prop, value); err != nil {
				rule.Release()
				return fmt.Errorf("设置规则属性 %s 失败: %w", prop, err)
			}
			return nil
		}

		if err := set("Name", name); err != nil {
			return err
		}
		if err := set("Description", fmt.Sprintf(
			"单向防火墙白名单放行（%s，%s）— 由 OneWayFW 托管，请勿手工修改", protoName, scope)); err != nil {
			return err
		}
		if appPath != "" {
			if err := set("ApplicationName", appPath); err != nil {
				return err
			}
		}
		if err := set("Protocol", proto); err != nil {
			return err
		}
		if err := set("Direction", int32(dirIn)); err != nil {
			return err
		}
		if err := set("Action", int32(actAllow)); err != nil {
			return err
		}
		if err := set("Enabled", true); err != nil {
			return err
		}
		if err := set("Profiles", int32(profileAll)); err != nil {
			return err
		}
		if err := set("Grouping", fwGroup); err != nil {
			return err
		}
		remote := "*"
		if remoteAddresses != "" {
			remote = remoteAddresses
		}
		if err := set("RemoteAddresses", remote); err != nil {
			return err
		}
		if _, err := oleutil.CallMethod(f.rules, "Add", rule); err != nil {
			rule.Release()
			return fmt.Errorf("添加规则[%s]失败: %w", lastPathSegment(appPath), err)
		}
		rule.Release()
		return nil
	})
}

// ---------------------------------------------------------------------------
// 默认入站策略 / 防火墙开关状态
// ---------------------------------------------------------------------------

func profileName(p int32) string {
	switch p {
	case profileDomain:
		return "域网络"
	case profilePrivate:
		return "专用网络"
	case profilePublic:
		return "公用网络"
	}
	return "未知"
}

// GetDefaultInboundActions 读取三个配置文件的默认入站动作 {profile: 0阻断/1允许}
func GetDefaultInboundActions() (map[string]int32, error) {
	out := map[string]int32{}
	err := withPolicy(func(f *fwPolicy) error {
		for _, p := range []int32{profileDomain, profilePrivate, profilePublic} {
			v, err := oleutil.GetProperty(f.policy, "DefaultInboundAction", p)
			if err != nil {
				return fmt.Errorf("读取 %s 默认入站动作失败: %w", profileName(p), err)
			}
			out[profileName(p)] = vInt(v)
		}
		return nil
	})
	return out, err
}

// SetDefaultInboundAction 设置指定配置文件的默认入站动作
func SetDefaultInboundAction(profile int32, action int32) error {
	return withPolicy(func(f *fwPolicy) error {
		if _, err := oleutil.PutProperty(f.policy, "DefaultInboundAction", profile, action); err != nil {
			return fmt.Errorf("设置 %s 默认入站动作失败: %w", profileName(profile), err)
		}
		return nil
	})
}

// GetFirewallEnabled 读取各配置文件防火墙总开关状态
func GetFirewallEnabled() (map[string]bool, error) {
	out := map[string]bool{}
	err := withPolicy(func(f *fwPolicy) error {
		for _, p := range []int32{profileDomain, profilePrivate, profilePublic} {
			v, err := oleutil.GetProperty(f.policy, "FirewallEnabled", p)
			if err != nil {
				return fmt.Errorf("读取 %s 防火墙开关失败: %w", profileName(p), err)
			}
			out[profileName(p)] = vBool(v)
		}
		return nil
	})
	return out, err
}

// SetFirewallEnabled 开/关指定配置文件的防火墙总开关
func SetFirewallEnabled(profile int32, on bool) error {
	return withPolicy(func(f *fwPolicy) error {
		if _, err := oleutil.PutProperty(f.policy, "FirewallEnabled", profile, on); err != nil {
			return fmt.Errorf("设置 %s 防火墙开关失败: %w", profileName(profile), err)
		}
		return nil
	})
}

func lastPathSegment(path string) string {
	if i := strings.LastIndexAny(path, `\/`); i >= 0 {
		return path[i+1:]
	}
	return path
}
