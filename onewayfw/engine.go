// engine.go — 单向防火墙核心引擎：开启（apply）/ 还原（restore）/ 白名单变更热更新。
//
// 开启流程（详见 comfw.go 头部注释）：
//  1. 记录现场：各配置文件默认入站动作、丢弃包日志开关
//  2. 将默认入站动作全部设为「阻止」
//  3. 停用所有现存「入站允许」规则（白名单程序的除外），记录被停用名单
//  4. 为白名单程序创建托管「入站允许」规则（TCP+UDP 各一条）
//  5. 可选：创建局域网放行规则（LocalSubnet → 允许）
//
// 还原流程完全逆向：重新启用被停用规则 → 删除托管规则 → 恢复默认入站动作 → 恢复日志开关。
//
// 两条不变式（任何改动都必须保持）：
//   - Start 中途失败必须回滚到开启前状态，不能留下半开状态；
//   - Stop 只有在「现场确实已还原」之后才允许清空 state.json 里的原始记录，
//     否则用户将永久失去还原防火墙的能力。
package main

import (
	"fmt"
	"hash/fnv"
	"log"
	"strings"
	"sync"
	"time"
)

type Engine struct {
	store  *Store
	dryRun bool
	lan    bool // 局域网放行

	mu sync.Mutex // 串行化 Start/Stop/ReloadWhitelist，避免并发读写 state.json
}

func NewEngine(store *Store, dryRun bool) *Engine {
	e := &Engine{store: store, dryRun: dryRun}
	// 程序重启后恢复防护运行态的局域网放行标志（以 state.json 为准）
	if st := store.State(); st.Applied {
		e.lan = st.LanRuleAdded
	}
	return e
}

// Running 返回当前是否处于防护中（以 state.json 为准）
func (e *Engine) Running() bool { return e.store.State().Applied }

// LANAllow 当前局域网放行状态
func (e *Engine) LANAllow() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.lan
}

// ruleNameForApp 生成托管规则名。
// 使用完整 32 位 FNV-1a 摘要：早期版本截断到 16 位（&0xffff），只有 65536 种取值，
// 白名单约 300 个程序时按生日问题碰撞概率已接近 50%，一旦碰撞两个程序会共用规则名，
// 删除其中一个会连带删掉另一个。
func ruleNameForApp(appPath string, proto int32) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(strings.ToLower(appPath)))
	return fmt.Sprintf("OneWayFW Allow %s - %s-%08x", protoName(proto), lastPathSegment(appPath), h.Sum32())
}

const lanRuleBase = "OneWayFW Allow LocalSubnet"

func lanRuleName(proto int32) string { return fmt.Sprintf("%s %s", lanRuleBase, protoName(proto)) }

func protoName(p int32) string {
	if p == protoUDP {
		return "UDP"
	}
	return "TCP"
}

// ---------------------------------------------------------------------------
// 开启
// ---------------------------------------------------------------------------

