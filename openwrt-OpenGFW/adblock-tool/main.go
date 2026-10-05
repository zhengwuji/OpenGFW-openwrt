package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/apernet/OpenGFW/ruleset/builtins/geo/v2geo"
	"google.golang.org/protobuf/proto"
)

var domainRegex = regexp.MustCompile(`^[a-zA-Z0-9][-a-zA-Z0-9_.]*[a-zA-Z0-9]$`)

// parseAdblockLine extracts a domain name from various adblock/hosts/dnsmasq formats
func parseAdblockLine(line string) string {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "!") || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "[") {
		return ""
	}

	// Ignore cosmetic element hiding rules: ##, #@#, #?#, $$
	if strings.Contains(line, "##") || strings.Contains(line, "#@#") || strings.Contains(line, "#?#") || strings.Contains(line, "$$") {
		return ""
	}

	// Whitelist rules starting with @@ - ignore for blocklist
	if strings.HasPrefix(line, "@@") {
		return ""
	}

	// 1. EasyList / AdGuard format: ||example.com^
	if strings.HasPrefix(line, "||") {
		line = strings.TrimPrefix(line, "||")
		// strip ^ and everything after (^$third-party...)
		if idx := strings.Index(line, "^"); idx != -1 {
			line = line[:idx]
		}
		if idx := strings.Index(line, "$"); idx != -1 {
			line = line[:idx]
		}
		if idx := strings.Index(line, "/"); idx != -1 {
			line = line[:idx]
		}
		line = strings.TrimSpace(line)
		if isValidDomain(line) {
			return strings.ToLower(line)
		}
		return ""
	}

	// 2. Dnsmasq format: address=/example.com/0.0.0.0 or server=/example.com/
	if strings.HasPrefix(line, "address=/") || strings.HasPrefix(line, "server=/") {
		parts := strings.Split(line, "/")
		if len(parts) >= 2 {
			d := strings.TrimSpace(parts[1])
			if isValidDomain(d) {
				return strings.ToLower(d)
			}
		}
		return ""
	}

	// 3. Hosts format: 0.0.0.0 example.com or 127.0.0.1 example.com
	fields := strings.Fields(line)
	if len(fields) >= 2 {
		first := fields[0]
		if first == "0.0.0.0" || first == "127.0.0.1" || first == "::1" || first == "broadcast" {
			d := fields[1]
			if d != "localhost" && d != "local" && d != "ip6-localhost" && d != "ip6-loopback" && isValidDomain(d) {
				return strings.ToLower(d)
			}
			return ""
		}
	}

	// 4. URL format: http://example.com/path
	if strings.HasPrefix(line, "http://") || strings.HasPrefix(line, "https://") {
		u, err := url.Parse(line)
		if err == nil && u.Hostname() != "" && isValidDomain(u.Hostname()) {
			return strings.ToLower(u.Hostname())
		}
	}

	// 5. Plain domain format
	clean := strings.Trim(fields[0], " \t\r\n^|/")
	if isValidDomain(clean) {
		return strings.ToLower(clean)
	}

	return ""
}

func isValidDomain(d string) bool {
	if len(d) < 3 || len(d) > 255 {
		return false
	}
	if !strings.Contains(d, ".") {
		return false
	}
	// Avoid IP addresses
	if d == "0.0.0.0" || d == "127.0.0.1" || d == "255.255.255.255" {
		return false
	}
	return domainRegex.MatchString(d)
}

func parseRules(r io.Reader) []string {
	scanner := bufio.NewScanner(r)
	buf := make([]byte, 1024*1024)
	scanner.Buffer(buf, 1024*1024)

	domainSet := make(map[string]struct{})
	for scanner.Scan() {
		line := scanner.Text()
		d := parseAdblockLine(line)
		if d != "" {
			domainSet[d] = struct{}{}
		}
	}

	res := make([]string, 0, len(domainSet))
	for d := range domainSet {
		res = append(res, d)
	}
	return res
}

