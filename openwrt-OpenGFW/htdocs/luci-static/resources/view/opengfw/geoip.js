'use strict';
'require dom';
'require form';
'require fs';
'require poll';
'require uci';
'require ui';
'require view';

// 全球所有国家与地区完整清单 (涵盖全球全部 246 个主权国家、海外属地与岛屿，ISO 3166-1 alpha-2)
const ALL_COUNTRIES = [
	{ code: 'cn', name: '中国大陆 (CN)', flag: '🇨🇳' },
	{ code: 'hk', name: '中国香港 (HK)', flag: '🇭🇰' },
	{ code: 'mo', name: '中国澳门 (MO)', flag: '🇲🇴' },
	{ code: 'tw', name: '中国台湾 (TW)', flag: '🇹🇼' },
	{ code: 'us', name: '美国 (US)', flag: '🇺🇸' },
	{ code: 'jp', name: '日本 (JP)', flag: '🇯🇵' },
	{ code: 'kr', name: '韩国 (KR)', flag: '🇰🇷' },
	{ code: 'ru', name: '俄罗斯 (RU)', flag: '🇷🇺' },
	{ code: 'sg', name: '新加坡 (SG)', flag: '🇸🇬' },
	{ code: 'my', name: '马来西亚 (MY)', flag: '🇲🇾' },
	{ code: 'th', name: '泰国 (TH)', flag: '🇹🇭' },
	{ code: 'vn', name: '越南 (VN)', flag: '🇻🇳' },
	{ code: 'ph', name: '菲律宾 (PH)', flag: '🇵🇭' },
	{ code: 'id', name: '印度尼西亚 (ID)', flag: '🇮🇩' },
	{ code: 'in', name: '印度 (IN)', flag: '🇮🇳' },
	{ code: 'pk', name: '巴基斯坦 (PK)', flag: '🇵🇰' },
	{ code: 'bd', name: '孟加拉国 (BD)', flag: '🇧🇩' },
	{ code: 'mm', name: '缅甸 (MM)', flag: '🇲🇲' },
	{ code: 'kh', name: '柬埔寨 (KH)', flag: '🇰🇭' },
	{ code: 'la', name: '老挝 (LA)', flag: '🇱🇦' },
	{ code: 'np', name: '尼泊尔 (NP)', flag: '🇳🇵' },
	{ code: 'lk', name: '斯里兰卡 (LK)', flag: '🇱🇰' },
	{ code: 'mn', name: '蒙古 (MN)', flag: '🇲🇳' },
	{ code: 'kp', name: '朝鲜 (KP)', flag: '🇰🇵' },
	{ code: 'kz', name: '哈萨克斯坦 (KZ)', flag: '🇰🇿' },
	{ code: 'uz', name: '乌兹别克斯坦 (UZ)', flag: '🇺🇿' },
	{ code: 'kg', name: '吉尔吉斯斯坦 (KG)', flag: '🇰🇬' },
	{ code: 'tj', name: '塔吉克斯坦 (TJ)', flag: '🇹🇯' },
	{ code: 'tm', name: '土库曼斯坦 (TM)', flag: '🇹🇲' },
	{ code: 'af', name: '阿富汗 (AF)', flag: '🇦🇫' },
	{ code: 'ae', name: '阿联酋 (AE)', flag: '🇦🇪' },
	{ code: 'sa', name: '沙特阿拉伯 (SA)', flag: '🇸🇦' },
	{ code: 'ir', name: '伊朗 (IR)', flag: '🇮🇷' },
	{ code: 'iq', name: '伊拉克 (IQ)', flag: '🇮🇶' },
	{ code: 'il', name: '以色列 (IL)', flag: '🇮🇱' },
	{ code: 'tr', name: '土耳其 (TR)', flag: '🇹🇷' },
	{ code: 'qa', name: '卡塔尔 (QA)', flag: '🇶🇦' },
	{ code: 'kw', name: '科威特 (KW)', flag: '🇰🇼' },
	{ code: 'om', name: '阿曼 (OM)', flag: '🇴🇲' },
	{ code: 'bh', name: '巴林 (BH)', flag: '🇧🇭' },
	{ code: 'jo', name: '约旦 (JO)', flag: '🇯🇴' },
	{ code: 'lb', name: '黎巴嫩 (LB)', flag: '🇱🇧' },
	{ code: 'sy', name: '叙利亚 (SY)', flag: '🇸🇾' },
	{ code: 'ye', name: '也门 (YE)', flag: '🇾🇪' },
	{ code: 'ge', name: '格鲁吉亚 (GE)', flag: '🇬🇪' },
	{ code: 'am', name: '亚美尼亚 (AM)', flag: '🇦🇲' },
	{ code: 'az', name: '阿塞拜疆 (AZ)', flag: '🇦🇿' },
	{ code: 'ps', name: '巴勒斯坦 (PS)', flag: '🇵🇸' },
	{ code: 'bn', name: '文莱 (BN)', flag: '🇧🇳' },
	{ code: 'bt', name: '不丹 (BT)', flag: '🇧🇹' },
	{ code: 'mv', name: '马尔代夫 (MV)', flag: '🇲🇻' },
	{ code: 'tl', name: '东帝汶 (TL)', flag: '🇹🇱' },
	{ code: 'gb', name: '英国 (GB)', flag: '🇬🇧' },
	{ code: 'de', name: '德国 (DE)', flag: '🇩🇪' },
	{ code: 'fr', name: '法国 (FR)', flag: '🇫🇷' },
	{ code: 'nl', name: '荷兰 (NL)', flag: '🇳🇱' },
	{ code: 'it', name: '意大利 (IT)', flag: '🇮🇹' },
	{ code: 'es', name: '西班牙 (ES)', flag: '🇪🇸' },
	{ code: 'ua', name: '乌克兰 (UA)', flag: '🇺🇦' },
	{ code: 'pl', name: '波兰 (PL)', flag: '🇵🇱' },
	{ code: 'se', name: '瑞典 (SE)', flag: '🇸🇪' },
	{ code: 'ch', name: '瑞士 (CH)', flag: '🇨🇭' },
	{ code: 'no', name: '挪威 (NO)', flag: '🇳🇴' },
	{ code: 'fi', name: '芬兰 (FI)', flag: '🇫🇮' },
	{ code: 'dk', name: '丹麦 (DK)', flag: '🇩🇰' },
	{ code: 'ie', name: '爱尔兰 (IE)', flag: '🇮🇪' },
	{ code: 'be', name: '比利时 (BE)', flag: '🇧🇪' },
	{ code: 'at', name: '奥地利 (AT)', flag: '🇦🇹' },
	{ code: 'pt', name: '葡萄牙 (PT)', flag: '🇵🇹' },
	{ code: 'gr', name: '希腊 (GR)', flag: '🇬🇷' },
	{ code: 'cz', name: '捷克 (CZ)', flag: '🇨🇿' },
	{ code: 'ro', name: '罗马尼亚 (RO)', flag: '🇷🇴' },
	{ code: 'hu', name: '匈牙利 (HU)', flag: '🇭🇺' },
	{ code: 'by', name: '白俄罗斯 (BY)', flag: '🇧🇾' },
	{ code: 'bg', name: '保加利亚 (BG)', flag: '🇧🇬' },
	{ code: 'rs', name: '塞尔维亚 (RS)', flag: '🇷🇸' },
	{ code: 'hr', name: '克罗地亚 (HR)', flag: '🇭🇷' },
	{ code: 'sk', name: '斯洛伐克 (SK)', flag: '🇸🇰' },
	{ code: 'si', name: '斯洛文尼亚 (SI)', flag: '🇸🇮' },
	{ code: 'lt', name: '立陶宛 (LT)', flag: '🇱🇹' },
	{ code: 'lv', name: '拉脱维亚 (LV)', flag: '🇱🇻' },
	{ code: 'ee', name: '爱沙尼亚 (EE)', flag: '🇪🇪' },
	{ code: 'is', name: '冰岛 (IS)', flag: '🇮🇸' },
	{ code: 'lu', name: '卢森堡 (LU)', flag: '🇱🇺' },
	{ code: 'al', name: '阿尔巴尼亚 (AL)', flag: '🇦🇱' },
	{ code: 'ba', name: '波黑 (BA)', flag: '🇧🇦' },
	{ code: 'md', name: '摩尔多瓦 (MD)', flag: '🇲🇩' },
	{ code: 'mk', name: '北马其顿 (MK)', flag: '🇲🇰' },
	{ code: 'me', name: '黑山 (ME)', flag: '🇲🇪' },
	{ code: 'mt', name: '马耳他 (MT)', flag: '🇲🇹' },
	{ code: 'cy', name: '塞浦路斯 (CY)', flag: '🇨🇾' },
	{ code: 'ad', name: '安道尔 (AD)', flag: '🇦🇩' },
	{ code: 'mc', name: '摩纳哥 (MC)', flag: '🇲🇨' },
	{ code: 'li', name: '列支敦士登 (LI)', flag: '🇱🇮' },
	{ code: 'sm', name: '圣马力诺 (SM)', flag: '🇸🇲' },
	{ code: 'va', name: '梵蒂冈 (VA)', flag: '🇻🇦' },
	{ code: 'gi', name: '直布罗陀 (GI)', flag: '🇬🇮' },
	{ code: 'fo', name: '法罗群岛 (FO)', flag: '🇫🇴' },
	{ code: 'im', name: '马恩岛 (IM)', flag: '🇮🇲' },
	{ code: 'je', name: '泽西岛 (JE)', flag: '🇯🇪' },
	{ code: 'gg', name: '根西岛 (GG)', flag: '🇬🇬' },
	{ code: 'ax', name: '奥兰群岛 (AX)', flag: '🇦🇽' },
	{ code: 'sj', name: '斯瓦尔巴和扬马延 (SJ)', flag: '🇸🇯' },
	{ code: 'ca', name: '加拿大 (CA)', flag: '🇨🇦' },
	{ code: 'mx', name: '墨西哥 (MX)', flag: '🇲🇽' },
	{ code: 'br', name: '巴西 (BR)', flag: '🇧🇷' },
	{ code: 'ar', name: '阿根廷 (AR)', flag: '🇦🇷' },
	{ code: 'cl', name: '智利 (CL)', flag: '🇨🇱' },
	{ code: 'co', name: '哥伦比亚 (CO)', flag: '🇨🇴' },
	{ code: 'pe', name: '秘鲁 (PE)', flag: '🇵🇪' },
	{ code: 've', name: '委内瑞拉 (VE)', flag: '🇻🇪' },
	{ code: 'ec', name: '厄瓜多尔 (EC)', flag: '🇪🇨' },
	{ code: 'uy', name: '乌拉圭 (UY)', flag: '🇺🇾' },
	{ code: 'py', name: '巴拉圭 (PY)', flag: '🇵🇾' },
	{ code: 'bo', name: '玻利维亚 (BO)', flag: '🇧🇴' },
	{ code: 'cu', name: '古巴 (CU)', flag: '🇨🇺' },
	{ code: 'pa', name: '巴拿马 (PA)', flag: '🇵🇦' },
	{ code: 'cr', name: '哥斯达黎加 (CR)', flag: '🇨🇷' },
	{ code: 'do', name: '多米尼加 (DO)', flag: '🇩🇴' },
	{ code: 'gt', name: '危地马拉 (GT)', flag: '🇬🇹' },
	{ code: 'hn', name: '洪都拉斯 (HN)', flag: '🇭🇳' },
	{ code: 'ni', name: '尼加拉瓜 (NI)', flag: '🇳🇮' },
	{ code: 'sv', name: '萨尔瓦多 (SV)', flag: '🇸🇻' },
	{ code: 'jm', name: '牙买加 (JM)', flag: '🇯🇲' },
	{ code: 'ht', name: '海地 (HT)', flag: '🇭🇹' },
	{ code: 'bs', name: '巴哈马 (BS)', flag: '🇧🇸' },
	{ code: 'tt', name: '特立尼达和多巴哥 (TT)', flag: '🇹🇹' },
	{ code: 'bb', name: '巴巴多斯 (BB)', flag: '🇧🇧' },
	{ code: 'gy', name: '圭亚那 (GY)', flag: '🇬🇾' },
	{ code: 'sr', name: '苏里南 (SR)', flag: '🇸🇷' },
	{ code: 'bz', name: '伯利兹 (BZ)', flag: '🇧🇿' },
	{ code: 'gl', name: '格陵兰 (GL)', flag: '🇬🇱' },
	{ code: 'bm', name: '百慕大 (BM)', flag: '🇧🇲' },
	{ code: 'pr', name: '波多黎各 (PR)', flag: '🇵🇷' },
	{ code: 'ky', name: '开曼群岛 (KY)', flag: '🇰🇾' },
	{ code: 'vg', name: '英属维尔京群岛 (VG)', flag: '🇻🇬' },
	{ code: 'vi', name: '美属维尔京群岛 (VI)', flag: '🇻🇮' },
	{ code: 'aw', name: '阿鲁巴 (AW)', flag: '🇦🇼' },
	{ code: 'cw', name: '库拉索 (CW)', flag: '🇨🇼' },
	{ code: 'sx', name: '荷属圣马丁 (SX)', flag: '🇸🇽' },
	{ code: 'bq', name: '荷属加勒比 (BQ)', flag: '🇧🇶' },
	{ code: 'tc', name: '特克斯和凯科斯群岛 (TC)', flag: '🇹🇨' },
	{ code: 'ag', name: '安提瓜和巴布达 (AG)', flag: '🇦🇬' },
	{ code: 'dm', name: '多米尼克 (DM)', flag: '🇩🇲' },
	{ code: 'lc', name: '圣卢西亚 (LC)', flag: '🇱🇨' },
	{ code: 'vc', name: '圣文森特和格林纳丁斯 (VC)', flag: '🇻🇨' },
	{ code: 'gd', name: '格林纳达 (GD)', flag: '🇬🇩' },
	{ code: 'kn', name: '圣基茨和尼维斯 (KN)', flag: '🇰🇳' },
	{ code: 'ai', name: '安圭拉 (AI)', flag: '🇦🇮' },
	{ code: 'ms', name: '蒙特塞拉特 (MS)', flag: '🇲🇸' },
	{ code: 'gp', name: '瓜德罗普 (GP)', flag: '🇬🇵' },
	{ code: 'mq', name: '马提尼克 (MQ)', flag: '🇲🇶' },
	{ code: 'bl', name: '圣巴泰勒米 (BL)', flag: '🇧🇱' },
	{ code: 'mf', name: '法属圣马丁 (MF)', flag: '🇲🇫' },
	{ code: 'gf', name: '法属圭亚那 (GF)', flag: '🇬🇫' },
	{ code: 'pm', name: '圣皮埃尔和密克隆 (PM)', flag: '🇵🇲' },
	{ code: 'fk', name: '福克兰群岛 (FK)', flag: '🇫🇰' },
	{ code: 'au', name: '澳大利亚 (AU)', flag: '🇦🇺' },
	{ code: 'nz', name: '新西兰 (NZ)', flag: '🇳🇿' },
	{ code: 'pg', name: '巴布亚新几内亚 (PG)', flag: '🇵🇬' },
	{ code: 'fj', name: '斐济 (FJ)', flag: '🇫🇯' },
	{ code: 'sb', name: '所罗门群岛 (SB)', flag: '🇸🇧' },
	{ code: 'vu', name: '瓦努阿图 (VU)', flag: '🇻🇺' },
	{ code: 'ws', name: '萨摩亚 (WS)', flag: '🇼🇸' },
	{ code: 'to', name: '汤加 (TO)', flag: '🇹🇴' },
	{ code: 'fm', name: '密克罗尼西亚 (FM)', flag: '🇫🇲' },
	{ code: 'ki', name: '基里巴斯 (KI)', flag: '🇰🇮' },
	{ code: 'mh', name: '马绍尔群岛 (MH)', flag: '🇲🇭' },
	{ code: 'pw', name: '帕劳 (PW)', flag: '🇵🇼' },
	{ code: 'nr', name: '瑙鲁 (NR)', flag: '🇳🇷' },
	{ code: 'tv', name: '图瓦卢 (TV)', flag: '🇹🇻' },
	{ code: 'gu', name: '关岛 (GU)', flag: '🇬🇺' },
	{ code: 'nc', name: '新喀里多尼亚 (NC)', flag: '🇳🇨' },
	{ code: 'pf', name: '法属波利尼西亚 (PF)', flag: '🇵🇫' },
	{ code: 'mp', name: '北马里亚纳群岛 (MP)', flag: '🇲🇵' },
	{ code: 'as', name: '美属萨摩亚 (AS)', flag: '🇦🇸' },
	{ code: 'ck', name: '库克群岛 (CK)', flag: '🇨🇰' },
	{ code: 'nu', name: '纽埃 (NU)', flag: '🇳🇺' },
	{ code: 'tk', name: '托克劳 (TK)', flag: '🇹🇰' },
	{ code: 'wf', name: '瓦利斯和富图纳 (WF)', flag: '🇼🇫' },
	{ code: 'nf', name: '诺福克岛 (NF)', flag: '🇳🇫' },
	{ code: 'za', name: '南非 (ZA)', flag: '🇿🇦' },
	{ code: 'eg', name: '埃及 (EG)', flag: '🇪🇬' },
	{ code: 'ng', name: '尼日利亚 (NG)', flag: '🇳🇬' },
	{ code: 'ke', name: '肯尼亚 (KE)', flag: '🇰🇪' },
	{ code: 'ma', name: '摩洛哥 (MA)', flag: '🇲🇦' },
	{ code: 'et', name: '埃塞俄比亚 (ET)', flag: '🇪🇹' },
	{ code: 'gh', name: '加纳 (GH)', flag: '🇬🇭' },
	{ code: 'dz', name: '阿尔及利亚 (DZ)', flag: '🇩🇿' },
	{ code: 'tn', name: '突尼斯 (TN)', flag: '🇹🇳' },
	{ code: 'ug', name: '乌干达 (UG)', flag: '🇺🇬' },
	{ code: 'tz', name: '坦桑尼亚 (TZ)', flag: '🇹🇿' },
	{ code: 'ao', name: '安哥拉 (AO)', flag: '🇦🇴' },
	{ code: 'ci', name: '科特迪瓦 (CI)', flag: '🇨🇮' },
	{ code: 'cm', name: '喀麦隆 (CM)', flag: '🇨🇲' },
	{ code: 'sn', name: '塞内加尔 (SN)', flag: '🇸🇳' },
	{ code: 'zm', name: '赞比亚 (ZM)', flag: '🇿🇲' },
	{ code: 'zw', name: '津巴布韦 (ZW)', flag: '🇿🇼' },
	{ code: 'sd', name: '苏丹 (SD)', flag: '🇸🇩' },
	{ code: 'ss', name: '南苏丹 (SS)', flag: '🇸🇸' },
	{ code: 'ly', name: '利比亚 (LY)', flag: '🇱🇾' },
	{ code: 'mu', name: '毛里求斯 (MU)', flag: '🇲🇺' },
	{ code: 'mg', name: '马达加斯加 (MG)', flag: '🇲🇬' },
	{ code: 'mz', name: '莫桑比克 (MZ)', flag: '🇲🇿' },
	{ code: 'na', name: '纳米比亚 (NA)', flag: '🇳🇦' },
	{ code: 'bw', name: '博茨瓦纳 (BW)', flag: '🇧🇼' },
	{ code: 'rw', name: '卢旺达 (RW)', flag: '🇷🇼' },
	{ code: 'so', name: '索马里 (SO)', flag: '🇸🇴' },
	{ code: 'cg', name: '刚果共和国 (CG)', flag: '🇨🇬' },
	{ code: 'cd', name: '刚果民主共和国 (CD)', flag: '🇨🇩' },
	{ code: 'ga', name: '加蓬 (GA)', flag: '🇬🇦' },
	{ code: 'gn', name: '几内亚 (GN)', flag: '🇬🇳' },
	{ code: 'gw', name: '几内亚比绍 (GW)', flag: '🇬🇼' },
	{ code: 'gq', name: '赤道几内亚 (GQ)', flag: '🇬🇶' },
	{ code: 'sl', name: '塞拉利昂 (SL)', flag: '🇸🇱' },
	{ code: 'lr', name: '利比里亚 (LR)', flag: '🇱🇷' },
	{ code: 'ml', name: '马里 (ML)', flag: '🇲🇱' },
	{ code: 'bf', name: '布基纳法索 (BF)', flag: '🇧🇫' },
	{ code: 'ne', name: '尼日尔 (NE)', flag: '🇳🇪' },
	{ code: 'td', name: '乍得 (TD)', flag: '🇹🇩' },
	{ code: 'cf', name: '中非共和国 (CF)', flag: '🇨🇫' },
	{ code: 'mr', name: '毛里塔尼亚 (MR)', flag: '🇲🇷' },
	{ code: 'er', name: '厄立特里亚 (ER)', flag: '🇪🇷' },
	{ code: 'dj', name: '吉布提 (DJ)', flag: '🇩🇯' },
	{ code: 'bi', name: '布隆迪 (BI)', flag: '🇧🇮' },
	{ code: 'mw', name: '马拉维 (MW)', flag: '🇲🇼' },
	{ code: 'ls', name: '莱索托 (LS)', flag: '🇱🇸' },
	{ code: 'sz', name: '斯威士兰 (SZ)', flag: '🇸🇿' },
	{ code: 'gm', name: '冈比亚 (GM)', flag: '🇬🇲' },
	{ code: 'tg', name: '多哥 (TG)', flag: '🇹🇬' },
	{ code: 'bj', name: '贝宁 (BJ)', flag: '🇧🇯' },
	{ code: 'cv', name: '佛得角 (CV)', flag: '🇨🇻' },
	{ code: 'st', name: '圣多美和普林西比 (ST)', flag: '🇸🇹' },
	{ code: 'sc', name: '塞舌尔 (SC)', flag: '🇸🇨' },
	{ code: 'km', name: '科摩罗 (KM)', flag: '🇰🇲' },
	{ code: 're', name: '留尼汪 (RE)', flag: '🇷🇪' },
	{ code: 'yt', name: '马约特 (YT)', flag: '🇾🇹' },
	{ code: 'sh', name: '圣赫勒拿 (SH)', flag: '🇸🇭' },
	{ code: 'eh', name: '西撒哈拉 (EH)', flag: '🇪🇭' },
	{ code: 'aq', name: '南极洲 (AQ)', flag: '🇦🇶' },
	{ code: 'bv', name: '布韦岛 (BV)', flag: '🇧🇻' },
	{ code: 'gs', name: '南乔治亚和南桑威奇群岛 (GS)', flag: '🇬🇸' },
	{ code: 'hm', name: '赫德岛和麦克唐纳群岛 (HM)', flag: '🇭🇲' },
	{ code: 'io', name: '英属印度洋领地 (IO)', flag: '🇮🇴' },
	{ code: 'tf', name: '法属南部和南极领地 (TF)', flag: '🇹🇫' },
	{ code: 'um', name: '美国本土外小岛屿 (UM)', flag: '🇺🇲' }
];

