'use strict';
'require dom';
'require form';
'require fs';
'require poll';
'require rpc';
'require uci';
'require ui';
'require view';

function safeJsonParse(str) {
	if (!str || typeof str !== 'string') return {};
	try {
		return JSON.parse(str.trim());
	} catch(e) {
		try {
			let cleaned = str.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
			                 .replace(/\t/g, ' ')
			                 .replace(/\r/g, '');
			return JSON.parse(cleaned.trim());
		} catch(e2) {
			return {};
		}
	}
}

function createStatCard(title, id, initialValue, color) {
	return E('div', {
		'style': 'background: rgba(128, 128, 128, 0.05); border: 1px solid rgba(128, 128, 128, 0.15); border-radius: 6px; padding: 10px 8px; text-align: center; display: flex; flex-direction: column; justify-content: center; min-width: 0; box-sizing: border-box;'
	}, [
		E('div', { 'style': 'font-size: 12px; color: #888; margin-bottom: 6px; white-space: normal; word-break: break-word; line-height: 1.3;' }, title),
		E('div', {
			'id': id,
			'style': 'font-size: 14px; font-weight: bold; white-space: normal; word-break: break-word; ' + (color ? 'color: ' + color + ';' : '')
		}, initialValue)
	]);
}

function extractDomainFromEvent(evStr) {
	if (!evStr) return null;
	let m = evStr.match(/(?:sni|host|name)[:=]\s*["']?([a-zA-Z0-9][-a-zA-Z0-9_.]*\.[a-zA-Z]{2,})["']?/i);
	if (m && m[1]) return m[1].toLowerCase();
	let m2 = evStr.match(/([a-zA-Z0-9][-a-zA-Z0-9_]*\.(?:com|cn|net|org|io|cc|me|vip|top|xyz|app|site|live|tv|info|club|fun|online|shop|pro|asia|mobi|tech|co)[a-zA-Z0-9_.]*)/i);
	if (m2 && m2[1]) return m2[1].toLowerCase();
	return null;
}

function renderRecentEvents(events) {
	if (events && events.length > 0) {
		return events.map(function(evStr) {
			let isAd = evStr.indexOf('广告') !== -1 || evStr.indexOf('adblock') !== -1 || evStr.indexOf('block ads') !== -1;
			let isGeo = evStr.indexOf('地区') !== -1 || evStr.indexOf('custom_ips') !== -1 || evStr.indexOf('自定义IP') !== -1;
			let isTrojan = evStr.indexOf('trojan') !== -1;
			let badge = isAd ? E('span', { 'style': 'background: #e03131; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 11px; white-space: nowrap;' }, '🛡️ 广告阻断') :
						(isGeo ? E('span', { 'style': 'background: #f76707; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 11px; white-space: nowrap;' }, '🌐 地区IP阻断') :
						(isTrojan ? E('span', { 'style': 'background: #d6336c; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 11px; white-space: nowrap;' }, '🔒 Trojan代理阻断') :
						E('span', { 'style': 'background: #7950f2; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 11px; white-space: nowrap;' }, '⛔ 规则阻断')));

			let domain = extractDomainFromEvent(evStr);
			let actions = [];
			if (domain) {
				actions.push(E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'style': 'padding: 2px 8px; font-size: 11px; white-space: nowrap; margin-left: 8px;',
					'click': function(ev) {
						ev.preventDefault();
						return fs.exec('/usr/bin/opengfw-whitelist-helper', ['add', domain]).then(function() {
							if (window._opengfw_reload_whitelist) window._opengfw_reload_whitelist();
							ui.showModal(_('白名单添加成功'), [
								E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('✅ 域名 [' + domain + '] 已成功加入白名单并秒级生效！')),
								E('p', { 'style': 'color: #666; font-size: 12px;' }, _('后续该域名的访问将直接内核放行直通，不再拦截。')),
								E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
									E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('完成'))
								])
							]);
						}).catch(function(err) {
							ui.showModal(_('添加失败'), [ E('p', { 'style': 'color: #dc3545;' }, _('添加失败: ') + err) ]);
						});
					}
				}, _('⚡ 加白名单')));
			}

			return E('div', { 'style': 'border-bottom: 1px dashed rgba(128, 128, 128, 0.2); padding: 6px 0; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px;' }, [
				E('div', { 'style': 'display: flex; align-items: center; gap: 8px;' }, [ badge ]),
				E('div', { 'style': 'flex: 1; min-width: 200px; color: #333; word-break: break-all;' }, evStr),
				E('div', {}, actions)
			]);
		});
	} else {
		return [ E('div', { 'style': 'color: #28a745; text-align: center; padding: 8px;' }, _('✅ 当前网络畅通。当检测到广告请求或拦截国家 IP 连接时将在此实时展示！')) ];
	}
}