func parseIPLine(line string) *net.IPNet {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") || strings.HasPrefix(line, "//") || strings.HasPrefix(line, "!") {
		return nil
	}
	// Strip inline comments
	if idx := strings.Index(line, "#"); idx != -1 {
		line = strings.TrimSpace(line[:idx])
	}
	if idx := strings.Index(line, ";"); idx != -1 {
		line = strings.TrimSpace(line[:idx])
	}

	fields := strings.Fields(line)
	for _, token := range fields {
		token = strings.Trim(token, " ,;\"'[]")
		if token == "" {
			continue
		}
		if strings.Contains(token, "/") {
			_, ipNet, err := net.ParseCIDR(token)
			if err == nil {
				return ipNet
			}
		} else {
			ip := net.ParseIP(token)
			if ip != nil {
				if ip4 := ip.To4(); ip4 != nil {
					return &net.IPNet{
						IP:   ip4,
						Mask: net.CIDRMask(32, 32),
					}
				} else if ip16 := ip.To16(); ip16 != nil {
					return &net.IPNet{
						IP:   ip16,
						Mask: net.CIDRMask(128, 128),
					}
				}
			}
		}
	}
	return nil
}

func parseIPRules(r io.Reader) []*net.IPNet {
	scanner := bufio.NewScanner(r)
	buf := make([]byte, 1024*1024)
	scanner.Buffer(buf, 1024*1024)

	cidrSet := make(map[string]*net.IPNet)
	for scanner.Scan() {
		line := scanner.Text()
		if ipNet := parseIPLine(line); ipNet != nil {
			cidrSet[ipNet.String()] = ipNet
		}
	}

	res := make([]*net.IPNet, 0, len(cidrSet))
	for _, ipNet := range cidrSet {
		res = append(res, ipNet)
	}
	return res
}

func updateGeosite(geositePath string, category string, domains []string) error {
	category = strings.ToLower(category)

	var list v2geo.GeoSiteList
	if bs, err := os.ReadFile(geositePath); err == nil && len(bs) > 0 {
		_ = proto.Unmarshal(bs, &list)
	}

	pbDomains := make([]*v2geo.Domain, 0, len(domains))
	for _, d := range domains {
		pbDomains = append(pbDomains, &v2geo.Domain{
			Type:  v2geo.Domain_RootDomain,
			Value: d,
		})
	}

	found := false
	for i, entry := range list.Entry {
		if strings.ToLower(entry.CountryCode) == category {
			list.Entry[i].Domain = pbDomains
			found = true
			break
		}
	}
	if !found {
		list.Entry = append(list.Entry, &v2geo.GeoSite{
			CountryCode: strings.ToUpper(category),
			Domain:      pbDomains,
		})
	}

	data, err := proto.Marshal(&list)
	if err != nil {
		return fmt.Errorf("序列化规则库失败: %w", err)
	}

	tmpFile := geositePath + ".tmp"
	if err := os.WriteFile(tmpFile, data, 0644); err != nil {
		return fmt.Errorf("写入临时规则库文件失败: %w", err)
	}

	if err := os.Rename(tmpFile, geositePath); err != nil {
		return fmt.Errorf("原子替换规则库失败: %w", err)
	}

	return nil
}

func updateGeoIP(geoipPath string, category string, ipNets []*net.IPNet) error {
	category = strings.ToLower(category)

	var list v2geo.GeoIPList
	if bs, err := os.ReadFile(geoipPath); err == nil && len(bs) > 0 {
		_ = proto.Unmarshal(bs, &list)
	}

	pbCidrs := make([]*v2geo.CIDR, 0, len(ipNets))
	for _, n := range ipNets {
		var ipBytes []byte
		var bits int
		if ip4 := n.IP.To4(); ip4 != nil {
			ipBytes = ip4
			bits = 32
		} else {
			ipBytes = n.IP.To16()
			bits = 128
		}
		ones, _ := n.Mask.Size()
		if ones < 0 || ones > bits {
			continue
		}
		pbCidrs = append(pbCidrs, &v2geo.CIDR{
			Ip:     ipBytes,
			Prefix: uint32(ones),
		})
	}

	found := false
	for i, entry := range list.Entry {
		if strings.ToLower(entry.CountryCode) == category {
			list.Entry[i].Cidr = pbCidrs
			found = true
			break
		}
	}
	if !found {
		list.Entry = append(list.Entry, &v2geo.GeoIP{
			CountryCode: strings.ToUpper(category),
			Cidr:        pbCidrs,
		})
	}

	data, err := proto.Marshal(&list)
	if err != nil {
		return fmt.Errorf("序列化 GeoIP 失败: %w", err)
	}

	tmpFile := geoipPath + ".tmp"
	if err := os.WriteFile(tmpFile, data, 0644); err != nil {
		return fmt.Errorf("写入临时 GeoIP 文件失败: %w", err)
	}

	if err := os.Rename(tmpFile, geoipPath); err != nil {
		return fmt.Errorf("原子替换 GeoIP 文件失败: %w", err)
	}

	return nil
}