// ---------------------------------------------------------------------------
// 「全部国家与地区」伪代码 (ALL)
// geoip.dat 中并不存在名为 "all" 的分类，因此该代码由后端辅助脚本
// /usr/bin/opengfw-geoip-helper 特殊展开为「放行内网/私网 + 拦截其余全部境外 IP」规则，
// 从而在不误伤局域网、SSH 与后台管理的前提下实现「一键封锁全世界」。
// ---------------------------------------------------------------------------
const ALL_SENTINEL = { code: 'all', name: '全部国家与地区 (全球 ALL)', flag: '🌍' };

// 「全部」搜索关键词（中文 / 拼音 / 英文 / 代码），命中后即把 ALL_SENTINEL 置顶
const ALL_KEYWORDS = [
	'all', 'ALL', '全部', '所有', '全部国家', '所有国家', '全世界', '全球',
	'世界', '全球所有', 'quanbu', 'suoyou', 'quanqiu', 'shijie', 'world', 'global', 'every'
];

// 判断输入的关键词是否意图命中「全部国家与地区」
function matchAllKeyword(query) {
	// 去掉所有空白，避免「全 部」这类带空格的输入无法命中
	query = (query || '').replace(/\s+/g, '').toLowerCase();
	if (query.length === 0) return false;
	// 中文关键词 1 个字符即可命中（如「全」）；纯 ASCII 需 >= 3 个字符，
	// 否则 "al"(阿尔巴尼亚 ISO 代码) 会误命中 "all"。
	let hasCJK = /[\u4e00-\u9fa5]/.test(query);
	let minLen = hasCJK ? 1 : 3;
	if (query.length < minLen) return false;
	for (let i = 0; i < ALL_KEYWORDS.length; i++) {
		let k = ALL_KEYWORDS[i].toLowerCase();
		if (k === query) return true;
		// 前缀匹配：输入「全」/「所有」/「qua」/「glo」也能命中
		if (k.indexOf(query) === 0) return true;
	}
	return false;
}

