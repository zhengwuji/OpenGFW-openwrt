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
					createStatCard(_('⛔ 命中阻断数据包'), 'st_pkts_dropped', '' + (initialStatus.pkts_dropped || 0), '#c92a2a')
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
				let elRecent = document.getElementById('st_recent_events_list');

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
			loadWhitelist();

			return E('div', { 'class': 'cbi-section', 'style': 'margin-top: 20px;' }, [
				E('div', { 'style': 'display: flex; align-items: center; margin-bottom: 8px;' }, [ inputEl, addBtn ]),
				E('div', { 'style': 'color: #888; font-size: 12px; margin-bottom: 8px;' }, _('白名单内的域名将直接在防火墙首层内核直通放行，优先级高于任何广告与地区阻断规则。')),
				listContainer
			]);
		};

		return m.render();
	}
});