func ensureRuleInYaml(rulesPath string, category string) error {
	category = strings.ToLower(category)
	bs, err := os.ReadFile(rulesPath)
	content := ""
	if err == nil {
		content = string(bs)
	}

	checkStr := fmt.Sprintf("geosite(tls.sni, %q)", category)
	if strings.Contains(content, checkStr) {
		return nil
	}

	ruleSnippet := fmt.Sprintf(`
# ------------------------------------------------------------------------------
# 广告拦截订阅规则: %s
# ------------------------------------------------------------------------------
- name: 拦截广告订阅-%s-tls
  action: block
  log: true
  expr: tls != nil && tls.sni != nil && geosite(tls.sni, %q)

- name: 拦截广告订阅-%s-http
  action: block
  log: true
  expr: http != nil && http.host != nil && geosite(http.host, %q)

- name: 拦截广告订阅-%s-quic
  action: block
  log: true
  expr: quic != nil && quic.sni != nil && geosite(quic.sni, %q)

- name: 广告订阅黑洞-%s-dns
  action: modify
  log: true
  expr: dns != nil && dns.qr && dns.name != nil && geosite(dns.name, %q)
  modifier:
    name: dns
    args:
      a: "0.0.0.0"
`, category, category, category, category, category, category, category, category, category)

	newContent := strings.TrimRight(content, " \t\r\n") + "\n" + ruleSnippet
	return os.WriteFile(rulesPath, []byte(newContent), 0644)
}

func recordSubscription(name, urlStr string) {
	if urlStr == "" {
		return
	}
	subFile := "/etc/opengfw/adblock_subscriptions.txt"
	_ = os.MkdirAll(filepath.Dir(subFile), 0755)

	var lines []string
	if bs, err := os.ReadFile(subFile); err == nil {
		for _, line := range strings.Split(string(bs), "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				continue
			}
			parts := strings.Fields(trimmed)
			if len(parts) >= 2 && parts[0] == name {
				continue
			}
			lines = append(lines, trimmed)
		}
	}
	lines = append(lines, fmt.Sprintf("%s\t%s", name, urlStr))
	_ = os.WriteFile(subFile, []byte(strings.Join(lines, "\n")+"\n"), 0644)
}

func removeCategory(geositePath, category, rulesPath string) error {
	catLow := strings.ToLower(category)

	// 1. Remove from geosite.dat
	if bs, err := os.ReadFile(geositePath); err == nil && len(bs) > 0 {
		var list v2geo.GeoSiteList
		if err := proto.Unmarshal(bs, &list); err == nil {
			newEntries := make([]*v2geo.GeoSite, 0, len(list.Entry))
			for _, entry := range list.Entry {
				if strings.ToLower(entry.CountryCode) != catLow {
					newEntries = append(newEntries, entry)
				}
			}
			list.Entry = newEntries
			if data, err := proto.Marshal(&list); err == nil {
				tmpFile := geositePath + ".tmp"
				if err := os.WriteFile(tmpFile, data, 0644); err == nil {
					_ = os.Rename(tmpFile, geositePath)
				}
			}
		}
	}

	// 2. Remove rules from rules.yaml
	if bs, err := os.ReadFile(rulesPath); err == nil {
		lines := strings.Split(string(bs), "\n")
		var outLines []string
		skip := false
		targetName := fmt.Sprintf("-%s-", catLow)
		targetGeosite := fmt.Sprintf("%q", catLow)
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "- name:") {
				if strings.Contains(line, targetName) || strings.Contains(line, targetGeosite) {
					skip = true
					continue
				} else {
					skip = false
				}
			} else if skip && (trimmed == "" || strings.HasPrefix(trimmed, "- name:")) {
				if strings.HasPrefix(trimmed, "- name:") {
					skip = false
				} else {
					continue
				}
			}
			if !skip {
				outLines = append(outLines, line)
			}
		}
		_ = os.WriteFile(rulesPath, []byte(strings.Join(outLines, "\n")), 0644)
	}

	// 3. Remove from adblock_subscriptions.txt
	subFile := "/etc/opengfw/adblock_subscriptions.txt"
	if bs, err := os.ReadFile(subFile); err == nil {
		lines := strings.Split(string(bs), "\n")
		var outLines []string
		for _, line := range lines {
			parts := strings.Fields(line)
			if len(parts) >= 1 && strings.ToLower(parts[0]) == catLow {
				continue
			}
			outLines = append(outLines, line)
		}
		_ = os.WriteFile(subFile, []byte(strings.Join(outLines, "\n")), 0644)
	}

	_ = exec.Command("/etc/init.d/opengfw", "reload").Run()
	return nil
}