// 把「全部国家」加入动态列表
function addAllCountries(dynlistEl) {
	return addCountryToDynlist(dynlistEl, ALL_SENTINEL, true);
}

// ---------------------------------------------------------------------------
// 修复一：Argon 主题下动态列表的「×」删除按钮点不动
//
// Argon 的 cascade.css 把 .cbi-dynlist > .item 设为 pointer-events: none，
// 只把 ::after（那个红色 × ）设为 auto，本意是让只有红叉可点。
// 但 Chromium 不会把 pointer-events:none 元素的伪元素当作命中测试目标，
// 于是点击红叉时 elementFromPoint 命中的是父级 .cbi-dynlist，
// ui.js 的 handleClick 中 findParent(ev.target, '.item') 匹配失败，
// 表现为「点 × 没有任何反应」。
//
// 把 .item 恢复为 auto 即可（这也是 LuCI 原生 bootstrap 主题的行为）。
// 实测：点击右侧红叉可正常删除；点击左侧标签区不会误删
// （ui.js 依据 rect.right - clientX <= ::after 宽度 判定，左半边距离足够大）。
// ---------------------------------------------------------------------------
(function() {
	try {
		let existing = document.getElementById('opengfw-dynlist-pointer-fix');
		if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
		let st = document.createElement('style');
		st.id = 'opengfw-dynlist-pointer-fix';
		st.textContent = [
			'.cbi-dynlist > .item { pointer-events: auto !important; cursor: default !important; }',
			'.cbi-dynlist > .item::after { pointer-events: auto !important; cursor: pointer !important; transition: filter 0.15s ease, background-color 0.15s ease, transform 0.1s ease !important; }',
			'.cbi-dynlist > .item::after:hover { filter: brightness(1.15) !important; background-color: #e02447 !important; }',
			'.cbi-dynlist > .item::after:active { transform: scale(0.96) !important; }'
		].join('\n');
		(document.head || document.documentElement).appendChild(st);
	} catch (e) {}

	// 全局捕获阶段委托：点击红叉删除区（item 右侧 48px 内）100% 触发删除
	if (!window._opengfw_dynlist_click_bound) {
		window._opengfw_dynlist_click_bound = true;
		document.addEventListener('click', function(ev) {
			let t = ev.target;
			if (!t) return;
			let item = (t.closest && t.closest('.item')) || null;
			if (!item) {
				// 兜底方案：如果点击命中了 .cbi-dynlist 父容器（在部分未恢复 pointer-events 的旧主题或怪异浏览器下）
				let dlCandidate = (t.closest && t.closest('.cbi-dynlist')) || ((t.classList && t.classList.contains('cbi-dynlist')) ? t : null);
				if (dlCandidate) {
					let allItems = dlCandidate.querySelectorAll('.item');
					for (let i = 0; i < allItems.length; i++) {
						let r = allItems[i].getBoundingClientRect();
						if (ev.clientY >= r.top && ev.clientY <= r.bottom &&
						    ev.clientX >= r.left && ev.clientX <= r.right + 2) {
							item = allItems[i];
							break;
						}
					}
				}
			}
			if (!item) return;
			let dl = (item.closest && item.closest('.cbi-dynlist')) || item.parentNode;
			if (!dl || !dl.classList || !dl.classList.contains('cbi-dynlist')) return;

			let rect = item.getBoundingClientRect();
			// 点击在红叉区域（右边缘 48px 内，且在 item 范围内部）
			if ((rect.right - ev.clientX <= 48 || ev.clientX >= rect.right - 48) && ev.clientX >= rect.left) {
				let valInput = item.querySelector('input[type="hidden"]');
				let val = valInput ? valInput.value : '';
				let inst = dom.findClassInstance(dl);
				if (inst && typeof inst.removeItem === 'function') {
					inst.removeItem(dl, item);
				} else {
					if (val) {
						let sb = dl.querySelector('.cbi-dropdown');
						if (sb) {
							sb.querySelectorAll('ul > li').forEach(function(li) {
								if (li.getAttribute('data-value') === val) {
									if (li.hasAttribute('dynlistcustom')) li.remove();
									else li.removeAttribute('unselectable');
								}
							});
						}
					}
					item.remove();
					dl.dispatchEvent(new CustomEvent('cbi-dynlist-change', {
						bubbles: true,
						detail: { instance: inst, element: dl, value: val, add: false }
					}));
				}
				ev.stopPropagation();
				ev.preventDefault();
			}
		}, true);
	}
})();

