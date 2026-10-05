'use strict';
'require fs';
'require ui';
'require view';

const RULES_PATH = '/etc/opengfw/rules.yaml';
const RULES_EXAMPLE_PATH = '/etc/opengfw/rules.yaml.example';

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

		let resetDefault = function() {
			if (!confirm(_('确定要恢复到默认初始规则模板吗？当前修改将会被覆盖。'))) return;
			return fs.read_direct(RULES_EXAMPLE_PATH).then(function(defaultContent) {
				textarea.value = defaultContent;
				ui.showModal(_('已重置'), [ E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('已重置为默认规则模板，请点击保存。')), E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [ E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('确定')) ]) ]);
			});
		};

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('OpenGFW 规则集管理 (rules.yaml)')),
			E('div', { 'class': 'cbi-map-descr' }, _('在此编辑 OpenGFW 流量匹配规则。支持按应用层协议 (HTTP/TLS/DNS/Trojan)、GeoSite 域名分类库、GeoIP 归属地库过滤，点击【保存并立即热重载】可秒级生效，网络不掉线。')),
			
			E('div', { 'class': 'cbi-section', 'style': 'margin-bottom: 12px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;' }, [
				E('strong', { 'style': 'margin-right: 6px;' }, _('一键插入常用规则模板:')),
				E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': function() { insertPreset('ads'); } }, _('+ 🛡️ 广告拦截常用规则')),
				E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': function() { insertPreset('proxy'); } }, _('+ 🛑 阻断代理与全加密混淆流量')),
				E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': function() { insertPreset('parental'); } }, _('+ 🔞 家长控制 (成人与不良网站)')),
				E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': function() { insertPreset('observe'); } }, _('+ 📋 全局域名访问审计 (只记录不拦截)'))
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
					}, _('🔄 恢复默认初始规则'))
				])
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