func ensureIPRuleInYaml(rulesPath string, category string) error {
	category = strings.ToLower(category)
	bs, err := os.ReadFile(rulesPath)
	content := ""
	if err == nil {
		content = string(bs)
	}

	checkStr := fmt.Sprintf("geoip(ip.dst, %q)", category)
	if strings.Contains(content, checkStr) {
		return nil
	}

	ruleSnippet := fmt.Sprintf(`
# ------------------------------------------------------------------------------
# 自定义 IP 网段拦截规则: %s
# ------------------------------------------------------------------------------
- name: 阻断自定义IP-%s-出站
  action: block
  log: true
  expr: geoip(ip.dst, %q)

- name: 阻断自定义IP-%s-入站
  action: block
  log: true
  expr: geoip(ip.src, %q)
`, category, category, category, category, category)

	newContent := strings.TrimRight(content, " \t\r\n") + "\n" + ruleSnippet
	return os.WriteFile(rulesPath, []byte(newContent), 0644)
}

type OutputResult struct {
	Success     bool   `json:"success"`
	Category    string `json:"category"`
	Count       int    `json:"count"`
	Message     string `json:"message"`
	Error       string `json:"error,omitempty"`
}

func main() {
	if len(os.Args) < 2 {
		printUsage()
		return
	}

	switch os.Args[1] {
	case "import":
		cmdImport := flag.NewFlagSet("import", flag.ExitOnError)
		urlFlag := cmdImport.String("url", "", "域名规则订阅 URL")
		fileFlag := cmdImport.String("file", "", "本地规则文件路径")
		nameFlag := cmdImport.String("name", "adblockfilters", "规则分类名称")
		geositeFlag := cmdImport.String("geosite", "/etc/opengfw/geosite.dat", "geosite.dat 文件路径")
		rulesFlag := cmdImport.String("rules", "/etc/opengfw/rules.yaml", "rules.yaml 文件路径")
		noReloadFlag := cmdImport.Bool("no-reload", false, "导入后不自动热重载")
		_ = cmdImport.Parse(os.Args[2:])

		var reader io.Reader
		if *urlFlag != "" {
			client := &http.Client{Timeout: 60 * time.Second}
			resp, err := client.Get(*urlFlag)
			if err != nil {
				outputJSON(OutputResult{Success: false, Error: fmt.Sprintf("下载订阅规则失败: %v", err)})
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				outputJSON(OutputResult{Success: false, Error: fmt.Sprintf("下载失败，HTTP 状态码: %d", resp.StatusCode)})
				return
			}
			reader = resp.Body
		} else if *fileFlag != "" {
			f, err := os.Open(*fileFlag)
			if err != nil {
				outputJSON(OutputResult{Success: false, Error: fmt.Sprintf("无法读取规则文件: %v", err)})
				return
			}
			defer f.Close()
			reader = f
		} else {
			stat, _ := os.Stdin.Stat()
			if (stat.Mode() & os.ModeCharDevice) == 0 {
				reader = os.Stdin
			} else {
				outputJSON(OutputResult{Success: false, Error: "请通过 --url、--file 或标准输入提供规则内容"})
				return
			}
		}

		domains := parseRules(reader)
		if len(domains) == 0 {
			outputJSON(OutputResult{Success: false, Error: "未在输入中解析出任何有效域名规则"})
			return
		}

		_ = os.MkdirAll(filepath.Dir(*geositeFlag), 0755)

		if err := updateGeosite(*geositeFlag, *nameFlag, domains); err != nil {
			outputJSON(OutputResult{Success: false, Error: err.Error()})
			return
		}

		if err := ensureRuleInYaml(*rulesFlag, *nameFlag); err != nil {
			outputJSON(OutputResult{Success: false, Error: fmt.Sprintf("写入规则配置失败: %v", err)})
			return
		}

		if *urlFlag != "" {
			recordSubscription(*nameFlag, *urlFlag)
		}

		if !*noReloadFlag {
			_ = exec.Command("/etc/init.d/opengfw", "reload").Run()
		}

		outputJSON(OutputResult{
			Success:  true,
			Category: *nameFlag,
			Count:    len(domains),
			Message:  fmt.Sprintf("成功导入分类 [%s] 共 %d 条域名规则并热重载生效！", *nameFlag, len(domains)),
		})

	case "import-ip":
		cmdImportIP := flag.NewFlagSet("import-ip", flag.ExitOnError)
		urlFlag := cmdImportIP.String("url", "", "IP段落订阅 URL (支持多个URL使用逗号/空格/换行隔开)")
		fileFlag := cmdImportIP.String("file", "", "本地 IP 列表文件路径")
		nameFlag := cmdImportIP.String("name", "custom_ips", "自定义分类代码 (例如 custom_ips)")
		geoipFlag := cmdImportIP.String("geoip", "/etc/opengfw/geoip.dat", "geoip.dat 文件路径")
		rulesFlag := cmdImportIP.String("rules", "/etc/opengfw/rules.yaml", "rules.yaml 文件路径")
		noReloadFlag := cmdImportIP.Bool("no-reload", false, "导入后不自动热重载")
		_ = cmdImportIP.Parse(os.Args[2:])

		var allIPNets []*net.IPNet
		ipSet := make(map[string]*net.IPNet)

		if *urlFlag != "" {
			fields := strings.FieldsFunc(*urlFlag, func(r rune) bool {
				return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == '\r'
			})
			var urls []string
			for _, f := range fields {
				f = strings.TrimSpace(f)
				if f != "" {
					urls = append(urls, f)
				}
			}

			client := &http.Client{
				Timeout: 30 * time.Second,
			}

			totalURLs := len(urls)
			fmt.Printf("[*] 开始从 %d 个自定义 IP 订阅链接中下载网段数据...\n", totalURLs)

			for idx, u := range urls {
				fmt.Printf("  [%d/%d] 正在下载: %s\n", idx+1, totalURLs, u)
				req, err := http.NewRequest("GET", u, nil)
				if err != nil {
					fmt.Printf("    [-] 链接格式错误: %v\n", err)
					continue
				}
				req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

				resp, err := client.Do(req)
				if err != nil {
					fmt.Printf("    [-] 下载超时或失败: %v\n", err)
					continue
				}
				if resp.StatusCode != http.StatusOK {
					resp.Body.Close()
					fmt.Printf("    [-] HTTP 响应码错误: %d\n", resp.StatusCode)
					continue
				}
				subNets := parseIPRules(resp.Body)
				resp.Body.Close()
				fmt.Printf("    -> 成功解析出 %d 条有效 IP/CIDR 网段\n", len(subNets))
				for _, n := range subNets {
					ipSet[n.String()] = n
				}
			}
		} else if *fileFlag != "" {
			f, err := os.Open(*fileFlag)
			if err != nil {
				outputJSON(OutputResult{Success: false, Error: fmt.Sprintf("无法读取 IP 文件: %v", err)})
				return
			}
			subNets := parseIPRules(f)
			f.Close()
			for _, n := range subNets {
				ipSet[n.String()] = n
			}
		} else {
			stat, _ := os.Stdin.Stat()
			if (stat.Mode() & os.ModeCharDevice) == 0 {
				subNets := parseIPRules(os.Stdin)
				for _, n := range subNets {
					ipSet[n.String()] = n
				}
			} else {
				outputJSON(OutputResult{Success: false, Error: "请通过 --url、--file 或标准输入提供 IP 网段列表"})
				return
			}
		}

		for _, n := range ipSet {
			allIPNets = append(allIPNets, n)
		}

		if len(allIPNets) == 0 {
			outputJSON(OutputResult{Success: false, Error: "未在输入中解析出任何有效 IP 或 CIDR 网段"})
			return
		}

		_ = os.MkdirAll(filepath.Dir(*geoipFlag), 0755)

		fmt.Printf("[+] 合并去重后共计 %d 条 IP 网段，正在写入 GeoIP 数据库 [%s]...\n", len(allIPNets), *nameFlag)
		if err := updateGeoIP(*geoipFlag, *nameFlag, allIPNets); err != nil {
			outputJSON(OutputResult{Success: false, Error: err.Error()})
			return
		}

		if err := ensureIPRuleInYaml(*rulesFlag, *nameFlag); err != nil {
			outputJSON(OutputResult{Success: false, Error: fmt.Sprintf("写入规则配置失败: %v", err)})
			return
		}

		if !*noReloadFlag {
			_ = exec.Command("/etc/init.d/opengfw", "reload").Run()
		}

		outputJSON(OutputResult{
			Success:  true,
			Category: *nameFlag,
			Count:    len(allIPNets),
			Message:  fmt.Sprintf("成功解析并导入 [%s] 共计 %d 条 IP/CIDR 网段，已自动热重载生效！", *nameFlag, len(allIPNets)),
		})

	case "list":
		cmdList := flag.NewFlagSet("list", flag.ExitOnError)
		listGeositeFlag := cmdList.String("geosite", "/etc/opengfw/geosite.dat", "geosite.dat 文件路径")
		_ = cmdList.Parse(os.Args[2:])
		listCategories(*listGeositeFlag)

	case "list-ip":
		cmdListIP := flag.NewFlagSet("list-ip", flag.ExitOnError)
		listGeoipFlag := cmdListIP.String("geoip", "/etc/opengfw/geoip.dat", "geoip.dat 文件路径")
		_ = cmdListIP.Parse(os.Args[2:])
		listIPCategories(*listGeoipFlag)

	case "audit":
		cmdAudit := flag.NewFlagSet("audit", flag.ExitOnError)
		auditLogFlag := cmdAudit.String("log", "/var/log/opengfw.log", "日志文件路径")
		auditGeositeFlag := cmdAudit.String("geosite", "/etc/opengfw/geosite.dat", "geosite.dat 路径")
		_ = cmdAudit.Parse(os.Args[2:])
		runAudit(*auditLogFlag, *auditGeositeFlag)

	case "delete":
		cmdDelete := flag.NewFlagSet("delete", flag.ExitOnError)
		nameFlag := cmdDelete.String("name", "", "要删除的规则分类名称")
		geositeFlag := cmdDelete.String("geosite", "/etc/opengfw/geosite.dat", "geosite.dat 路径")
		rulesFlag := cmdDelete.String("rules", "/etc/opengfw/rules.yaml", "rules.yaml 路径")
		_ = cmdDelete.Parse(os.Args[2:])
		if *nameFlag == "" {
			outputJSON(OutputResult{Success: false, Error: "请指定要删除的分类名称 (--name)"})
			return
		}
		if err := removeCategory(*geositeFlag, *nameFlag, *rulesFlag); err != nil {
			outputJSON(OutputResult{Success: false, Error: err.Error()})
			return
		}
		outputJSON(OutputResult{
			Success: true,
			Message: fmt.Sprintf("分类 [%s] 已成功从规则库与拦截策略中移除并热重载生效！", *nameFlag),
		})

	default:
		printUsage()
	}
}

