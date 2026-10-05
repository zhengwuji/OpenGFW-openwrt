'use strict';
'require dom';
'require fs';
'require ui';
'require view';

const RULES_PATH = '/etc/opengfw/rules.yaml';
const RULES_EXAMPLE_PATH = '/etc/opengfw/rules.yaml.example';

const PURE_DEFAULT_RULES = `# ==============================================================================
# OpenGFW 初始纯净规则集 (没有任何拦截设置状态)
# 
# 规则说明：
# - 当前处于纯净全放行模式，未设置任何域名、IP 或协议阻断规则
# - 所有经过软路由的数据包均直接放行，仅在日志中输出访问域名审计
# ==============================================================================

# ------------------------------------------------------------------------------
# 1. 核心基础设施与管理端口放行（确保 SSH 与后台管理绝对安全）
# ------------------------------------------------------------------------------
- name: allow ssh
  action: allow
  expr: port.dst == 22 || port.src == 22

- name: allow router web management
  action: allow
  expr: (port.dst == 80 || port.dst == 443) && (cidr(ip.dst, "10.0.0.0/8") || cidr(ip.dst, "172.16.0.0/12") || cidr(ip.dst, "192.168.0.0/16"))

# ------------------------------------------------------------------------------
# 2. 流量审计与观察模式（在日志中打印所有内网终端访问的 TLS 域名，不执行任何拦截）
# ------------------------------------------------------------------------------
- name: observe tls sni
  log: true
  expr: tls != nil && tls.sni != ""
`;

const PRESETS = {
	ads: `# --- 广告拦截预设模板 ---
- name: 拦截广告-TLS
  action: block
  log: true
  expr: tls != nil && (geosite(tls.sni, "category-ads-all") || geosite(tls.sni, "adblockfilters"))

- name: 拦截广告-HTTP
  action: block
  log: true
  expr: http != nil && (geosite(http.host, "category-ads-all") || geosite(http.host, "adblockfilters"))

- name: 拦截广告-QUIC
  action: block
  log: true
  expr: quic != nil && (geosite(quic.sni, "category-ads-all") || geosite(quic.sni, "adblockfilters"))

- name: 广告DNS黑洞
  action: modify
  log: true
  expr: dns != nil && dns.qr && (geosite(dns.name, "category-ads-all") || geosite(dns.name, "adblockfilters"))
  modifier:
    name: dns
    args:
      a: "0.0.0.0"
`,
	proxy: `# --- 代理与全加密混淆流量阻断预设 (警告：开启将导致 Passwall2 / Xray 翻墙断网) ---
- name: 拦截全加密流量
  action: block
  log: true
  expr: fet != nil && fet.yes

- name: 拦截Trojan协议
  action: block
  log: true
  expr: trojan != nil && trojan.yes
`,
	parental: `# --- 家长控制与不良分类管控预设 ---
- name: 阻断成人色情内容
  action: block
  log: true
  expr: (tls != nil && geosite(tls.sni, "category-porn")) || (http != nil && geosite(http.host, "category-porn"))

- name: 阻断网络博彩关键词
  action: block
  log: true
  expr: (tls != nil && (tls.sni contains "casino" || tls.sni contains "bet"))
`,
	observe: `# --- 全局域名与流量审计预设 (只记录不拦截) ---
- name: 记录所有访问域名
  log: true
  expr: tls != nil && tls.sni != ""
`
};

function isRuleActive(content, keyword) {
	if (!content) return false;
	let lines = content.split('\n');
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i].trim();
		if (line.indexOf(keyword) !== -1) {
			if (!line.startsWith('#')) return true;
		}
	}
	return false;
}

function extractSpecialBlock(content, startTag, endTag) {
	if (!content) return '';
	let p1 = content.indexOf(startTag);
	let p2 = content.indexOf(endTag);
	if (p1 !== -1 && p2 !== -1 && p2 > p1) {
		return content.substring(p1, p2 + endTag.length).trim();
	}
	return '';
}

function detectRuleStates(content) {
	if (!content) content = '';
	return {
		ads: isRuleActive(content, 'block ads tls') || isRuleActive(content, 'category-ads-all'),
		ads_sinkhole: isRuleActive(content, 'sinkhole ads dns') || (isRuleActive(content, 'modify') && isRuleActive(content, '0.0.0.0')),
		proxy_fet: isRuleActive(content, 'fet.yes'),
		proxy_trojan: isRuleActive(content, 'trojan.yes'),
		parental_porn: isRuleActive(content, 'category-porn'),
		parental_gambling: isRuleActive(content, 'casino') || isRuleActive(content, 'bet'),
		dns_dot: isRuleActive(content, 'port.dst == 853'),
		dns_doh: isRuleActive(content, 'category-doh'),
		observe: isRuleActive(content, 'observe tls sni'),
		allow_ssh: isRuleActive(content, 'port.dst == 22'),
		allow_web: isRuleActive(content, 'router web management') || isRuleActive(content, 'port.dst == 80')
	};
}

