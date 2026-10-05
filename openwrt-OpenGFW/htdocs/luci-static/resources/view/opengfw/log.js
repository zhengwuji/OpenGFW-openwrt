'use strict';
'require dom';
'require fs';
'require poll';
'require ui';
'require view';

const LOG_FILE = '/var/log/opengfw.log';
const HELPER = '/usr/bin/opengfw-custom-helper';
const CUSTOM_JSON_PATH = '/etc/opengfw/custom_rules.json';

// 彻底解决主题下 alert-message 通知框无法点击关闭的 Bug
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
	render: function() {
		let currentFilterMode = 'all';
		let viewMode = 'excel'; // 'excel' (表格视图) 或 'raw' (原始终端视图)
		let rawLogs = '';

		// 结构化日志解析器
		function parseLogLine(line) {
			if (!line || !line.trim()) return null;
			line = line.trim();

			// 提取时间戳
			let timeMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\+\d{2}:\d{2})?)/);
			let timeFull = timeMatch ? timeMatch[1].replace('T', ' ').split('+')[0] : '';
			let timeShort = timeFull ? timeFull.split(' ')[1] : '';

			// 提取 JSON
			let jsonStart = line.indexOf('{');
			let payload = null;
			if (jsonStart !== -1) {
				try {
					payload = JSON.parse(line.substring(jsonStart));
				} catch(e) {}
			}

			let item = {
				id: (payload && payload.id) ? String(payload.id) : null,
				raw: line,
				timeFull: timeFull || '-',
				timeShort: timeShort || '-',
				action: 'info',
				actionDesc: '系统信息',
				rule: '-',
				ruleDesc: '-',
				domain: '-',
				src: '-',
				dst: '-',
				proto: 'TCP',
				isAd: false,
				isGeo: false,
				isBlock: false
			};

			if (line.indexOf('UDP stream') !== -1) item.proto = 'UDP';
			else if (line.indexOf('TCP stream') !== -1) item.proto = 'TCP';

			if (payload) {
				item.src = payload.src || '-';
				item.dst = payload.dst || '-';

				// 1. 规则命中日志 (ruleset log)
				if (payload.name) {
					item.rule = payload.name;
					item.ruleDesc = payload.name;

					// 提取域名 (SNI / Host / DNS / QUIC)
					if (payload.props) {
						let p = payload.props;
						if (p.tls && p.tls.sni) {
							item.domain = p.tls.sni;
							item.proto = 'TLS';
						} else if (p.http && p.http.host) {
							item.domain = p.http.host;
							item.proto = 'HTTP';
						} else if (p.dns && p.dns.name) {
							item.domain = p.dns.name;
							item.proto = 'DNS';
						} else if (p.quic && p.quic.sni) {
							item.domain = p.quic.sni;
							item.proto = 'QUIC';
						}
					}

					// 规则类型判定
					let rLower = payload.name.toLowerCase();
					if (rLower.indexOf('block ads') !== -1 || rLower.indexOf('adblock') !== -1 || rLower.indexOf('广告') !== -1 || rLower.indexOf('sinkhole') !== -1) {
						item.isAd = true;
						item.action = 'block';
						item.actionDesc = '🛡️ 广告拦截';
						item.isBlock = true;
					} else if (rLower.indexOf('地区') !== -1 || rLower.indexOf('geoip') !== -1 || rLower.indexOf('custom_ip') !== -1 || rLower.indexOf('自定义ip') !== -1) {
						item.isGeo = true;
						item.action = 'block';
						item.actionDesc = '🌐 地区/IP阻断';
						item.isBlock = true;
					} else if (rLower.indexOf('observe') !== -1 || rLower.indexOf('sni') !== -1) {
						item.action = 'observe';
						item.actionDesc = '👁️ 域名审计';
					} else if (rLower.indexOf('allow') !== -1 || rLower.indexOf('放行') !== -1 || rLower.indexOf('whitelist') !== -1) {
						item.action = 'allow';
						item.actionDesc = '⚡ 白名单放行';
					} else if (rLower.indexOf('block') !== -1 || rLower.indexOf('drop') !== -1 || rLower.indexOf('reject') !== -1 || rLower.indexOf('阻断') !== -1) {
						item.action = 'block';
						item.actionDesc = '🛑 规则阻断';
						item.isBlock = true;
					}
				}

				// 2. 流动作日志 (stream action)
				if (payload.action) {
					if (payload.action === 'block' || payload.action === 'drop') {
						item.action = 'block';
						item.actionDesc = '🛑 流级阻断';
						item.isBlock = true;
						if (item.rule === '-') item.ruleDesc = '连接握手阻断';
					} else if (payload.action === 'allow') {
						item.action = 'allow';
						item.actionDesc = '⚡ 内核放行';
						if (item.rule === '-') item.ruleDesc = '正常流量直通';
					}
				}
			} else {
				item.ruleDesc = line.replace(/^[0-9T:+-]+\s+[A-Z]+\s+/, '');
			}

			return item;
		}

		// 表格 DOM 容器
		let tableBody = E('tbody');
		let logRawPre = E('pre', {
			'id': 'opengfw_log_content',
			'style': 'display: none; width: 100%; min-height: 520px; max-height: 680px; overflow-y: auto; font-family: monospace, Consolas, "Courier New"; font-size: 12px; line-height: 1.4; padding: 12px; background: #181818; color: #00ff66; border-radius: 6px; border: 1px solid #333; white-space: pre-wrap; word-break: break-all;'
		}, [ _('正在获取实时日志...') ]);

		let excelContainer = E('div', {
			'style': 'overflow-x: auto; max-height: 680px; border: 1px solid #e5e7eb; border-radius: 6px; background: #fff;'
		}, [
			E('table', { 'class': 'table cbi-section-table', 'style': 'width: 100%; margin: 0; border-collapse: collapse; font-size: 12px;' }, [
				E('thead', { 'style': 'position: sticky; top: 0; background: #f8fafc; z-index: 2; border-bottom: 2px solid #cbd5e1;' }, [
					E('tr', {}, [
						E('th', { 'style': 'padding: 8px 10px; width: 135px;' }, _('时间 (Date & Time)')),
						E('th', { 'style': 'padding: 8px 10px; width: 110px;' }, _('处置动作')),
						E('th', { 'style': 'padding: 8px 10px; width: 80px;' }, _('协议')),
						E('th', { 'style': 'padding: 8px 10px;' }, _('目标域名 / 访问对象 (Domain / Host)')),
						E('th', { 'style': 'padding: 8px 10px; width: 170px;' }, _('内网源设备 (Source)')),
						E('th', { 'style': 'padding: 8px 10px; width: 170px;' }, _('目的地址 (Destination)')),
						E('th', { 'style': 'padding: 8px 10px; width: 180px;' }, _('命中规则 (Matched Rule)')),
						E('th', { 'style': 'padding: 8px 10px; width: 90px; text-align: right;' }, _('快捷操作'))
					])
				]),
				tableBody
			])
		]);

		let filterInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'placeholder': _('🔍 实时搜索域名、IP、规则、动作、时间...'),
			'style': 'width: 280px;'
		});

		let statsBadge = E('span', {
			'style': 'font-size: 12px; color: #475569; background: #f1f5f9; padding: 4px 10px; border-radius: 12px; border: 1px solid #cbd5e1;'
		}, _('统计中...'));

		// 快速加入自定义拦截功能
		function quickBlockTarget(type, value) {
			if (!confirm(_('确定将此目标加入【自定义拦截】吗？\n') + (type === 'domain' ? _('域名: ') : _('IP地址: ')) + value)) return;
			ui.showModal(_('正在处理'), [ E('p', { 'class': 'spinning' }, _('正在添加规则并热重载...')) ]);

			fs.read_direct(CUSTOM_JSON_PATH).then(function(res) {
				let list = [];
				try { list = JSON.parse(res); } catch(e) {}
				if (!Array.isArray(list)) list = [];

				let exists = list.some(function(item) { return item.value.toLowerCase() === value.toLowerCase(); });
				if (exists) {
					ui.hideModal();
					ui.addNotification(null, E('p', {}, _('该目标已存在于自定义清单中！')), 'warning');
					return;
				}

				let d = new Date();
				let pad = function(n) { return (n < 10 ? '0' : '') + n; };
				let nowStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());

				list.unshift({
					id: 'c_' + Date.now(),
					type: type,
					value: value,
					action: 'block',
					direction: 'both',
					comment: _('日志一键快捷添加'),
					enabled: true,
					time: nowStr
				});

				return fs.write(CUSTOM_JSON_PATH, JSON.stringify(list, null, 2)).then(function() {
					return fs.exec_direct(HELPER, ['apply']);
				}).then(function() {
					ui.hideModal();
					ui.addNotification(null, E('p', {}, _('已成功将目标加入自定义拦截并热生效: ') + value), 'info');
				});
			}).catch(function(err) {
				ui.hideModal();
				ui.showModal(_('操作失败'), [ E('p', { 'style': 'color: #dc3545;' }, _('错误: ') + err) ]);
			});
		}

		// 导出为 CSV / Excel 文件
		function exportToCsv(parsedItems) {
			if (!parsedItems || parsedItems.length === 0) {
				ui.addNotification(null, E('p', {}, _('暂无日志可供导出！')), 'warning');
				return;
			}
			let csvRows = [
				['时间', '处置动作', '协议', '目标域名/Host', '内网源设备', '目的地址', '命中规则'].join(',')
			];
			parsedItems.forEach(function(item) {
				let row = [
					'"' + (item.timeFull || '').replace(/"/g, '""') + '"',
					'"' + (item.actionDesc || '').replace(/"/g, '""') + '"',
					'"' + (item.proto || '').replace(/"/g, '""') + '"',
					'"' + (item.domain !== '-' ? item.domain : '').replace(/"/g, '""') + '"',
					'"' + (item.src !== '-' ? item.src : '').replace(/"/g, '""') + '"',
					'"' + (item.dst !== '-' ? item.dst : '').replace(/"/g, '""') + '"',
					'"' + (item.ruleDesc || '').replace(/"/g, '""') + '"'
				];
				csvRows.push(row.join(','));
			});
			let csvContent = '\uFEFF' + csvRows.join('\r\n'); // BOM for Excel Chinese support
			let blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
			let link = document.createElement('a');
			link.href = URL.createObjectURL(blob);
			link.setAttribute('download', 'opengfw_logs_' + Date.now() + '.csv');
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
		}

		let lastParsedItems = [];

		let updateDisplay = function() {
			let filter = filterInput.value.trim().toLowerCase();
			if (!rawLogs) {
				tableBody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: #888; padding: 30px;">暂无日志数据。</td></tr>';
				logRawPre.textContent = _('暂无日志数据。');
				statsBadge.textContent = _('无数据');
				return;
			}

			let lines = rawLogs.trim().split('\n');

			// 解析全部行为对象并按 stream ID 智能关联（消除同一次请求重复断续打印的问题）
			let streamMap = {};
			let items = [];
			for (let i = 0; i < lines.length; i++) {
				let parsed = parseLogLine(lines[i]);
				if (!parsed) continue;

				if (parsed.id) {
					let sid = parsed.id;
					if (streamMap[sid]) {
						let exist = streamMap[sid];
						// 补充域名与应用层协议
						if (exist.domain === '-' && parsed.domain !== '-') {
							exist.domain = parsed.domain;
							exist.proto = parsed.proto;
						}
						// 补充命中规则与分类
						if ((exist.rule === '-' || !exist.rule) && parsed.rule !== '-') {
							exist.rule = parsed.rule;
							exist.ruleDesc = parsed.ruleDesc;
							exist.isAd = exist.isAd || parsed.isAd;
							exist.isGeo = exist.isGeo || parsed.isGeo;
						}
						// 阻断动作覆盖（只要该连接触发了拦截，则标记为拦截）
						if (parsed.isBlock) {
							exist.isBlock = true;
							exist.action = 'block';
							if (parsed.actionDesc && parsed.actionDesc !== '🛑 流级阻断') {
								exist.actionDesc = parsed.actionDesc;
							}
						}
						exist.raw += '\n' + parsed.raw;
						continue;
					} else {
						streamMap[sid] = parsed;
					}
				}
				items.push(parsed);
			}

			// 分类快捷标签过滤
			if (currentFilterMode === 'ad') {
				items = items.filter(function(it) { return it.isAd || /(block ads|adblock|广告|ads|sinkhole)/i.test(it.raw); });
			} else if (currentFilterMode === 'geo') {
				items = items.filter(function(it) { return it.isGeo || /(地区|geoip|custom_ip|自定义|ip阻断|ip黑名单)/i.test(it.raw); });
			} else if (currentFilterMode === 'blocked') {
				items = items.filter(function(it) { return it.isBlock || /(action":\s*"block"|action":\s*"drop"|action":\s*"reject"|block|drop|reject|阻断|拦截)/i.test(it.raw); });
			} else if (currentFilterMode === 'sni') {
				items = items.filter(function(it) { return it.domain !== '-' || /(observe|sni|host|dns)/i.test(it.raw); });
			} else if (currentFilterMode === 'system') {
				items = items.filter(function(it) { return /(engine|worker|started|ruleset|loaded|init)/i.test(it.raw); });
			}

			// 搜索框过滤
			if (filter) {
				items = items.filter(function(it) {
					return (it.domain && it.domain.toLowerCase().indexOf(filter) !== -1) ||
					       (it.src && it.src.toLowerCase().indexOf(filter) !== -1) ||
					       (it.dst && it.dst.toLowerCase().indexOf(filter) !== -1) ||
					       (it.rule && it.rule.toLowerCase().indexOf(filter) !== -1) ||
					       (it.actionDesc && it.actionDesc.toLowerCase().indexOf(filter) !== -1) ||
					       (it.timeFull && it.timeFull.toLowerCase().indexOf(filter) !== -1);
				});
			}

			// 统计信息
			let totalAd = items.filter(function(it) { return it.isAd; }).length;
			let totalBlocked = items.filter(function(it) { return it.isBlock; }).length;
			let totalSni = items.filter(function(it) { return it.domain !== '-'; }).length;
			statsBadge.textContent = _('筛选结果: %d 条 | 阻断拦截: %d | 广告拦截: %d | 域名审计: %d').format(items.length, totalBlocked, totalAd, totalSni);

			// 取最新 300 条 (倒序，最新在最前)
			items = items.slice(-300).reverse();
			lastParsedItems = items;

			// 1. 渲染原始视图
			let rawFilteredLines = items.map(function(it) { return it.raw; });
			logRawPre.textContent = rawFilteredLines.join('\n') || _('未匹配到包含该过滤条件的日志。');

			// 2. 渲染 Excel 结构化表格
			tableBody.innerHTML = '';
			if (items.length === 0) {
				tableBody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: #888; padding: 30px;">' + (filter ? _('未匹配到包含该搜索条件的日志') : _('暂无相关日志')) + '</td></tr>';
				return;
			}

			items.forEach(function(it, idx) {
				let actionBadge;
				if (it.action === 'block') {
					actionBadge = E('span', { 'style': 'background: #fee2e2; color: #dc2626; border: 1px solid #fca5a5; font-weight: bold; padding: 2px 8px; border-radius: 4px; font-size: 11px; white-space: nowrap;' }, it.actionDesc || '🛑 阻断');
				} else if (it.action === 'allow') {
					actionBadge = E('span', { 'style': 'background: #dcfce7; color: #16a34a; border: 1px solid #86efac; font-weight: bold; padding: 2px 8px; border-radius: 4px; font-size: 11px; white-space: nowrap;' }, it.actionDesc || '⚡ 放行');
				} else if (it.action === 'observe') {
					actionBadge = E('span', { 'style': 'background: #e0f2fe; color: #0284c7; border: 1px solid #7dd3fc; font-weight: bold; padding: 2px 8px; border-radius: 4px; font-size: 11px; white-space: nowrap;' }, it.actionDesc || '👁️ 审计');
				} else {
					actionBadge = E('span', { 'style': 'background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; padding: 2px 8px; border-radius: 4px; font-size: 11px; white-space: nowrap;' }, it.actionDesc || 'ℹ️ 信息');
				}

				let protoBadge = E('span', { 'style': 'background: #f8fafc; color: #334155; border: 1px solid #cbd5e1; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 11px; font-weight: 600;' }, it.proto);

				let domainTd;
				if (it.domain !== '-') {
					domainTd = E('span', {
						'style': 'font-family: monospace; font-weight: 600; color: #0369a1; word-break: break-all;'
					}, it.domain);
				} else {
					domainTd = E('span', { 'style': 'color: #94a3b8;' }, '-');
				}

				// 操作按钮
				let opBtn = null;
				if (it.domain !== '-') {
					opBtn = E('button', {
						'class': 'btn cbi-button cbi-button-reset',
						'style': 'padding: 2px 8px; font-size: 11px; white-space: nowrap; font-weight: bold;',
						'title': _('将此域名一键加入自定义拦截黑名单'),
						'click': function() { quickBlockTarget('domain', it.domain); }
					}, _('➕ 拦截'));
				} else if (it.src !== '-' && it.src.indexOf('10.10.10.') === -1 && it.src.indexOf('192.168.') === -1 && it.src.indexOf('127.') === -1) {
					let cleanIP = it.src.split(':')[0];
					opBtn = E('button', {
						'class': 'btn cbi-button cbi-button-reset',
						'style': 'padding: 2px 8px; font-size: 11px; white-space: nowrap;',
						'title': _('将此外部 IP 加入自定义拦截'),
						'click': function() { quickBlockTarget('ip', cleanIP); }
					}, _('➕ 拦截IP'));
				} else {
					opBtn = E('span', { 'style': 'color: #cbd5e1;' }, '-');
				}

				let rowBg = (idx % 2 === 0) ? '#ffffff' : '#f8fafc';
				if (it.isBlock) rowBg = (idx % 2 === 0) ? '#fef2f2' : '#fee2e225';

				let tr = E('tr', {
					'style': 'background: ' + rowBg + '; border-bottom: 1px solid #e2e8f0; transition: background 0.15s ease;'
				}, [
					E('td', { 'style': 'padding: 7px 10px; font-family: monospace; color: #64748b; white-space: nowrap; border-right: 1px solid #f1f5f9;', 'title': it.timeFull }, it.timeFull),
					E('td', { 'style': 'padding: 7px 10px; border-right: 1px solid #f1f5f9;' }, [ actionBadge ]),
					E('td', { 'style': 'padding: 7px 10px; border-right: 1px solid #f1f5f9;' }, [ protoBadge ]),
					E('td', { 'style': 'padding: 7px 10px; border-right: 1px solid #f1f5f9;' }, [ domainTd ]),
					E('td', { 'style': 'padding: 7px 10px; font-family: monospace; font-size: 11.5px; color: #334155; white-space: nowrap; border-right: 1px solid #f1f5f9;' }, it.src),
					E('td', { 'style': 'padding: 7px 10px; font-family: monospace; font-size: 11.5px; color: #334155; white-space: nowrap; border-right: 1px solid #f1f5f9;' }, it.dst),
					E('td', { 'style': 'padding: 7px 10px; font-family: monospace; font-size: 11px; color: #475569; word-break: break-all; border-right: 1px solid #f1f5f9;' }, it.ruleDesc),
					E('td', { 'style': 'padding: 7px 10px; text-align: right;' }, [ opBtn ])
				]);

				tr.addEventListener('mouseenter', function() { tr.style.background = '#f0fdf4'; });
				tr.addEventListener('mouseleave', function() { tr.style.background = rowBg; });

				tableBody.appendChild(tr);
			});
		};

		filterInput.addEventListener('input', updateDisplay);

		function createFilterBtn(text, mode, active) {
			let b = E('button', {
				'class': 'btn cbi-button ' + (active ? 'cbi-button-action' : 'cbi-button-neutral'),
				'style': 'margin-right: 5px; padding: 4px 12px; font-size: 12px;',
				'click': function() {
					currentFilterMode = mode;
					let p = this.parentNode;
					for (let i = 0; i < p.children.length; i++) {
						p.children[i].className = 'btn cbi-button cbi-button-neutral';
					}
					this.className = 'btn cbi-button cbi-button-action';
					updateDisplay();
				}
			}, text);
			return b;
		}

		let filterBtnGroup = E('div', { 'style': 'display: flex; flex-wrap: wrap; gap: 4px;' }, [
			createFilterBtn(_('📋 全部日志'), 'all', true),
			createFilterBtn(_('🛑 所有阻断拦截'), 'blocked', false),
			createFilterBtn(_('🛡️ 广告拦截'), 'ad', false),
			createFilterBtn(_('🌐 地区/IP阻断'), 'geo', false),
			createFilterBtn(_('👁️ 域名访问审计'), 'sni', false),
			createFilterBtn(_('⚙️ 系统核心'), 'system', false)
		]);

		// 切换 Excel 表格与终端视图
		let viewToggleBtn = E('button', {
			'class': 'btn cbi-button cbi-button-action',
			'style': 'margin-right: 8px; padding: 5px 14px; font-size: 12px; font-weight: bold;',
			'click': function() {
				if (viewMode === 'excel') {
					viewMode = 'raw';
					this.textContent = _('📊 切换回 Excel 表格明细');
					excelContainer.style.display = 'none';
					logRawPre.style.display = 'block';
				} else {
					viewMode = 'excel';
					this.textContent = _('💻 切换为终端原始日志');
					excelContainer.style.display = 'block';
					logRawPre.style.display = 'none';
				}
			}
		}, _('💻 切换为终端原始日志'));

		// 导出 Excel 按钮
		let exportBtn = E('button', {
			'class': 'btn cbi-button cbi-button-apply',
			'style': 'margin-right: 8px; padding: 5px 14px; font-size: 12px; font-weight: bold;',
			'click': function() {
				exportToCsv(lastParsedItems);
			}
		}, _('📥 导出为 Excel (CSV)'));

		// 清空日志按钮
		let clearBtn = E('button', {
			'class': 'btn cbi-button cbi-button-reset',
			'style': 'padding: 5px 14px; font-size: 12px;',
			'click': function() {
				if (!confirm(_('确定清空 OpenGFW 运行日志吗？'))) return;
				return fs.write(LOG_FILE, '').then(function() {
					rawLogs = '';
					updateDisplay();
					ui.addNotification(null, E('p', {}, _('日志已清空！')), 'info');
				});
			}
		}, _('🗑️ 清空日志'));

		poll.add(function() {
			return Promise.all([
				fs.read_direct(LOG_FILE).catch(function() { return ''; }),
				fs.exec_direct('/sbin/logread', ['-e', 'opengfw']).catch(function() { return ''; })
			]).then(function(res) {
				let fLog = (res[0] || '').trim();
				let sLog = (res[1] || '').trim();
				let combined = '';
				if (fLog && sLog) {
					combined = fLog + '\n' + sLog;
				} else {
					combined = fLog || sLog;
				}
				rawLogs = combined.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
				updateDisplay();
			}).catch(function() {
				tableBody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: #888; padding: 30px;">无法获取日志或暂无流量记录。</td></tr>';
			});
		});

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('OpenGFW 实时流量与拦截日志')),
			E('div', { 'class': 'cbi-map-descr' }, _('实时表格化监控 OpenGFW 深度包检测、规则命中与拦截记录。支持 Excel 结构化排列、多维关键字实时检索，可一键将目标域名或外部 IP 加入自定义拦截名单。')),

			// 顶部工具栏
			E('div', { 'class': 'cbi-section', 'style': 'background: #fafafa; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 16px; margin-bottom: 15px;' }, [
				E('div', { 'style': 'display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 10px;' }, [
					filterBtnGroup,
					E('div', { 'style': 'display: flex; align-items: center;' }, [
						viewToggleBtn,
						exportBtn,
						clearBtn
					])
				]),
				E('div', { 'style': 'display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; border-top: 1px dashed #cbd5e1; padding-top: 10px;' }, [
					filterInput,
					statsBadge
				])
			]),

			// 内容区域 (默认展示 Excel 结构化表格)
			excelContainer,
			logRawPre,

			E('div', { 'style': 'margin-top: 10px; color: #888; font-size: 12px; display: flex; justify-content: space-between;' }, [
				E('span', {}, _('💡 提示: 表格支持实时按时间、动作、域名、IP 搜索过滤；点击【➕ 拦截】可即刻阻断该域名，支持一键导出为 Excel CSV 表格。')),
				E('span', {}, _('页面每隔 3 秒自动轮询刷新，展示最近 300 条流记录（最新在最前）'))
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
