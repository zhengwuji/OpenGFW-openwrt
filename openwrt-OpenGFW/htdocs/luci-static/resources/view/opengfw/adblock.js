'use strict';
'require fs';
'require poll';
'require ui';
'require view';

const PRESET_SOURCES = [
	{
		name: '217heidai 广告全能拦截规则 (精简去重)',
		url: 'https://raw.githubusercontent.com/217heidai/adblockfilters/main/rules/adblockdns.txt',
		category: 'adblockfilters'
	},
	{
		name: '217heidai 完整综合广告过滤列表',
		url: 'https://raw.githubusercontent.com/217heidai/adblockfilters/main/rules/adblockfilters.txt',
		category: 'adblockfilters'
	},
	{
		name: 'anti-AD 知名中文广告过滤源',
		url: 'https://raw.githubusercontent.com/privacy-protection-tools/anti-AD/master/anti-ad-domains.txt',
		category: 'anti_ad'
	},
	{
		name: 'AdGuard 官方 DNS 基础过滤规则',
		url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt',
		category: 'adguard_dns'
	}
];


// 彻底解决主题下 alert-message 通知框无法点击关闭的 Bug (瞬时关闭 + 捕获阶段拦截)
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
		let urlInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'style': 'width: 100%; font-family: monospace; font-size: 13px;',
			'placeholder': '例如: https://raw.githubusercontent.com/217heidai/adblockfilters/main/rules/adblockdns.txt',
			'value': PRESET_SOURCES[0].url
		});

		let categoryInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'style': 'width: 200px; font-family: monospace;',
			'value': 'adblockfilters'
		});

		let textRulesInput = E('textarea', {
			'class': 'cbi-input-textarea',
			'style': 'width: 100%; min-height: 160px; font-family: monospace; font-size: 12px;',
			'placeholder': '在此直接粘贴 Adblock / EasyList / Hosts / 域名列表，支持:\n||ad.example.com^\n0.0.0.0 bad.ad.com\naddress=/tracking.com/0.0.0.0\nspam.domain.com'
		});

		let fileInput = E('input', {
			'type': 'file',
			'class': 'cbi-input-file',
			'accept': '.txt,.conf,.rules'
		});

		let lastAuditData = null;
		let auditModalTab = 'blocked';
		let auditSearchKeyword = '';
		let tableContainer = E('div', { 'id': 'audit_modal_table_container', 'style': 'overflow-y: auto; max-height: 420px; border-radius: 4px;' });

		let renderAuditTable = function(container) {
			container.innerHTML = '';
			if (!lastAuditData) {
				container.appendChild(E('p', { 'style': 'text-align: center; color: #888; padding: 25px;' }, _('正在获取实时审计数据...')));
				return;
			}
			let list = (auditModalTab === 'blocked') ? (lastAuditData.blocked || []) : (lastAuditData.allowed || []);
			if (auditSearchKeyword) {
				let kw = auditSearchKeyword.toLowerCase();
				list = list.filter(function(item) {
					return (item.sni && item.sni.toLowerCase().indexOf(kw) !== -1) ||
					       (item.src && item.src.toLowerCase().indexOf(kw) !== -1) ||
					       (item.rule && item.rule.toLowerCase().indexOf(kw) !== -1) ||
					       (item.dst && item.dst.toLowerCase().indexOf(kw) !== -1);
				});
			}

			if (list.length === 0) {
				container.appendChild(E('div', { 'style': 'text-align: center; color: #888; padding: 35px 15px;' }, [
					E('p', { 'style': 'font-size: 14px; margin-bottom: 5px;' }, (auditModalTab === 'blocked' ? _('🎉 暂无广告拦截记录，所有访问顺畅！') : _('暂无正常放行流量记录。'))),
					E('small', {}, _('当内网设备产生访问时，内核 DPI 引擎将在此实时捕获呈现。'))
				]));
				return;
			}

			let tbl;
			if (auditModalTab === 'blocked') {
				tbl = E('table', { 'class': 'table', 'style': 'width: 100%; font-size: 12px; margin-top: 5px;' }, [
					E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th', 'style': 'width: 85px;' }, _('拦截时间')),
						E('th', { 'class': 'th', 'style': 'width: 130px;' }, _('客户端 IP')),
						E('th', { 'class': 'th' }, _('拦截的目标域名 / SNI')),
						E('th', { 'class': 'th' }, _('命中规则')),
						E('th', { 'class': 'th', 'style': 'width: 95px; text-align: center;' }, _('处置动作'))
					])
				]);
				list.forEach(function(item) {
					let actionBadge = E('span', { 'style': 'background: rgba(220, 53, 69, 0.1); color: #dc3545; padding: 2px 6px; border-radius: 4px; font-weight: bold;' }, _('🔴 阻断 (Block)'));
					if (item.action === 'modify') {
						actionBadge = E('span', { 'style': 'background: rgba(255, 193, 7, 0.1); color: #e67e22; padding: 2px 6px; border-radius: 4px; font-weight: bold;' }, _('🟡 DNS黑洞'));
					} else if (item.action === 'drop') {
						actionBadge = E('span', { 'style': 'background: rgba(108, 117, 125, 0.1); color: #6c757d; padding: 2px 6px; border-radius: 4px; font-weight: bold;' }, _('丢弃 (Drop)'));
					}
					tbl.appendChild(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td', 'style': 'color: #888; font-family: monospace;' }, item.time || '-'),
						E('td', { 'class': 'td', 'style': 'font-family: monospace;' }, item.src ? item.src.split(':')[0] : '-'),
						E('td', { 'class': 'td', 'style': 'font-weight: bold; color: #dc3545; word-break: break-all;' }, item.sni || item.dst || '-'),
						E('td', { 'class': 'td', 'style': 'color: #555;' }, item.rule || _('广告拦截库规则')),
						E('td', { 'class': 'td', 'style': 'text-align: center;' }, [ actionBadge ])
					]));
				});
			} else {
				tbl = E('table', { 'class': 'table', 'style': 'width: 100%; font-size: 12px; margin-top: 5px;' }, [
					E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th', 'style': 'width: 85px;' }, _('访问时间')),
						E('th', { 'class': 'th', 'style': 'width: 130px;' }, _('客户端 IP')),
						E('th', { 'class': 'th' }, _('访问域名 / SNI')),
						E('th', { 'class': 'th', 'style': 'width: 160px;' }, _('目的服务器')),
						E('th', { 'class': 'th', 'style': 'width: 80px; text-align: center;' }, _('状态')),
						E('th', { 'class': 'th', 'style': 'width: 100px; text-align: center;' }, _('操作'))
					])
				]);
				list.forEach(function(item) {
					let blockBtn = E('button', {
						'class': 'btn cbi-button cbi-button-reset',
						'style': 'padding: 2px 8px; font-size: 11px;',
						'click': function() {
							let targetDomain = item.sni;
							if (!targetDomain) return;
							if (!confirm(_('确定将域名【%s】一键加入广告拦截规则吗？').format(targetDomain))) return;
							ui.hideModal();
							let tmpFile = '/tmp/opengfw_single_block.txt';
							fs.write(tmpFile, '||' + targetDomain + '^\n').then(function() {
								doImport(['import', '--file', tmpFile, '--name', 'user_blacklist'], _('域名已成功加入拦截列表并生效！'));
							});
						}
					}, _('🚫 拦截此域名'));

					tbl.appendChild(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td', 'style': 'color: #888; font-family: monospace;' }, item.time || '-'),
						E('td', { 'class': 'td', 'style': 'font-family: monospace;' }, item.src ? item.src.split(':')[0] : '-'),
						E('td', { 'class': 'td', 'style': 'font-weight: bold; color: #28a745; word-break: break-all;' }, item.sni || item.dst || '-'),
						E('td', { 'class': 'td', 'style': 'color: #666; font-family: monospace; font-size: 11px;' }, item.dst || '-'),
						E('td', { 'class': 'td', 'style': 'text-align: center;' }, [
							E('span', { 'style': 'background: rgba(40, 167, 69, 0.1); color: #28a745; padding: 2px 6px; border-radius: 4px; font-weight: bold;' }, _('🟢 放行'))
						]),
						E('td', { 'class': 'td', 'style': 'text-align: center;' }, [ item.sni ? blockBtn : '-' ])
					]));
				});
			}

			container.appendChild(tbl);
		};

		let refreshAuditData = function(container) {
			return fs.exec_direct('/usr/bin/opengfw-adblock-tool', ['audit']).then(function(out) {
				try {
					lastAuditData = JSON.parse(out.trim());
					let elBlocked = document.getElementById('audit_blocked_count');
					let elAllowed = document.getElementById('audit_allowed_count');
					let elRules = document.getElementById('audit_rules_count');
					let elRate = document.getElementById('audit_hit_rate');
					if (elBlocked) elBlocked.textContent = lastAuditData.blocked_count + ' 次';
					if (elAllowed) elAllowed.textContent = lastAuditData.allowed_count + ' 次';
					if (elRules) elRules.textContent = (lastAuditData.total_rules_domains || 0).toLocaleString() + ' 条';
					if (elRate) elRate.textContent = lastAuditData.hit_rate || '0.0%';

					let mb1 = document.getElementById('modal_badge_blocked');
					let mb2 = document.getElementById('modal_badge_allowed');
					if (mb1) mb1.textContent = '(' + lastAuditData.blocked_count + ')';
					if (mb2) mb2.textContent = '(' + lastAuditData.allowed_count + ')';

					if (container) {
						renderAuditTable(container);
					}
				} catch(e) {}
			}).catch(function() {});
		};

		let openAuditModal = function() {
			let modalBody = E('div', { 'style': 'max-height: 520px; display: flex; flex-direction: column;' }, [
				// 顶部统计与切换栏
				E('div', { 'style': 'display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid #eee;' }, [
					E('div', { 'style': 'display: flex; gap: 8px;' }, [
						E('button', {
							'id': 'audit_tab_btn_blocked',
							'class': 'btn cbi-button cbi-button-reset',
							'style': 'font-weight: bold; padding: 5px 14px; background: #dc3545; color: #fff;',
							'click': function() {
								auditModalTab = 'blocked';
								this.style.background = '#dc3545';
								this.style.color = '#fff';
								let b2 = document.getElementById('audit_tab_btn_allowed');
								if (b2) { b2.style.background = ''; b2.style.color = ''; }
								renderAuditTable(tableContainer);
							}
						}, [ '🛑 ' + _('已拦截明细'), E('span', { 'id': 'modal_badge_blocked', 'style': 'margin-left: 5px; opacity: 0.9;' }, (lastAuditData ? '(' + lastAuditData.blocked_count + ')' : '')) ]),
						E('button', {
							'id': 'audit_tab_btn_allowed',
							'class': 'btn cbi-button cbi-button-neutral',
							'style': 'font-weight: bold; padding: 5px 14px;',
							'click': function() {
								auditModalTab = 'allowed';
								this.style.background = '#28a745';
								this.style.color = '#fff';
								let b1 = document.getElementById('audit_tab_btn_blocked');
								if (b1) { b1.style.background = ''; b1.style.color = ''; }
								renderAuditTable(tableContainer);
							}
						}, [ '✅ ' + _('放行正常流量'), E('span', { 'id': 'modal_badge_allowed', 'style': 'margin-left: 5px; opacity: 0.9;' }, (lastAuditData ? '(' + lastAuditData.allowed_count + ')' : '')) ])
					]),
					E('div', { 'style': 'display: flex; align-items: center; gap: 8px;' }, [
						E('input', {
							'type': 'text',
							'class': 'cbi-input-text',
							'placeholder': _('快速搜索域名/IP/规则...'),
							'style': 'width: 220px; font-size: 12px;',
							'input': function(ev) {
								auditSearchKeyword = ev.target.value.trim();
								renderAuditTable(tableContainer);
							}
						}),
						E('button', {
							'class': 'btn cbi-button cbi-button-action',
							'style': 'padding: 4px 10px; font-size: 12px;',
							'click': function() {
								refreshAuditData(tableContainer);
							}
						}, _('🔄 刷新'))
					])
				]),

				// 表格容器 (滚动区域)
				tableContainer
			]);

			ui.showModal(_('📊 OpenGFW 流量拦截与放行审计看板'), [
				modalBody,
				E('div', { 'class': 'right', 'style': 'margin-top: 15px; display: flex; justify-content: space-between; align-items: center;' }, [
					E('span', { 'style': 'font-size: 12px; color: #888;' }, _('💡 数据源自内核 DPI 引擎实时日志流，支持秒级审计')),
					E('button', {
						'class': 'btn cbi-button cbi-button-primary',
						'style': 'padding: 6px 20px;',
						'click': ui.hideModal
					}, _('关闭'))
				])
			]);

			refreshAuditData(tableContainer);
		};


		let statusTable = E('table', { 'class': 'table', 'style': 'width: 100%; text-align: left;' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('规则分类名称')),
				E('th', { 'class': 'th' }, _('已加载域名数量')),
				E('th', { 'class': 'th' }, _('生效状态')),
				E('th', { 'class': 'th', 'style': 'text-align: right;' }, _('操作'))
			]),
			E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', 'colspan': '4' }, _('正在获取当前规则库列表...'))
			])
		]);

		let refreshStatus = function() {
			return fs.exec_direct('/usr/bin/opengfw-adblock-tool', ['list']).then(function(res) {
				try {
					let list = JSON.parse(res.trim());
					let rows = [
						E('tr', { 'class': 'tr table-titles' }, [
							E('th', { 'class': 'th' }, _('规则分类名称')),
							E('th', { 'class': 'th' }, _('已加载域名数量')),
							E('th', { 'class': 'th' }, _('生效状态')),
							E('th', { 'class': 'th', 'style': 'text-align: right;' }, _('操作'))
						])
					];
					if (Array.isArray(list) && list.length > 0) {
						list.forEach(function(item) {
							// Highlight custom/adblock categories
							let isAdblock = (item.name.indexOf('ad') !== -1 || item.name.indexOf('block') !== -1 || item.name.indexOf('filter') !== -1);
							let style = isAdblock ? 'font-weight: bold; color: #0070f3;' : '';

							let actionCell = E('td', { 'class': 'td', 'style': 'text-align: right;' });
							if (item.name.toLowerCase() !== 'category-ads-all') {
								actionCell.appendChild(E('button', {
									'class': 'btn cbi-button cbi-button-remove',
									'style': 'padding: 2px 8px; font-size: 11px;',
									'click': function() {
										if (confirm(_('确定从规则库和防火墙策略中删除分类 [' + item.name + '] 吗？'))) {
											ui.showModal(_('正在删除分类'), [ E('p', { 'class': 'spinning' }, _('正在移除规则并重新编译规则库...')) ]);
											fs.exec_direct('/usr/bin/opengfw-adblock-tool', ['delete', '--name', item.name]).then(function() {
												ui.hideModal();
												refreshStatus();
												ui.addNotification(null, E('p', {}, '✅ 分类 [' + item.name + '] 已成功删除并热重载生效！'), 'success');
											}).catch(function(err) {
												ui.hideModal();
												ui.showModal(_('删除失败'), [ E('p', { 'style': 'color: #dc3545;' }, _('删除失败: ') + err) ]);
											});
										}
									}
								}, _('🗑️ 删除分类')));
							} else {
								actionCell.appendChild(E('span', { 'style': 'color: #888; font-size: 11px;' }, _('社区基础库')));
							}

							rows.push(E('tr', { 'class': 'tr' }, [
								E('td', { 'class': 'td', 'style': style }, item.name),
								E('td', { 'class': 'td' }, item.count + ' 个独立根域名'),
								E('td', { 'class': 'td', 'style': 'color: #28a745;' }, '● 拦截生效中'),
								actionCell
							]));
						});
					} else {
						rows.push(E('tr', { 'class': 'tr' }, [
							E('td', { 'class': 'td', 'colspan': '4', 'style': 'color: #888;' }, _('暂无已导入分类，请在上方添加订阅导入。'))
						]));
					}
					statusTable.innerHTML = '';
					rows.forEach(function(r) { statusTable.appendChild(r); });
					refreshAuditData();
				} catch(e) {}
			}).catch(function() {});
		};

		let doImport = function(args, successMsg) {
			ui.showModal(_('正在处理规则导入'), [
				E('p', { 'class': 'spinning' }, _('正在下载/解析规则内容并生成高效前缀匹配树，请稍候...'))
			]);
			return fs.exec_direct('/usr/bin/opengfw-adblock-tool', args).then(function(res) {
				ui.hideModal();
				try {
					let obj = JSON.parse(res.trim());
					if (obj.success) {
						ui.showModal(_('导入成功'), [ E('p', { 'style': 'color: #28a745; font-weight: bold;' }, obj.message || successMsg), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('关闭')) ]) ]);
						refreshStatus();
					} else {
						ui.showModal(_('导入失败'), [ E('p', { 'style': 'color: #dc3545;' }, _('导入失败: ') + (obj.error || _('未知错误'))), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('关闭')) ]) ]);
					}
				} catch(e) {
					ui.showModal(_('执行结果'), [ E('pre', { 'style': 'background: #1e1e1e; color: #00ff66; padding: 10px; border-radius: 4px; font-family: monospace;' }, res), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('关闭')) ]) ]);
					refreshStatus();
				}
			}).catch(function(err) {
				ui.hideModal();
				ui.showModal(_('执行出错'), [ E('p', { 'style': 'color: #dc3545;' }, _('执行出错: ') + err), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('关闭')) ]) ]);
			});
		};

		poll.add(refreshStatus);

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('OpenGFW 广告拦截与规则订阅导入')),
			E('div', { 'class': 'cbi-map-descr' }, _('支持一键导入 217heidai/adblockfilters、AdGuard、EasyList、Hosts 以及普通域名列表。系统会自动去重并编译为超高速内核级前缀树，对 TLS SNI、HTTP 域名、QUIC 以及 DNS 查询进行全量硬件级拦截！')),

			// 预设选择器
			E('div', { 'class': 'cbi-section', 'style': 'margin-bottom: 20px;' }, [
				E('h3', {}, [ _('一键选择推荐规则源:'), E('span', { 'id': 'preset_selected_hint', 'style': 'display: none; color: #28a745; font-size: 13px; font-weight: bold; margin-left: 10px;' }) ]),
				E('div', { 'style': 'display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px;' },
					PRESET_SOURCES.map(function(s) {
						return E('button', {
							'class': 'btn cbi-button cbi-button-neutral',
							'click': function() {
								urlInput.value = s.url;
								categoryInput.value = s.category;
								let hint = document.getElementById('preset_selected_hint');
								if (hint) {
									hint.style.display = 'inline-block';
									hint.textContent = '✅ 已选定预设: ' + s.name;
								}
							}
						}, s.name);
					})
				)
			]),

			// 1. 网络 URL 导入 + 广告拦截实时看板 (红圈位置)
			E('div', { 'class': 'cbi-section', 'style': 'margin-bottom: 20px; border-top: 1px solid #eee; padding-top: 15px;' }, [
				E('div', { 'style': 'display: flex; flex-wrap: wrap; gap: 20px; align-items: stretch;' }, [
					// 左侧：从网络订阅链接导入
					E('div', { 'style': 'flex: 1 1 420px; min-width: 300px;' }, [
						E('h3', {}, _('方式一：从网络订阅链接 (URL) 下载导入')),
						E('div', { 'class': 'cbi-value', 'style': 'margin-top: 10px;' }, [
							E('label', { 'class': 'cbi-value-title', 'style': 'width: 140px; font-weight: bold;' }, _('规则订阅 URL: ')),
							E('div', { 'class': 'cbi-value-field' }, [ urlInput ])
						]),
						E('div', { 'class': 'cbi-value' }, [
							E('label', { 'class': 'cbi-value-title', 'style': 'width: 140px; font-weight: bold;' }, _('指定分类标识: ')),
							E('div', { 'class': 'cbi-value-field' }, [
								categoryInput,
								E('small', { 'style': 'margin-left: 10px; color: #888;' }, _('英文标识，默认为 adblockfilters'))
							])
						]),
						E('div', { 'class': 'cbi-value', 'style': 'margin-top: 15px;' }, [
							E('div', { 'class': 'cbi-value-field' }, [
								E('button', {
									'class': 'btn cbi-button cbi-button-apply',
									'style': 'padding: 6px 20px; font-weight: bold;',
									'click': function() {
										let u = urlInput.value.trim();
										let cat = categoryInput.value.trim() || 'adblockfilters';
										if (!u) {
											ui.showModal(_('提示'), [ E('p', { 'style': 'color: #dc3545;' }, _('请输入有效的规则订阅 URL 地址！')), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('确定')) ]) ]);
											return;
										}
										doImport(['import', '--url', u, '--name', cat], _('网络规则订阅导入成功！'));
									}
								}, _('📥 立即下载并导入规则库'))
							])
						])
					]),

					// 右侧：红圈位置！广告拦截与流控实时统计仪表盘
					E('div', {
						'id': 'adblock_audit_card',
						'style': 'flex: 1 1 420px; min-width: 300px; background: rgba(0, 112, 243, 0.03); border: 1px solid rgba(0, 112, 243, 0.25); border-radius: 8px; padding: 16px; display: flex; flex-direction: column; justify-content: space-between; box-shadow: 0 2px 8px rgba(0,0,0,0.04);'
					}, [
						E('div', {}, [
							E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(0, 112, 243, 0.15); padding-bottom: 8px; margin-bottom: 12px;' }, [
								E('h3', { 'style': 'margin: 0; color: #0070f3; font-size: 15px; display: flex; align-items: center; gap: 6px;' }, [
									'🛡️ ', _('当前拦截与流控实时统计')
								]),
								E('span', { 'style': 'display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: #28a745; font-weight: bold; background: rgba(40, 167, 69, 0.1); padding: 3px 8px; border-radius: 12px;' }, [
									E('span', { 'style': 'width: 8px; height: 8px; border-radius: 50%; background: #28a745; display: inline-block;' }),
									_('● 深度 DPI 拦截中')
								])
							]),
							// 4 格指标看板
							E('div', { 'style': 'display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;' }, [
								// 拦截指标
								E('div', { 'style': 'background: rgba(220, 53, 69, 0.06); border: 1px solid rgba(220, 53, 69, 0.2); border-radius: 6px; padding: 10px; text-align: center;' }, [
									E('div', { 'style': 'font-size: 12px; color: #888; margin-bottom: 4px;' }, _('已拦截广告/恶意请求')),
									E('div', { 'id': 'audit_blocked_count', 'style': 'font-size: 22px; font-weight: bold; color: #dc3545;' }, '0')
								]),
								// 放行指标
								E('div', { 'style': 'background: rgba(40, 167, 69, 0.06); border: 1px solid rgba(40, 167, 69, 0.2); border-radius: 6px; padding: 10px; text-align: center;' }, [
									E('div', { 'style': 'font-size: 12px; color: #888; margin-bottom: 4px;' }, _('已放行正常流量')),
									E('div', { 'id': 'audit_allowed_count', 'style': 'font-size: 22px; font-weight: bold; color: #28a745;' }, '0')
								]),
								// 规则库域名总数
								E('div', { 'style': 'background: rgba(0, 112, 243, 0.06); border: 1px solid rgba(0, 112, 243, 0.2); border-radius: 6px; padding: 10px; text-align: center;' }, [
									E('div', { 'style': 'font-size: 12px; color: #888; margin-bottom: 4px;' }, _('已加载过滤规则域名')),
									E('div', { 'id': 'audit_rules_count', 'style': 'font-size: 18px; font-weight: bold; color: #0070f3;' }, '0 条')
								]),
								// 命中率
								E('div', { 'style': 'background: rgba(156, 39, 176, 0.06); border: 1px solid rgba(156, 39, 176, 0.2); border-radius: 6px; padding: 10px; text-align: center;' }, [
									E('div', { 'style': 'font-size: 12px; color: #888; margin-bottom: 4px;' }, _('拦截命中率')),
									E('div', { 'id': 'audit_hit_rate', 'style': 'font-size: 18px; font-weight: bold; color: #9c27b0;' }, '0.0%')
								])
							])
						]),
						// 点击进去的大按钮
						E('div', { 'style': 'margin-top: 8px;' }, [
							E('button', {
								'class': 'btn cbi-button cbi-button-action',
								'style': 'width: 100%; font-size: 14px; font-weight: bold; padding: 9px 12px; display: flex; align-items: center; justify-content: center; gap: 8px;',
								'click': function() {
									openAuditModal();
								}
							}, [
								_('🔍 点击进入：查看【已拦截】与【放行】明细清单 ➔')
							])
						])
					])
				])
			]),

			// 2. 文本内容粘贴导入
			E('div', { 'class': 'cbi-section', 'style': 'margin-bottom: 20px; border-top: 1px solid #eee; padding-top: 15px;' }, [
				E('h3', {}, _('方式二：直接粘贴规则文本导入')),
				E('div', { 'style': 'margin-top: 10px;' }, [ textRulesInput ]),
				E('div', { 'style': 'margin-top: 10px;' }, [
					E('button', {
						'class': 'btn cbi-button cbi-button-save',
						'click': function() {
							let text = textRulesInput.value.trim();
							let cat = categoryInput.value.trim() || 'adblockfilters';
							if (!text) {
								ui.showModal(_('提示'), [ E('p', { 'style': 'color: #dc3545;' }, _('请先在上方文本框粘贴规则内容！')), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('确定')) ]) ]);
								return;
							}
							let tmpFile = '/tmp/opengfw_paste_rules.txt';
							ui.showModal(_('正在处理'), [ E('p', { 'class': 'spinning' }, _('正在写入临时文件并解析...')) ]);
							fs.write(tmpFile, text).then(function() {
								ui.hideModal();
								doImport(['import', '--file', tmpFile, '--name', cat], _('规则文本解析导入成功！'));
							}).catch(function(err) {
								ui.hideModal();
								ui.showModal(_('写入出错'), [ E('p', { 'style': 'color: #dc3545;' }, _('写入出错: ') + err), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('确定')) ]) ]);
							});
						}
					}, _('📝 解析文本并合并导入'))
				])
			]),

			// 3. 本地文件上传导入
			E('div', { 'class': 'cbi-section', 'style': 'margin-bottom: 20px; border-top: 1px solid #eee; padding-top: 15px;' }, [
				E('h3', {}, _('方式三：本地规则文件上传导入')),
				E('div', { 'style': 'display: flex; align-items: center; gap: 15px; margin-top: 10px;' }, [
					fileInput,
					E('button', {
						'class': 'btn cbi-button cbi-button-save',
						'click': function() {
							let file = fileInput.files[0];
							if (!file) {
								ui.showModal(_('提示'), [ E('p', { 'style': 'color: #dc3545;' }, _('请先选择本地规则文本文件！')), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('确定')) ]) ]);
								return;
							}
							let cat = categoryInput.value.trim() || 'adblockfilters';
							let reader = new FileReader();
							reader.onload = function(e) {
								let content = e.target.result;
								let tmpFile = '/tmp/opengfw_uploaded_rules.txt';
								ui.showModal(_('正在上传'), [ E('p', { 'class': 'spinning' }, _('正在上传文件并解析...')) ]);
								fs.write(tmpFile, content).then(function() {
									ui.hideModal();
									doImport(['import', '--file', tmpFile, '--name', cat], _('本地文件导入成功！'));
								}).catch(function(err) {
									ui.hideModal();
									ui.showModal(_('上传出错'), [ E('p', { 'style': 'color: #dc3545;' }, _('上传出错: ') + err), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('确定')) ]) ]);
								});
							};
							reader.readAsText(file);
						}
					}, _('📂 上传并导入规则'))
				])
			]),

			// 4. 当前规则库统计
			E('div', { 'class': 'cbi-section', 'style': 'border-top: 1px solid #eee; padding-top: 15px;' }, [
				E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;' }, [
					E('h3', { 'style': 'margin: 0;' }, _('当前已加载的规则分类统计')),
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'click': function() {
							return fs.exec_direct('/etc/init.d/opengfw', ['reload']).then(function() {
								ui.showModal(_('已热重载'), [ E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('已触发 SIGHUP 热重载，所有规则已全量刷新生效！')), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('关闭')) ]) ]);
							});
						}
					}, _('⚡ 立即热重载生效'))
				]),
				statusTable
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