function renderTopDomains(domains) {
	if (!domains || domains.length === 0) {
		return [ E('div', { 'style': 'color: #888; text-align: center; padding: 14px; font-size: 12px;' }, _('暂无高频拦截域名记录')) ];
	}
	return domains.map(function(item, idx) {
		let rankColor = idx === 0 ? '#f59f00' : (idx === 1 ? '#495057' : (idx === 2 ? '#d9480f' : '#868e96'));
		let rankBg = idx === 0 ? 'rgba(245, 159, 0, 0.15)' : (idx === 1 ? 'rgba(134, 142, 150, 0.15)' : (idx === 2 ? 'rgba(217, 72, 15, 0.15)' : 'rgba(173, 181, 189, 0.12)'));
		let pct = Math.max(5, Math.min(100, item.percent || 10));

		return E('div', {
			'style': 'padding: 6px 0; border-bottom: 1px dashed rgba(128, 128, 128, 0.15); display: flex; flex-direction: column; gap: 4px;'
		}, [
			E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; gap: 8px;' }, [
				E('div', { 'style': 'display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1;' }, [
					E('span', {
						'style': 'display: inline-block; width: 22px; height: 18px; line-height: 18px; text-align: center; font-size: 11px; font-weight: bold; border-radius: 3px; background: ' + rankBg + '; color: ' + rankColor + '; flex-shrink: 0;'
					}, '#' + (idx + 1)),
					E('span', {
						'style': 'font-family: monospace; font-size: 12px; font-weight: 600; color: #212529; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
						'title': item.domain
					}, item.domain)
				]),
				E('div', { 'style': 'display: flex; align-items: center; gap: 6px; flex-shrink: 0;' }, [
					E('span', { 'style': 'font-size: 11px; font-weight: bold; color: #e03131; background: rgba(224, 49, 49, 0.1); padding: 1px 6px; border-radius: 3px;' }, item.count + ' 次'),
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'style': 'padding: 1px 6px; font-size: 11px; line-height: 1.4;',
						'click': function(ev) {
							ev.preventDefault();
							return fs.exec('/usr/bin/opengfw-whitelist-helper', ['add', item.domain]).then(function() {
								if (window._opengfw_reload_whitelist) window._opengfw_reload_whitelist();
								ui.showModal(_('域名加白成功'), [
									E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('✅ 域名 [' + item.domain + '] 已加入白名单并秒级生效！')),
									E('p', { 'style': 'color: #666; font-size: 12px;' }, _('后续该域名的访问将直接内核放行直通，不再拦截。')),
									E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
										E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('完成'))
									])
								]);
							});
						}
					}, _('⚡ 加白'))
				])
			]),
			E('div', { 'style': 'width: 100%; height: 4px; background: rgba(128, 128, 128, 0.1); border-radius: 2px; overflow: hidden;' }, [
				E('div', { 'style': 'width: ' + pct + '%; height: 100%; background: linear-gradient(90deg, #ff6b6b, #fa5252); border-radius: 2px;' })
			])
		]);
	});
}