// Start 开启单向防护。lan：是否放行局域网来源。
//
// 采用「先记录意图 → 逐项执行 → 任一步失败即整体回滚」的模型：
// 任何一步出错都调用 rollback，把已经改掉的防火墙项恢复原样，
// 避免用户看到"开启失败"却发现防火墙已被改了一半。
func (e *Engine) Start(lan bool) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.dryRun {
		log.Printf("[dry-run] Start(lan=%v) — 仅模拟，不改动防火墙", lan)
		e.lan = lan
		return nil
	}
	if e.Running() {
		return fmt.Errorf("防护已在运行中，请先关闭")
	}

	st := AppliedState{}

	// rollback 在 Start 失败时把已完成的改动逆序撤销。
	// 只撤销「确实已执行成功」的步骤，未执行的步骤是空操作。
	rollback := func(cause error) error {
		log.Printf("开启失败，正在回滚已执行的改动: %v", cause)

		// 逆序：先删托管规则，再恢复被停用的实例，最后恢复默认动作与总开关
		if n, err := removeManagedRules(); err != nil {
			log.Printf("回滚：删除托管规则失败: %v", err)
		} else if n > 0 {
			log.Printf("回滚：已删除 %d 条托管规则", n)
		}

		if len(st.DisabledRules) > 0 {
			e.restoreDisabledInstances(st.DisabledRules)
			log.Printf("回滚：已恢复 %d 条被停用的入站放行规则", st.DisabledInstanceCount)
		}

		for name, action := range st.OrigDefaultIn {
			p := profileFromName(name)
			if p == 0 {
				continue
			}
			// 只有当前值仍是我们写入的 actBlock 时才需要恢复
			if cur, err := GetDefaultInboundActions(); err == nil && cur[name] == action {
				continue
			}
			if err := SetDefaultInboundAction(p, action); err != nil {
				log.Printf("回滚：恢复 %s 默认入站动作失败: %v", name, err)
			}
		}

		for name := range st.OrigFirewallEnabled {
			if err := SetFirewallEnabled(profileFromName(name), false); err != nil {
				log.Printf("回滚：关闭 %s 防火墙总开关失败: %v", name, err)
			}
		}

		if len(st.OrigLogDropped) > 0 {
			if err := RestoreDroppedLog(st.OrigLogDropped); err != nil {
				log.Printf("回滚：还原丢弃包日志开关失败: %v", err)
			}
		}

		// 回滚后现场回到原样，state 里不应留下"已开启"的痕迹
		st.Applied = false
		st.DisabledRules = nil
		st.DisabledInstanceCount = 0
		st.OrigDefaultIn = nil
		st.OrigFirewallEnabled = nil
		st.OrigLogDropped = nil
		st.LanRuleAdded = false
		if err := e.store.SaveState(st); err != nil {
			log.Printf("回滚：保存状态失败: %v", err)
		}
		e.lan = false
		return fmt.Errorf("%w（已回滚到开启前的防火墙状态）", cause)
	}

	// 1. 防火墙总开关：被关闭的配置文件自动启用（记录原状，关闭防护时还原）
	fwOn, err := GetFirewallEnabled()
	if err != nil {
		return err
	}
	for name, on := range fwOn {
		if on {
			continue
		}
		p := profileFromName(name)
		if err := SetFirewallEnabled(p, true); err != nil {
			return fmt.Errorf("启用 %s 的 Windows 防火墙失败，请手动在系统设置中开启后重试: %w", name, err)
		}
		if st.OrigFirewallEnabled == nil {
			st.OrigFirewallEnabled = map[string]bool{}
		}
		st.OrigFirewallEnabled[name] = false
		log.Printf("%s 的防火墙原为关闭状态，已自动启用（关闭防护时还原）", name)
	}

	// 2. 记录默认入站动作现场
	origIn, err := GetDefaultInboundActions()
	if err != nil {
		return rollback(fmt.Errorf("读取默认入站策略失败: %w", err))
	}
	st.OrigDefaultIn = origIn

	// 3. 开启丢弃包日志（供「拦截日志」面板展示；原值记录后还原）
	if _, logPath, err := GetFwLogState(); err == nil {
		st.OrigLogFilePath = logPath
	} else {
		log.Printf("读取防火墙日志状态失败（不影响防护，跳过日志功能）: %v", err)
	}
	if err := SetDroppedLog(true, &st.OrigLogDropped); err != nil {
		log.Printf("开启丢弃包日志失败（不影响防护）: %v", err)
	}

	// 4. 逐实例记录将被停用的规则（指纹+序号），并直接执行停用。
	//    必须逐实例操作：同名规则在不同配置文件下有多个实例，
	//    其中一些可能原本就是停用状态，按名称批量处理会把它们误启用。
	whitelist := map[string]bool{}
	for _, p := range e.store.WhitelistPaths() {
		whitelist[strings.ToLower(p)] = true
	}

	plan := map[string]*DisabledRuleRecord{}
	counter := map[string]int{}
	disableErr := MutateRuleInstances(func(info FwRuleInfo) *bool {
		if info.Grouping == fwGroup {
			return nil // 自己托管的规则不动
		}
		key := fingerprintKey(info)
		idx := counter[key]
		counter[key] = idx + 1
		if info.Direction != dirIn || info.Action != actAllow || !info.Enabled {
			return nil // 只停用「原本处于启用状态」的入站放行实例
		}
		if info.AppPath != "" && whitelist[strings.ToLower(info.AppPath)] {
			return nil // 白名单程序：保留其原有放行规则
		}
		rec := plan[key]
		if rec == nil {
			rec = &DisabledRuleRecord{Fp: fingerprintOf(info)}
			plan[key] = rec
		}
		rec.Ordinals = append(rec.Ordinals, idx)
		fl := false
		return &fl
	})
	// 组装停用记录（无论成败都要组装，失败时回滚需要用到已记录的部分）
	var records []DisabledRuleRecord
	total := 0
	for _, rec := range plan {
		records = append(records, *rec)
		total += len(rec.Ordinals)
	}
	st.DisabledRules = records
	st.DisabledInstanceCount = total
	if disableErr != nil {
		return rollback(fmt.Errorf("停用规则时失败: %w", disableErr))
	}

	// 先落盘状态再动手：若中途断电/崩溃，Stop 可依据 state.json 安全还原
	st.Applied = true
	st.AppliedAt = time.Now().Format("2006-01-02 15:04:05")
	st.LanRuleAdded = lan
	if err := e.store.SaveState(st); err != nil {
		return rollback(fmt.Errorf("保存状态文件失败: %w", err))
	}
	log.Printf("已停用 %d 条入站放行规则（%d 组同名实例）", total, len(records))

	// 5. 默认入站动作设为「阻止」——原本已是「阻止」的（含 NotConfigured 继承默认）不写，保持零改动
	for _, p := range []int32{profileDomain, profilePrivate, profilePublic} {
		name := profileName(p)
		if st.OrigDefaultIn[name] == actBlock {
			continue
		}
		if err := SetDefaultInboundAction(p, actBlock); err != nil {
			return rollback(fmt.Errorf("设置 %s 默认入站为阻止失败: %w", name, err))
		}
	}

	// 6. 为白名单程序添加托管放行规则（TCP + UDP）
	if err := e.syncWhitelistRules(); err != nil {
		return rollback(err)
	}

	// 7. 局域网放行
	if lan {
		if err := e.addLanRules(); err != nil {
			return rollback(err)
		}
		log.Printf("已放行局域网（LocalSubnet）")
	}

	e.lan = lan
	log.Printf("单向防护已开启：入站默认阻止，白名单 %d 个程序，局域网放行=%v", len(whitelist), lan)
	return nil
}