func outputJSON(res OutputResult) {
	bs, _ := json.Marshal(res)
	fmt.Println(string(bs))
}

func listCategories(geositePath string) {
	bs, err := os.ReadFile(geositePath)
	if err != nil {
		fmt.Printf("{\"error\": \"无法读取规则库: %v\"}\n", err)
		return
	}
	var list v2geo.GeoSiteList
	if err := proto.Unmarshal(bs, &list); err != nil {
		fmt.Printf("{\"error\": \"解析规则库失败: %v\"}\n", err)
		return
	}

	type CatItem struct {
		Name  string `json:"name"`
		Count int    `json:"count"`
	}
	items := make([]CatItem, 0)
	for _, e := range list.Entry {
		items = append(items, CatItem{
			Name:  strings.ToLower(e.CountryCode),
			Count: len(e.Domain),
		})
	}
	out, _ := json.Marshal(items)
	fmt.Println(string(out))
}

func listIPCategories(geoipPath string) {
	bs, err := os.ReadFile(geoipPath)
	if err != nil {
		fmt.Printf("{\"error\": \"无法读取 GeoIP 库: %v\"}\n", err)
		return
	}
	var list v2geo.GeoIPList
	if err := proto.Unmarshal(bs, &list); err != nil {
		fmt.Printf("{\"error\": \"解析 GeoIP 库失败: %v\"}\n", err)
		return
	}

	type CatItem struct {
		Name  string `json:"name"`
		Count int    `json:"count"`
	}
	items := make([]CatItem, 0)
	for _, e := range list.Entry {
		items = append(items, CatItem{
			Name:  strings.ToLower(e.CountryCode),
			Count: len(e.Cidr),
		})
	}
	out, _ := json.Marshal(items)
	fmt.Println(string(out))
}

