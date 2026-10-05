# luci-app-opengfw —— OpenWrt 深度流控与流量防火墙插件

本目录为适用于 OpenWrt 软路由环境的 **OpenGFW 插件完整源码包**。基于 OpenWrt 标准架构与 LuCI 客户端视图规范开发，实现开箱即用的傻瓜式 Web 管理与网关转发级 DPI 流量拦截。

---

## 一、目录结构

```text
openwrt-OpenGFW/
├── Makefile                                       # OpenWrt 标准包构建 Makefile
├── README.md                                      # 插件说明文档
├── htdocs/luci-static/resources/view/opengfw/     # 现代化 LuCI Web 前端视图
│   ├── overview.js                                # 基本设置、运行大盘、流量计数器与一键运维
│   ├── rules.js                                   # 规则管理 (YAML 编辑器 + 常用预设一键插入 + 热重载)
│   ├── adblock.js                                 # 广告规则导入 (支持 217heidai/adblockfilters 等各类源)
│   └── log.js                                     # 实时流量审计与拦截日志流看板
├── adblock-tool/                                  # 广告拦截规则智能解析与二进制导入工具源码
│   └── main.go
└── root/
    ├── etc/
    │   ├── config/
    │   │   └── opengfw                            # UCI 配置文件
    │   ├── init.d/
    │   │   └── opengfw                            # Procd 服务守护脚本 (start/stop/reload/status)
    │   ├── opengfw/
    │   │   ├── rules.yaml                         # 默认规则集 (含详细中文注释与常用配置)
    │   │   └── rules.yaml.example                 # 规则备份模板
    │   └── uci-defaults/
    │       └── 99-luci-app-opengfw                # 首次安装权限配置脚本
    └── usr/
        ├── bin/
        │   ├── opengfw                            # OpenGFW 编译二进制 (x86_64)
        │   ├── opengfw-status                     # LuCI 状态监控辅助脚本 (输出 JSON)
        │   └── opengfw-update-dat                 # 一键从 CDN 更新 GeoIP/GeoSite 规则库
        └── share/
            ├── luci/
            │   └── menu.d/
            │       └── luci-app-opengfw.json      # LuCI 菜单注册文件 (服务 -> OpenGFW 防火墙)
            └── rpcd/
                └── acl.d/
                    └── luci-app-opengfw.json      # RPCD 权限访问控制配置
```

---

## 二、核心功能

1. **傻瓜式 Web 管理**：
   - 自动注册到 LuCI 导航菜单：**服务 (Services) -> OpenGFW 防火墙**。
   - **状态大盘**：直观展示服务运行状态、进程 PID、内存消耗、已检测数据包、放行直通包、拦截阻断包计数。
   - **一键快捷操作**：一键重启服务、一键发送 `SIGHUP` 信号热重载规则（秒级生效，连接不掉线）、一键更新规则库。
2. **可视化规则管理与预设模板**：
   - 内置代码高亮规则编辑器，自带一键插入常用规则模板：
     - 🛡️ **广告拦截**：全网免客户端拦截常见广告域名的 TLS SNI、HTTP 及 DNS。
     - 🛑 **防代理与全加密混淆流量**：深度检测 Shadowsocks / VMess-TCP / Trojan 流量。
     - 🔞 **家长控制**：成人分类、博彩、不良关键词精准阻断。
     - 📋 **纯审计日志模式**：只记录全屋设备发起的 TLS SNI 请求，不拦截。
3. **网关转发透明拦截**：
   - 专为软路由网关场景优化，挂载至 nftables 的 `FORWARD` 链，对局域网内所有手机、电脑、IoT 设备实现透明深度检测。
   - 放行后的正常连接打上 `ct mark 1001` 直通标记，后续数据包内核硬件级直通，CPU 消耗低。
4. **实时日志跟踪**：
   - 网页端实时轮询 `/var/log/opengfw.log`，最新日志置顶，支持按 `block`、`sni`、`dns`、`drop` 等关键词即时过滤搜索。

---

## 三、常用命令速查

在软路由 SSH 终端中：

```sh
# 启动服务
/etc/init.d/opengfw start

# 停止服务 (自动清理 nftables 规则)
/etc/init.d/opengfw stop

# 重载规则 (SIGHUP 无感秒级热生效)
/etc/init.d/opengfw reload

# 查看运行状态与流量统计
/usr/bin/opengfw-status

# 手动更新 GeoIP 与 GeoSite 数据库
/usr/bin/opengfw-update-dat
```
