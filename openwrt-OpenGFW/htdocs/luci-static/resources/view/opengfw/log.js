'use strict';
'require dom';
'require fs';
'require poll';
'require ui';
'require view';

const LOG_FILE = '/var/log/opengfw.log';


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
		let currentFilterMode = 'all';

		let logTextarea = E('pre', {
			'id': 'opengfw_log_content',
			'style': 'width: 100%; min-height: 480px; max-height: 650px; overflow-y: auto; font-family: monospace, Consolas, "Courier New"; font-size: 12px; line-height: 1.4; padding: 12px; background: #181818; color: #00ff66; border-radius: 4px; border: 1px solid #333; white-space: pre-wrap; word-break: break-all;'
		}, [ _('正在获取实时日志...') ]);

		let filterInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'placeholder': _('输入关键词过滤筛选 (例如: 拦截, 阻断, 域名, 广告, sni, IP)...'),
			'style': 'width: 280px; margin-right: 10px;'
		});

		let clearBtn = E('button', {
			'class': 'btn cbi-button cbi-button-reset',
			'click': function() {
				if (!confirm(_('确定清空 OpenGFW 运行日志吗？'))) return;
				return fs.write(LOG_FILE, '').then(function() {
					logTextarea.textContent = _('日志已清空。');
					ui.showModal(_('提示'), [ E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('日志已清空！')), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('确定')) ]) ]);
				});
			}
		}, _('🗑️ 清空日志'));

		let rawLogs = '';

		let updateDisplay = function() {
			let filter = filterInput.value.trim().toLowerCase();
			if (!rawLogs) {
				logTextarea.textContent = _('暂无日志数据。');
				return;
			}
			let lines = rawLogs.trim().split('\n');

			// 分类快捷标签过滤
			if (currentFilterMode === 'ad') {
				lines = lines.filter(function(line) {
					return /(block ads|adblock|广告|ads|sinkhole)/i.test(line);
				});
			} else if (currentFilterMode === 'geo') {
				lines = lines.filter(function(line) {
					return /(地区|geoip|custom_ip|自定义|ip阻断|ip黑名单|block.*ip)/i.test(line);
				});
			} else if (currentFilterMode === 'blocked') {
				lines = lines.filter(function(line) {
					return /(action":\s*"block"|action":\s*"drop"|action":\s*"reject"|block|drop|reject|阻断|拦截)/i.test(line);
				});
			} else if (currentFilterMode === 'sni') {
				lines = lines.filter(function(line) {
					return /(observe|sni|host|dns)/i.test(line);
				});
			} else if (currentFilterMode === 'system') {
				lines = lines.filter(function(line) {
					return /(engine|worker|started|ruleset|loaded|init)/i.test(line);
				});
			}

			// 搜索框过滤
			if (filter) {
				lines = lines.filter(function(line) {
					return line.toLowerCase().indexOf(filter) !== -1;
				});
			}

			// Show last 300 lines, reversed so newest on top
			lines = lines.slice(-300).reverse();
			logTextarea.textContent = lines.join('\n') || _('未匹配到包含该过滤条件的日志。');
		};

		filterInput.addEventListener('input', updateDisplay);

		function createFilterBtn(text, mode, active) {
			let b = E('button', {
				'class': 'btn cbi-button ' + (active ? 'cbi-button-action' : 'cbi-button-neutral'),
				'style': 'margin-right: 6px; padding: 4px 12px;',
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

		let filterBtnGroup = E('div', { 'style': 'display: flex; flex-wrap: wrap; gap: 6px;' }, [
			createFilterBtn(_('📋 全部日志'), 'all', true),
			createFilterBtn(_('🛑 所有阻断拦截'), 'blocked', false),
			createFilterBtn(_('🛡️ 广告拦截'), 'ad', false),
			createFilterBtn(_('🌐 地区/IP阻断'), 'geo', false),
			createFilterBtn(_('👁️ 访问域名审计'), 'sni', false),
			createFilterBtn(_('⚙️ 系统核心'), 'system', false)
		]);

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
				logTextarea.textContent = _('无法获取日志或暂无流量记录。');
			});
		});

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('OpenGFW 实时流量与拦截日志')),
			E('div', { 'class': 'cbi-map-descr' }, _('实时监控 OpenGFW 深度包检测、规则命中与拦截记录。支持快捷分类查看广告拦截与地区阻断日志。')),

			E('div', { 'class': 'cbi-section', 'style': 'margin-bottom: 12px; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px;' }, [
				E('div', { 'style': 'display: flex; flex-wrap: wrap; align-items: center; gap: 10px;' }, [
					filterBtnGroup,
					E('div', { 'style': 'display: flex; align-items: center;' }, [
						E('label', { 'style': 'margin-right: 6px; font-weight: bold;' }, _('搜索:')),
						filterInput
					])
				]),
				E('div', {}, [
					clearBtn
				])
			]),

			E('div', { 'class': 'cbi-section' }, [
				logTextarea
			]),

			E('div', { 'class': 'cbi-section', 'style': 'text-align: right; color: #888; font-size: 12px; margin-top: 5px;' }, [
				_('页面每隔 3 秒自动轮询刷新，展示最近 300 条日志（最新在最前）。')
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