func printUsage() {
	fmt.Println("OpenGFW 规则与全球 IP 网段智能导入工具")
	fmt.Println("用法:")
	fmt.Println("  opengfw-adblock-tool import --url <URL> [--name <分类名>]")
	fmt.Println("  opengfw-adblock-tool import-ip --url <URL1,URL2...> [--name <分类名>]")
	fmt.Println("  opengfw-adblock-tool import-ip --file <文件路径> [--name <分类名>]")
	fmt.Println("  opengfw-adblock-tool list")
	fmt.Println("  opengfw-adblock-tool list-ip")
	fmt.Println("  opengfw-adblock-tool audit [--log /var/log/opengfw.log]")
}

type AuditRecord struct {
	ID     uint64 `json:"id"`
	Time   string `json:"time"`
	Src    string `json:"src"`
	Dst    string `json:"dst"`
	SNI    string `json:"sni"`
	Rule   string `json:"rule"`
	Action string `json:"action"`
	Proto  string `json:"proto"`
	Type   string `json:"type"`
}

type AuditSummary struct {
	TotalStreams     int           `json:"total_streams"`
	BlockedCount     int           `json:"blocked_count"`
	AllowedCount     int           `json:"allowed_count"`
	TotalRulesDomain int           `json:"total_rules_domains"`
	HitRate          string        `json:"hit_rate"`
	Blocked          []AuditRecord `json:"blocked"`
	Allowed          []AuditRecord `json:"allowed"`
}