// syncWhitelistRules 按当前白名单重建托管放行规则（Start 与白名单热更新共用）
func (e *Engine) syncWhitelistRules() error {
	entries := e.store.Whitelist()
	rules, err := ListRules()
	if err != nil {
		return err
	}
	// 先删掉旧的托管程序规则（保留局域网规则）
	want := map[string]bool{}
	for _, ent := range entries {
		want[ruleNameForApp(ent.Path, protoTCP)] = true
		want[ruleNameForApp(ent.Path, protoUDP)] = true
	}
	for _, r := range rules {
		if r.Grouping != fwGroup {
			continue
		}
		if r.Name == lanRuleName(protoTCP) || r.Name == lanRuleName(protoUDP) {
			continue
		}
		if want[r.Name] {
			continue
		}
		if err := removeRuleByName(r.Name); err != nil {
			return fmt.Errorf("清理旧托管规则[%s]失败: %w", r.Name, err)
		}
	}
	for _, ent := range entries {
		for _, proto := range []int32{protoTCP, protoUDP} {
			if err := AddManagedAllowRule(ruleNameForApp(ent.Path, proto), ent.Path, proto, false); err != nil {
				return fmt.Errorf("为 %s 添加放行规则失败: %w", ent.Name, err)
			}
		}
	}
	return nil
}