function generateYamlFromState(state, existingContent) {
	let bypassBlock = extractSpecialBlock(existingContent, '# --- BEGIN_DEVICE_BYPASS ---', '# --- END_DEVICE_BYPASS ---');
	let customBlock = extractSpecialBlock(existingContent, '# --- BEGIN_CUSTOM_RULES ---', '# --- END_CUSTOM_RULES ---');
	let geoipBlock = extractSpecialBlock(existingContent, '# --- BEGIN_GEOIP_RULES ---', '# --- END_GEOIP_RULES ---');

	let lines = [];
	
	// 1. 设备直通名单保留
	if (bypassBlock) {
		lines.push(bypassBlock);
		lines.push('');
	}

	lines.push('# ==============================================================================');
	lines.push('# OpenGFW 流量过滤与深度包检测 (DPI) 规则集（GUI 可视化管理版）');
	lines.push('# 规则说明：规则按自上而下匹配，一旦命中带 action 的规则即终止判定');
	lines.push('# ==============================================================================');
	lines.push('');

	// 2. 自定义拦截清单保留
	if (customBlock) {
		lines.push(customBlock);
		lines.push('');
	}

	// 3. 用户白名单直通 (最高优先级，永远放行)
	lines.push('# ------------------------------------------------------------------------------');
	lines.push('# 0. 用户自定义白名单（最高优先级，直接内核直通，杜绝误杀）');
	lines.push('# ------------------------------------------------------------------------------');
	lines.push('- name: allow whitelist tls');
	lines.push('  action: allow');
	lines.push('  expr: tls != nil && tls.sni != nil && geosite(tls.sni, "whitelist")');
	lines.push('');
	lines.push('- name: allow whitelist http');
	lines.push('  action: allow');
	lines.push('  expr: http != nil && http.host != nil && geosite(http.host, "whitelist")');
	lines.push('');
	lines.push('- name: allow whitelist quic');
	lines.push('  action: allow');
	lines.push('  expr: quic != nil && quic.sni != nil && geosite(quic.sni, "whitelist")');
	lines.push('');
	lines.push('- name: allow whitelist dns');
	lines.push('  action: allow');
	lines.push('  expr: dns != nil && dns.name != nil && geosite(dns.name, "whitelist")');
	lines.push('');

	// 4. 地区 IP 过滤保留
	if (geoipBlock) {
		lines.push(geoipBlock);
		lines.push('');
	}

	// 5. 核心基础设施放行
	lines.push('# ------------------------------------------------------------------------------');
	lines.push('# 1. 核心基础设施与管理端口放行（确保 SSH 与后台管理绝对安全）');
	lines.push('# ------------------------------------------------------------------------------');
	if (state.allow_ssh !== false) {
		lines.push('- name: allow ssh');
		lines.push('  action: allow');
		lines.push('  expr: port.dst == 22 || port.src == 22');
		lines.push('');
	}
	if (state.allow_web !== false) {
		lines.push('- name: allow router web management');
		lines.push('  action: allow');
		lines.push('  expr: (port.dst == 80 || port.dst == 443) && (cidr(ip.dst, "10.0.0.0/8") || cidr(ip.dst, "172.16.0.0/12") || cidr(ip.dst, "192.168.0.0/16"))');
		lines.push('');
	}

	// 6. DNS 规避防护组
	if (state.dns_dot || state.dns_doh) {
		lines.push('# ------------------------------------------------------------------------------');
		lines.push('# 2. DNS 规避防范（阻断 DoT 与公共 DoH，迫使设备使用路由器本地安全 DNS）');
		lines.push('# ------------------------------------------------------------------------------');
		if (state.dns_dot) {
			lines.push('- name: block dot 853');
			lines.push('  action: block');
			lines.push('  log: true');
			lines.push('  expr: port.dst == 853');
			lines.push('');
		}
		if (state.dns_doh) {
			lines.push('- name: block doh providers');
			lines.push('  action: block');
			lines.push('  log: true');
			lines.push('  expr: tls != nil && tls.sni != nil && geosite(tls.sni, "category-doh")');
			lines.push('');
		}
	}

	// 7. 广告拦截组
	if (state.ads || state.ads_sinkhole) {
		lines.push('# ------------------------------------------------------------------------------');
		lines.push('# 3. 广告拦截规则组（基于 51.7万+ 条规则库底层透明过滤）');
		lines.push('# ------------------------------------------------------------------------------');
		if (state.ads) {
			lines.push('- name: block ads tls');
			lines.push('  action: block');
			lines.push('  log: true');
			lines.push('  expr: tls != nil && tls.sni != nil && (geosite(tls.sni, "category-ads-all") || geosite(tls.sni, "adblockfilters"))');
			lines.push('');
			lines.push('- name: block ads http');
			lines.push('  action: block');
			lines.push('  log: true');
			lines.push('  expr: http != nil && http.host != nil && (geosite(http.host, "category-ads-all") || geosite(http.host, "adblockfilters"))');
			lines.push('');
			lines.push('- name: block ads quic');
			lines.push('  action: block');
			lines.push('  log: true');
			lines.push('  expr: quic != nil && quic.sni != nil && (geosite(quic.sni, "category-ads-all") || geosite(quic.sni, "adblockfilters"))');
			lines.push('');
		}
		if (state.ads_sinkhole) {
			lines.push('# 将广告域名的 DNS 应答解析修改为 0.0.0.0（温和黑洞）');
			lines.push('- name: sinkhole ads dns');
			lines.push('  action: modify');
			lines.push('  log: true');
			lines.push('  expr: dns != nil && dns.qr && dns.name != nil && (geosite(dns.name, "category-ads-all") || geosite(dns.name, "adblockfilters"))');
			lines.push('  modifier:');
			lines.push('    name: dns');
			lines.push('    args:');
			lines.push('      a: "0.0.0.0"');
			lines.push('');
		}
	}

	// 8. 代理与全加密混淆阻断组
	if (state.proxy_fet || state.proxy_trojan) {
		lines.push('# ------------------------------------------------------------------------------');
		lines.push('# 4. 代理与全加密混淆流量检测与阻断（警告：开启将导致翻墙节点断连）');
		lines.push('# ------------------------------------------------------------------------------');
		if (state.proxy_fet) {
			lines.push('- name: block fully-encrypted');
			lines.push('  action: block');
			lines.push('  log: true');
			lines.push('  expr: fet != nil && fet.yes');
			lines.push('');
		}
		if (state.proxy_trojan) {
			lines.push('- name: block trojan');
			lines.push('  action: block');
			lines.push('  log: true');
			lines.push('  expr: trojan != nil && trojan.yes');
			lines.push('');
		}
	}

	// 9. 家长控制组
	if (state.parental_porn || state.parental_gambling) {
		lines.push('# ------------------------------------------------------------------------------');
		lines.push('# 5. 家长控制与不良分类管控');
		lines.push('# ------------------------------------------------------------------------------');
		if (state.parental_porn) {
			lines.push('- name: block adult content');
			lines.push('  action: block');
			lines.push('  log: true');
			lines.push('  expr: (tls != nil && geosite(tls.sni, "category-porn")) || (http != nil && geosite(http.host, "category-porn"))');
			lines.push('');
		}
		if (state.parental_gambling) {
			lines.push('- name: block gambling keywords');
			lines.push('  action: block');
			lines.push('  log: true');
			lines.push('  expr: (tls != nil && (tls.sni contains "casino" || tls.sni contains "bet")) || (http != nil && (http.host contains "casino" || http.host contains "bet"))');
			lines.push('');
		}
	}

	// 10. 流量审计组
	if (state.observe) {
		lines.push('# ------------------------------------------------------------------------------');
		lines.push('# 6. 流量审计与观察模式（在日志中打印所有内网终端访问的 TLS 域名）');
		lines.push('# ------------------------------------------------------------------------------');
		lines.push('- name: observe tls sni');
		lines.push('  log: true');
		lines.push('  expr: tls != nil && tls.sni != ""');
		lines.push('');
	}

	return lines.join('\n');
}