func runAudit(logPath, geositePath string) {
	summary := AuditSummary{
		HitRate: "0.0%",
		Blocked: make([]AuditRecord, 0),
		Allowed: make([]AuditRecord, 0),
	}

	// 1. Calculate total rules domains in geosite.dat
	if bs, err := os.ReadFile(geositePath); err == nil {
		var list v2geo.GeoSiteList
		if err := proto.Unmarshal(bs, &list); err == nil {
			for _, e := range list.Entry {
				summary.TotalRulesDomain += len(e.Domain)
			}
		}
	}

	// 2. Read log file
	f, err := os.Open(logPath)
	if err != nil {
		bs, _ := json.Marshal(summary)
		fmt.Println(string(bs))
		return
	}
	defer f.Close()

	// If file is larger than 2MB, seek towards end
	fi, err := f.Stat()
	if err == nil && fi.Size() > 2*1024*1024 {
		f.Seek(-2*1024*1024, io.SeekEnd)
	}

	scanner := bufio.NewScanner(f)
	streams := make(map[uint64]*AuditRecord)
	var order []uint64

	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.Split(line, "\t")
		if len(parts) < 4 {
			continue
		}
		timeStr := parts[0]
		if idx := strings.Index(timeStr, "T"); idx != -1 {
			timeStr = timeStr[idx+1:]
		}
		if idx := strings.Index(timeStr, "+"); idx != -1 {
			timeStr = timeStr[:idx]
		}
		category := parts[2]

		var data map[string]interface{}
		if err := json.Unmarshal([]byte(parts[3]), &data); err != nil {
			continue
		}

		rawID, ok := data["id"]
		if !ok {
			continue
		}
		var id uint64
		switch v := rawID.(type) {
		case float64:
			id = uint64(v)
		case int64:
			id = uint64(v)
		case uint64:
			id = v
		default:
			continue
		}

		rec, exists := streams[id]
		if !exists {
			rec = &AuditRecord{
				ID:     id,
				Time:   timeStr,
				Action: "allow",
				Proto:  "TCP",
				Type:   "normal",
			}
			if s, ok := data["src"].(string); ok {
				rec.Src = s
			}
			if d, ok := data["dst"].(string); ok {
				rec.Dst = d
			}
			streams[id] = rec
			order = append(order, id)
		}

		if props, ok := data["props"].(map[string]interface{}); ok {
			if tls, ok := props["tls"].(map[string]interface{}); ok {
				rec.Proto = "TLS"
				if req, ok := tls["req"].(map[string]interface{}); ok {
					if sni, ok := req["sni"].(string); ok && sni != "" {
						rec.SNI = sni
					}
				}
			} else if httpData, ok := props["http"].(map[string]interface{}); ok {
				rec.Proto = "HTTP"
				if req, ok := httpData["req"].(map[string]interface{}); ok {
					if host, ok := req["host"].(string); ok && host != "" {
						rec.SNI = host
					}
				}
			} else if dns, ok := props["dns"].(map[string]interface{}); ok {
				rec.Proto = "DNS"
				if req, ok := dns["req"].(map[string]interface{}); ok {
					if name, ok := req["name"].(string); ok && name != "" {
						rec.SNI = name
					}
				}
			} else if quic, ok := props["quic"].(map[string]interface{}); ok {
				rec.Proto = "QUIC"
				if req, ok := quic["req"].(map[string]interface{}); ok {
					if sni, ok := req["sni"].(string); ok && sni != "" {
						rec.SNI = sni
					}
				}
			}
		}

		if name, ok := data["name"].(string); ok {
			lower := strings.ToLower(name)
			if strings.Contains(lower, "block") || strings.Contains(lower, "拦截") || strings.Contains(lower, "sinkhole") || strings.Contains(lower, "drop") {
				rec.Action = "block"
				rec.Rule = name
				if strings.Contains(lower, "ad") || strings.Contains(lower, "广告") || strings.Contains(lower, "filter") {
					rec.Type = "ad"
				} else if strings.Contains(lower, "trojan") || strings.Contains(lower, "fet") {
					rec.Type = "proxy"
				} else {
					rec.Type = "ip"
				}
			}
		}

		if category == "TCP stream action" || category == "UDP stream action" {
			if act, ok := data["action"].(string); ok && act != "" {
				if act == "block" || act == "drop" || act == "modify" {
					rec.Action = act
				}
			}
		}
	}

	for i := len(order) - 1; i >= 0; i-- {
		id := order[i]
		rec := *streams[id]
		summary.TotalStreams++
		if rec.Action == "block" || rec.Action == "drop" || rec.Action == "modify" {
			summary.BlockedCount++
			if len(summary.Blocked) < 150 {
				summary.Blocked = append(summary.Blocked, rec)
			}
		} else {
			summary.AllowedCount++
			if len(summary.Allowed) < 150 {
				summary.Allowed = append(summary.Allowed, rec)
			}
		}
	}

	if summary.TotalStreams > 0 {
		summary.HitRate = fmt.Sprintf("%.1f%%", float64(summary.BlockedCount)*100.0/float64(summary.TotalStreams))
	}

	bs, _ := json.Marshal(summary)
	fmt.Println(string(bs))
}

