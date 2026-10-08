# OpenGFW & luci-app-opengfw —— 企业级 7 层透明流控与 DPI 深度防火墙系统

[![License](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20OpenWrt-blue.svg)](https://openwrt.org/)
[![Architecture](https://img.shields.io/badge/Arch-x86__64%20%7C%20arm64-orange.svg)]()

OpenGFW 是一款运行在 Linux / OpenWrt 软路由环境下的**高性能 7 层透明流防火墙与深度包检测（DPI）系统**。配套完整的现代化 LuCI Web 管理套件，实现全屋免客户端去广告、恶意域名阻断、全加密流量审计、DNS 穿透防范与 GeoIP 国别精细化控制。

---

## 目录 (Table of Contents)

1. [最新更新动态与核心亮点](#最新更新动态与核心亮点-latest-updates)
2. [核心优缺点客观对比](#一核心优缺点客观对比)
3. [软路由硬件配置推荐指南](#二软路由硬件配置推荐指南)
4. [系统架构与工作原理](#三系统架构与工作原理)
5. [LuCI Web 管理界面功能详解](#四luci-web-管理界面功能详解)
6. [安装与快速上手教程 (含一键安装 IPK)](#五安装与快速上手教程)
7. [命令行高级运维速查](#六命令行高级运维速查)
8. [常见问题解答 (FAQ)](#七常见问题解答-faq)
9. [上游溯源与同步说明](#八上游溯源与同步说明-upstream-tracking)

---

## 📢 最新更新动态与核心亮点 (Latest Updates)

- 🚀 **GitHub Actions 云端自动化构建与发布（自适应所有 OpenWrt 版本）**  
  仓库已配置开箱即用的 CI/CD 自动构建工作流。**每次向仓库推送代码修改（除 Markdown 文档外），GitHub 会自动触发多架构交叉编译，为 x86_64、aarch64、arm、mipsel 以及 universal all 自动打包全套 `.ipk` 安装包**。普通用户无需安装复杂的本地 SDK，可在 GitHub 直接下载对应 CPU 架构的 `.ipk` 文件，在 OpenWrt 网页后台一键上传安装即可使用！
- 🛡️ **GeoIP 国别精细化拦截升级与安全加固**  
  - 默认拦截方向更新为 **「外部连入源 IP」** 防御模式（禁止境外管控国家主动访问/扫描我方，不影响内网主动访问境外业务）。
  - 重构了规则生效优先级：入站黑名单规则自动插入至核心管理端口放行规则之前，彻底消除恶意端口扫描穿透隐患。
- 📦 **Adblock 50万+ 超大去广告规则持久化订阅**  
  - 研发配套专用编译工具 `opengfw-adblock-tool`，支持将外部 Adblock / AdGuard 规则自动清洗合并入 `geosite.dat`。
  - 重构基础数据库自动更新机制：官方库更新时，系统会自动保护并重新合并自定义订阅规则和白名单，解决以往更新时自定义规则被覆盖冲掉的缺陷。
- 🛠️ **协议兼容与使用体验全面修复**  
  - 修复 DNS Modifier 模块键名兼容性问题（统一为底层支持的 `a: 0.0.0.0`）。
  - WebUI 日志模块增加终端彩色转义字符自动剥除清洗，杜绝 `\x1b[34m` 等 ANSI 乱码。
  - 广告分类管理面板新增「🗑️ 删除」按钮，支持已有外部分类的按需清退与内存释放。

---

## 一、核心优缺点客观对比

### 1. 核心优势 (Pros)

- 🛡️ **网关级 7 层透明拦截（零客户端感知）**  
  工作在软路由网关层，无需在客户端安装任何软件或配置自签名根证书（无需中间人证书劫持 MITM）。对局域网内所有 **iOS / Android 手机、PC、Mac、智能电视（TV 盒子）、IoT 智能家居** 统一透明生效。
- ⚡ **内核级直通加速（Kernel Fastpath），千兆线速近乎零 CPU 开销**  
  基于 nftables 与 Linux 连接跟踪（conntrack mark），仅在新建连接的握手首包送入用户态审查。一旦判定安全放行，内核直通标记（`ct mark 0x3e9`）生效，后续 GB 级长连接数据包**全部在 Linux 内核层硬直通转发**，不产生用户态上下文切换，网络几乎零延迟。
- 🎯 **TLS SNI / HTTP Host / QUIC 真实域名阻断**  
  比传统基于本地 DNS 污染的广告拦截器（如 AdGuard Home / Pi-hole）更彻底。即使客户端自带内置 IP、硬编码 DNS 或走加密隧道，只要在 TLS ClientHello 中暴露明文 SNI 或 HTTP Host，网关即可瞬间阻断。
- 📦 **模块化 Adblock 外部规则智能编译与持久化订阅引擎**  
  内置专为 OpenGFW 打造的 `opengfw-adblock-tool` 编译工具，支持直接拉取 AdGuard / Adblock 格式的 50万+ 超大外部去广告规则集（如 `217heidai/adblockfilters`），自动清洗解析并增量编译合并入二进制 `geosite.dat`。当官方基础库自动更新时，系统会自动保护并重新合并用户的自定义订阅与白名单，杜绝数据被冲掉。
- 🌍 **可视化 GeoIP 国别阻断（带中英文即时搜索）**  
  覆盖全球 240+ 国家和地区，支持中文全称、拼音、英文名及两位 ISO 国家代码的实时前端拼音/字符串模糊检索，一键勾选加黑并秒级热生效。
- 🔄 **规则秒级无感热重载 (Hot-Reload)**  
  修改任何规则或订阅外部列表后，通过向主进程发送 `SIGHUP` 信号实现毫秒级原子重载，已建立的 TCP 长连接不中断，网络不掉线。

---

### 2. 架构短板与使用边界 (Cons)

- ⚠️ **超大规则集内存开销（硬件门槛）**  
  OpenGFW 会在内存中为所有域名构建高效 Trie 匹配树。当载入类似 `adblockfilters` 级别的超大规则集（**51.7 万条域名**）时，进程常驻内存（RSS）约为 **380 MB**。  
  *【结论】* 在 x86 软路由（2GB/4GB/8GB RAM）上毫无压力，但若在 256MB~512MB RAM 的轻量硬路由（如 MT7621、廉价 arm64 盒子）上运行，可能存在 OOM 风险。
- ⚠️ **同域名内嵌视频流广告不可阻断（非解密 DPI 的物理边界）**  
  YouTube、Bilibili 等客户端的内置片头贴片广告与正常视频流共享相同的 CDN 域名（如 `*.googlevideo.com`、`*.bilivideo.com`）。OpenGFW 作为非中间人劫持的透明流防火墙，无法且不应解密 TLS 加密载荷内部的 HTTP URI 路径。  
  *【对策】* 此类同域名视频流内嵌广告需配合浏览器扩展（如 uBlock Origin）或定制客户端处理。
- ⚠️ **运行日志暂存于 tmpfs 内存虚拟盘**  
  遵循 OpenWrt 官方保护板载 Flash 闪存寿命的标准规范，`/var/log/opengfw.log` 运行日志默认保存在内存盘（tmpfs）中，软路由重启后日志与历史拦截计数会归零（但所有规则、配置与订阅规则持久保存在磁盘上，完全不受影响）。  
  *【对策】* 如需长达数月的大数据审计回溯，可将日志输出重定向至外部 Syslog 服务器或外接移动硬盘。
- ⚠️ **复杂非对称策略路由注意事项**  
  在常规单 WAN 或双栈 NAT 网关下运行完美；但在极端的多 WAN 负载均衡（如 mwan3）或非对称路由（去程走 WAN1、回程走 WAN2）网络下，需注意保持单向 TCP 握手流的完整性，避免流分类状态机失步。

---

## 二、软路由硬件配置推荐指南

软路由硬件配置面对上述优缺点是否够用？答案是：**对于主流 x86 软路由，完全够用，性能甚至严重过剩。**

| 配置等级 | 推荐 CPU | 推荐内存 | 推荐网卡 | 适用场景与带宽承载 |
| :--- | :--- | :--- | :--- | :--- |
| **黄金甜点配置**<br>*(强烈推荐 / 典型配置)* | **Intel N100 / N200 / N5105 / J4125** 或 **Core 6/7/8/10代低压 U** (如 i5-7200U、i3-8109U 等) | **4GB ~ 8GB** (DDR4) | Intel i225-V / i226-V (2.5G) 或 i211 (千兆) | **全量载入 50万+ 条超大广告规则集**，配合国别拦截，**跑满 1000M 千兆宽带毫无压力**，同时并存运行 Xray/Passwall 等代理软件。 |
| **基础入门配置** | Intel J1900 / N4100，或 MT7981 / RK3399 等 ARM 平台 | **1GB ~ 2GB** | 常见千兆板载网卡 | 适合加载精简版广告规则（2~5 万条以内），300M~500M 家用宽带。 |
| **极客发烧配置** | Intel 12/13/14代酷睿 (如 i3-12100、i5-12400) 或 AMD Ryzen 5000/7000 系 | **16GB+** (DDR4/DDR5) | Intel X520 / X710 万兆光口/电口 | **2.5G ~ 10G 万兆局域网**，内网 50+ 台终端高并发连接同时做深度包检测。 |

### 选型核心原则：
1. **内存建议 4GB 及以上**：OpenGFW 自身占用约 380MB，OpenWrt 系统占用约 150MB，4GB 内存可确保系统永远不会触发 OOM。
2. **注重单核 IPC 性能**：DPI 单流审查与 Trie 树匹配属于单流串行任务，高主频、高 IPC 的 x86 处理器在新建流判定时延迟极低（微秒级）。
3. **网卡认准 Intel 网卡**：Intel i211/i225/i226 驱动完善，硬件校验和卸载与多队列 RSS 支持极佳，能将 NFQUEUE 软中断负载降至最低。

---

## 三、系统架构与工作原理

```
[局域网内终端] (手机/PC/电视)
      │
      ▼ (数据包进入网关)
[Linux 内核 nftables / Netfilter]
      │
      ├── (已有连接 / ct mark 0x3e9) ─────────► [直接内核硬直通转发 (Kernel Fastpath) 极速出网]
      │
      └── (新建连接首包 / SYN / TLS握手)
            │
            ▼ (NFQUEUE 旁路接入)
      [OpenGFW 7层流控引擎 (Go)]
            │
            ├── ① 白名单校验 (用户白名单 -> 立即放行打标 0x3e9)
            ├── ② 广告规则匹配 (TLS SNI / HTTP Host -> block/drop)
            ├── ③ DNS 黑洞重定向 (DNS A记录篡改为 0.0.0.0)
            ├── ④ 国别 IP 阻断 (GeoIP 匹配指定国家)
            └── ⑤ 协议指纹与加密审计 (Shadowsocks / VMess / Trojan 检测)
```

---

## 四、LuCI Web 管理界面功能详解

安装插件后，登录 OpenWrt Web 管理后台，进入导航菜单：**【服务】 -> 【OpenGFW 防火墙】**。

### 1. 运行状态 (Overview)
- **实时大盘**：直观展示服务运行状态（运行中/已停止）、进程 PID、常驻物理内存占用、连续运行时间。
- **流量与统计计数**：实时显示内核直通数据包、审查数据包、已拦截广告总数、阻断 IP 总数。
- **一键运维控制**：支持一键启动/停止服务、秒级热重载配置、一键更新基础数据库。

### 2. 广告拦截管理 (Adblock)
- **内置官方高精规则一键导入**：内置包含 51.7 万条规则的 `217heidai/adblockfilters`，点击即可一键载入。
- **自定义订阅链接录入**：支持输入任意第三方去广告规则订阅 URL（支持 AdGuard 格式、Hosts 格式、纯域名格式）。
- **分类管理与退订**：表格中清晰罗列所有已导入的规则分类与域名数，支持直接点击 `[🗑️ 删除]` 一键注销该分类并释放内存。
- **自动定时更新**：支持启用每天/每周自动更新外部去广告订阅规则。

### 3. GeoIP 国别过滤 (GeoIP)
- **中英文国家双向搜索**：输入国家名（如“美国”、“日本”、“俄罗斯”）、拼音或代码（如 `US`, `JP`），即时高亮匹配。
- **一键批量阻断**：勾选想要屏蔽的国家，点击【保存并立即应用】，即可全自动完成规则编译与秒级热重载。

### 4. 规则集管理 (Rules)
- **可视化 YAML 语法编辑器**：直观编辑 `/etc/opengfw/rules.yaml`。
- **丰富开箱即用模板**：
  - `白名单快速直通`：放行特定域名，防止任何误杀。
  - `广告 DNS 黑洞`：将恶意/广告域名解析结果就地修改为 `0.0.0.0`。
  - `DNS 穿透阻断`：阻断 DoT（853 端口）与公共 DoH 服务器，强制全内网设备使用路由器纯净 DNS。
  - `流量观察模式`：在日志中仅打印所有内网终端访问的 TLS SNI 域名，不阻断。

### 5. 运行日志 (Log)
- **实时清洗看板**：自动剥除 ANSI 终端转义乱码，清晰格式化展示每条审计与阻断日志。
- **交互控制**：支持自动刷新、手动刷新以及一键清空日志文件。

---

## 五、安装与快速上手教程

### 1. 目录结构
```text
openwrt-OpenGFW/
├── Makefile                                       # OpenWrt 编译 Makefile
├── adblock-tool/                                  # 规则编译合并引擎源码 (Go)
├── htdocs/luci-static/resources/view/opengfw/     # LuCI Web 界面组件
│   ├── overview.js                                # 运行大盘
│   ├── rules.js                                   # 规则编辑器
│   ├── adblock.js                                 # 广告拦截管理
│   ├── geoip.js                                   # 国别选择器
│   ├── countries_data.js                          # 全球 240+ 国家数据
│   └── log.js                                     # 日志查看看板
└── root/
    ├── etc/
    │   ├── init.d/opengfw                         # 服务守护脚本
    │   └── opengfw/rules.yaml                     # 规则集模板
    └── usr/bin/
        ├── opengfw                                # OpenGFW 主执行程序 (x86_64)
        ├── opengfw-adblock-tool                   # 规则编译工具
        ├── opengfw-status                         # 状态采集脚本
        └── opengfw-update-dat                     # 基础数据库持久化更新脚本
```

### 2. 方式一：下载预编译 IPK 网页一键安装（新手首选 / 自适应所有系统版本）

每次代码提交，GitHub Actions 会自动在 **Releases** 与 **Actions Artifacts** 页面构建生成最新安装包。

1. **选择对应 CPU 架构下载**：
   - Intel/AMD x86_64 软路由：下载 `luci-app-opengfw_*_x86_64.ipk`
   - ARM64 软/硬路由（树莓派、NanoPi R2S/R4S/R5S/R6S、RK3399/RK3568、MT798x）：下载 `luci-app-opengfw_*_aarch64_generic.ipk`
   - ARM32 路由（IPQ40xx 等）：下载 `luci-app-opengfw_*_arm_cortex-a7_neon-vfpv4.ipk`
   - MIPS 小端（MT7621、K2P、新路由 3）：下载 `luci-app-opengfw_*_mipsel_24kc.ipk`
   - 纯 WebUI 界面（全平台通用）：下载 `luci-app-opengfw_*_all.ipk`
2. **Web 界面一键上传安装**：
   - 登录 OpenWrt 路由器后台，点击 **【系统】 -> 【软件包】 -> 【上传软件包】**；
   - 选中下载的 `.ipk` 文件，点击 **【安装】** 即可。
   - 安装完成后刷新浏览器页面，在导航菜单 **【服务】 -> 【OpenGFW 防火墙】** 即可开箱即用！
3. **命令行 opkg 安装（可选）**：
   ```sh
   opkg update
   opkg install /tmp/luci-app-opengfw_*.ipk
   ```

### 3. 方式二：手动快速部署（开发者调试）

将编译好的二进制文件与脚本上传至 OpenWrt 软路由对应目录：
```sh
# 1. 拷贝二进制程序与脚本并赋权
chmod +x /usr/bin/opengfw /usr/bin/opengfw-adblock-tool /usr/bin/opengfw-status /usr/bin/opengfw-update-dat /usr/bin/opengfw-geoip-helper /usr/bin/opengfw-cron-update
chmod +x /etc/init.d/opengfw

# 2. 清理 LuCI 视图缓存
rm -rf /tmp/luci-indexcache /tmp/luci-modulecache

# 3. 首次启动服务
/etc/init.d/opengfw enable
/etc/init.d/opengfw start
```

### 4. 基础数据库初始化
在终端运行一次基础库拉取（自动下载 GeoIP 与 GeoSite 数据库）：
```sh
/usr/bin/opengfw-update-dat
```

---

## 六、命令行高级运维速查

在软路由 SSH 终端中，提供了一套完整的 CLI 运维命令：

```sh
# 查看当前防火墙运行状态与拦截计数 (JSON 格式)
opengfw-status

# 启动、停止、重启服务
/etc/init.d/opengfw start
/etc/init.d/opengfw stop
/etc/init.d/opengfw restart

# 秒级热重载规则 (不中断连接)
/etc/init.d/opengfw reload

# 外部去广告规则导入与管理 (opengfw-adblock-tool)
opengfw-adblock-tool list                                   # 查看当前已加载的所有规则分类与数量
opengfw-adblock-tool import /path/to/rules.txt my-ads       # 导入本地规则文件为分类 my-ads
opengfw-adblock-tool delete my-ads                          # 删除指定的规则分类并热重载
opengfw-adblock-tool prune /path/to/rules.txt /out.txt      # 域名冗余剪枝优化

# 手动更新 GeoIP/GeoSite 数据库（自动保留并重新合并自定义订阅与白名单）
opengfw-update-dat
```

---

## 七、常见问题解答 (FAQ)

### Q1: 开启后为什么有些视频网站的内嵌片头广告依然存在？
**A**: YouTube、Bilibili、爱奇艺等平台的客户端内置片头广告，其视频数据与广告数据使用的是相同的 CDN 域名（例如 `*.googlevideo.com`）。OpenGFW 是基于 TLS SNI 握手特征的透明流防火墙，为了保证用户隐私与证书安全，不解密 TLS 报文内部的具体 URL。对于这类广告，建议在客户端浏览器上配合 **uBlock Origin** 扩展使用。

### Q2: 遇到误拦截如何快速加入白名单？
**A**:
1. 进入 Web 界面【规则集管理】；
2. 在顶部的 `allow whitelist tls` 规则中，或者在 `/etc/opengfw/whitelist.txt` 文件中添加想要放行的域名（每行一个，如 `example.com`）；
3. 点击【保存并立即热重载】，新白名单即可秒级生效直通。

### Q3: 为什么路由器重启后拦截计数器归零了？
**A**: 这是 OpenWrt 官方的设计机制，`/var/log` 挂载在内存虚拟盘（tmpfs）中以保护软路由存储颗粒不受频繁写入磨损。您的所有规则配置、已导入的 50万+ 广告库以及白名单均永久保存在 `/etc/opengfw/` 中，系统重启后会自动加载，防护功能持续有效。

---

## 八、上游溯源与同步说明 (Upstream Tracking)

> ⚠️ **重要：本仓库 `upstream` 指向的 `HyNetworks/OpenGFW` 并非第三方 Fork，它就是 OpenGFW 原作者 apernet 的官方仓库。**
> 原地址 `github.com/apernet/OpenGFW` 已下线（返回 404），项目整体迁移至该组织账号下继续维护。

### 8.1 关于项目状态

根据上游 README 的官方说明，OpenGFW 已被原作者主动下架过一次，原因是有与官方关系密切、对外销售审查方案的公司抄袭其代码并入自有产品，这与项目「网络研究 / 广告拦截 / 家长控制」的初衷相悖；经社区沟通后重新公开。同时官方明确表示：

> *For now, we do not plan to actively continue developing OpenGFW ourselves. Instead, we intend to focus more of our efforts on Hysteria and other upcoming anti-censorship projects. However, if members of the community would like to continue developing OpenGFW, they are more than welcome to do so.*

即**上游已进入维护模式**：原作者重心转向 Hysteria 等反审查项目，对 OpenGFW 只会合并社区 PR、按需发版，不再主动开发新功能。

### 8.2 同步状态核对方法

```sh
# 1. 拉取上游最新提交与标签
git fetch upstream --tags --prune

# 2. 查看上游 master 的最新提交
git log -1 --format="%H %ad %s" --date=iso upstream/master

# 3. 计算分叉点，确认落后 / 领先多少个提交
MB=$(git merge-base main upstream/master)
echo "落后上游: $(git rev-list --count $MB..upstream/master) 个提交"
echo "领先上游: $(git rev-list --count $MB..main) 个提交"

# 4. 确认上游最新 Release
git ls-remote --tags upstream
```

### 8.3 当前基线（截至最近一次核对）

| 项目 | 值 |
| --- | --- |
| 上游仓库 | `https://github.com/HyNetworks/OpenGFW` |
| 上游 master | `581518071fbe72519887fc92250df31d86b4386c`（2026-10-04） |
| 分叉基点 | `5815180` —— 与上游 master 一致，**落后 0 个提交** |
| 上游最新 Release | `v0.4.3`（2026-10-04，为分叉点的祖先，已包含） |
| 本仓库增量 | OpenWrt 适配层（LuCI 面板、helper 脚本、打包与 CI 工作流） |

### 8.4 我们在上游之上做的核心改动

上游进入维护模式后，本仓库承担了「OpenWrt 化 + 功能补强 + 安全维护」的角色。除 `openwrt-OpenGFW/` 整层新增外，对上游 Go 源码有三处必要补丁：

1. **`ruleset/expr.go` —— 规则表达式环境补强**  
   将 `tls.sni` / `quic.sni` / `http.host` / `dns.name` 提升为可直接引用的扁平字段，并补充 `ip.protocol`、`tcp.*`、`udp.*` 等字段；同时把 `geoip` / `geosite` / `cidr` 三个内建函数改为带类型与空值防御的实现，避免上游 `params[0].(string)` 直接断言在空值时 panic。

2. **`io/nfqueue.go` —— 入站流量接管**  
   非 local 模式下新增 `PREROUTING`（nftables）与 `mangle/PREROUTING`（iptables）链挂载并放行 `lo`，使**外部连入**流量也能进入 DPI 判定，而不是只处理 `FORWARD` 出站流量。这是「国别入站拦截」与「防御外部扫描」得以成立的前提。

3. **依赖安全维护 —— `github.com/expr-lang/expr` 升级至 `v1.17.8`**  
   上游锁定在 `v1.16.3`，存在两个已披露漏洞：

   | 编号 | 问题 | 修复版本 |
   | --- | --- | --- |
   | GO-2025-4245 | Expr 内建函数无界递归导致拒绝服务 | v1.17.7 |
   | GO-2025-3525 | Expr 解析器处理无限制输入导致内存耗尽 | v1.17.0 |

   触发路径位于 `ruleset/expr.go` 的 `expr.Compile` 与 `vm.Run`（规则匹配主链路）。本仓库升级至 `v1.17.8` 后 `govulncheck ./...` 报告 **No vulnerabilities found**。

   升级已通过以下验证：`go build ./...`（linux/amd64）通过；全量 `go test ./...` 结果与升级前逐项一致；**真实投放的 `rules.yaml` 与「全部国家」生成版规则集均编译通过**；自定义 `expr` Patcher（`cidr` 常量折叠）与内建函数注册路径行为不变。

---

## 许可证 (License)

本项目遵循 [Mozilla Public License Version 2.0 (MPL 2.0)](LICENSE) 开源协议。