// ---------------------------------------------------------------------------
// 修复二：保存时 uci.apply() 报 ubus code 5 (UBUS_STATUS_NO_DATA)
//
// 本页自定义保存按钮此前直接调用 uci.save()。但 uci.save() 只负责把
// uci 内部状态中已登记的变更通过 RPC 写出去；而「把 DOM 表单值读回该状态」
// 是 CBI 表单 parse() 的职责。缺了 parse() 这一步，save() 会发出 0 个
// uci/set 请求，紧接着的 uci.apply() 因没有任何待应用变更而返回
// code 5 (NO_DATA)，界面便弹出「应用出错」。
//
// 正确做法与 LuCI 原生 handleSave 完全一致：先调用各 cbi-map 实例的
// save()（其内部实现即 parse() -> data.save()），再执行 uci.apply()。
// ---------------------------------------------------------------------------
function saveAllMaps() {
	let maps = document.querySelectorAll('#maincontent .cbi-map');
	if (!maps.length) maps = document.querySelectorAll('.cbi-map');
	let tasks = [];
	for (let i = 0; i < maps.length; i++) {
		let inst = dom.findClassInstance(maps[i]);
		if (inst && typeof inst.save === 'function') {
			tasks.push(inst.save());
		} else {
			tasks.push(dom.callClassMethod(maps[i], 'save'));
		}
	}
	return Promise.all(tasks);
}

// 判断是否为「没有待应用变更」这一无害情形（ubus code 5 / NO_DATA）
function isNoDataError(err) {
	if (!err) return false;
	if (err === 5 || err.code === 5) return true;
	let s = (err.message != null) ? String(err.message) : String(err);
	return /code 5\b|NO_DATA|No data received|未收到数据|没有数据/i.test(s);
}

// 应用 uci 变更；确实没有变更时静默通过，避免弹出无意义的「应用出错」
function applyUci() {
	return uci.apply().catch(function(err) {
		if (isNoDataError(err)) return null;
		throw err;
	});
}


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

const PINYIN_MAP = {
	'cn': 'zhongguo dalu zg cn',
	'hk': 'xianggang hk xg',
	'mo': 'aomen mo am',
	'tw': 'taiwan tw',
	'us': 'meiguo mg us usa',
	'jp': 'riben rb jp japan',
	'kr': 'hanguo hg kr korea',
	'ru': 'eluosi els ru russia',
	'gb': 'yingguo yg gb uk britain',
	'de': 'deguo dg de germany',
	'fr': 'faguo fg fr france',
	'sg': 'xinjiapo xjp sg singapore',
	'in': 'yindu yd in india',
	'my': 'malaixiya mlxy my malaysia',
	'th': 'taiguo tg th thailand',
	'vn': 'yuenan yn vn vietnam',
	'ph': 'feilvbin flb ph philippines',
	'id': 'yindunixiya ydnxy id indonesia',
	'mm': 'miandian md mm myanmar',
	'kh': 'jianpuzhai jpz kh cambodia',
	'ca': 'jianada jnd ca canada',
	'au': 'aodaliya adly au australia',
	'nl': 'helan hl nl netherlands',
	'it': 'yidali ydl it italy',
	'es': 'xibanya xby es spain',
	'ch': 'ruishi rs ch switzerland',
	'se': 'ruidian rd se sweden',
	'br': 'baxi bx br brazil',
	'kp': 'chaoxian cx kp north korea',
	'ua': 'wukelan wkl ua ukraine',
	'tr': 'tuerqi teq tr turkey',
	'ir': 'yilang yl ir iran',
	'iq': 'yilake ylk iq iraq',
	'ae': 'alianqiu alq ae uae dubai',
	'sa': 'shate saudi sa'
};

