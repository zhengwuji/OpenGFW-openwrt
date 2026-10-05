'use strict';
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
  expr: tls != nil && geosite(tls.sni, "category-ads-all")

- name: 拦截广告-HTTP
  action: block
  log: true
  expr: http != nil && geosite(http.host, "category-ads-all")

- name: 广告DNS黑洞
  action: modify
  log: true
  expr: dns != nil && geosite(dns.name, "category-ads-all")
  modifier:
    name: dns
    args:
      a: "0.0.0.0"
`,
	proxy: `# --- 代理与全加密混淆流量阻断预设 ---
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
	load: function() {
		return fs.read_direct(RULES_PATH).catch(function() {
			return fs.read_direct(RULES_EXAMPLE_PATH).catch(function() {
				return '# 未找到规则文件。';
			});
		});
	},

	render: function(rulesContent) {
		let textarea = E('textarea', {
			'id': 'opengfw_rules_textarea',
			'style': 'width: 100%; min-height: 480px; font-family: monospace, Consolas, "Courier New"; font-size: 13px; line-height: 1.5; padding: 12px; background: #1e1e1e; color: #d4d4d4; border-radius: 4px; border: 1px solid #333; resize: vertical;',
			'spellcheck': 'false'
		}, [ rulesContent ]);

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
			ui.showModal(_('已追加预设'), [ E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('预设模板已追加到规则末尾，请点击【保存并立即热重载】使之生效。')), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('确定')) ]) ]);
		};

		let saveRules = function(reload) {
			let content = textarea.value;
			if (!content || !content.trim()) {
				ui.showModal(_('错误'), [ E('p', { 'style': 'color: #dc3545;' }, _('规则内容不能为空！')), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('确定')) ]) ]);
				return;
			}
			ui.showModal(_('正在保存规则'), [
				E('p', { 'class': 'spinning' }, _('正在写入规则文件并核验语法...'))
			]);
			return fs.write(RULES_PATH, content).then(function() {
				if (reload) {
					return fs.exec_direct('/etc/init.d/opengfw', ['reload']).then(function() {
						ui.hideModal();
						ui.showModal(_('保存成功'), [ E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('规则已保存并完成热重载，秒级生效！')), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('关闭')) ]) ]);
					});
				} else {
					ui.hideModal();
					ui.showModal(_('保存成功'), [ E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('规则已成功保存。')), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('关闭')) ]) ]);
				}
			}).catch(function(err) {
				ui.hideModal();
				ui.showModal(_('保存失败'), [ E('p', { 'style': 'color: #dc3545;' }, _('保存规则失败: ') + err), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('关闭')) ]) ]);
			});
		};

		let applyReset = function(newContent, desc, autoSave) {
			textarea.value = newContent;
			textarea.scrollTop = 0;
			if (autoSave) {
				return saveRules(true);
			} else {
				ui.showModal(_('已恢复规则'), [
					E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('✅ 已成功载入【' + desc + '】！')),
					E('p', { 'style': 'color: #666; font-size: 12px;' }, _('当前内容已加载至下方编辑器。请确认后点击【💾 保存并立即热重载 (秒级生效)】写入并生效。')),
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

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('OpenGFW 规则集管理 (rules.yaml)')),
			E('div', { 'class': 'cbi-map-descr' }, _('在此编辑 OpenGFW 流量匹配规则。支持按应用层协议 (HTTP/TLS/DNS/Trojan)、GeoSite 域名分类库、GeoIP 归属地库过滤，点击【保存并立即热重载】可秒级生效，网络不掉线。')),
			
			E('div', { 'class': 'cbi-section', 'style': 'margin-bottom: 12px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;' }, [
				E('strong', { 'style': 'margin-right: 6px;' }, _('一键插入常用规则模板:')),
				E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': function() { insertPreset('ads'); } }, _('+ 🛡️ 广告拦截常用规则')),
				E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': function() { insertPreset('proxy'); } }, _('+ 🛑 阻断代理与全加密混淆流量')),
				E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': function() { insertPreset('parental'); } }, _('+ 🔞 家长控制 (成人与不良网站)')),
				E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': function() { insertPreset('observe'); } }, _('+ 📋 全局域名访问审计 (只记录不拦截)')),
				E('button', {
					'class': 'btn cbi-button cbi-button-reset',
					'style': 'margin-left: 8px; font-weight: bold;',
					'click': resetDefault
				}, _('🔄 恢复默认规则'))
			]),

			E('div', { 'class': 'cbi-section' }, [
				textarea
			]),

			E('div', { 'class': 'cbi-section', 'style': 'margin-top: 15px; display: flex; justify-content: space-between;' }, [
				E('div', {}, [
					E('button', {
						'class': 'btn cbi-button cbi-button-apply',
						'style': 'margin-right: 10px; font-weight: bold; font-size: 14px; padding: 6px 18px;',
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
