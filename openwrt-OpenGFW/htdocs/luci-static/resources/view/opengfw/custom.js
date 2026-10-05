'use strict';
'require dom';
'require fs';
'require ui';
'require view';

const HELPER = '/usr/bin/opengfw-custom-helper';
const CUSTOM_JSON_PATH = '/etc/opengfw/custom_rules.json';

// 解决主题下通知框关闭事件捕获
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
		return fs.read_direct(CUSTOM_JSON_PATH).then(function(res) {
			try {
				let data = JSON.parse(res);
				return Array.isArray(data) ? data : [];
			} catch(e) {
				return [];
			}
		}).catch(function() {
			return [];
		});
	},

	render: function(rulesList) {
		let currentRules = Array.isArray(rulesList) ? rulesList : [];
		let activeFilterMode = 'all';
		let searchKeyword = '';
		let addMode = 'single'; // 'single' or 'batch'

		// 格式化当前时间为 YYYY-MM-DD HH:mm:ss
		function getNowStr() {
			let d = new Date();
			let pad = function(n) { return (n < 10 ? '0' : '') + n; };
			return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
			       pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
		}

		// 保存并热重载核心逻辑
		function saveAndApply(newRules, successMsg) {
			ui.showModal(_('正在应用规则'), [
				E('p', { 'class': 'spinning' }, _('正在编译自定义规则并通知 OpenGFW 内核引擎热重载生效，请稍候...'))
			]);
			let jsonStr = JSON.stringify(newRules, null, 2);
			return fs.write(CUSTOM_JSON_PATH, jsonStr).then(function() {
				return fs.exec_direct(HELPER, ['apply']);
			}).then(function(res) {
				ui.hideModal();
				currentRules = newRules;
				renderTable();
				updateStats();
				ui.addNotification(null, E('p', {}, successMsg || _('自定义规则已成功编译并热重载生效！')), 'info');
			}).catch(function(err) {
				ui.hideModal();
				ui.showModal(_('应用失败'), [
					E('p', { 'style': 'color: #dc3545; font-weight: bold;' }, _('错误信息: ') + err),
					E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
						E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('关闭'))
					])
				]);
			});
		}

		// 单条添加表单控件
		let typeSelect = E('select', { 'class': 'cbi-input-select', 'style': 'width: 140px;' }, [
			E('option', { 'value': 'domain' }, _('🌐 域名 (Domain)')),
			E('option', { 'value': 'ip' }, _('🖥️ IP 地址 / CIDR'))
		]);

		let valueInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'style': 'flex: 1; min-width: 220px; font-family: monospace; font-size: 13px;',
			'placeholder': _('例如: ads.example.com 或 198.51.100.1 或 1.2.3.0/24')
		});

		let actionSelect = E('select', { 'class': 'cbi-input-select', 'style': 'width: 140px;' }, [
			E('option', { 'value': 'block' }, _('🛑 阻断 (Block)')),
			E('option', { 'value': 'allow' }, _('⚡ 白名单 (Allow)'))
		]);

		let directionSelect = E('select', { 'class': 'cbi-input-select', 'style': 'width: 150px;' }, [
			E('option', { 'value': 'both' }, _('🔄 双向接管 (推荐)')),
			E('option', { 'value': 'outbound' }, _('⬆️ 仅出站 (内网外联)')),
			E('option', { 'value': 'inbound' }, _('⬇️ 仅入站 (外网打入)'))
		]);

		let commentInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'style': 'width: 180px;',
			'placeholder': _('备注说明 (可选)')
		});

		// 批量添加文本框
		let batchTextarea = E('textarea', {
			'class': 'cbi-input-textarea',
			'style': 'width: 100%; min-height: 120px; font-family: monospace; font-size: 12px;',
			'placeholder': _('在此直接粘贴多个域名或 IP (每行一个，支持 # 注释)，例如:\nbad.example.com # 恶意弹窗\ntracking.com\n198.51.100.4\n203.0.113.0/24')
		});

		let batchActionSelect = E('select', { 'class': 'cbi-input-select', 'style': 'width: 140px;' }, [
			E('option', { 'value': 'block' }, _('🛑 全部设为阻断')),
			E('option', { 'value': 'allow' }, _('⚡ 全部设为白名单'))
		]);

		let singleFormContainer = E('div', { 'style': 'display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 10px;' }, [
			typeSelect,
			valueInput,
			actionSelect,
			directionSelect,
			commentInput,
			E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'style': 'padding: 6px 18px; font-weight: bold;',
				'click': function() {
					let val = valueInput.value.trim();
					if (!val) {
						ui.addNotification(null, E('p', {}, _('请输入要拦截的域名或 IP 地址！')), 'warning');
						return;
					}
					// 自动纠正去除协议头 http:// 或 https://
					val = val.replace(/^https?:\/\//i, '').split('/')[0].trim();

					// 查重检测
					let exists = currentRules.some(function(r) {
						return r.value.toLowerCase() === val.toLowerCase();
					});
					if (exists) {
						ui.addNotification(null, E('p', {}, _('该规则目标已存在于清单中，请勿重复添加！')), 'warning');
						return;
					}

					let item = {
						id: 'c_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
						type: typeSelect.value,
						value: val,
						action: actionSelect.value,
						direction: directionSelect.value,
						comment: commentInput.value.trim(),
						enabled: true,
						time: getNowStr()
					};

					let newRules = [item].concat(currentRules);
					valueInput.value = '';
					commentInput.value = '';
					saveAndApply(newRules, _('已成功添加规则并秒级热重载生效: ') + val);
				}
			}, _('➕ 添加并立即生效'))
		]);

		let batchFormContainer = E('div', { 'style': 'display: none; margin-top: 10px;' }, [
			batchTextarea,
			E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-top: 10px;' }, [
				E('div', { 'style': 'display: flex; gap: 10px; align-items: center;' }, [
					E('label', { 'style': 'font-weight: bold;' }, _('批量操作动作:')),
					batchActionSelect
				]),
				E('button', {
					'class': 'btn cbi-button cbi-button-apply',
					'style': 'padding: 6px 18px; font-weight: bold;',
					'click': function() {
						let text = batchTextarea.value.trim();
						if (!text) {
							ui.addNotification(null, E('p', {}, _('请先在文本框中粘贴域名或 IP 列表！')), 'warning');
							return;
						}
						let lines = text.split('\n');
						let addedCount = 0;
						let act = batchActionSelect.value;
						let timeNow = getNowStr();
						let newItems = [];

						lines.forEach(function(line) {
							line = line.trim();
							if (!line || line.startsWith('#') || line.startsWith('//')) return;
							let comment = '';
							if (line.indexOf('#') !== -1) {
								let parts = line.split('#');
								line = parts[0].trim();
								comment = parts.slice(1).join('#').trim();
							}
							line = line.replace(/^https?:\/\//i, '').split('/')[0].trim();
							if (!line) return;

							// 判定是 IP 还是域名
							let isIP = /^([0-9]{1,3}\.){3}[0-9]{1,3}(\/[0-9]{1,2})?$/.test(line) || line.indexOf(':') !== -1;
							let rtype = isIP ? 'ip' : 'domain';

							let exists = currentRules.concat(newItems).some(function(r) {
								return r.value.toLowerCase() === line.toLowerCase();
							});
							if (!exists) {
								newItems.push({
									id: 'c_' + Date.now() + '_' + Math.floor(Math.random() * 10000) + '_' + addedCount,
									type: rtype,
									value: line,
									action: act,
									direction: 'both',
									comment: comment,
									enabled: true,
									time: timeNow
								});
								addedCount++;
							}
						});

						if (addedCount === 0) {
							ui.addNotification(null, E('p', {}, _('未解析到新的有效目标，或已全部存在！')), 'warning');
							return;
						}

						batchTextarea.value = '';
						let newRules = newItems.concat(currentRules);
						saveAndApply(newRules, _('批量导入成功！已生效新增 %d 条自定义规则。').format(addedCount));
					}
				}, _('📥 批量导入并立即生效'))
			])
		]);

		// 搜索与过滤组件
		let searchInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'placeholder': _('🔍 实时搜索域名、IP、备注、动作、方向...'),
			'style': 'width: 320px; font-size: 13px;'
		});

		let statsBadge = E('span', {
			'style': 'margin-left: 10px; font-size: 12px; color: #555; background: #eef2ff; padding: 4px 10px; border-radius: 12px; border: 1px solid #c7d2fe;'
		}, _('统计加载中...'));

		let tableBody = E('tbody');

		function updateStats() {
			let total = currentRules.length;
			let domains = currentRules.filter(function(r) { return r.type === 'domain'; }).length;
			let ips = currentRules.filter(function(r) { return r.type === 'ip'; }).length;
			let blocks = currentRules.filter(function(r) { return r.action === 'block' || r.action === 'drop'; }).length;
			let allows = currentRules.filter(function(r) { return r.action === 'allow'; }).length;
			statsBadge.textContent = _('已生效总计: %d 条 | 域名: %d | IP/网段: %d | 阻断: %d | 白名单: %d').format(total, domains, ips, blocks, allows);
		}

		function renderTable() {
			tableBody.innerHTML = '';
			let kw = searchKeyword.toLowerCase();

			let filtered = currentRules.filter(function(r) {
				if (activeFilterMode === 'domain' && r.type !== 'domain') return false;
				if (activeFilterMode === 'ip' && r.type !== 'ip') return false;
				if (activeFilterMode === 'block' && r.action !== 'block' && r.action !== 'drop') return false;
				if (activeFilterMode === 'allow' && r.action !== 'allow') return false;

				if (kw) {
					let matchVal = r.value && r.value.toLowerCase().indexOf(kw) !== -1;
					let matchComment = r.comment && r.comment.toLowerCase().indexOf(kw) !== -1;
					let matchAction = r.action && r.action.toLowerCase().indexOf(kw) !== -1;
					let matchType = r.type && r.type.toLowerCase().indexOf(kw) !== -1;
					let matchDir = r.direction && r.direction.toLowerCase().indexOf(kw) !== -1;
					return matchVal || matchComment || matchAction || matchType || matchDir;
				}
				return true;
			});

			if (filtered.length === 0) {
				tableBody.appendChild(E('tr', {}, [
					E('td', { 'colspan': '8', 'style': 'text-align: center; color: #888; padding: 30px;' },
						kw ? _('未找到匹配搜索条件的规则') : _('当前暂无自定义拦截规则，可在上方添加'))
				]));
				return;
			}

			filtered.forEach(function(r, idx) {
				let typeBadge = (r.type === 'domain') ?
					E('span', { 'style': 'background: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 11px;' }, '🌐 域名') :
					E('span', { 'style': 'background: #fef3c7; color: #b45309; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 11px;' }, '🖥️ IP网段');

				let actionBadge = (r.action === 'allow') ?
					E('span', { 'style': 'background: #dcfce7; color: #15803d; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 11px;' }, '⚡ 白名单放行') :
					E('span', { 'style': 'background: #fee2e2; color: #b91c1c; padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 11px;' }, '🛑 阻断拦截');

				let dirText = _('双向接管');
				if (r.direction === 'outbound') dirText = _('仅出站 (外访)');
				if (r.direction === 'inbound') dirText = _('仅入站 (打入)');

				let chkBox = E('input', {
					'type': 'checkbox',
					'class': 'cbi-input-checkbox rule-select-item',
					'data-id': r.id
				});

				let removeBtn = E('button', {
					'class': 'btn cbi-button cbi-button-reset',
					'style': 'padding: 2px 10px; font-size: 12px;',
					'click': function() {
						if (!confirm(_('确定从拦截清单中移除此规则吗？\n目标: ') + r.value)) return;
						let remain = currentRules.filter(function(item) {
							return item.id !== r.id;
						});
						saveAndApply(remain, _('已移除规则并立即解除拦截: ') + r.value);
					}
				}, _('🗑️ 移除'));

				tableBody.appendChild(E('tr', { 'class': 'cbi-rowstyle-' + ((idx % 2) + 1) }, [
					E('td', { 'style': 'text-align: center; width: 35px;' }, [ chkBox ]),
					E('td', { 'style': 'text-align: center; width: 50px; color: #888;' }, (idx + 1)),
					E('td', { 'style': 'width: 90px;' }, [ typeBadge ]),
					E('td', { 'style': 'font-family: monospace; font-weight: bold; font-size: 13px;' }, r.value),
					E('td', { 'style': 'width: 120px;' }, [ actionBadge ]),
					E('td', { 'style': 'width: 120px; font-size: 12px;' }, dirText),
					E('td', { 'style': 'color: #555; font-size: 12px;' }, r.comment || '-'),
					E('td', { 'style': 'text-align: right; width: 80px;' }, [ removeBtn ])
				]));
			});
		}

		searchInput.addEventListener('input', function() {
			searchKeyword = this.value.trim();
			renderTable();
		});

		function createTabBtn(label, mode, active) {
			return E('button', {
				'class': 'btn cbi-button ' + (active ? 'cbi-button-action' : 'cbi-button-neutral'),
				'style': 'margin-right: 6px; padding: 3px 10px; font-size: 12px;',
				'click': function() {
					activeFilterMode = mode;
					let p = this.parentNode;
					for (let i = 0; i < p.children.length; i++) {
						p.children[i].className = 'btn cbi-button cbi-button-neutral';
					}
					this.className = 'btn cbi-button cbi-button-action';
					renderTable();
				}
			}, label);
		}

		let filterBtnGroup = E('div', { 'style': 'display: flex; gap: 5px; align-items: center;' }, [
			createTabBtn(_('全部'), 'all', true),
			createTabBtn(_('🌐 仅看域名'), 'domain', false),
			createTabBtn(_('🖥️ 仅看 IP'), 'ip', false),
			createTabBtn(_('🛑 仅看阻断'), 'block', false),
			createTabBtn(_('⚡ 仅看白名单'), 'allow', false)
		]);

		let selectAllChk = E('input', {
			'type': 'checkbox',
			'class': 'cbi-input-checkbox',
			'title': _('全选 / 全不选'),
			'change': function() {
				let checked = this.checked;
				document.querySelectorAll('.rule-select-item').forEach(function(c) {
					c.checked = checked;
				});
			}
		});

		// 批量删除选定项
		let batchRemoveBtn = E('button', {
			'class': 'btn cbi-button cbi-button-reset',
			'style': 'padding: 4px 14px; font-size: 12px; margin-right: 8px;',
			'click': function() {
				let selectedIds = [];
				document.querySelectorAll('.rule-select-item:checked').forEach(function(c) {
					let id = c.getAttribute('data-id');
					if (id) selectedIds.push(id);
				});
				if (selectedIds.length === 0) {
					ui.addNotification(null, E('p', {}, _('请先在下方表格中勾选要批量移除的规则！')), 'warning');
					return;
				}
				if (!confirm(_('确定批量移除已选中的 %d 条规则吗？移除后将即时解除拦截。').format(selectedIds.length))) return;

				let remain = currentRules.filter(function(r) {
					return selectedIds.indexOf(r.id) === -1;
				});
				saveAndApply(remain, _('已批量移除 %d 条规则并热重载生效！').format(selectedIds.length));
			}
		}, _('🗑️ 批量移除已选'));

		// 清空全部
		let clearAllBtn = E('button', {
			'class': 'btn cbi-button cbi-button-reset',
			'style': 'padding: 4px 14px; font-size: 12px;',
			'click': function() {
				if (currentRules.length === 0) return;
				if (!confirm(_('⚠️ 高危操作：确定清空全部自定义域名与 IP 拦截规则吗？'))) return;
				saveAndApply([], _('已清空全部自定义规则并热重载生效！'));
			}
		}, _('⚠️ 清空全部'));

		// 刷新按钮
		let refreshBtn = E('button', {
			'class': 'btn cbi-button cbi-button-neutral',
			'style': 'padding: 4px 14px; font-size: 12px; margin-right: 8px;',
			'click': function() {
				return fs.read_direct(CUSTOM_JSON_PATH).then(function(res) {
					try {
						currentRules = JSON.parse(res);
					} catch(e) { currentRules = []; }
					renderTable();
					updateStats();
					ui.addNotification(null, E('p', {}, _('已刷新规则清单！')), 'info');
				});
			}
		}, _('🔄 刷新清单'));

		// 切换单条/批量添加卡片标签
		let singleTabBtn = E('button', {
			'class': 'btn cbi-button cbi-button-action',
			'style': 'margin-right: 8px; padding: 4px 14px; font-size: 12px; font-weight: bold;',
			'click': function() {
				addMode = 'single';
				this.className = 'btn cbi-button cbi-button-action';
				batchTabBtn.className = 'btn cbi-button cbi-button-neutral';
				singleFormContainer.style.display = 'flex';
				batchFormContainer.style.display = 'none';
			}
		}, _('🎯 单条快速添加'));

		let batchTabBtn = E('button', {
			'class': 'btn cbi-button cbi-button-neutral',
			'style': 'padding: 4px 14px; font-size: 12px;',
			'click': function() {
				addMode = 'batch';
				this.className = 'btn cbi-button cbi-button-action';
				singleTabBtn.className = 'btn cbi-button cbi-button-neutral';
				singleFormContainer.style.display = 'none';
				batchFormContainer.style.display = 'block';
			}
		}, _('📑 批量文本导入'));

		// 页面初始化渲染
		renderTable();
		updateStats();

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('OpenGFW 自定义域名与 IP 拦截')),
			E('div', { 'class': 'cbi-map-descr' }, _('在此手动添加自定义域名（支持泛域名子域）、单机 IP 或 CIDR 网段黑名单与白名单。支持实时搜索检索、多选批量移除，添加或移除后系统自动编译并平滑热重载生效！')),

			// 添加卡片
			E('div', { 'class': 'cbi-section', 'style': 'background: #fafafa; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 20px;' }, [
				E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e5e7eb; padding-bottom: 10px; margin-bottom: 10px;' }, [
					E('div', { 'style': 'font-weight: bold; font-size: 14px; color: #111;' }, _('➕ 手动添加拦截 / 白名单规则:')),
					E('div', {}, [ singleTabBtn, batchTabBtn ])
				]),
				singleFormContainer,
				batchFormContainer
			]),

			// 清单与搜索卡片
			E('div', { 'class': 'cbi-section', 'style': 'background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px;' }, [
				E('div', { 'style': 'display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 15px;' }, [
					E('div', { 'style': 'display: flex; flex-wrap: wrap; align-items: center; gap: 10px;' }, [
						searchInput,
						filterBtnGroup,
						statsBadge
					]),
					E('div', { 'style': 'display: flex; align-items: center;' }, [
						refreshBtn,
						batchRemoveBtn,
						clearAllBtn
					])
				]),

				// 表格
				E('table', { 'class': 'table cbi-section-table', 'style': 'width: 100%; border-collapse: collapse;' }, [
					E('thead', {}, [
						E('tr', { 'class': 'cbi-section-table-titles' }, [
							E('th', { 'class': 'cbi-section-table-cell', 'style': 'text-align: center; width: 35px;' }, [ selectAllChk ]),
							E('th', { 'class': 'cbi-section-table-cell', 'style': 'text-align: center; width: 50px;' }, _('序号')),
							E('th', { 'class': 'cbi-section-table-cell', 'style': 'width: 90px;' }, _('类型')),
							E('th', { 'class': 'cbi-section-table-cell' }, _('目标内容 (域名 / IP)')),
							E('th', { 'class': 'cbi-section-table-cell', 'style': 'width: 120px;' }, _('处置动作')),
							E('th', { 'class': 'cbi-section-table-cell', 'style': 'width: 120px;' }, _('拦截方向')),
							E('th', { 'class': 'cbi-section-table-cell' }, _('备注说明')),
							E('th', { 'class': 'cbi-section-table-cell', 'style': 'text-align: right; width: 80px;' }, _('操作'))
						])
					]),
					tableBody
				]),

				E('div', { 'style': 'margin-top: 15px; color: #888; font-size: 12px; display: flex; justify-content: space-between;' }, [
					E('span', {}, _('💡 提示: 添加的域名会自动覆盖根域及其全部子域名；规则置于引擎最优先判定链路，点击移除即刻解除拦截。')),
					E('span', {}, _('支持快捷搜索过滤，数据实时同步保存在 /etc/opengfw/custom_rules.json'))
				])
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