func (e *Engine) addLanRules() error {
	// 放行局域网子网及组播/广播发现协议（SSDP 1900、WS-Discovery 3702、mDNS 5353、LLMNR 5355）
	remoteScope := "LocalSubnet,239.255.255.250,224.0.0.251,224.0.0.252"
	if custom := strings.TrimSpace(e.store.Config().CustomSubnets); custom != "" {
		remoteScope += "," + custom
	}
	for _, proto := range []int32{protoTCP, protoUDP} {
		if err := AddManagedAllowRuleScope(lanRuleName(proto), "", proto, remoteScope); err != nil {
			return fmt.Errorf("添加局域网放行规则失败: %w", err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// 白名单热更新（防护运行中增删程序后调用）
// ---------------------------------------------------------------------------

func (e *Engine) ReloadWhitelist(lan bool) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.reloadWhitelistLocked(lan)
}

func (e *Engine) reloadWhitelistLocked(lan bool) error {
	if !e.Running() {
		return nil
	}
	if e.dryRun {
		e.lan = lan
		return nil
	}
	if err := e.syncWhitelistRules(); err != nil {
		return err
	}
	// 白名单更新后，把新加入程序的原始放行规则恢复启用（若之前被停用）
	whitelist := map[string]bool{}
	for _, p := range e.store.WhitelistPaths() {
		whitelist[strings.ToLower(p)] = true
	}
	// 按程序路径精确恢复：只启用「程序路径在白名单中且当前停用」的入站放行实例
	if err := MutateRuleInstances(func(info FwRuleInfo) *bool {
		if info.Grouping == fwGroup || info.Enabled {
			return nil
		}
		if info.Direction != dirIn || info.Action != actAllow {
			return nil
		}
		if info.AppPath != "" && whitelist[strings.ToLower(info.AppPath)] {
			t := true
			return &t
		}
		return nil
	}); err != nil {
		log.Printf("恢复白名单程序规则失败: %v", err)
	}

	// 一次性读改写 state：避免跨多次加解锁导致并发丢失更新
	st := e.store.State()
	var kept []DisabledRuleRecord
	for _, rec := range st.DisabledRules {
		if rec.Fp.AppPath != "" && whitelist[strings.ToLower(rec.Fp.AppPath)] {
			continue // 已随白名单恢复，不再需要记录
		}
		kept = append(kept, rec)
	}
	st.DisabledRules = kept

	// 局域网放行开关同步
	if lan != st.LanRuleAdded {
		if lan {
			if err := e.addLanRules(); err != nil {
				return err
			}
		} else {
			if err := removeRuleByName(lanRuleName(protoTCP)); err != nil {
				log.Printf("移除局域网放行规则(TCP)失败: %v", err)
			}
			if err := removeRuleByName(lanRuleName(protoUDP)); err != nil {
				log.Printf("移除局域网放行规则(UDP)失败: %v", err)
			}
		}
		st.LanRuleAdded = lan
	}
	if err := e.store.SaveState(st); err != nil {
		return err
	}
	e.lan = lan
	log.Printf("白名单已热更新，当前 %d 个程序", len(whitelist))
	return nil
}

// ---------------------------------------------------------------------------
// 关闭 / 还原
// ---------------------------------------------------------------------------

// Stop 完全还原开启前的防火墙状态。
//
// 关键不变式：只有现场确实还原成功，才允许清空 state.json 中的原始记录。
// 早期版本无条件把 OrigDefaultIn / OrigFirewallEnabled 置 nil，
// 而还原步骤失败时仅打日志——这意味着一次失败的还原会让用户永久失去
// 恢复防火墙的能力。现在改为：任何一步失败都保留原始记录并把
// Applied 维持为 true，用户可重试，state.json 始终可用来还原。
func (e *Engine) Stop() error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.dryRun {
		log.Printf("[dry-run] Stop() — 仅模拟")
		return nil
	}
	st := e.store.State()
	if !st.Applied {
		return nil
	}

	var failed []string
	note := func(format string, args ...interface{}) {
		msg := fmt.Sprintf(format, args...)
		log.Printf("还原失败: %s", msg)
		failed = append(failed, msg)
	}

	// 1. 恢复默认入站动作（当前值与原值不同才写，避免无谓改动）
	for name, action := range st.OrigDefaultIn {
		p := profileFromName(name)
		if p == 0 {
			continue
		}
		if cur, err := GetDefaultInboundActions(); err == nil && cur[name] == action {
			continue
		}
		if err := SetDefaultInboundAction(p, action); err != nil {
			note("恢复 %s 默认入站动作: %v", name, err)
		}
	}

	// 2. 还原本工具自动启用的防火墙配置文件总开关。
	//    只在「当前仍为开启」时才关闭：若用户在防护期间手动打开过防火墙，
	//    说明那是用户的意图，不应被我们覆盖。
	for name := range st.OrigFirewallEnabled {
		if cur, err := GetFirewallEnabled(); err == nil {
			if on, ok := cur[name]; ok && !on {
				continue // 已经是关闭状态，无需处理
			}
		}
		if err := SetFirewallEnabled(profileFromName(name), false); err != nil {
			note("还原 %s 防火墙总开关: %v", name, err)
		} else {
			log.Printf("已还原 %s 的防火墙总开关为关闭", name)
		}
	}

	// 3. 删除全部托管规则
	if n, err := removeManagedRules(); err != nil {
		note("删除托管规则: %v", err)
	} else {
		log.Printf("已删除 %d 条托管规则", n)
	}

	// 4. 按指纹+序号精确恢复被停用的规则实例
	restored := 0
	if len(st.DisabledRules) > 0 {
		counter := map[string]int{}
		err := MutateRuleInstances(func(info FwRuleInfo) *bool {
			key := fingerprintKey(info)
			idx := counter[key]
			counter[key] = idx + 1
			for _, rec := range st.DisabledRules {
				if key != fingerprintKeyOf(rec.Fp) {
					continue
				}
				for _, o := range rec.Ordinals {
					if o == idx {
						restored++
						t := true
						return &t
					}
				}
			}
			return nil
		})
		if err != nil {
			note("恢复规则实例: %v", err)
		}
	}
	if restored != st.DisabledInstanceCount {
		note("入站放行规则恢复不完整（%d/%d）", restored, st.DisabledInstanceCount)
	} else {
		log.Printf("已恢复 %d/%d 条入站放行规则", restored, st.DisabledInstanceCount)
	}

	// 5. 还原丢弃包日志开关（逐 profile 写回原值，未记录的不碰）
	if len(st.OrigLogDropped) > 0 {
		if err := RestoreDroppedLog(st.OrigLogDropped); err != nil {
			note("还原丢弃包日志开关: %v", err)
		} else {
			log.Printf("已还原丢弃包日志开关")
		}
	}

	if len(failed) > 0 {
		// 现场未完全还原：保留全部原始记录，Applied 维持 true，
		// 用户可在界面重试「关闭防护并还原」。
		st.PartialRestore = true
		st.LastError = strings.Join(failed, "; ")
		if err := e.store.SaveState(st); err != nil {
			log.Printf("保存状态失败: %v", err)
		}
		return fmt.Errorf("还原未完全成功，原始记录已保留，可重试：%s", st.LastError)
	}

	// 全部还原成功，才清空原始记录
	st.Applied = false
	st.PartialRestore = false
	st.LastError = ""
	st.DisabledRules = nil
	st.DisabledInstanceCount = 0
	st.OrigDefaultIn = nil
	st.OrigFirewallEnabled = nil
	st.OrigLogDropped = nil
	st.LanRuleAdded = false
	e.lan = false
	return e.store.SaveState(st)
}

// profileFromName 中文名 → 配置文件枚举值
func profileFromName(name string) int32 {
	switch name {
	case "域网络":
		return profileDomain
	case "专用网络":
		return profilePrivate
	case "公用网络":
		return profilePublic
	}
	return 0
}

// removeRuleByName 按名称删除规则（同名全部删除）
func removeRuleByName(name string) error {
	_, err := removeRulesByName(name)
	return err
}

// fingerprintOf 规则实例指纹
func fingerprintOf(info FwRuleInfo) RuleFingerprint {
	return RuleFingerprint{
		Name:        info.Name,
		Profiles:    info.Profiles,
		Protocol:    info.Protocol,
		LocalPorts:  info.LocalPorts,
		RemoteAddrs: info.RemoteAddrs,
		AppPath:     info.AppPath,
	}
}

func fingerprintKeyOf(fp RuleFingerprint) string {
	return fmt.Sprintf("%s|%d|%d|%s|%s|%s", fp.Name, fp.Profiles, fp.Protocol, fp.LocalPorts, fp.RemoteAddrs, fp.AppPath)
}

func fingerprintKey(info FwRuleInfo) string {
	return fingerprintKeyOf(fingerprintOf(info))
}

// restoreDisabledInstances 按记录恢复一组被停用的实例（Start 回滚用）
func (e *Engine) restoreDisabledInstances(records []DisabledRuleRecord) {
	counter := map[string]int{}
	_ = MutateRuleInstances(func(info FwRuleInfo) *bool {
		key := fingerprintKey(info)
		idx := counter[key]
		counter[key] = idx + 1
		for _, rec := range records {
			if key != fingerprintKeyOf(rec.Fp) {
				continue
			}
			for _, o := range rec.Ordinals {
				if o == idx {
					t := true
					return &t
				}
			}
		}
		return nil
	})
}

// EmergencyResetDirect 在无 GUI 环境下一键安全还原防火墙（供命令行 -restore 参数使用）
func EmergencyResetDirect(store *Store) error {
	log.Printf("正在执行紧急还原防火墙...")
	eng := NewEngine(store, false)
	st := store.State()
	if st.Applied {
		if err := eng.Stop(); err != nil {
			return err
		}
	} else {
		// 即使 state 认为未开启，也强制清理所有托管规则并确保无残留
		if n, err := removeManagedRules(); err == nil && n > 0 {
			log.Printf("清理了 %d 条残留托管规则", n)
		}
	}
	log.Printf("防火墙已成功紧急还原")
	return nil
}