// 解决主题下 alert-message 通知框关闭事件
(function() {
	try {
		document.querySelectorAll('.alert-message').forEach(function(el) { el.remove(); });
	} catch(e) {}
	if (!window._opengfw_alert_dismiss_patched) {
		window._opengfw_alert_dismiss_patched = true;
		document.addEventListener('click', function(ev) {
			let t = ev.target;
			if (!t) return;
			let btn = (t.closest && t.closest('.alert-message button, .alert-message .btn, .alert-message .close')) ||
			          ((t.matches && (t.matches('.alert-message button, .alert-message .btn, .alert-message .close') || t.innerText === '关闭' || t.innerText === 'Dismiss')) ? t : null);
			if (btn) {
				let alertNode = btn.closest ? btn.closest('.alert-message') : btn.parentNode;
				if (alertNode) {
					ev.preventDefault();
					ev.stopPropagation();
					try { alertNode.remove(); } catch(e) { if (alertNode.parentNode) alertNode.parentNode.removeChild(alertNode); }
				}
			}
		}, true);
	}
})();

return view.extend({
	load: function() {
		return fs.read_direct(RULES_PATH).catch(function() {
			return fs.read_direct(RULES_EXAMPLE_PATH).catch(function() {
				return '# 未找到规则文件。';
			});
		});
	},

	render: function(rulesContent) {
		let currentView = 'gui'; // 'gui' (图形化) 或 'code' (代码编辑器)
		let ruleState = detectRuleStates(rulesContent);

		// 代码编辑器 textarea
		let textarea = E('textarea', {
			'id': 'opengfw_rules_textarea',
			'style': 'width: 100%; min-height: 520px; font-family: monospace, Consolas, "Courier New"; font-size: 13px; line-height: 1.5; padding: 12px; background: #1e1e1e; color: #d4d4d4; border-radius: 6px; border: 1px solid #333; resize: vertical;',
			'spellcheck': 'false'
		}, [ rulesContent ]);

		let syncGuiToCode = function() {
			let newYaml = generateYamlFromState(ruleState, textarea.value);
			textarea.value = newYaml;
		};

		let syncCodeToGui = function() {
			ruleState = detectRuleStates(textarea.value);
			updateAllCheckboxes();
		};

		let registeredCheckboxes = {};

		function updateAllCheckboxes() {
			for (let key in registeredCheckboxes) {
				if (registeredCheckboxes.hasOwnProperty(key)) {
					registeredCheckboxes[key].checked = !!ruleState[key];
					updateBadge(key, !!ruleState[key]);
				}
			}
		}

		function updateBadge(key, isChecked) {
			let badge = document.getElementById('badge_' + key);
			if (badge) {
				if (isChecked) {
					badge.textContent = '已启用';
					badge.style.background = '#2b8a3e';
					badge.style.color = '#fff';
				} else {
					badge.textContent = '已禁用';
					badge.style.background = 'rgba(128,128,128,0.2)';
					badge.style.color = '#888';
				}
			}
		}

		function createGuiItem(key, title, opt, isDangerous) {
			let isChecked = !!ruleState[key];

			let checkbox = E('input', {
				'type': 'checkbox',
				'class': 'cbi-input-checkbox',
				'id': 'chk_' + key,
				'style': 'width: 20px; height: 20px; cursor: pointer; accent-color: ' + (isDangerous ? '#e03131' : '#228be6') + ';'
			});
			checkbox.checked = isChecked;
			registeredCheckboxes[key] = checkbox;

			let badge = E('span', {
				'id': 'badge_' + key,
				'style': 'font-size: 11px; padding: 3px 10px; border-radius: 4px; font-weight: bold; ' + (isChecked ? 'background: #2b8a3e; color: #fff;' : 'background: rgba(128,128,128,0.2); color: #888;')
			}, isChecked ? _('已启用') : _('已禁用'));

			checkbox.addEventListener('change', function(ev) {
				let willEnable = ev.target.checked;
				if (willEnable && isDangerous) {
					ui.showModal(_('⚠️ 代理阻断高危功能警示提醒'), [
						E('p', { 'style': 'color: #e03131; font-weight: bold; font-size: 15px; margin-bottom: 8px;' }, _('极其重要原因与致命影响：')),
						E('p', { 'style': 'color: #212529; line-height: 1.6; margin-bottom: 10px; font-size: 13px;' },
							_('重要原因：如果把它做成基本设置里的全局默认开关，一旦开启，OpenGFW 就会把软路由上的 Passwall2 / Xray / 翻墙节点流量当成“违规加密代理”就地拦截阻断，导致您全家的科学上网立即断连失效！')),
						E('p', { 'style': 'color: #666; font-size: 12px; margin-bottom: 16px; line-height: 1.5;' },
							_('仅在明确需要禁止局域网一切终端挂代理翻墙的专有监管环境（如公司网络、涉密内网、考场等）下才允许开启。普通家庭用户强烈建议保持关闭！确定仍要强制开启吗？')),
						E('div', { 'class': 'right', 'style': 'text-align: right; display: flex; justify-content: flex-end; gap: 8px;' }, [
							E('button', {
								'class': 'btn cbi-button cbi-button-neutral',
								'click': function() {
									checkbox.checked = false;
									ruleState[key] = false;
									updateBadge(key, false);
									syncGuiToCode();
									ui.hideModal();
								}
							}, _('取消 (保持安全关闭)')),
							E('button', {
								'class': 'btn cbi-button cbi-button-reset',
								'style': 'background: #e03131; color: #fff; font-weight: bold;',
								'click': function() {
									ruleState[key] = true;
									updateBadge(key, true);
									syncGuiToCode();
									ui.hideModal();
								}
							}, _('我已知晓风险，强制开启'))
						])
					]);
				} else {
					ruleState[key] = willEnable;
					updateBadge(key, willEnable);
					syncGuiToCode();
				}
			});

			let borderColor = isDangerous ? 'rgba(224, 49, 49, 0.4)' : (isChecked ? 'rgba(43, 138, 62, 0.4)' : 'rgba(128, 128, 128, 0.2)');
			let itemBg = isDangerous ? 'rgba(224, 49, 49, 0.02)' : 'rgba(128, 128, 128, 0.02)';

			return E('div', {
				'style': 'background: ' + itemBg + '; border: 1px solid ' + borderColor + '; border-radius: 6px; padding: 14px 16px; margin-bottom: 12px;'
			}, [
				E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px;' }, [
					E('label', {
						'for': 'chk_' + key,
						'style': 'display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: bold; font-size: 14px; color: #212529; margin: 0;'
					}, [
						checkbox,
						title,
						opt.recTag ? E('span', {
							'style': 'font-size: 11px; padding: 2px 7px; border-radius: 3px; font-weight: normal; background: ' + (opt.recColor || '#1c7ed6') + '; color: #fff;'
						}, opt.recTag) : null
					]),
					badge
				]),
				E('div', {
					'style': 'background: rgba(128, 128, 128, 0.04); border-left: 3px solid ' + (isDangerous ? '#e03131' : '#2b8a3e') + '; padding: 10px 14px; border-radius: 0 4px 4px 0; margin-left: 28px; font-size: 12px; line-height: 1.6;'
				}, [
					E('div', { 'style': 'margin-bottom: 5px;' }, [
						E('strong', { 'style': 'color: ' + (isDangerous ? '#c92a2a' : '#2b8a3e') + ';' }, _('💡 重要原因与底层影响：')),
						E('span', { 'style': 'color: #333;' }, opt.why)
					]),
					opt.principle ? E('div', { 'style': 'margin-bottom: 5px;' }, [
						E('strong', { 'style': 'color: #495057;' }, _('⚙️ 工作原理与技术实现：')),
						E('span', { 'style': 'color: #555;' }, opt.principle)
					]) : null,
					opt.vpnImpact ? E('div', { 'style': 'margin-bottom: 5px;' }, [
						E('strong', { 'style': 'color: ' + (isDangerous ? '#e03131' : '#1c7ed6') + ';' }, _('🚀 对科学上网与日常体验影响：')),
						E('span', { 'style': 'color: ' + (isDangerous ? '#c92a2a' : '#333') + ';' }, opt.vpnImpact)
					]) : null,
					opt.recommendation ? E('div', {}, [
						E('strong', { 'style': 'color: #888;' }, _('📌 适用场景与推荐配置：')),
						E('span', { 'style': 'color: #495057; font-weight: 500;' }, opt.recommendation)
					]) : null
				])
			]);
		}

		function createCategoryCard(title, subtitle, items, alertBox) {
			return E('div', {
				'class': 'cbi-section',
				'style': 'background: #fff; border: 1px solid rgba(128, 128, 128, 0.15); border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.02);'
			}, [
				E('div', { 'style': 'border-bottom: 1px solid rgba(128, 128, 128, 0.15); padding-bottom: 8px; margin-bottom: 12px;' }, [
					E('h4', { 'style': 'margin: 0; font-size: 15px; font-weight: bold; color: #212529;' }, title),
					E('div', { 'style': 'font-size: 12px; color: #888; margin-top: 3px;' }, subtitle)
				]),
				alertBox || null,
				E('div', {}, items)
			]);
		}

		// 1. 广告拦截组
		let cardAds = createCategoryCard(
			_('🛡️ 广告与全网恶意追踪拦截组 (AdBlock)'),
			_('基于内置与导入的 51.7万+ 条广告特征规则库，在第 7 层透明识别过滤，杜绝手机、电脑、电视广告干扰。'),
			[
				createGuiItem(
					'ads',
					_('全网广告与追踪拦截 (TLS / HTTP / QUIC)'),
					{
						why: _('手机、电视、平板、PC 端各大 App（如优爱腾、知乎、微博、网易云等）充斥着大量开屏广告、横幅插播和隐私埋点。通过软路由网关集中拦截，免除所有终端单独安装去广告插件的繁琐，电视盒子等不可装插件设备也能畅享清爽体验。'),
						principle: _('利用 DPI 引擎深度检测 TLS Client Hello 中的 SNI 扩展、HTTP 请求头 Host 以及 QUIC 握手头部，实时命中 51.7万+ 条 GeoSite 广告规则库，在 TCP/UDP 首包握手期主动发送 TCP RST 复位切断。'),
						vpnImpact: _('【完全兼容无冲突】：对正常国内国外合法网站 100% 畅通；与 Passwall2 协同运作，若个别小众国内业务偶有误拦，可在「基本设置」一键添加域名白名单秒级放行。'),
						recommendation: _('【强烈推荐开启 🛡️】全家设备统一去广告必备，净网效果显著。'),
						recTag: _('强烈推荐开启'),
						recColor: '#2b8a3e'
					},
					false
				),
				createGuiItem(
					'ads_sinkhole',
					_('广告域名 DNS 黑洞化重写 (Sinkhole to 0.0.0.0)'),
					{
						why: _('如果仅在 TCP 握手阶段掐断连接，部分 App 或浏览器会持续重试连接甚至等待 30 秒 TCP 超时，导致打开网页时图片加载缓慢、页面转圈白屏或排版裂图。开启 DNS 黑洞化后，客户端在域名解析阶段就直接收到 0.0.0.0，立即判定广告服务器不可达并瞬间放弃，网页加载极速秒开！'),
						principle: _('当内网设备发起已知广告域名的 DNS A/AAAA 查询时，OpenGFW 在首层拦截并利用 DNS modifier 原地修改响应包，将解析 IP 重写为 0.0.0.0（标准 DNS 黑洞技术）。'),
						vpnImpact: _('【速度大幅提升】：网页与 App 响应更加敏捷流畅，彻底消除“去广告导致网页打开变慢”的痛点，完全不影响正常翻墙。'),
						recommendation: _('【强烈推荐开启 ⚡】有效消除网页图片加载延迟。'),
						recTag: _('强烈推荐开启'),
						recColor: '#2b8a3e'
					},
					false
				)
			]
		);

		// 2. 代理协议与全加密流量阻断 (高危管控组)
		let proxyAlert = E('div', {
			'style': 'background: rgba(224, 49, 49, 0.08); border-left: 4px solid #e03131; padding: 12px 16px; border-radius: 4px; margin-bottom: 14px;'
		}, [
			E('div', { 'style': 'color: #c92a2a; font-weight: bold; font-size: 14px; margin-bottom: 5px;' }, _('⚠️ 极其重要警告提醒（关系到全家科学上网翻墙状态）：')),
			E('div', { 'style': 'color: #212529; font-size: 12px; line-height: 1.6;' },
				_('重要原因：如果把它做成基本设置里的全局默认开关，一旦开启，OpenGFW 就会把软路由上的 Passwall2 / Xray / 翻墙节点流量当成“违规加密代理”就地拦截阻断，导致您全家的科学上网立即断连失效！因此该高危功能被严格隔离在此处，并设置了强制二次确认拦截弹窗。普通家庭用户日常使用请务必保持关闭！仅在严禁内网翻墙的专有监管网络中按需开启。'))
		]);

		let cardProxy = createCategoryCard(
			_('🛑 代理协议与全加密混淆流量阻断 (Proxy & FET) —— 【高危管控组】'),
			_('专用于企业、涉密单位或特定监管内网，严查并杜绝终端私自架设或使用翻墙工具。'),
			[
				createGuiItem(
					'proxy_fet',
					_('阻断全加密混淆流量 (FET / Fully-Encrypted Traffic)'),
					{
						why: _('重要原因：如果开启此项（或如果把它做成基本设置里的全局默认开关），一旦开启，OpenGFW 就会把软路由上的 Passwall2 / Xray / 翻墙节点流量当成“违规加密代理”就地拦截阻断，导致您全家的科学上网立即断连失效！通过包长分布特征与高熵值计算，深度识别无明文握手协议特征的纯加密翻墙流量（如 Shadowsocks、纯 VMess 等）。一旦开启，将直接导致软路由内网此类代理通道全部被掐断，普通家庭切勿开启！'),
						principle: _('FET (Fully-Encrypted Traffic) 算法基于香农信息熵和前序数据包载荷长度分布特征，用于深度识别无明文协议特征、纯高度混淆伪装的数据流。'),
						vpnImpact: _('【致命阻断】：所有无特定伪装的加密翻墙节点将被全部直接掐断，导致手机与电脑完全无法翻墙科学上网。'),
						recommendation: _('【普通家庭用户请务必保持关闭 ❌】仅适用于严禁内网翻墙的涉密单位、企业办公网或考场监控局域网。'),
						recTag: _('家庭请保持关闭'),
						recColor: '#e03131'
					},
					true
				),
				createGuiItem(
					'proxy_trojan',
					_('阻断 Trojan 代理协议'),
					{
						why: _('重要原因：如果把它做成基本设置里的全局默认开关，一旦开启，OpenGFW 就会把软路由上的 Passwall2 / Xray / 翻墙节点流量当成“违规加密代理”就地拦截阻断，导致您全家的科学上网立即断连失效！精确匹配 Trojan 协议特有的 56 字节 Hex 密码特征首包，命中后秒级切断。开启后所有 Trojan 类型的翻墙节点将全部失效！'),
						principle: _('精准比对数据流 TLS 握手后第一个应用层数据包的前 56 字节 Hex 密码校验散列值特征，识别出人工伪装成 HTTPS 网站的 Trojan 代理服务。'),
						vpnImpact: _('【致命阻断】：Passwall2 / Xray 中所有类型为 Trojan 协议的翻墙节点出站连接将被当场发送 TCP RST 切断。'),
						recommendation: _('【普通家庭用户请务必保持关闭 ❌】仅在特殊企业管控内网按需开启。'),
						recTag: _('家庭请保持关闭'),
						recColor: '#e03131'
					},
					true
				)
			],
			proxyAlert
		);

		// 3. 家长控制与不良分类管控
		let cardParental = createCategoryCard(
			_('🔞 家长控制与不良分类管控 (Parental Controls)'),
			_('保护未成年人身心健康，杜绝内网设备接触不良、色情与网络赌博网站。'),
			[
				createGuiItem(
					'parental_porn',
					_('阻断成人色情内容 (内置全球百万级黑名单分类)'),
					{
						why: _('全面守护未成年人与青少年的身心健康，防范家中小孩在使用手机、平板上网课或玩耍时误点、误入各类涉黄网站、成人论坛或低俗弹窗。'),
						principle: _('依托 GeoSite 官方分类数据库 category-porn，覆盖全球主流与衍生色情域名、涉黄直播及关联图床 CDN，在 TLS SNI 握手及 HTTP 请求阶段进行毫秒级阻断。'),
						vpnImpact: _('【精准过滤】：仅拦截涉黄域名与图床，不影响任何正常主流网站与 Passwall2 翻墙节点。'),
						recommendation: _('【有儿童或学生的家庭强烈推荐按需开启 🔞】构建绿色纯净的家庭网关屏障。'),
						recTag: _('家庭按需开启'),
						recColor: '#f59f00'
					},
					false
				),
				createGuiItem(
					'parental_gambling',
					_('阻断网络博彩与赌博网站 (casino / bet 关键词)'),
					{
						why: _('网络赌博、境外博彩网站多伴随网络钓鱼、杀猪盘欺诈与资金洗劫风险，开启后可在网关首道防线拦截家庭成员因误点涉赌链接而遭受财产损失。'),
						principle: _('在 L7 应用层深度扫描 HTTP Host 与 TLS SNI 域名字符串，精准匹配 casino（赌场）、bet（下注/博彩）、poker（扑克赌博）等高风险关键词。'),
						vpnImpact: _('【无冲突】：仅拦截博彩关键词域名，对日常主流网络与翻墙无任何负面影响。'),
						recommendation: _('【建议按需开启 🎰】杜绝家庭成员误触涉赌涉诈陷阱。'),
						recTag: _('建议按需开启'),
						recColor: '#f59f00'
					},
					false
				)
			]
		);

		// 4. DNS 防护与反规避组
		let cardDns = createCategoryCard(
			_('🌐 DNS 防护与防规避组 (DNS Security)'),
			_('封堵客户端私自加密绕过软路由本地 DNS 的通道，确保全家设备统一受控。'),
			[
				createGuiItem(
					'dns_dot',
					_('阻断 DoT (DNS over TLS) 853 端口'),
					{
						why: _('现代很多智能手机（如小米 MIUI/HyperOS、华为、三星、OPPO、vivo 等）出厂默认开启了“私人 DNS”，会自动尝试通过 853 端口向境外公共 DNS 建立加密连接。这会导致手机的所有域名解析完全跳过软路由的本地 DNS，造成软路由上的广告拦截、域名分流和智能加速全面失效！'),
						principle: _('拦截目的地端口为 853 的 TCP/UDP 报文，切断设备擅自与外网建立的私有 DNS 隧道，促使设备自动降级回退至软路由本地下发的局域网安全 DNS。'),
						vpnImpact: _('【增强接管】：迫使手机服从路由器的统一调度，让 Passwall2 域名智能分流与去广告规则 100% 稳定接管。'),
						recommendation: _('【强烈推荐开启 🌐】确保全屋网络行为受控统一。'),
						recTag: _('强烈推荐开启'),
						recColor: '#2b8a3e'
					},
					false
				),
				createGuiItem(
					'dns_doh',
					_('阻断公共 DoH (DNS over HTTPS) 服务器'),
					{
						why: _('电脑端主流浏览器（如 Chrome、Edge、Firefox）常常默认提示开启“安全 DNS”，使用 HTTPS 443 端口伪装向公共 DoH 服务器解析域名。这不仅导致去广告失效，还会将国内网站错误解析到海外 CDN 导致打开极慢。'),
						principle: _('根据 GeoSite 规则库中的 category-doh 规则，识别并阻断各大公共 DoH 服务的 TLS SNI 握手，强制浏览器回退至局域网本地 DNS。'),
						vpnImpact: _('【确保分流】：消除因国外公共 DNS 导致的国内网站 CDN 解析偏远迟缓问题，保证路由器本地智能分流发挥最佳效能。'),
						recommendation: _('【推荐开启 🌐】保持局域网解析策略一致无绕路。'),
						recTag: _('推荐开启'),
						recColor: '#2b8a3e'
					},
					false
				)
			]
		);

		// 5. 访问审计与基础设施安全放行
		let cardObserve = createCategoryCard(
			_('👁️ 访问审计与核心基础设施放行'),
			_('基础运维安全守护与网络全景状态观察。'),
			[
				createGuiItem(
					'observe',
					_('内网域名访问实时审计模式 (observe tls sni)'),
					{
						why: _('家庭网络管理员需要直观了解当前局域网内各设备正在访问哪些互联网服务（例如是在看视频、打游戏还是访问未知站点），有助于排查网络卡顿、分析异常流量或追溯被误杀的域名。'),
						principle: _('实时提取所有内网设备发送的 TLS Client Hello 报文中的 SNI 扩展域名并打入日志（例如 action=none sni=www.jd.com），不执行任何拦截阻断动作，数据包 100% 原速放行。'),
						vpnImpact: _('【完全零负面影响】：纯日志审计模式，不改变数据包，网络吞吐与科学上网完全不受影响。'),
						recommendation: _('【强烈推荐开启 👁️】配合「实时拦截 Top 看板」与「实时日志」实现全景网络掌控。'),
						recTag: _('强烈推荐开启'),
						recColor: '#2b8a3e'
					},
					false
				),
				createGuiItem(
					'allow_ssh',
					_('核心管理端口安全放行 (SSH 22 / Web 80/443 管理)'),
					{
						why: _('作为软路由防火墙的绝对安全“保命底线”！如果在下方自定义规则中不慎写错了全局拦截或全端口阻断指令，有了此项置顶放行规则，管理员电脑永远可以顺利连接软路由的 22 端口（终端维护）和局域网 Web 后台（80/443），绝不发生软路由断连“失联成砖”的悲剧。'),
						principle: _('在 Netfilter 过滤链首位匹配端口 22 以及私有网段（10/172/192）的 80/443 端口并标记为 allow 直通，优先于所有后续拦截规则。'),
						vpnImpact: _('【安全底线】：仅作用于局域网内软路由自身管理端口，对外网流量和科学上网无任何干扰。'),
						recommendation: _('【强制常开保底 🛡️】系统安全生命线，请勿关闭。'),
						recTag: _('强制推荐开启'),
						recColor: '#2b8a3e'
					},
					false
				)
			]
		);

		// GUI 容器
		let guiContainer = E('div', { 'id': 'opengfw_gui_view_container' }, [
			// 一键快捷批量配置栏
			E('div', {
				'style': 'background: rgba(128,128,128,0.05); border: 1px solid rgba(128,128,128,0.15); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px;'
			}, [
				E('div', {}, [
					E('strong', { 'style': 'font-size: 13px; color: #212529; margin-right: 6px;' }, _('⚡ 一键智能配置方案:')),
					E('span', { 'style': 'font-size: 12px; color: #888;' }, _('点击一键切换适合您使用场景的推荐规则组合'))
				]),
				E('div', { 'style': 'display: flex; flex-wrap: wrap; gap: 8px;' }, [
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'style': 'font-size: 12px;',
						'click': function(ev) {
							ev.preventDefault();
							ruleState.ads = true;
							ruleState.ads_sinkhole = true;
							ruleState.dns_dot = true;
							ruleState.dns_doh = true;
							ruleState.observe = true;
							ruleState.allow_ssh = true;
							ruleState.allow_web = true;
							ruleState.proxy_fet = false; // 严防断网
							ruleState.proxy_trojan = false; // 严防断网
							ruleState.parental_porn = false;
							ruleState.parental_gambling = false;
							updateAllCheckboxes();
							syncGuiToCode();
							ui.addNotification(null, E('p', {}, '✅ 已一键切换为【推荐家庭过滤配置】（广告+DNS+审计全开，代理阻断保持关闭以保证 Passwall2 翻墙正常）！请点击下方【保存并立即热重载】使之生效。'), 'info');
						}
					}, _('🛡️ 一键开启推荐配置 (安全不影响翻墙)')),

					E('button', {
						'class': 'btn cbi-button cbi-button-neutral',
						'style': 'font-size: 12px;',
						'click': function(ev) {
							ev.preventDefault();
							for (let k in ruleState) {
								if (ruleState.hasOwnProperty(k)) ruleState[k] = false;
							}
							ruleState.allow_ssh = true;
							ruleState.allow_web = true;
							ruleState.observe = true;
							updateAllCheckboxes();
							syncGuiToCode();
							ui.addNotification(null, E('p', {}, '🕊️ 已一键切换为【纯净全放行配置】（关闭所有广告与分类阻断，仅保留管理放行与日志审计）！请点击下方【保存并立即热重载】使之生效。'), 'info');
						}
					}, _('🕊️ 一键纯净全放行 (关闭全部阻断)'))
				])
			]),

			cardAds,
			cardProxy,
			cardParental,
			cardDns,
			cardObserve
		]);

		// Code 容器 (代码编辑器)
		let codeContainer = E('div', { 'id': 'opengfw_code_view_container', 'style': 'display: none;' }, [
			E('div', { 'class': 'cbi-section', 'style': 'margin-bottom: 12px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;' }, [
				E('strong', { 'style': 'margin-right: 6px;' }, _('一键插入常用规则代码块:')),
				E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': function() { insertPreset('ads'); } }, _('+ 🛡️ 广告拦截代码')),
				E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': function() { insertPreset('proxy'); } }, _('+ 🛑 代理阻断代码')),
				E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': function() { insertPreset('parental'); } }, _('+ 🔞 家长控制代码')),
				E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': function() { insertPreset('observe'); } }, _('+ 📋 域名审计代码'))
			]),
			E('div', { 'class': 'cbi-section' }, [ textarea ])
		]);

		let insertPreset = function(presetKey) {
			let snippet = PRESETS[presetKey];
			if (!snippet) return;
			let cur = textarea.value;
			if (cur.indexOf(snippet.trim()) !== -1) {
				ui.showModal(_('提示'), [ E('p', { 'style': 'color: #f76707;' }, _('该预设规则已存在于当前规则集中，无需重复添加。')), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('确定')) ]) ]);
				return;
			}
			textarea.value = cur.trim() + '\n\n' + snippet;
			textarea.scrollTop = textarea.scrollHeight;
			syncCodeToGui();
			ui.showModal(_('已追加预设'), [ E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('预设模板已追加到规则末尾，请点击【保存并立即热重载】使之生效。')), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('确定')) ]) ]);
		};

		let saveRules = function(reload) {
			if (currentView === 'gui') {
				syncGuiToCode();
			}
			let content = textarea.value;
			if (!content || !content.trim()) {
				ui.showModal(_('错误'), [ E('p', { 'style': 'color: #dc3545;' }, _('规则内容不能为空！')), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('确定')) ]) ]);
				return;
			}
			ui.showModal(_('正在保存规则'), [
				E('p', { 'class': 'spinning' }, _('正在写入规则文件并核验语法，请稍候...'))
			]);
			return fs.write(RULES_PATH, content).then(function() {
				if (reload) {
					return fs.exec_direct('/etc/init.d/opengfw', ['reload']).then(function() {
						ui.hideModal();
						ui.showModal(_('保存成功'), [
							E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('✅ 规则已成功保存并完成秒级热重载！')),
							E('p', { 'style': 'color: #666; font-size: 12px;' }, _('所有新规则与功能开关已立即生效，网络未中断。')),
							E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
								E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('完成'))
							])
						]);
					});
				} else {
					ui.hideModal();
					ui.showModal(_('保存成功'), [
						E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('✅ 规则已成功保存至文件。')),
						E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
							E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('完成'))
						])
					]);
				}
			}).catch(function(err) {
				ui.hideModal();
				ui.showModal(_('保存失败'), [
					E('p', { 'style': 'color: #dc3545;' }, _('保存规则失败: ') + err),
					E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
						E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('关闭'))
					])
				]);
			});
		};

		let applyReset = function(newContent, desc, autoSave) {
			textarea.value = newContent;
			textarea.scrollTop = 0;
			syncCodeToGui();
			if (autoSave) {
				return saveRules(true);
			} else {
				ui.showModal(_('已恢复规则'), [
					E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('✅ 已成功恢复为【' + desc + '】！')),
					E('p', { 'style': 'color: #666; font-size: 12px;' }, _('图形化开关与代码编辑器均已同步刷新。请确认后点击【💾 保存并立即热重载 (秒级生效)】生效。')),
					E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
						E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('确定'))
					])
				]);
			}
		};

		let resetDefault = function() {
			ui.showModal(_('恢复默认规则集 (rules.yaml)'), [
				E('p', { 'style': 'margin-bottom: 12px; font-size: 13px; color: #333;' }, _('请选择您希望恢复的目标默认状态（将清除当前自定义拦截与设备旁路标记）：')),
				E('div', { 'style': 'display: flex; flex-direction: column; gap: 12px; margin-bottom: 15px;' }, [
					// 选项 1: 纯净空白默认规则 (没有任何拦截设置)
					E('div', { 'style': 'border: 1px solid #2b8a3e; background: rgba(43, 138, 62, 0.05); border-radius: 6px; padding: 12px;' }, [
						E('div', { 'style': 'font-weight: bold; font-size: 14px; color: #2b8a3e; margin-bottom: 4px;' }, _('🕊️ 纯净空白默认规则 (没有任何拦截设置)')),
						E('div', { 'style': 'font-size: 12px; color: #666; margin-bottom: 10px; line-height: 1.4;' }, _('完全没有任何广告、代理或分类拦截规则，仅保留路由器基础管理放行与域名日志审计，全流量直通无阻断。')),
						E('div', { 'style': 'display: flex; gap: 8px;' }, [
							E('button', {
								'class': 'btn cbi-button cbi-button-apply',
								'style': 'padding: 4px 12px; font-size: 12px;',
								'click': function() {
									ui.hideModal();
									applyReset(PURE_DEFAULT_RULES, _('纯净空白默认规则 (无任何拦截设置)'), true);
								}
							}, _('💾 恢复并立即热重载')),
							E('button', {
								'class': 'btn cbi-button cbi-button-neutral',
								'style': 'padding: 4px 12px; font-size: 12px;',
								'click': function() {
									ui.hideModal();
									applyReset(PURE_DEFAULT_RULES, _('纯净空白默认规则 (无任何拦截设置)'), false);
								}
							}, _('✏️ 仅载入编辑器'))
						])
					]),

					// 选项 2: 出厂标准模板规则 (含预设广告拦截)
					E('div', { 'style': 'border: 1px solid #1c7ed6; background: rgba(28, 126, 214, 0.05); border-radius: 6px; padding: 12px;' }, [
						E('div', { 'style': 'font-weight: bold; font-size: 14px; color: #1c7ed6; margin-bottom: 4px;' }, _('📦 出厂标准模板规则 (含开箱即用广告拦截)')),
						E('div', { 'style': 'font-size: 12px; color: #666; margin-bottom: 10px; line-height: 1.4;' }, _('恢复为官方出厂标准规则集（包含白名单、基础管理、常用广告拦截与分类模板注释）。')),
						E('div', { 'style': 'display: flex; gap: 8px;' }, [
							E('button', {
								'class': 'btn cbi-button cbi-button-apply',
								'style': 'padding: 4px 12px; font-size: 12px;',
								'click': function() {
									ui.hideModal();
									fs.read_direct(RULES_EXAMPLE_PATH).then(function(content) {
										applyReset(content, _('出厂标准模板规则'), true);
									});
								}
							}, _('💾 恢复并立即热重载')),
							E('button', {
								'class': 'btn cbi-button cbi-button-neutral',
								'style': 'padding: 4px 12px; font-size: 12px;',
								'click': function() {
									ui.hideModal();
									fs.read_direct(RULES_EXAMPLE_PATH).then(function(content) {
										applyReset(content, _('出厂标准模板规则'), false);
									});
								}
							}, _('✏️ 仅载入编辑器'))
						])
					])
				]),
				E('div', { 'class': 'right', 'style': 'text-align: right;' }, [
					E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('取消'))
				])
			]);
		};

		// 模式切换按钮组
		let btnGuiMode = E('button', {
			'class': 'btn cbi-button cbi-button-primary',
			'style': 'font-weight: bold; border-radius: 4px 0 0 4px; margin-right: 0;'
		}, _('🎛️ 图形化控制面板 (点击即设置)'));

		let btnCodeMode = E('button', {
			'class': 'btn cbi-button cbi-button-neutral',
			'style': 'border-radius: 0 4px 4px 0; margin-left: -1px;'
		}, _('📝 YAML 高级代码编辑器'));

		btnGuiMode.addEventListener('click', function() {
			if (currentView === 'gui') return;
			currentView = 'gui';
			btnGuiMode.className = 'btn cbi-button cbi-button-primary';
			btnGuiMode.style.fontWeight = 'bold';
			btnCodeMode.className = 'btn cbi-button cbi-button-neutral';
			btnCodeMode.style.fontWeight = 'normal';
			syncCodeToGui();
			codeContainer.style.display = 'none';
			guiContainer.style.display = 'block';
		});

		btnCodeMode.addEventListener('click', function() {
			if (currentView === 'code') return;
			currentView = 'code';
			btnCodeMode.className = 'btn cbi-button cbi-button-primary';
			btnCodeMode.style.fontWeight = 'bold';
			btnGuiMode.className = 'btn cbi-button cbi-button-neutral';
			btnGuiMode.style.fontWeight = 'normal';
			syncGuiToCode();
			guiContainer.style.display = 'none';
			codeContainer.style.display = 'block';
		});

		return E('div', { 'class': 'cbi-map' }, [
			E('div', { 'style': 'display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px;' }, [
				E('h2', { 'style': 'margin: 0;' }, _('OpenGFW 规则集管理 (rules.yaml)')),
				E('div', { 'style': 'display: flex; gap: 8px;' }, [
					E('button', {
						'class': 'btn cbi-button cbi-button-reset',
						'style': 'font-weight: bold;',
						'click': resetDefault
					}, _('🔄 恢复默认规则'))
				])
			]),
			E('div', { 'class': 'cbi-map-descr', 'style': 'margin-bottom: 14px;' },
				_('支持【图形化控制面板】一键开关与【YAML 高级代码编辑器】双模式实时同步。每个功能均配有详细底层影响说明，点击【保存并立即热重载】可秒级生效，网络不掉线。')),

			// 视图模式切换栏
			E('div', { 'style': 'display: flex; align-items: center; margin-bottom: 16px;' }, [
				btnGuiMode,
				btnCodeMode
			]),

			// 主视图展示区域
			guiContainer,
			codeContainer,

			// 底部操作按钮栏
			E('div', { 'class': 'cbi-section', 'style': 'margin-top: 18px; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px;' }, [
				E('div', { 'style': 'display: flex; gap: 10px;' }, [
					E('button', {
						'class': 'btn cbi-button cbi-button-apply',
						'style': 'font-weight: bold; font-size: 14px; padding: 6px 20px;',
						'click': function() { saveRules(true); }
					}, _('💾 保存并立即热重载 (秒级生效)')),
					E('button', {
						'class': 'btn cbi-button cbi-button-save',
						'click': function() { saveRules(false); }
					}, _('仅保存文件'))
				]),
				E('div', {}, [
					E('button', {
						'class': 'btn cbi-button cbi-button-reset',
						'click': resetDefault
					}, _('🔄 恢复默认规则'))
				])
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
