/**
 * OpenGFW 白名单与黑名单直编控制台 (傻瓜式多行编辑与一键防误杀预设)
 */
'use strict';
'require dom';
'require fs';
'require ui';
'require view';

const WHITELIST_PATH = '/etc/opengfw/whitelist.txt';
const CUSTOM_JSON_PATH = '/etc/opengfw/custom_rules.json';
const WL_HELPER = '/usr/bin/opengfw-whitelist-helper';
const CUSTOM_HELPER = '/usr/bin/opengfw-custom-helper';

// 常用防误杀傻瓜式预设库
const PRESETS = {
	google: {
		name: '🌐 谷歌 / Gmail / FCM 全家桶',
		desc: '放行谷歌搜索、Gmail邮箱、GMS推送信标、Play商店与核心后端接口',
		domains: [
			'google.com', 'gmail.com', 'googleapis.com', 'gstatic.com',
			'googleusercontent.com', 'gvt1.com', 'gvt2.com', 'gvt3.com',
			'android.com', '1e100.net', 'googlemail.com', 'ggpht.com'
		]
	},
	apple: {
		name: '🍎 苹果服务与 APNs 推送',
		desc: '放行苹果系统级后台推送、天气组件、App Store与iCloud',
		domains: [
			'push.apple.com', 'apple.com', 'icloud.com',
			'weather-analytics-events.apple.com', 'mzstatic.com', 'aaplimg.com'
		]
	},
	alipay: {
		name: '💳 阿里 / 支付宝 / 淘宝 AMDC 调度',
		desc: '放行移动网络调度中心，彻底解决手机连WiFi开支付宝/淘宝卡顿转圈',
		domains: [
			'amdc.alipay.com', 'alipay.com', 'taobao.com', 'alicdn.com'
		]
	},
	vendor_push: {
		name: '📱 小米 / 华为 / vivo / OPPO 手机推送',
		desc: '放行各主流国产品牌系统级后台消息通知信道与安全鉴权',
		domains: [
			'xmpush.xiaomi.com', 'push.oppomobile.com', 'push.vivo.com.cn',
			'push.hicloud.com', 'authbe.sec.intl.miui.com'
		]
	},
	microsoft: {
		name: '🪟 微软 Office 365 / Windows',
		desc: '放行Office 365在线办公、Teams、Windows更新与配置同步',
		domains: [
			'microsoft.com', 'office.com', 'live.com',
			'default.exp-tas.com', 'windowsupdate.com'
		]
	},
	dns: {
		name: '🛡️ 公共加密 DNS',
		desc: '放行主流公共加密DNS服务',
		domains: [
			'dns.google', 'cloudflare-dns.com'
		]
	}
};

// 常见黑名单阻断预设示例
const BLACKLIST_PRESETS = {
	mining: {
		name: '⛏️ 常见挖矿与恶意脚本域名',
		domains: [
			'coinhive.com', 'coin-hive.com', 'jsecoin.com', 'cryptoloot.pro',
			'minr.pw', 'webminepool.com'
		]
	},
	telemetry: {
		name: '🚫 弹窗流氓广告及高危域名',
		domains: [
			'union.baidu.com', 'tanx.com', 'pos.baidu.com', 'cpro.baidu.com'
		]
	}
};