function renderTopClients(clients) {
	if (!clients || clients.length === 0) {
		return [ E('div', { 'style': 'color: #888; text-align: center; padding: 14px; font-size: 12px;' }, _('暂无受限局域网设备记录')) ];
	}
	return clients.map(function(item, idx) {
		let rankColor = idx === 0 ? '#1c7ed6' : (idx === 1 ? '#228be6' : (idx === 2 ? '#339af0' : '#4dabf7'));
		let rankBg = 'rgba(28, 126, 214, 0.12)';
		let pct = Math.max(5, Math.min(100, item.percent || 10));
		let title = (item.hostname && item.hostname !== '局域网设备') ? (item.hostname + ' (' + item.ip + ')') : item.ip;

		return E('div', {
			'style': 'padding: 6px 0; border-bottom: 1px dashed rgba(128, 128, 128, 0.15); display: flex; flex-direction: column; gap: 4px;'
		}, [
			E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; gap: 8px;' }, [
				E('div', { 'style': 'display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1;' }, [
					E('span', {
						'style': 'display: inline-block; width: 22px; height: 18px; line-height: 18px; text-align: center; font-size: 11px; font-weight: bold; border-radius: 3px; background: ' + rankBg + '; color: ' + rankColor + '; flex-shrink: 0;'
					}, '#' + (idx + 1)),
					E('span', { 'style': 'font-size: 13px;' }, '💻'),
					E('span', {
						'style': 'font-size: 12px; font-weight: 600; color: #212529; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
						'title': title
					}, title)
				]),
				E('div', { 'style': 'display: flex; align-items: center; gap: 6px; flex-shrink: 0;' }, [
					E('span', { 'style': 'font-size: 11px; font-weight: bold; color: #1c7ed6; background: rgba(28, 126, 214, 0.1); padding: 1px 6px; border-radius: 3px;' }, item.count + ' 次'),
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'style': 'padding: 1px 6px; font-size: 11px; line-height: 1.4;',
						'click': function(ev) {
							ev.preventDefault();
							let host = item.hostname || '局域网设备';
							return fs.exec('/usr/bin/opengfw-bypass-helper', ['add', item.ip, host]).then(function() {
								if (window._opengfw_reload_bypass) window._opengfw_reload_bypass();
								ui.showModal(_('设备直通豁免成功'), [
									E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('✅ 设备 [' + host + ' (' + item.ip + ')] 已加入硬件级直通免过滤名单！')),
									E('p', { 'style': 'color: #666; font-size: 12px;' }, _('该设备在 nftables 内核层通过 O(1) 哈希表直接放行，彻底跳过 OpenGFW 审查队列，保证 0 延迟、0 丢包和满速传输。')),
									E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
										E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('完成'))
									])
								]);
							});
						}
					}, _('🚀 设为直通'))
				])
			]),
			E('div', { 'style': 'width: 100%; height: 4px; background: rgba(128, 128, 128, 0.1); border-radius: 2px; overflow: hidden;' }, [
				E('div', { 'style': 'width: ' + pct + '%; height: 100%; background: linear-gradient(90deg, #339af0, #1c7ed6); border-radius: 2px;' })
			])
		]);
	});
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
		return Promise.all([
			uci.load('opengfw'),
			fs.exec('/usr/bin/opengfw-status').then(function(res) {
				return (res && res.code === 0 && res.stdout) ? res.stdout.trim() : (typeof res === 'string' ? res.trim() : '{}');
			}).catch(function() { return '{}'; })
		]);
	},

	render: function(data) {
		let m, s, o;

		let initialStatus = {};
		if (data && data[1]) {
			let raw = typeof data[1] === 'string' ? data[1] : (data[1].stdout || '{}');
			initialStatus = safeJsonParse(raw);
		}

		m = new form.Map('opengfw', _('OpenGFW 深度流控与流量防火墙'),
			_('OpenGFW 是基于 Linux 原生网络队列的高性能第 7 层应用识别与过滤引擎。同等支持 IPv4 与 IPv6，提供局域网全设备广告拦截、加密代理协议识别与家长控制。'));

		// 运行状态与统计大盘
		s = m.section(form.NamedSection, 'global', 'opengfw');
		s.anonymous = true;

		s.render = function() {
			let isRunning = !!initialStatus.running;
			let statusCard = E('div', { 'class': 'cbi-section', 'style': 'margin-bottom: 20px; width: 100%; box-sizing: border-box;' }, [
				E('div', { 'style': 'display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; border-bottom: 1px solid #e5e5e5; padding-bottom: 10px; margin-bottom: 15px;' }, [
					E('h3', { 'style': 'margin: 0;' }, _('服务运行状态与流量统计')),
					E('div', { 'id': 'opengfw_action_btns', 'style': 'display: flex; flex-wrap: wrap; gap: 8px;' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-action',
							'click': ui.createHandlerFn(this, function() {
								return fs.exec('/etc/init.d/opengfw', ['reload']).then(function() {
									ui.showModal(_('热重载成功'), [ E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('已发送重载信号，规则秒级生效，网络未中断！')), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('关闭')) ]) ]);
								});
							})
						}, _('⚡ 热重载规则')),
						E('button', {
							'class': 'btn cbi-button cbi-button-save',
							'click': ui.createHandlerFn(this, function() {
								return fs.exec('/etc/init.d/opengfw', ['restart']).then(function() {
									ui.showModal(_('服务已重启'), [ E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('OpenGFW 防火墙服务已重启！')), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('关闭')) ]) ]);
								});
							})
						}, _('🔄 重启服务')),
						E('button', {
							'class': 'btn cbi-button cbi-button-neutral',
							'click': ui.createHandlerFn(this, function() {
								ui.showModal(_('正在更新规则库'), [
									E('p', { 'class': 'spinning' }, _('正在从 CDN 下载最新的 GeoIP 归属地与 GeoSite 分类数据库，请稍候...'))
								]);
								return fs.exec('/usr/bin/opengfw-update-dat').then(function(res) {
									let out = (res && res.code === 0 && res.stdout) ? res.stdout : (typeof res === 'string' ? res : '');
									ui.showModal(_('基础规则库更新结果'), [
										E('div', { 'class': 'cbi-section' }, [
											E('p', { 'style': 'font-weight: bold; color: #28a745; margin-bottom: 8px;' }, _('✅ 规则数据库更新完成，已自动热重载生效！')),
											E('pre', {
												'style': 'max-height: 280px; overflow-y: auto; background: #1e1e1e; color: #00ff66; padding: 12px; border-radius: 4px; font-family: monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all;'
											}, out || _('更新完成！'))
										]),
										E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
											E('button', {
												'class': 'btn cbi-button cbi-button-primary',
												'click': ui.hideModal
											}, _('关闭'))
										])
									]);
								}).catch(function(err) {
									ui.showModal(_('更新失败'), [
										E('p', { 'style': 'color: #dc3545;' }, _('更新失败: ') + err),
										E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
											E('button', {
												'class': 'btn cbi-button cbi-button-neutral',
												'click': ui.hideModal
											}, _('关闭'))
										])
									]);
								});
							})
						}, _('🌐 更新基础规则库'))
					])
				]),
				E('div', {
					'id': 'opengfw_status_content',
					'style': 'display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; width: 100%; box-sizing: border-box;'
				}, [
					createStatCard(_('运行状态'), 'st_running', isRunning ? '● 正在运行' : '● 已停止运行', isRunning ? '#28a745' : '#dc3545'),
					createStatCard(_('进程号 (PID)'), 'st_pid', (initialStatus.pid && initialStatus.pid !== 'null') ? '' + initialStatus.pid : '-', null),
					createStatCard(_('内存占用'), 'st_mem', initialStatus.memory || '-', null),
					createStatCard(_('持续运行时间'), 'st_uptime', initialStatus.uptime || '-', null),
					createStatCard(_('已生效规则数'), 'st_rules', (initialStatus.rules_count ? initialStatus.rules_count + ' 条' : '-'), null),
					createStatCard(_('待检测数据包'), 'st_pkts_queued', '' + (initialStatus.pkts_queued || 0), '#0070f3'),
					createStatCard(_('直通放行数据包'), 'st_pkts_accepted', '' + (initialStatus.pkts_accepted || 0), '#28a745'),
					createStatCard(_('🛡️ 广告拦截次数'), 'st_ads_blocked', (initialStatus.ads_blocked || 0) + ' 次', '#e03131'),
					createStatCard(_('🌐 地区/IP阻断'), 'st_ips_blocked', (initialStatus.ips_blocked || 0) + ' 次', '#f76707'),
					createStatCard(_('🚀 直通豁免设备'), 'st_bypass_count', (initialStatus.bypass_count || 0) + ' 台', '#1098ad'),
					createStatCard(_('⛔ 命中阻断数据包'), 'st_pkts_dropped', '' + (initialStatus.pkts_dropped || 0), '#c92a2a')
				]),

				// 📊 拦截统计 Top 看板
				E('div', { 'id': 'opengfw_top_analytics_container', 'style': 'margin-top: 15px; border-top: 1px solid #e5e5e5; padding-top: 12px;' }, [
					E('div', { 'style': 'display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px;' }, [
						E('h4', { 'style': 'margin: 0; font-size: 14px; font-weight: bold;' }, _('📊 实时拦截 Top 统计看板 (近2000次阻断深度聚合)')),
						E('span', { 'style': 'font-size: 12px; color: #888;' }, _('点击【⚡ 加白】放行误杀域名，点击【🚀 设为直通】免除该设备一切审查'))
					]),
					E('div', { 'style': 'display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 15px;' }, [
						// Top 10 Domains
						E('div', { 'style': 'background: rgba(128, 128, 128, 0.05); border: 1px solid rgba(128, 128, 128, 0.15); border-radius: 6px; padding: 12px;' }, [
							E('div', { 'style': 'font-weight: bold; margin-bottom: 8px; font-size: 13px; color: #d6336c; display: flex; align-items: center; justify-content: space-between;' }, [
								E('span', {}, '🌐 拦截最多域名 Top 10'),
								E('span', { 'style': 'font-size: 11px; color: #888;' }, '高频阻断目标')
							]),
							E('div', { 'id': 'st_top_domains_list' }, renderTopDomains(initialStatus.top_domains))
						]),
						// Top 5 Clients
						E('div', { 'style': 'background: rgba(128, 128, 128, 0.05); border: 1px solid rgba(128, 128, 128, 0.15); border-radius: 6px; padding: 12px;' }, [
							E('div', { 'style': 'font-weight: bold; margin-bottom: 8px; font-size: 13px; color: #1c7ed6; display: flex; align-items: center; justify-content: space-between;' }, [
								E('span', {}, '📱 触发拦截最多设备 Top 5'),
								E('span', { 'style': 'font-size: 11px; color: #888;' }, '高频受限来源')
							]),
							E('div', { 'id': 'st_top_clients_list' }, renderTopClients(initialStatus.top_clients))
						])
					])
				]),

				// 实时拦截事件明细展示区
				E('div', { 'id': 'opengfw_recent_events_container', 'style': 'margin-top: 15px; border-top: 1px solid #e5e5e5; padding-top: 12px;' }, [
					E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;' }, [
						E('h4', { 'style': 'margin: 0; font-size: 14px; font-weight: bold;' }, _('⚡ 实时拦截事件动态 (验证是否已生效)')),
						E('a', { 'href': L.url('admin', 'services', 'opengfw', 'log'), 'class': 'btn cbi-button cbi-button-action', 'style': 'font-size: 12px; padding: 2px 10px;' }, _('查看全部实时日志 →'))
					]),
					E('div', { 'id': 'st_recent_events_list', 'style': 'background: rgba(128, 128, 128, 0.05); border: 1px solid rgba(128, 128, 128, 0.15); border-radius: 6px; padding: 10px; font-family: monospace; font-size: 12px; max-height: 220px; overflow-y: auto;' }, renderRecentEvents(initialStatus.recent_events))
				])
			]);

			function updateStatusUI(st) {
				if (!st) return;
				let elRunning = document.getElementById('st_running');
				let elPid = document.getElementById('st_pid');
				let elMem = document.getElementById('st_mem');
				let elUptime = document.getElementById('st_uptime');
				let elRules = document.getElementById('st_rules');
				let elQ = document.getElementById('st_pkts_queued');
				let elA = document.getElementById('st_pkts_accepted');
				let elD = document.getElementById('st_pkts_dropped');
				let elAds = document.getElementById('st_ads_blocked');
				let elIps = document.getElementById('st_ips_blocked');
				let elBypass = document.getElementById('st_bypass_count');
				let elRecent = document.getElementById('st_recent_events_list');
				let elTopD = document.getElementById('st_top_domains_list');
				let elTopC = document.getElementById('st_top_clients_list');

				if (elRunning) {
					if (st.running) {
						elRunning.innerHTML = '<span style="color: #28a745; font-weight: bold;">● 正在运行</span>';
					} else {
						elRunning.innerHTML = '<span style="color: #dc3545; font-weight: bold;">● 已停止运行</span>';
					}
				}
				if (elPid) elPid.textContent = (st.pid && st.pid !== 'null') ? '' + st.pid : '-';
				if (elMem) elMem.textContent = st.memory || '-';
				if (elUptime) elUptime.textContent = st.uptime || '-';
				if (elRules) elRules.textContent = (st.rules_count || 0) + ' 条';
				if (elQ) elQ.textContent = st.pkts_queued != null ? '' + st.pkts_queued : '0';
				if (elA) elA.textContent = st.pkts_accepted != null ? '' + st.pkts_accepted : '0';
				if (elD) elD.textContent = st.pkts_dropped != null ? '' + st.pkts_dropped : '0';
				if (elAds) elAds.textContent = (st.ads_blocked || 0) + ' 次';
				if (elIps) elIps.textContent = (st.ips_blocked || 0) + ' 次';
				if (elBypass) elBypass.textContent = (st.bypass_count != null ? st.bypass_count : 0) + ' 台';

				if (elTopD && st.top_domains) {
					dom.content(elTopD, renderTopDomains(st.top_domains));
				}
				if (elTopC && st.top_clients) {
					dom.content(elTopC, renderTopClients(st.top_clients));
				}
				if (elRecent) {
					dom.content(elRecent, renderRecentEvents(st.recent_events));
				}
			}

			poll.add(function() {
				return fs.exec('/usr/bin/opengfw-status').then(function(res) {
					try {
						let out = (res && res.code === 0 && res.stdout) ? res.stdout.trim() : (typeof res === 'string' ? res.trim() : '');
						let st = safeJsonParse(out);
						updateStatusUI(st);
					} catch(e) {}
				}).catch(function() {});
			}, 3);

			return statusCard;
		};

		// 核心配置区域
		s = m.section(form.NamedSection, 'global', 'opengfw', _('基本参数设置'));

		o = s.option(form.Flag, 'enabled', _('启用 OpenGFW 防火墙'));
		o.default = o.disabled;
		o.rmempty = false;

		o = s.option(form.ListValue, 'mode', _('工作模式'));
		o.value('forward', _('网关转发模式 (推荐软路由：全透明拦截局域网内所有手机/电脑流量)'));
		o.value('local', _('单机自测模式 (仅拦截软路由本机流量)'));
		o.default = 'forward';
		o.rmempty = false;

		o = s.option(form.ListValue, 'workers', _('核心工作线程数'));
		o.value('1', _('1 线程'));
		o.value('2', _('2 线程 (推荐均衡配置)'));
		o.value('4', _('4 线程 (全核高性能)'));
		o.value('8', _('8 线程'));
		o.default = '2';
		o.description = _('多核流级负载均衡处理线程数，当前软路由为 4 核心，推荐设置为 2 至 4。');

		o = s.option(form.Flag, 'rst', _('拦截时主动发送 TCP 复位包 (RST)'));
		o.default = o.enabled;
		o.description = _('启用后，被拦截的网页连接会立即收到复位切断信号，手机和电脑端无需等待连接超时。');

		o = s.option(form.ListValue, 'log_level', _('日志记录详细等级'));
		o.value('debug', _('调试 (最详细)'));
		o.value('info', _('普通信息 (推荐)'));
		o.value('warn', _('警告'));
		o.value('error', _('仅错误'));
		o.default = 'info';

		o = s.option(form.Value, 'queue_size', _('数据包队列深度'));
		o.datatype = 'uinteger';
		o.default = '2048';
		o.description = _('内核与用户空间通信的数据包缓冲队列长度，推荐 2048。内核缓冲区已自动扩容至 8MB。');

		o = s.option(form.Flag, 'autoupdate', _('规则库每周自动定时更新'));
		o.default = o.enabled;
		o.description = _('开启后，软路由每周一凌晨 04:00 自动拉取更新最新的 GeoIP、GeoSite 与广告规则库并热重载。');

		// 快速白名单卡片
		s = m.section(form.NamedSection, 'global', 'opengfw', _('快速域名白名单管理 (杜绝误杀)'));
		s.anonymous = true;
		s.render = function() {
			let inputEl = E('input', {
				'type': 'text',
				'placeholder': '例如: jd.com 或 api.example.com',
				'class': 'cbi-input-text',
				'style': 'max-width: 320px; margin-right: 10px; display: inline-block;'
			});
			let addBtn = E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': function(ev) {
					ev.preventDefault();
					let val = (inputEl.value || '').trim();
					if (!val) {
						ui.addNotification(null, E('p', {}, '请输入有效的域名'), 'warning');
						return;
					}
					fs.exec('/usr/bin/opengfw-whitelist-helper', ['add', val]).then(function() {
						inputEl.value = '';
						loadWhitelist();
						ui.showModal(_('添加成功'), [
							E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('✅ 域名 [' + val + '] 已加入白名单并秒级生效！')),
							E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
								E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('完成'))
							])
						]);
					});
				}
			}, _('⚡ 添加并秒级生效'));

			let listContainer = E('div', { 'style': 'margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px;' });

			function loadWhitelist() {
				fs.exec('/usr/bin/opengfw-whitelist-helper', ['list']).then(function(res) {
					let data = safeJsonParse((res && res.stdout) || '{}');
					let list = data.whitelist || [];
					dom.content(listContainer, list.length > 0 ? list.map(function(d) {
						return E('span', {
							'style': 'background: rgba(128, 128, 128, 0.1); border: 1px solid rgba(128, 128, 128, 0.2); padding: 4px 10px; border-radius: 4px; font-size: 12px; display: inline-flex; align-items: center; gap: 8px;'
						}, [
							d,
							E('a', {
								'href': '#',
								'style': 'color: #dc3545; font-weight: bold; text-decoration: none; cursor: pointer;',
								'title': '移除',
								'click': function(e) {
									e.preventDefault();
									fs.exec('/usr/bin/opengfw-whitelist-helper', ['remove', d]).then(function() {
										loadWhitelist();
									});
								}
							}, '×')
						]);
					}) : [ E('span', { 'style': 'color: #999; font-size: 12px;' }, _('暂无自定义白名单域名')) ]);
				});
			}

			window._opengfw_reload_whitelist = loadWhitelist;
			loadWhitelist();

			return E('div', { 'class': 'cbi-section', 'style': 'margin-top: 20px;' }, [
				E('div', { 'style': 'display: flex; align-items: center; margin-bottom: 8px;' }, [ inputEl, addBtn ]),
				E('div', { 'style': 'color: #888; font-size: 12px; margin-bottom: 8px;' }, _('白名单内的域名将直接在防火墙首层内核直通放行，优先级高于任何广告与地区阻断规则。')),
				listContainer
			]);
		};

		// 🚀 局域网设备直通免过滤管理卡片 (设备级白名单 / MAC/IP 豁免)
		s = m.section(form.NamedSection, 'global', 'opengfw', _('🚀 局域网设备直通免过滤管理 (设备级白名单 / MAC/IP 豁免)'));
		s.anonymous = true;
		s.render = function() {
			let leaseSelect = E('select', {
				'class': 'cbi-input-select',
				'style': 'max-width: 280px; margin-right: 8px;'
			}, [
				E('option', { 'value': '' }, _('⚡ 从当前在线局域网设备选择 (DHCP)...'))
			]);

			let inputIp = E('input', {
				'type': 'text',
				'placeholder': '例如: 10.10.10.117',
				'class': 'cbi-input-text',
				'style': 'max-width: 150px; margin-right: 8px;'
			});

			let inputComment = E('input', {
				'type': 'text',
				'placeholder': '设备名称/备注 (如: 客厅PS5)',
				'class': 'cbi-input-text',
				'style': 'max-width: 180px; margin-right: 8px;'
			});

			let addBtn = E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': function(ev) {
					ev.preventDefault();
					let ip = (inputIp.value || '').trim();
					let comment = (inputComment.value || '').trim();
					if (!ip) {
						ui.addNotification(null, E('p', {}, '请输入设备局域网 IP 地址'), 'warning');
						return;
					}
					fs.exec('/usr/bin/opengfw-bypass-helper', ['add', ip, comment, '', comment]).then(function() {
						inputIp.value = '';
						inputComment.value = '';
						leaseSelect.value = '';
						loadBypassDevices();
						ui.showModal(_('添加成功'), [
							E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('✅ 设备 [' + ip + (comment ? ' - ' + comment : '') + '] 已加入直通豁免名单！')),
							E('p', { 'style': 'color: #666; font-size: 12px;' }, _('该设备流量将在底层 Linux 内核通过 nftables 硬件集合瞬间放行，彻底跳过审查。')),
							E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
								E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('完成'))
							])
						]);
					});
				}
			}, _('➕ 添加直通设备'));

			let leasesMap = {};
			fs.exec('/usr/bin/opengfw-bypass-helper', ['leases']).then(function(res) {
				let leases = safeJsonParse((res && res.stdout) || '[]');
				if (Array.isArray(leases)) {
					leases.forEach(function(l) {
						leasesMap[l.ip] = l;
						let opt = E('option', { 'value': l.ip }, '📱 ' + l.hostname + ' (' + l.ip + ')');
						leaseSelect.appendChild(opt);
					});
				}
			});

			leaseSelect.addEventListener('change', function() {
				let ip = leaseSelect.value;
				if (ip && leasesMap[ip]) {
					inputIp.value = ip;
					if (!inputComment.value) inputComment.value = leasesMap[ip].hostname || '';
				}
			});

			let tableContainer = E('div', { 'style': 'margin-top: 15px; overflow-x: auto;' });

			function loadBypassDevices() {
				fs.exec('/usr/bin/opengfw-bypass-helper', ['get']).then(function(res) {
					let devices = safeJsonParse((res && res.stdout) || '[]');
					if (!Array.isArray(devices) || devices.length === 0) {
						dom.content(tableContainer, E('div', {
							'style': 'color: #888; padding: 15px; text-align: center; border: 1px dashed rgba(128,128,128,0.2); border-radius: 6px;'
						}, _('暂无直通豁免设备。所有局域网设备默认均接受 OpenGFW 审查与广告拦截。')));
						return;
					}

					let rows = devices.map(function(d) {
						let isEnabled = d.enabled !== false;
						let statusBadge = isEnabled ?
							E('span', { 'style': 'background: #2b8a3e; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 11px;' }, '● 硬件直通中 (O(1))') :
							E('span', { 'style': 'background: #868e96; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 11px;' }, '● 已暂停直通');

						let toggleBtn = E('button', {
							'class': 'btn cbi-button ' + (isEnabled ? 'cbi-button-neutral' : 'cbi-button-save'),
							'style': 'padding: 2px 8px; font-size: 11px; margin-right: 6px;',
							'click': function(e) {
								e.preventDefault();
								fs.exec('/usr/bin/opengfw-bypass-helper', ['toggle', d.ip]).then(function() {
									loadBypassDevices();
								});
							}
						}, isEnabled ? _('⏸️ 暂停') : _('▶️ 恢复'));

						let delBtn = E('button', {
							'class': 'btn cbi-button cbi-button-remove',
							'style': 'padding: 2px 8px; font-size: 11px;',
							'click': function(e) {
								e.preventDefault();
								fs.exec('/usr/bin/opengfw-bypass-helper', ['del', d.ip]).then(function() {
									loadBypassDevices();
								});
							}
						}, _('🗑️ 移除'));

						let devName = d.comment || d.hostname || '局域网设备';
						let icon = (devName.indexOf('PC') !== -1 || devName.indexOf('电脑') !== -1 || devName.indexOf('主机') !== -1 || devName.indexOf('B50') !== -1) ? '💻' : '📱';

						return E('tr', { 'class': 'cbi-section-table-row' }, [
							E('td', { 'class': 'cbi-value-field', 'style': 'font-weight: bold;' }, [
								E('span', { 'style': 'margin-right: 6px;' }, icon),
								devName
							]),
							E('td', { 'class': 'cbi-value-field', 'style': 'font-family: monospace;' }, d.ip),
							E('td', { 'class': 'cbi-value-field', 'style': 'font-family: monospace; color: #666;' }, d.mac || '-'),
							E('td', { 'class': 'cbi-value-field' }, [ statusBadge ]),
							E('td', { 'class': 'cbi-value-field' }, [ toggleBtn, delBtn ])
						]);
					});

					let table = E('table', { 'class': 'table cbi-section-table', 'style': 'width: 100%; border-collapse: collapse;' }, [
						E('tr', { 'class': 'cbi-section-table-titles' }, [
							E('th', { 'class': 'th' }, _('设备名称 / 备注')),
							E('th', { 'class': 'th' }, _('局域网 IP')),
							E('th', { 'class': 'th' }, _('MAC 地址')),
							E('th', { 'class': 'th' }, _('直通状态')),
							E('th', { 'class': 'th' }, _('操作'))
						]),
						E('tbody', {}, rows)
					]);

					dom.content(tableContainer, table);
				});
			}

			window._opengfw_reload_bypass = loadBypassDevices;
			loadBypassDevices();

			return E('div', { 'class': 'cbi-section', 'style': 'margin-top: 20px;' }, [
				E('div', { 'style': 'display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px;' }, [
					leaseSelect, inputIp, inputComment, addBtn
				]),
				E('div', { 'style': 'color: #888; font-size: 12px; margin-bottom: 8px; line-height: 1.5;' },
					_('💡 原理说明：直通设备的所有网络数据包在进入 Linux 内核的第一时间（nftables prerouting/forward 阶段）即通过硬件哈希集（O(1) 复杂度）直接 accept 放行，彻底跳过审查队列，实现 0 内存拷贝、0 延迟与满速传输。')),
				tableContainer
			]);
		};

		return m.render();
	}
});