const COMMON_PRESETS = [
	{ code: 'all', name: '全部国家与地区 (全球 ALL)', flag: '🌍' },
	{ code: 'cn', name: '中国大陆 (CN)', flag: '🇨🇳' },
	{ code: 'hk', name: '中国香港 (HK)', flag: '🇭🇰' },
	{ code: 'mo', name: '中国澳门 (MO)', flag: '🇲🇴' },
	{ code: 'tw', name: '中国台湾 (TW)', flag: '🇹🇼' },
	{ code: 'us', name: '美国 (US)', flag: '🇺🇸' },
	{ code: 'jp', name: '日本 (JP)', flag: '🇯🇵' },
	{ code: 'kr', name: '韩国 (KR)', flag: '🇰🇷' },
	{ code: 'ru', name: '俄罗斯 (RU)', flag: '🇷🇺' },
	{ code: 'gb', name: '英国 (GB)', flag: '🇬🇧' },
	{ code: 'de', name: '德国 (DE)', flag: '🇩🇪' },
	{ code: 'fr', name: '法国 (FR)', flag: '🇫🇷' },
	{ code: 'sg', name: '新加坡 (SG)', flag: '🇸🇬' },
	{ code: 'in', name: '印度 (IN)', flag: '🇮🇳' },
	{ code: 'vn', name: '越南 (VN)', flag: '🇻🇳' },
	{ code: 'mm', name: '缅甸 (MM)', flag: '🇲🇲' },
	{ code: 'kh', name: '柬埔寨 (KH)', flag: '🇰🇭' },
	{ code: 'ph', name: '菲律宾 (PH)', flag: '🇵🇭' }
];

function isCountrySelected(dynlistEl, code) {
	let items = dynlistEl.querySelectorAll('.item > input[type="hidden"]');
	for (let i = 0; i < items.length; i++) {
		if (items[i].value && items[i].value.toLowerCase() === code.toLowerCase()) {
			return true;
		}
	}
	return false;
}

function addCountryToDynlist(dynlistEl, c, toastMsg) {
	if (c.code === 'all') {
		let modeSelect = document.querySelector('select[name="cbid.opengfw.geoip.mode"]');
		let isBlacklist = !modeSelect || modeSelect.value === 'blacklist';
		if (isBlacklist) {
			ui.addNotification(null, E('p', {}, '⚠️ 【黑名单模式】下不支持添加「全部国家」，否则会阻断全球流量导致断网！如需仅允许特定国家（如中国），请将策略切换为【白名单模式】。'), 'danger');
			return false;
		}
	}
	if (isCountrySelected(dynlistEl, c.code)) {
		if (toastMsg) ui.addNotification(null, E('p', {}, '⚠️ ' + c.flag + ' ' + c.name + ' 已在列表中，无需重复添加'), 'warning');
		return false;
	}
	let inst = dom.findClassInstance(dynlistEl);
	let label = c.flag + ' ' + c.name;
	if (inst && typeof inst.addItem === 'function') {
		inst.addItem(dynlistEl, c.code, label, true);
	} else {
		dom.callClassMethod(dynlistEl, 'addItem', dynlistEl, c.code, label, true);
	}
	if (toastMsg) {
		ui.addNotification(null, E('p', {}, '✅ 已添加: ' + label), 'success');
	}
	return true;
}