function getNowStr() {
	let d = new Date();
	let pad = function(n) { return (n < 10 ? '0' : '') + n; };
	return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
	       pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function cleanDomainOrIp(raw) {
	if (!raw) return { value: '', comment: '', isIp: false };
	let comment = '';
	let line = raw.trim();
	if (line.indexOf('#') !== -1) {
		let parts = line.split('#');
		line = parts[0].trim();
		comment = parts.slice(1).join('#').trim();
	}
	// 去除协议头与路径
	line = line.replace(/^[a-zA-Z]+:\/\//, '');
	line = line.split('/')[0];
	line = line.split(':')[0]; // 去除端口
	line = line.toLowerCase().trim();

	// 检查是否是 IP 或 CIDR
	let isIp = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(line) ||
	           /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(\/\d{1,3})?$/.test(line);

	return { value: line, comment: comment, isIp: isIp };
}

return view.extend({
	load: function() {
		return Promise.all([
			fs.read_direct(WHITELIST_PATH).catch(function() { return ''; }),
			fs.read_direct(CUSTOM_JSON_PATH).then(function(res) {
				try { return JSON.parse(res); } catch(e) { return []; }
			}).catch(function() { return []; })
		]);
	},

	render: function(loadedData) {
		let rawWhitelistText = loadedData[0] || '';
		let customRules = Array.isArray(loadedData[1]) ? loadedData[1] : [];

		// 从 whitelist.txt 解析已有域名
		let wlDomains = [];
		rawWhitelistText.split('\n').forEach(function(l) {
			l = l.trim();
			if (!l || l.startsWith('#')) return;
			let item = cleanDomainOrIp(l);
			if (item.value && wlDomains.indexOf(item.value) === -1) {
				wlDomains.push(item.value);
			}
		});

		// 从 custom_rules.json 提取已有加白 IP
		let wlIps = [];
		customRules.forEach(function(r) {
			if (r.action === 'allow') {
				let val = (r.value || '').trim();
				let comment = (r.comment || '').trim();
				if (val) {
					let lineStr = val + (comment ? ' # ' + comment : '');
					if (wlIps.indexOf(lineStr) === -1) {
						wlIps.push(lineStr);
					}
				}
			}
		});

		// 合并初始化白名单文本
		let initialWlText = wlDomains.concat(wlIps).join('\n');

		// 从 custom_rules.json 提取已有黑名单 (action === 'block')
		let blLines = [];
		customRules.forEach(function(r) {
			if (r.action === 'block') {
				let val = (r.value || '').trim();
				let comment = (r.comment || '').trim();
				if (val) {
					blLines.push(val + (comment ? ' # ' + comment : ''));
				}
			}
		});
		let initialBlText = blLines.join('\n');

		// ===== UI 控件构建 =====
		let activeTab = 'whitelist';

		// 头部统计徽章
		let wlBadge = E('span', {
			'style': 'background: #dcfce7; color: #15803d; font-size: 12px; font-weight: bold; padding: 3px 8px; border-radius: 12px; margin-left: 8px;'
		}, _('已加白: ') + (wlDomains.length + wlIps.length) + _(' 条'));

		let blBadge = E('span', {
			'style': 'background: #fee2e2; color: #b91c1c; font-size: 12px; font-weight: bold; padding: 3px 8px; border-radius: 12px; margin-left: 8px;'
		}, _('黑名单: ') + blLines.length + _(' 条'));

		// 导航 Tab 按钮
		let tabBtnWl = E('button', {
			'class': 'btn cbi-button cbi-button-action',
			'style': 'padding: 6px 18px; font-size: 13px; font-weight: bold; margin-right: 8px;',
			'click': function() { switchTab('whitelist'); }
		}, [ _('🛡️ 放行白名单 (防误杀)'), wlBadge ]);

		let tabBtnBl = E('button', {
			'class': 'btn cbi-button cbi-button-neutral',
			'style': 'padding: 6px 18px; font-size: 13px; font-weight: bold; margin-right: 8px;',
			'click': function() { switchTab('blacklist'); }
		}, [ _('🛑 精准黑名单 (强阻断)'), blBadge ]);

		let tabBtnSplit = E('button', {
			'class': 'btn cbi-button cbi-button-neutral',
			'style': 'padding: 6px 18px; font-size: 13px; font-weight: bold;',
			'click': function() { switchTab('split'); }
		}, _('📑 双栏对比分列编辑'));

		// ===== 白名单编辑区域 =====
		let wlTextarea = E('textarea', {
			'class': 'cbi-input-textarea',
			'style': 'width: 100%; min-height: 340px; font-family: monospace; font-size: 13px; line-height: 1.5; padding: 10px; border-radius: 6px; border: 1px solid #86efac; background: #f0fdf4;',
			'placeholder': _('在此直接输入或粘贴需要放行的域名或 IP (每行一个，支持 # 注释)，例如:\n') +
			               _('google.com                # 自动放行该域名及所有子域名\n') +
			               _('amdc.alipay.com           # 阿里移动网络调度中心 (解决支付宝/淘宝卡顿)\n') +
			               _('push.apple.com            # 苹果 APNs 实时推送通道\n') +
			               _('91.108.56.0/22            # 支持单机 IP 或 CIDR 网段\n')
		});
		wlTextarea.value = initialWlText;

		// 白名单预设按钮组
		let wlPresetContainer = E('div', {
			'style': 'display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center;'
		}, [
			E('span', { 'style': 'font-size: 12px; font-weight: bold; color: #166534;' }, _('⚡ 傻瓜式一键防误杀预设:'))
		]);

		Object.keys(PRESETS).forEach(function(key) {
			let p = PRESETS[key];
			let btn = E('button', {
				'class': 'btn cbi-button cbi-button-positive',
				'style': 'padding: 3px 10px; font-size: 12px; border-radius: 4px;',
				'title': p.desc,
				'click': function() {
					let currentLines = wlTextarea.value.split('\n').map(function(l) { return cleanDomainOrIp(l).value; }).filter(Boolean);
					let added = 0;
					p.domains.forEach(function(d) {
						if (currentLines.indexOf(d.toLowerCase()) === -1) {
							if (wlTextarea.value && !wlTextarea.value.endsWith('\n')) {
								wlTextarea.value += '\n';
							}
							wlTextarea.value += d + '\n';
							added++;
						}
					});
					updateCounters();
					if (added > 0) {
						ui.addNotification(null, E('p', {}, _('已追加 %d 个域名至白名单编辑框，点击【保存并立即生效】即可落盘！').format(added)), 'info');
					} else {
						ui.addNotification(null, E('p', {}, _('【%s】包含的所有域名均已在白名单中，无需重复添加。').format(p.name)), 'info');
					}
				}
			}, p.name);
			wlPresetContainer.appendChild(btn);
		});

		// 白名单操作栏
		let wlSaveBtn = E('button', {
			'class': 'btn cbi-button cbi-button-apply',
			'style': 'padding: 6px 20px; font-size: 13px; font-weight: bold; background: #16a34a; border-color: #15803d; color: #ffffff;',
			'click': function() { saveWhitelist(); }
		}, _('💾 保存并立即生效白名单'));

		let wlReloadBtn = E('button', {
			'class': 'btn cbi-button cbi-button-neutral',
			'style': 'padding: 6px 14px; font-size: 12px;',
			'click': function() {
				wlTextarea.value = initialWlText;
				updateCounters();
				ui.addNotification(null, E('p', {}, _('已恢复至初始加载的白名单配置')), 'info');
			}
		}, _('🔄 恢复未修改内容'));

		let wlClearBtn = E('button', {
			'class': 'btn cbi-button cbi-button-reset',
			'style': 'padding: 6px 14px; font-size: 12px;',
			'click': function() {
				if (confirm(_('确定清空白名单编辑框中的所有内容吗？（需点击保存后才会真正生效）'))) {
					wlTextarea.value = '';
					updateCounters();
				}
			}
		}, _('🧹 清空输入框'));

		let wlSection = E('div', {
			'class': 'cbi-section',
			'style': 'background: #ffffff; border: 1px solid #bbf7d0; border-radius: 8px; padding: 18px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);'
		}, [
			E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;' }, [
				E('div', {}, [
					E('h3', { 'style': 'margin: 0; color: #166534; font-size: 16px; font-weight: bold;' }, _('🛡️ 放行白名单 (Whitelist · 核心直通防误杀)')),
					E('div', { 'style': 'font-size: 12px; color: #65a30d; margin-top: 4px;' },
						_('白名单享有内核最高优先级直通，彻底免除广告规则、DPI 深度包检测与全加密识别的误杀。每行一个域名或 IP。'))
				])
			]),
			wlPresetContainer,
			wlTextarea,
			E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-top: 14px;' }, [
				E('div', { 'style': 'display: flex; gap: 8px;' }, [
					wlReloadBtn,
					wlClearBtn
				]),
				wlSaveBtn
			])
		]);

		// ===== 黑名单编辑区域 =====
		let blTextarea = E('textarea', {
			'class': 'cbi-input-textarea',
			'style': 'width: 100%; min-height: 340px; font-family: monospace; font-size: 13px; line-height: 1.5; padding: 10px; border-radius: 6px; border: 1px solid #fca5a5; background: #fff1f2;',
			'placeholder': _('在此直接输入或粘贴需要精准阻断的域名或 IP (每行一个，支持 # 注释)，例如:\n') +
			               _('bad-ads.example.com       # 阻断该域名及所有子域名\n') +
			               _('malicious-site.top        # 阻断恶意仿冒网站\n') +
			               _('198.51.100.4              # 阻断特定外网恶意服务器\n') +
			               _('203.0.113.0/24            # 阻断整个恶意网段\n')
		});
		blTextarea.value = initialBlText;

		// 黑名单预设按钮组
		let blPresetContainer = E('div', {
			'style': 'display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center;'
		}, [
			E('span', { 'style': 'font-size: 12px; font-weight: bold; color: #991b1b;' }, _('🛑 常用黑名单参考快捷导入:'))
		]);

		Object.keys(BLACKLIST_PRESETS).forEach(function(key) {
			let p = BLACKLIST_PRESETS[key];
			let btn = E('button', {
				'class': 'btn cbi-button cbi-button-reset',
				'style': 'padding: 3px 10px; font-size: 12px; border-radius: 4px;',
				'click': function() {
					let currentLines = blTextarea.value.split('\n').map(function(l) { return cleanDomainOrIp(l).value; }).filter(Boolean);
					let added = 0;
					p.domains.forEach(function(d) {
						if (currentLines.indexOf(d.toLowerCase()) === -1) {
							if (blTextarea.value && !blTextarea.value.endsWith('\n')) {
								blTextarea.value += '\n';
							}
							blTextarea.value += d + '\n';
							added++;
						}
					});
					updateCounters();
					if (added > 0) {
						ui.addNotification(null, E('p', {}, _('已追加 %d 条记录至黑名单编辑框，点击【保存并立即生效】后生效！').format(added)), 'info');
					}
				}
			}, p.name);
			blPresetContainer.appendChild(btn);
		});

		let blSaveBtn = E('button', {
			'class': 'btn cbi-button cbi-button-apply',
			'style': 'padding: 6px 20px; font-size: 13px; font-weight: bold; background: #dc2626; border-color: #b91c1c; color: #ffffff;',
			'click': function() { saveBlacklist(); }
		}, _('💾 保存并立即生效黑名单'));

		let blReloadBtn = E('button', {
			'class': 'btn cbi-button cbi-button-neutral',
			'style': 'padding: 6px 14px; font-size: 12px;',
			'click': function() {
				blTextarea.value = initialBlText;
				updateCounters();
				ui.addNotification(null, E('p', {}, _('已恢复至初始加载的黑名单配置')), 'info');
			}
		}, _('🔄 恢复未修改内容'));

		let blClearBtn = E('button', {
			'class': 'btn cbi-button cbi-button-reset',
			'style': 'padding: 6px 14px; font-size: 12px;',
			'click': function() {
				if (confirm(_('确定清空黑名单编辑框中的所有内容吗？（需点击保存后才会真正生效）'))) {
					blTextarea.value = '';
					updateCounters();
				}
			}
		}, _('🧹 清空输入框'));

		let blSection = E('div', {
			'class': 'cbi-section',
			'style': 'background: #ffffff; border: 1px solid #fecaca; border-radius: 8px; padding: 18px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);'
		}, [
			E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;' }, [
				E('div', {}, [
					E('h3', { 'style': 'margin: 0; color: #991b1b; font-size: 16px; font-weight: bold;' }, _('🛑 精准黑名单 (Blacklist · 底层强制阻断)')),
					E('div', { 'style': 'font-size: 12px; color: #b91c1c; margin-top: 4px;' },
						_('命中黑名单的目标将被 OpenGFW 立即拦截阻断（覆盖 TLS SNI、HTTP Host、QUIC 及 DNS 查询），每行一个。'))
				])
			]),
			blPresetContainer,
			blTextarea,
			E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-top: 14px;' }, [
				E('div', { 'style': 'display: flex; gap: 8px;' }, [
					blReloadBtn,
					blClearBtn
				]),
				blSaveBtn
			])
		]);

		// 分列双栏容器
		let splitContainer = E('div', {
			'style': 'display: none; grid-template-columns: 1fr 1fr; gap: 20px;'
		}, [
			wlSection,
			blSection
		]);

		// 更新徽章数字
		function updateCounters() {
			let wlCount = wlTextarea.value.split('\n').filter(function(l) { return l.trim() && !l.trim().startsWith('#'); }).length;
			let blCount = blTextarea.value.split('\n').filter(function(l) { return l.trim() && !l.trim().startsWith('#'); }).length;
			wlBadge.innerText = _('已加白: ') + wlCount + _(' 条');
			blBadge.innerText = _('黑名单: ') + blCount + _(' 条');
		}

		wlTextarea.addEventListener('input', updateCounters);
		blTextarea.addEventListener('input', updateCounters);

		// 切换 Tab 逻辑
		function switchTab(mode) {
			activeTab = mode;
			tabBtnWl.className = (mode === 'whitelist') ? 'btn cbi-button cbi-button-action' : 'btn cbi-button cbi-button-neutral';
			tabBtnBl.className = (mode === 'blacklist') ? 'btn cbi-button cbi-button-action' : 'btn cbi-button cbi-button-neutral';
			tabBtnSplit.className = (mode === 'split') ? 'btn cbi-button cbi-button-action' : 'btn cbi-button cbi-button-neutral';

			if (mode === 'whitelist') {
				splitContainer.style.display = 'none';
				wlSection.style.display = 'block';
				blSection.style.display = 'none';
				if (wlSection.parentNode !== mainContainer) {
					mainContainer.appendChild(wlSection);
				}
			} else if (mode === 'blacklist') {
				splitContainer.style.display = 'none';
				wlSection.style.display = 'none';
				blSection.style.display = 'block';
				if (blSection.parentNode !== mainContainer) {
					mainContainer.appendChild(blSection);
				}
			} else { // split
				wlSection.style.display = 'block';
				blSection.style.display = 'block';
				splitContainer.appendChild(wlSection);
				splitContainer.appendChild(blSection);
				splitContainer.style.display = 'grid';
			}
		}

		// ===== 保存白名单业务逻辑 =====
		function saveWhitelist() {
			let lines = wlTextarea.value.split('\n');
			let newDomains = [];
			let newIps = [];

			lines.forEach(function(l) {
				l = l.trim();
				if (!l || l.startsWith('#') || l.startsWith('//')) return;
				let item = cleanDomainOrIp(l);
				if (!item.value) return;
				if (item.isIp) {
					newIps.push({
						id: 'w_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
						type: 'ip',
						value: item.value,
						action: 'allow',
						direction: 'both',
						comment: item.comment || _('白名单放行'),
						enabled: true,
						time: getNowStr()
					});
				} else {
					if (newDomains.indexOf(item.value) === -1) {
						newDomains.push(item.value);
					}
				}
			});

			ui.showModal(_('正在应用白名单'), [
				E('p', { 'class': 'spinning' }, _('正在将白名单同步编译进 geosite.dat 规则库并平滑热重载 OpenGFW，请稍候...'))
			]);

			// 1. 写入 /etc/opengfw/whitelist.txt
			let wlFileContent = newDomains.join('\n') + '\n';
			fs.write_direct(WHITELIST_PATH, wlFileContent).then(function() {
				// 2. 更新 custom_rules.json (保留所有 block 规则，替换 allow IP 规则)
				let updatedCustom = customRules.filter(function(r) {
					return r.action === 'block'; // 保留黑名单
				}).concat(newIps);

				return fs.write_direct(CUSTOM_JSON_PATH, JSON.stringify(updatedCustom, null, 2));
			}).then(function() {
				// 3. 执行编译与重载
				return fs.exec_direct(WL_HELPER, ['sync']).then(function() {
					return fs.exec_direct(CUSTOM_HELPER, ['apply']);
				});
			}).then(function() {
				ui.hideModal();
				customRules = customRules.filter(function(r) { return r.action === 'block'; }).concat(newIps);
				initialWlText = wlTextarea.value;
				updateCounters();
				ui.addNotification(null, E('p', {}, _('🎉 白名单保存成功！已同步 %d 个域名至内核库，并放行 %d 个 IP 网段。系统已平滑热重载！').format(newDomains.length, newIps.length)), 'info');
			}).catch(function(err) {
				ui.hideModal();
				ui.addNotification(null, E('p', {}, _('保存失败: ') + (err.message || err)), 'error');
			});
		}

		// ===== 保存黑名单业务逻辑 =====
		function saveBlacklist() {
			let lines = blTextarea.value.split('\n');
			let newBlockedItems = [];

			lines.forEach(function(l, idx) {
				l = l.trim();
				if (!l || l.startsWith('#') || l.startsWith('//')) return;
				let item = cleanDomainOrIp(l);
				if (!item.value) return;
				newBlockedItems.push({
					id: 'b_' + Date.now() + '_' + idx,
					type: item.isIp ? 'ip' : 'domain',
					value: item.value,
					action: 'block',
					direction: 'both',
					comment: item.comment || _('黑名单精准阻断'),
					enabled: true,
					time: getNowStr()
				});
			});

			ui.showModal(_('正在应用黑名单'), [
				E('p', { 'class': 'spinning' }, _('正在编译黑名单阻断规则并平滑热重载 OpenGFW 内核，请稍候...'))
			]);

			// 更新 custom_rules.json (保留所有 allow 规则，替换 block 规则)
			let updatedCustom = customRules.filter(function(r) {
				return r.action === 'allow'; // 保留白名单
			}).concat(newBlockedItems);

			fs.write_direct(CUSTOM_JSON_PATH, JSON.stringify(updatedCustom, null, 2)).then(function() {
				return fs.exec_direct(CUSTOM_HELPER, ['apply']);
			}).then(function() {
				ui.hideModal();
				customRules = updatedCustom;
				initialBlText = blTextarea.value;
				updateCounters();
				ui.addNotification(null, E('p', {}, _('🎉 黑名单保存成功！已生效 %d 条精准阻断规则，OpenGFW 已平滑热重载！').format(newBlockedItems.length)), 'info');
			}).catch(function(err) {
				ui.hideModal();
				ui.addNotification(null, E('p', {}, _('保存失败: ') + (err.message || err)), 'error');
			});
		}

		// 主容器
		let mainContainer = E('div', { 'class': 'cbi-map' }, [
			E('h2', { 'style': 'margin-bottom: 6px;' }, _('OpenGFW 白名单与黑名单直编控制台')),
			E('div', { 'class': 'cbi-map-descr', 'style': 'margin-bottom: 18px;' },
				_('傻瓜式直接编辑白名单与黑名单列表。支持直接粘贴多行域名或 IP，内置常用防误杀预设（一键添加谷歌、苹果、微软、阿里调度、各大厂商推送），保存后内核秒级平滑热生效！无需懂 YAML 语法。')),

			// 顶栏切换按钮组
			E('div', { 'style': 'display: flex; gap: 8px; margin-bottom: 20px; align-items: center;' }, [
				tabBtnWl,
				tabBtnBl,
				tabBtnSplit
			]),

			wlSection,
			blSection,
			splitContainer
		]);

		// 默认显示白名单单栏
		switchTab('whitelist');

		return mainContainer;
	}
});