function renderCountrySearchHelper(dynlistEl) {
	let searchInput = E('input', {
		'type': 'text',
		'placeholder': '🔍 输入国家中文名、拼音或 ISO 代码实时搜索 (如: 日本、美国、俄罗斯、韩国、jp、us、ru)...',
		'class': 'cbi-input-text',
		'style': 'flex: 1; padding: 7px 12px; font-size: 13px; min-width: 240px; border-radius: 4px; box-sizing: border-box;'
	});

	let clearBtn = E('button', {
		'type': 'button',
		'class': 'btn cbi-button cbi-button-neutral',
		'style': 'padding: 7px 14px; font-size: 12px; white-space: nowrap;',
		'click': function(ev) {
			ev.preventDefault();
			searchInput.value = '';
			renderSearchResults('');
		}
	}, _('清空搜索'));

	let resultsContainer = E('div', {
		'style': 'display: none; max-height: 240px; overflow-y: auto; background: rgba(128, 128, 128, 0.05); border: 1px solid rgba(128, 128, 128, 0.2); border-radius: 6px; padding: 8px; margin-top: 8px;'
	});

	function renderSearchResults(query) {
		query = (query || '').trim().toLowerCase();
		if (!query) {
			resultsContainer.style.display = 'none';
			dom.content(resultsContainer, null);
			return;
		}

		let matches = ALL_COUNTRIES.filter(function(c) {
			if (c.code.toLowerCase() === query) return true;
			if (c.name.toLowerCase().indexOf(query) !== -1) return true;
			if (c.code.toLowerCase().indexOf(query) !== -1) return true;
			let pinyin = PINYIN_MAP[c.code.toLowerCase()];
			if (pinyin && pinyin.indexOf(query) !== -1) return true;
			return false;
		});

		// 「全部国家与地区」置顶：输入 全部/所有/全球/world/all 等关键词即出现
		if (matchAllKeyword(query)) {
			matches.unshift(ALL_SENTINEL);
		}

		if (matches.length === 0) {
			resultsContainer.style.display = 'block';
			dom.content(resultsContainer, E('div', { 'style': 'color: #888; text-align: center; padding: 12px; font-size: 13px;' }, [
				_('未找到匹配 "') + query + _('" 的国家或地区。您可以输入「全部」一键选中全世界，或直接在上方下拉框/输入框中手动键入任意国家代码。')
			]));
			return;
		}

		resultsContainer.style.display = 'block';
		dom.content(resultsContainer, E('div', {
			'style': 'display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px;'
		}, matches.slice(0, 24).map(function(c) {
			let isAdded = isCountrySelected(dynlistEl, c.code);
			let isAll = (c.code === ALL_SENTINEL.code);
			let itemCard = E('div', {
				'style': 'background: ' + (isAll ? 'rgba(0, 112, 243, 0.08)' : 'rgba(255, 255, 255, 0.8)') + '; border: 1px solid ' + (isAdded ? '#28a745' : (isAll ? '#0070f3' : 'rgba(128, 128, 128, 0.25)')) + '; border-radius: 5px; padding: 6px 10px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; transition: all 0.15s ease;' + (isAll ? ' grid-column: 1 / -1;' : '')
			}, [
				E('div', { 'style': 'display: flex; align-items: center; gap: 6px; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, [
					E('span', { 'style': 'font-size: 16px;' }, c.flag),
					E('span', { 'style': 'font-weight: ' + (isAll ? 'bold' : '500') + ';' }, c.name),
					isAll ? E('span', { 'style': 'font-size: 11px; color: #0070f3; font-weight: normal;' }, _('（一键封锁全世界，自动放行内网与局域网）')) : null
				].filter(Boolean)),
				isAdded ? E('span', { 'style': 'font-size: 11px; color: #28a745; font-weight: bold; padding: 2px 6px;' }, '✓ 已选') :
				E('button', {
					'type': 'button',
					'class': 'btn cbi-button cbi-button-action',
					'style': 'padding: 2px 8px; font-size: 11px; white-space: nowrap;',
					'click': function(e) {
						e.stopPropagation();
						addCountryToDynlist(dynlistEl, c, true);
						renderSearchResults(searchInput.value);
					}
				}, isAll ? '🌍 选择全部' : '+ 选择')
			]);

			itemCard.addEventListener('click', function() {
				addCountryToDynlist(dynlistEl, c, true);
				renderSearchResults(searchInput.value);
			});

			return itemCard;
		})));
	}

	searchInput.addEventListener('input', function() {
		renderSearchResults(searchInput.value);
	});

	dynlistEl.addEventListener('cbi-dynlist-change', function() {
		if (searchInput.value) {
			renderSearchResults(searchInput.value);
		}
	});

	searchInput.addEventListener('keydown', function(ev) {
		if (ev.keyCode === 13) {
			ev.preventDefault();
			let query = (searchInput.value || '').trim().toLowerCase();
			// 回车优先命中「全部国家与地区」
			if (matchAllKeyword(query)) {
				addAllCountries(dynlistEl);
				renderSearchResults(searchInput.value);
				return;
			}
			let firstMatch = ALL_COUNTRIES.find(function(c) {
				return c.code === query || c.name.toLowerCase().indexOf(query) !== -1;
			});
			if (firstMatch) {
				addCountryToDynlist(dynlistEl, firstMatch, true);
				renderSearchResults(searchInput.value);
			}
		}
	});

	// 常用快捷标签栏
	let presetRow = E('div', { 'style': 'margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center;' }, [
		E('span', { 'style': 'font-size: 12px; color: #888; font-weight: bold;' }, _('常用快捷添加:'))
	]);

	COMMON_PRESETS.forEach(function(c) {
		presetRow.appendChild(E('button', {
			'type': 'button',
			'class': 'btn cbi-button cbi-button-neutral',
			'style': 'padding: 2px 8px; font-size: 12px; display: inline-flex; align-items: center; gap: 4px;',
			'click': function(ev) {
				ev.preventDefault();
				addCountryToDynlist(dynlistEl, c, true);
				if (searchInput.value) renderSearchResults(searchInput.value);
			}
		}, [
			E('span', {}, c.flag),
			E('span', {}, c.name.split(' ')[0]),
			E('span', { 'style': 'color: #0070f3; font-weight: bold;' }, '+')
		]));
	});

	let toolRow = E('div', { 'style': 'margin-top: 8px; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px;' }, [
		E('button', {
			'type': 'button',
			'class': 'btn cbi-button cbi-button-action',
			'style': 'padding: 3px 12px; font-size: 12px; font-weight: bold;',
			'click': function(ev) {
				ev.preventDefault();
				addAllCountries(dynlistEl);
				if (searchInput.value) renderSearchResults(searchInput.value);
			}
		}, _('🌍 一键选中全部国家与地区（所有国家）')),
		E('button', {
			'type': 'button',
			'class': 'btn cbi-button cbi-button-remove',
			'style': 'padding: 3px 10px; font-size: 12px;',
			'click': function(ev) {
				ev.preventDefault();
				let items = dynlistEl.querySelectorAll('.item');
				if (items.length === 0) return;
				if (confirm(_('确定要清空列表中已选的所有国家和地区吗？'))) {
					let inst = dom.findClassInstance(dynlistEl);
					items.forEach(function(item) {
						if (inst && typeof inst.removeItem === 'function') {
							inst.removeItem(dynlistEl, item);
						} else {
							item.remove();
						}
					});
					if (searchInput.value) renderSearchResults(searchInput.value);
				}
			}
		}, _('🗑️ 一键清空已选国家'))
	]);

	return E('div', {
		'class': 'cbi-section',
		'style': 'background: rgba(128, 128, 128, 0.04); border: 1px solid rgba(128, 128, 128, 0.18); border-radius: 6px; padding: 12px; margin-top: 10px; box-sizing: border-box;'
	}, [
		E('div', { 'style': 'font-size: 13px; font-weight: bold; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;' }, [
			E('span', {}, '🔍'),
			E('span', {}, _('国家与地区快速搜索与选择 (输入名称或代码实时匹配，支持一键点选)'))
		]),
		E('div', { 'style': 'display: flex; gap: 8px; align-items: center;' }, [
			searchInput,
			clearBtn
		]),
		resultsContainer,
		presetRow,
		toolRow
	]);
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('opengfw'),
			fs.exec_direct('/usr/bin/opengfw-geoip-helper', ['get']).catch(function() { return '{}'; })
		]);
	},

	render: function(data) {
		let m, s, o;

		m = new form.Map('opengfw', _('全球国家与地区 IP 拦截'),
			_('OpenGFW 内置完整的全球国家/地区 IPv4 及 IPv6 CIDR 数据库。支持拦截全世界所有国家和地区，并支持无限添加自定义网络 IP 订阅链接进行自动下载和定期更新。'));

		// 状态大盘卡片
		s = m.section(form.NamedSection, 'geoip', 'opengfw');
		s.anonymous = true;

		s.render = function() {
			let card = E('div', { 'class': 'cbi-section', 'style': 'margin-bottom: 20px; width: 100%; box-sizing: border-box;' }, [
				E('div', { 'style': 'display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; border-bottom: 1px solid #e5e5e5; padding-bottom: 10px; margin-bottom: 15px;' }, [
					E('h3', { 'style': 'margin: 0;' }, _('全球 IP 数据库状态与自动更新')),
					E('div', { 'style': 'display: flex; flex-wrap: wrap; gap: 8px;' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-action',
							'click': function() {
								ui.showModal(_('正在下载全球 IP 数据库'), [
									E('p', { 'class': 'spinning' }, _('正在多源并发下载最新的全球 IP 段落数据，请稍候...'))
								]);
								return fs.exec_direct('/usr/bin/opengfw-update-dat').then(function(out) {
									ui.showModal(_('全球 IP 数据库更新结果'), [
										E('div', { 'class': 'cbi-section' }, [
											E('p', { 'style': 'font-weight: bold; color: #28a745; margin-bottom: 8px;' }, _('✅ 全球 IP 数据库与规则库更新成功，已自动热重载生效！')),
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
									ui.showModal(_('下载失败'), [
										E('p', { 'style': 'color: #dc3545;' }, _('下载更新出错: ') + err),
										E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
											E('button', {
												'class': 'btn cbi-button cbi-button-neutral',
												'click': ui.hideModal
											}, _('关闭'))
										])
									]);
								});
							}
						}, _('🌐 立即手动下载最新全球 IP 数据库'))
					])
				]),
				E('div', {
					'style': 'display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; width: 100%; box-sizing: border-box;'
				}, [
					E('div', {
						'style': 'background: rgba(128, 128, 128, 0.05); border: 1px solid rgba(128, 128, 128, 0.15); border-radius: 6px; padding: 10px 12px; text-align: center; display: flex; flex-direction: column; justify-content: center; min-width: 0; box-sizing: border-box;'
					}, [
						E('div', { 'style': 'font-size: 12px; color: #888; margin-bottom: 6px;' }, _('全球 IP 数据库大小')),
						E('div', { 'id': 'geoip_fsize', 'style': 'font-size: 14px; font-weight: bold;' }, _('检测中...'))
					]),
					E('div', {
						'style': 'background: rgba(128, 128, 128, 0.05); border: 1px solid rgba(128, 128, 128, 0.15); border-radius: 6px; padding: 10px 12px; text-align: center; display: flex; flex-direction: column; justify-content: center; min-width: 0; box-sizing: border-box;'
					}, [
						E('div', { 'style': 'font-size: 12px; color: #888; margin-bottom: 6px;' }, _('数据库上次更新时间')),
						E('div', { 'id': 'geoip_lupdate', 'style': 'font-size: 14px; font-weight: bold;' }, _('检测中...'))
					]),
					E('div', {
						'style': 'background: rgba(128, 128, 128, 0.05); border: 1px solid rgba(128, 128, 128, 0.15); border-radius: 6px; padding: 10px 12px; text-align: center; display: flex; flex-direction: column; justify-content: center; min-width: 0; box-sizing: border-box;'
					}, [
						E('div', { 'style': 'font-size: 12px; color: #888; margin-bottom: 6px;' }, _('国家与地区管控状态')),
						E('div', { 'id': 'geoip_status', 'style': 'font-size: 14px; font-weight: bold;' }, _('检测中...'))
					]),
					E('div', {
						'style': 'background: rgba(128, 128, 128, 0.05); border: 1px solid rgba(128, 128, 128, 0.15); border-radius: 6px; padding: 10px 12px; text-align: center; display: flex; flex-direction: column; justify-content: center; min-width: 0; box-sizing: border-box;'
					}, [
						E('div', { 'style': 'font-size: 12px; color: #888; margin-bottom: 6px;' }, _('自定义 IP 订阅状态')),
						E('div', { 'id': 'geoip_custom_status', 'style': 'font-size: 14px; font-weight: bold;' }, _('检测中...'))
					])
				])
			]);

			poll.add(function() {
				return fs.exec_direct('/usr/bin/opengfw-geoip-helper', ['get']).then(function(res) {
					try {
						let info = JSON.parse(res.trim());
						let elSize = document.getElementById('geoip_fsize');
						let elTime = document.getElementById('geoip_lupdate');
						let elSt = document.getElementById('geoip_status');
						let elCustom = document.getElementById('geoip_custom_status');

						if (elSize) elSize.textContent = info.file_size || '-';
						if (elTime) elTime.textContent = info.last_update || '-';
						if (elSt) {
							if (info.enabled) {
								let modeText = (info.mode === 'whitelist') ? '白名单模式' : '黑名单模式';
								let cList = (info.countries || '').trim().split(/\s+/).filter(Boolean);
								let hasAll = info.all_selected || cList.some(function(x) { return x.toLowerCase() === 'all'; });
								if (hasAll) {
									let others = cList.filter(function(x) { return x.toLowerCase() !== 'all'; }).length;
									elSt.innerHTML = '<span style="color: #0070f3; font-weight: bold;">● 已开启 (' + modeText + '，🌍 全部国家与地区' + (others > 0 ? ' + 另 ' + others + ' 个' : '') + ')</span>';
								} else {
									elSt.innerHTML = '<span style="color: #28a745; font-weight: bold;">● 已开启 (' + modeText + '，已选 ' + cList.length + ' 个国家)</span>';
								}
							} else {
								elSt.innerHTML = '<span style="color: #888;">● 未启用地区拦截</span>';
							}
						}
						if (elCustom) {
							let uCount = info.custom_urls_count || 0;
							let ipCount = info.custom_ips_count || 0;
							if (uCount > 0 || ipCount > 0) {
								elCustom.innerHTML = '<span style="color: #0070f3; font-weight: bold;">● 已加载 ' + ipCount + ' 个网段 (已配置 ' + uCount + ' 个订阅链接)</span>';
							} else {
								elCustom.innerHTML = '<span style="color: #888;">● 未配置自定义订阅</span>';
							}
						}
					} catch(e) {}
				}).catch(function() {});
			});

			return card;
		};

		// 国家与地区拦截策略
		s = m.section(form.NamedSection, 'geoip', 'opengfw', _('国家与地区拦截策略'));

		o = s.option(form.Flag, 'enabled', _('启用国家与地区 IP 拦截'));
		o.default = o.disabled;
		o.rmempty = false;

		o = s.option(form.ListValue, 'mode', _('拦截匹配策略'));
		o.value('blacklist', _('黑名单模式 (阻断选中的国家/地区，允许其他国家与内网正常通信)'));
		o.value('whitelist', _('严苛白名单模式 (仅允许选中的国家/地区及局域网私网，其余全世界所有境外 IP 全阻断)'));
		o.default = 'blacklist';

		o = s.option(form.ListValue, 'direction', _('流量拦截方向'));
		o.value('src', _('外部连入源 IP (禁止它们访问我方：它们访问不了我，但我可以正常访问它们，防御外部扫描与攻击) [默认推荐]'));
		o.value('dst', _('外网目标 IP (禁止内网访问它们：我方连不上目标国服务器，但对方主动扫描不受影响)'));
		o.value('both', _('双向彻底切断 (我访问不了它们，它们也访问不了我)'));
		o.default = 'src';
		o.description = _('【核心提示】默认已设为【外部连入源 IP】模式（它们访问不了我，我可以正常访问它们）。');

		// 全球所有国家/地区选择列表
		o = s.option(form.DynamicList, 'countries', _('管控国家与地区代码列表 (已收录全球全部 246 个国家和独立地区，含「全部国家」选项)'));
		o.description = _('点击下拉框可直接选择全世界任意国家，支持无限添加；也可在下方搜索栏搜索国家后一键选择。选择首项【🌍 全部国家与地区】或点击下方【🌍 一键选中全部国家与地区】按钮，即可一键封锁全世界（自动放行内网与局域网，不会断开 SSH 与后台管理）。');
		// 下拉框首项：全部国家与地区（一键封锁全世界）
		o.value(ALL_SENTINEL.code, ALL_SENTINEL.flag + ' ' + ALL_SENTINEL.name + ' — 一键封锁全世界');
		ALL_COUNTRIES.forEach(function(c) {
			o.value(c.code, c.flag + ' ' + c.name);
		});

		let origRenderWidget = o.renderWidget;
		o.renderWidget = function(section_id, option_index, cfgvalue) {
			let dynlistEl = origRenderWidget.apply(this, arguments);
			let searchBox = renderCountrySearchHelper(dynlistEl);
			return E('div', { 'class': 'cbi-country-picker-container', 'style': 'display: flex; flex-direction: column; gap: 12px; width: 100%; box-sizing: border-box;' }, [
				dynlistEl,
				searchBox
			]);
		};

		// 自定义 IP 段订阅链接 (无限个)
		s = m.section(form.NamedSection, 'geoip', 'opengfw', _('自定义 IP 网段订阅链接 (支持无限手动添加与自动下载)'));

		o = s.option(form.DynamicList, 'custom_urls', _('自定义 IP 网段订阅链接列表 (URL)'));
		o.description = _('支持输入任何网络上的 IP 段列表链接 (每行一个 IP 或 CIDR 网段，支持 # 注释)。点击下方【+】按钮可无限添加任意多个订阅链接，系统在定时任务中会自动下载更新！');

		// 自动更新设置
		s = m.section(form.NamedSection, 'geoip', 'opengfw', _('全球 IP 段与自定义订阅自动更新计划'));

		o = s.option(form.Flag, 'autoupdate', _('启用全球 IP 网段自动定时更新'));
		o.default = o.enabled;
		o.description = _('开启后，软路由将在后台根据设定的周期自动拉取最新划分的全球国家 IP 地址段数据库，并同步下载上方所有自定义 IP 订阅链接！');

		o = s.option(form.ListValue, 'freq', _('自动更新周期'));
		o.value('daily', _('每天凌晨 3:00 自动更新'));
		o.value('weekly', _('每周日凌晨 3:00 自动更新 (推荐)'));
		o.value('monthly', _('每月 1 号凌晨 3:00 自动更新'));
		o.default = 'weekly';

		return m.render().then(function(mapNode) {
			// 自定义订阅即时同步按钮与单链接快速导入区域
			let customImportCard = E('div', { 'class': 'cbi-section', 'style': 'margin-top: 20px; border-top: 1px solid #eee; padding-top: 15px;' }, [
				E('h3', {}, _('立即同步自定义 IP 订阅 / 手动单链接下载 / 文本批量导入')),
				E('div', { 'class': 'cbi-map-descr' }, _('点击下方同步按钮可立即下载并生效上方列表中的所有自定义 IP 订阅链接；也可以在下方测试单链接或手动粘贴 CIDR 网段！')),
				
				// 立即同步上方所有订阅链接按钮
				E('div', { 'style': 'margin: 15px 0 20px 0; padding: 12px; background: rgba(0, 112, 243, 0.05); border: 1px dashed #0070f3; border-radius: 6px;' }, [
					E('div', { 'style': 'font-weight: bold; margin-bottom: 6px; color: #0070f3;' }, _('🚀 一键下载并同步上方所有自定义 IP 订阅链接:')),
					E('div', { 'style': 'font-size: 12px; color: #666; margin-bottom: 10px;' }, _('会自动读取上方填写的全部订阅 URL，依次并发下载、解析 CIDR 网段、去除重复项并注入 GeoIP 数据库立即生效。')),
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'style': 'padding: 6px 18px; font-weight: bold;',
						'click': function() {
							ui.showModal(_('正在同步自定义 IP 订阅'), [
								E('p', { 'class': 'spinning' }, _('正在下载并解析上方所有自定义订阅链接中的 IP 网段，请稍候...'))
							]);
							return saveAllMaps().then(function() {
								return applyUci();
							}).then(function() {
								return fs.exec_direct('/usr/bin/opengfw-geoip-helper', ['sync-custom-ips']);
							}).then(function(res) {
								ui.showModal(_('自定义 IP 订阅同步结果'), [
									E('div', { 'class': 'cbi-section' }, [
										E('pre', {
											'style': 'max-height: 280px; overflow-y: auto; background: #1e1e1e; color: #00ff66; padding: 12px; border-radius: 4px; font-family: monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all;'
										}, res || _('同步成功！'))
									]),
									E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
										E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('关闭'))
									])
								]);
							}).catch(function(err) {
								ui.showModal(_('同步出错'), [
									E('p', { 'style': 'color: #dc3545;' }, _('同步出错: ') + err),
									E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
										E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('关闭'))
									])
								]);
							});
						}
					}, _('📥 立即同步下载所有自定义 IP 订阅'))
				]),

				// 单链接测试
				E('div', { 'style': 'margin-top: 15px;' }, [
					E('label', { 'style': 'font-weight: bold; display: block; margin-bottom: 5px;' }, _('测试单个临时 IP 列表链接 (URL):')),
					E('div', { 'style': 'display: flex; gap: 10px; align-items: center;' }, [
						E('input', {
							'id': 'custom_single_ip_url',
							'type': 'text',
							'class': 'cbi-input-text',
							'style': 'flex: 1; font-family: monospace;',
							'placeholder': '例如: https://raw.githubusercontent.com/.../ip-blocklist.txt'
						}),
						E('button', {
							'class': 'btn cbi-button cbi-button-apply',
							'click': function() {
								let u = (document.getElementById('custom_single_ip_url') || {}).value || '';
								u = u.trim();
								if (!u) {
									ui.showModal(_('提示'), [
										E('p', _('请输入有效的 IP 段下载链接！')),
										E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
											E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('确定'))
										])
									]);
									return;
								}
								ui.showModal(_('正在下载并解析 IP 段'), [
									E('p', { 'class': 'spinning' }, _('正在下载该链接中的所有 IP 网段并编译写入规则库，请稍候...'))
								]);
								return fs.exec_direct('/usr/bin/opengfw-adblock-tool', ['import-ip', '--url', u, '--name', 'custom_ips']).then(function(res) {
									ui.showModal(_('IP 段导入结果'), [
										E('div', { 'class': 'cbi-section' }, [
											E('pre', {
												'style': 'max-height: 280px; overflow-y: auto; background: #1e1e1e; color: #00ff66; padding: 12px; border-radius: 4px; font-family: monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all;'
											}, res)
										]),
										E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
											E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('关闭'))
										])
									]);
								}).catch(function(err) {
									ui.showModal(_('导入失败'), [
										E('p', { 'style': 'color: #dc3545;' }, _('下载或导入失败: ') + err),
										E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
											E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('关闭'))
										])
									]);
								});
							}
						}, _('📥 测试导入单链接'))
					])
				]),

				// 手动粘贴区域
				E('div', { 'style': 'margin-top: 20px;' }, [
					E('label', { 'style': 'font-weight: bold; display: block; margin-bottom: 5px;' }, _('或直接粘贴 IP / CIDR 网段文本 (每行一个):')),
					E('textarea', {
						'id': 'custom_paste_ip_text',
						'class': 'cbi-input-textarea',
						'style': 'width: 100%; min-height: 100px; font-family: monospace; font-size: 12px;',
						'placeholder': '例如:\n192.0.2.0/24\n198.51.100.0/24\n203.0.113.1\n2001:db8::/32'
					}),
					E('div', { 'style': 'margin-top: 8px;' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-save',
							'click': function() {
								let txt = (document.getElementById('custom_paste_ip_text') || {}).value || '';
								txt = txt.trim();
								if (!txt) {
									ui.showModal(_('提示'), [
										E('p', _('请先粘贴 IP 网段文本！')),
										E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
											E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('确定'))
										])
									]);
									return;
								}
								let tmpFile = '/tmp/opengfw_paste_ips.txt';
								ui.showModal(_('正在处理'), [ E('p', { 'class': 'spinning' }, _('正在写入并解析 IP 段...')) ]);
								fs.write(tmpFile, txt).then(function() {
									ui.hideModal();
									ui.showModal(_('正在导入'), [ E('p', { 'class': 'spinning' }, _('正在编译写入 GeoIP 数据库...')) ]);
									return fs.exec_direct('/usr/bin/opengfw-adblock-tool', ['import-ip', '--file', tmpFile, '--name', 'custom_ips']);
								}).then(function(res) {
									ui.showModal(_('IP 段解析结果'), [
										E('div', { 'class': 'cbi-section' }, [
											E('pre', {
												'style': 'max-height: 280px; overflow-y: auto; background: #1e1e1e; color: #00ff66; padding: 12px; border-radius: 4px; font-family: monospace;'
											}, res)
										]),
										E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
											E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('关闭'))
										])
									]);
								}).catch(function(err) {
									ui.showModal(_('导入失败'), [
										E('p', { 'style': 'color: #dc3545;' }, _('解析出错: ') + err),
										E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
											E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('关闭'))
										])
									]);
								});
							}
						}, _('📝 解析文本并合并导入 IP 段'))
					])
				])
			]);

			let saveBtn = E('div', { 'class': 'cbi-section', 'style': 'margin-top: 20px;' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-apply',
					'style': 'padding: 8px 24px; font-weight: bold; font-size: 14px;',
					'click': function() {
						ui.showModal(_('正在应用配置'), [
							E('p', { 'class': 'spinning' }, _('正在将国家地区拦截规则与自定义 IP 订阅编译并注入 OpenGFW 引擎...'))
						]);
						return saveAllMaps().then(function() {
							return applyUci();
						}).then(function() {
							return fs.exec_direct('/usr/bin/opengfw-geoip-helper', ['apply']);
						}).then(function() {
							ui.hideModal();
							ui.showModal(_('应用成功'), [
								E('p', { 'style': 'color: #28a745; font-weight: bold;' }, _('全球国家与自定义 IP 拦截配置已成功应用并热重载生效！')),
								E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
									E('button', { 'class': 'btn cbi-button cbi-button-primary', 'click': ui.hideModal }, _('关闭'))
								])
							]);
						}).catch(function(err) {
							ui.hideModal();
							ui.showModal(_('应用出错'), [
								E('p', { 'style': 'color: #dc3545;' }, _('应用出错: ') + err),
								E('div', { 'class': 'right', 'style': 'margin-top: 15px; text-align: right;' }, [
									E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal }, _('关闭'))
								])
							]);
						});
					}
				}, _('💾 保存并立即热生效地区拦截规则'))
			]);

			mapNode.appendChild(customImportCard);
			mapNode.appendChild(saveBtn);
			return mapNode;
		});
	},

	// -----------------------------------------------------------------------
	// 关闭 LuCI 默认的「保存 / 保存并应用」页脚按钮。
	//
	// 原因：本页的国家/地区清单只写进 uci 是不会生效的，必须再由
	// /usr/bin/opengfw-geoip-helper apply 把它编译成 rules.yaml 里的
	// geoip(...) 规则并触发引擎热重载。而 LuCI 默认的 handleSaveApply
	// 只调用 uci.save() + uci.apply()，不会执行该 helper —— 结果就是
	// uci 里已经出现 "all" 等新选项，rules.yaml 却仍是旧的，看似保存成功
	// 实则规则未变。
	//
	// 因此参照本应用其它页面 (adblock.js / custom.js / rules.js) 的做法，
	// 把这三个回调置为 null 以隐藏默认页脚，统一改用页面内置的
	// 「💾 保存并立即热生效地区拦截规则」按钮：
	//     uci.save() -> uci.apply() -> opengfw-geoip-helper apply
	// -----------------------------------------------------------------------
	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
