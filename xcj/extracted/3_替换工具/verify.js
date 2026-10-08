/**
 * 用码单器 App 的真实匹配逻辑校验新价格库。
 *
 * 移植自 madan/index.html 的以下实现（逐条对齐，未做简化）：
 *   - PriceRuleEngine.normalizeText / normalizeServiceDisplay / buildServiceKey
 *   - PriceRuleEngine.lowerTierRanks
 *   - PriceRuleMatcher.variantDefinitions / splitVariant / normalizeNamedRank
 *   - PriceRuleMatcher.parseService / matchRankTarget / collectCandidates
 *   - PriceRuleMatcher.resolveCandidate（定价取值）
 *   - PriceRuleEngine.normalizeRules / buildRuleKey / mergeRule
 */
const fs = require('fs');

// ---------- PriceRuleEngine 关键部分（逐条对齐） ----------
const AppTextUtils = {
  normalizeText(value) {
    return String(value ?? '')
      .replace(/\u3000/g, ' ')
      .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/\s+/g, ' ')
      .trim();
  }
};

const PriceRuleEngine = {
  get lowerTierRanks() { return ['钻石', '铂金', '黄金', '白银', '青铜']; },
  normalizeText(v) { return AppTextUtils.normalizeText(v); },
  normalizeServiceDisplay(value) {
    return this.normalizeText(value)
      .replace(/包\s*c/ig, '包c')
      .replace(/\s*([+＋])\s*/g, '$1');
  },
  buildServiceKey(value) { return this.normalizeServiceDisplay(value).toLowerCase(); },

  buildRuleKey(rule) {
    if (!rule) return '';
    if (rule.kind === 'exact') return `exact|${rule.serviceKey || this.buildServiceKey(rule.serviceName)}`;
    const boundary = rule.rankType === 'star'
      ? `${rule.minStar}-${rule.maxStar}`
      : (rule.namedRanks || []).map(i => this.normalizeText(i)).sort().join('|');
    return `rankRange|${rule.rankType}|${boundary}|${this.normalizeText(rule.rangeLabel).toLowerCase()}`;
  },

  normalizeAliases(raw) {
    const list = [];
    if (Array.isArray(raw?.aliases)) list.push(...raw.aliases);
    if (raw?.alias) list.push(raw.alias);
    return [...new Set(list.map(a => this.normalizeServiceDisplay(a)).filter(Boolean))];
  },

  mergeRule(current, incoming) {
    if (!current) return incoming;
    if (!incoming) return current;
    const mergedAliases = [...new Set([...(current.aliases || []), ...(incoming.aliases || []),
      ...(current.alias ? [current.alias] : []), ...(incoming.alias ? [incoming.alias] : [])].filter(Boolean))].slice(0, 12);
    const mergedScope = current.scope || incoming.scope || '';
    if (current.kind === 'exact' && incoming.kind === 'exact') {
      const latest = incoming.updatedAt >= current.updatedAt ? incoming : current;
      return { ...latest, scope: mergedScope, id: current.id || incoming.id,
        aliases: mergedAliases, alias: mergedAliases[0] || '',
        prices: { ...current.prices, ...incoming.prices },
        legacyManaged: Boolean(current.legacyManaged && incoming.legacyManaged),
        createdAt: Math.min(current.createdAt, incoming.createdAt),
        updatedAt: Math.max(current.updatedAt, incoming.updatedAt) };
    }
    const latest = incoming.updatedAt >= current.updatedAt ? incoming : current;
    return { ...latest, scope: mergedScope, id: current.id || incoming.id,
      aliases: mergedAliases, alias: mergedAliases[0] || '',
      createdAt: Math.min(current.createdAt, incoming.createdAt),
      updatedAt: Math.max(current.updatedAt, incoming.updatedAt) };
  },

  normalizeRules(list) {
    const source = Array.isArray(list) ? list : [];
    const rules = new Map();
    let duplicateCount = 0;
    source.forEach((raw, index) => {
      const rule = raw;
      if (!rule || !rule.kind) return;
      const key = this.buildRuleKey(rule);
      if (rules.has(key)) duplicateCount++;
      rules.set(key, this.mergeRule(rules.get(key), rule));
    });
    return { rules: [...rules.values()], duplicateCount };
  }
};

// ---------- PriceRuleMatcher（逐条对齐） ----------
const PriceRuleMatcher = {
  get variantDefinitions() {
    return [
      { key: 'starGuarantee', label: '包星' },
      { key: 'carry', label: '包c' },
      { key: 'normal', label: '普排' }
    ];
  },
  normalizeSettleType(value) {
    const type = String(value ?? '').trim().toLowerCase();
    if (type === 'hour') return 'hour';
    if (type === 'round' || type === 'game' || type === 'games') return 'round';
    if (type === 'gift') return 'gift';
    return '';
  },
  normalizeInput(value) {
    const display = PriceRuleEngine.normalizeServiceDisplay(value);
    const compact = display.replace(/\s+/g, '');
    return { raw: value, display, compact };
  },
  normalizeNamedRank(value) {
    const text = PriceRuleEngine.normalizeText(value).replace(/\s+/g, '');
    const starGlory = text.match(/^星耀(?:第)?([1-5一二三四五ivx]+)$/i);
    if (!starGlory) return text;
    const token = starGlory[1].toUpperCase();
    const numberMap = { '1': 1, '一': 1, 'I': 1, '2': 2, '二': 2, 'II': 2,
      '3': 3, '三': 3, 'III': 3, '4': 4, '四': 4, 'IV': 4, '5': 5, '五': 5, 'V': 5 };
    const level = numberMap[token];
    return level ? `星耀${level}` : text;
  },
  splitVariant(compactInput) {
    const compact = String(compactInput ?? '');
    const lower = compact.toLowerCase();
    const definition = this.variantDefinitions.find(item => lower.endsWith(item.label.toLowerCase()));
    if (!definition) return { base: compact, variantKey: '', variantLabel: '' };
    return { base: compact.slice(0, compact.length - definition.label.length),
      variantKey: definition.key, variantLabel: definition.label };
  },
  parseService(value) {
    const input = this.normalizeInput(value);
    if (!input.compact) return { ok: false, code: 'service_empty', compact: '' };
    const variant = this.splitVariant(input.compact);
    const base = variant.base;
    const starMatch = base.match(/^(?:王者)?(\d{1,4})星$/);
    if (starMatch) return { ok: true, code: 'parsed', compact: input.compact, base,
      variantKey: variant.variantKey, variantLabel: variant.variantLabel,
      rankType: 'star', star: Number(starMatch[1]), rankName: '' };
    const namedRank = this.normalizeNamedRank(base);
    if (/^星耀[1-5]$/.test(namedRank)) return { ok: true, code: 'parsed', compact: input.compact, base,
      variantKey: variant.variantKey, variantLabel: variant.variantLabel,
      rankType: 'namedTier', star: null, rankName: namedRank };
    const lowerTier = PriceRuleEngine.lowerTierRanks.find(rank => rank === base);
    if (lowerTier) return { ok: true, code: 'parsed', compact: input.compact, base,
      variantKey: variant.variantKey, variantLabel: variant.variantLabel,
      rankType: 'lowerTier', star: null, rankName: lowerTier };
    return { ok: true, code: 'unclassified', compact: input.compact, base,
      variantKey: variant.variantKey, variantLabel: variant.variantLabel,
      rankType: '', star: null, rankName: '' };
  },
  matchRankTarget(rule, parsed) {
    if (!rule || rule.kind !== 'rankRange' || !parsed) return false;
    if (parsed.rankType === 'star') {
      return rule.rankType === 'star' && Number.isInteger(parsed.star)
        && parsed.star >= rule.minStar && parsed.star <= rule.maxStar;
    }
    if (parsed.rankType === 'namedTier') {
      if (rule.rankType !== 'namedTier') return false;
      const target = this.normalizeNamedRank(parsed.rankName);
      return (rule.namedRanks || []).some(r => this.normalizeNamedRank(r) === target);
    }
    if (parsed.rankType === 'lowerTier') {
      if (rule.rankType !== 'lowerTier') return false;
      const target = PriceRuleEngine.normalizeText(parsed.rankName);
      return (rule.namedRanks || []).some(r => PriceRuleEngine.normalizeText(r) === target);
    }
    return false;
  },
  ruleAliasKeys(rule) {
    return [...(rule?.aliases || []), rule?.alias]
      .map(a => PriceRuleEngine.buildServiceKey(a)).filter(Boolean);
  },
  collectCandidates(rules, parsed) {
    const fullKey = PriceRuleEngine.buildServiceKey(parsed.compact);
    const baseKey = PriceRuleEngine.buildServiceKey(parsed.base);
    const exact = [], rank = [];
    rules.forEach(rule => {
      if (rule.kind === 'exact') {
        const keys = [rule.serviceKey || PriceRuleEngine.buildServiceKey(rule.serviceName),
          ...this.ruleAliasKeys(rule)].filter(Boolean);
        if (keys.includes(fullKey)) exact.push({ rule, matchedBy: keys[0] === fullKey ? 'serviceName' : 'alias' });
        return;
      }
      const targetMatch = this.matchRankTarget(rule, parsed);
      const aliasMatch = Boolean(baseKey && this.ruleAliasKeys(rule).includes(baseKey));
      const rangeLabelMatch = Boolean(baseKey && PriceRuleEngine.buildServiceKey(rule.rangeLabel) === baseKey);
      if (targetMatch || aliasMatch || rangeLabelMatch) {
        rank.push({ rule, matchedBy: targetMatch ? 'rank' : aliasMatch ? 'alias' : 'rangeLabel' });
      }
    });
    return { exact, rank };
  },
  normalizePositivePrice(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  },
  match(rules, serviceValue, settleValue) {
    const parsed = this.parseService(serviceValue);
    const settleType = this.normalizeSettleType(settleValue);
    if (!parsed.ok) return { ok: false, code: parsed.code, msg: '服务项目不能为空' };
    if (!settleType) return { ok: false, code: 'unsupported_settle_type', msg: '结算方式不受支持' };
    const { rules: normalized } = PriceRuleEngine.normalizeRules(rules);
    const cands = this.collectCandidates(normalized, parsed);
    const all = [...cands.exact, ...cands.rank];
    if (!all.length) return { ok: false, code: 'rule_not_found', msg: '当前价格库中没有匹配规则' };
    if (all.length > 1) {
      const seen = new Set(); const uniq = [];
      for (const c of all) {
        const k = `${c.rule.kind}|${c.rule.rangeLabel || c.rule.serviceName}|${settleType}`;
        if (!seen.has(k)) { seen.add(k); uniq.push(c); }
      }
      if (uniq.length > 1) {
        return { ok: false, code: 'ambiguous_rule', msg: '命中多条规则',
          candidates: uniq.map(c => `${c.rule.kind}:${c.rule.rangeLabel || c.rule.serviceName}`) };
      }
    }
    const rule = all[0].rule;
    if (rule.kind === 'rankRange') {
      if (!['round', 'hour'].includes(settleType)) return { ok: false, code: 'unsupported_settle_type' };
      if (!parsed.variantKey) return { ok: false, code: 'variant_required', msg: '段位项目必须填写普排、包c或包星' };
      const price = this.normalizePositivePrice(rule.prices?.[parsed.variantKey]?.[settleType]);
      if (price === null) return { ok: false, code: 'price_missing', msg: `命中「${rule.rangeLabel}」但 ${parsed.variantLabel} 未设置${settleType === 'round' ? '按局' : '按小时'}价` };
      return { ok: true, price, rule, rangeLabel: rule.rangeLabel, variant: parsed.variantLabel, settleType };
    }
    const price = this.normalizePositivePrice(rule.prices?.[settleType]);
    if (price === null) return { ok: false, code: 'price_missing', msg: `命中「${rule.serviceName}」但未设置${settleType}价` };
    return { ok: true, price, rule, serviceName: rule.serviceName, settleType };
  }
};

// ---------- 跑校验 ----------
const club = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const libs = club.modules.priceLibraries.libraries;
const lib = libs.find(l => (l.name || '').includes('常驻'));
const rules = lib.rules;

const CASES = [];
function add(service, settle, expected, note) { CASES.push({ service, settle, expected, note }); }

// 排位区 10 档 × 3 变体 × 2 结算
const ranks = [
  ['星耀3', [15,45],[18,54],[20,null]],
  ['钻石',  [15,45],[18,54],[20,null]],
  ['0星',  [18,54],[20,60],[25,null]],
  ['20星', [18,54],[20,60],[25,null]],
  ['21星', [20,60],[25,75],[30,null]],
  ['35星', [20,60],[25,75],[30,null]],
  ['36星', [25,75],[30,90],[40,null]],
  ['50星', [25,75],[30,90],[40,null]],
  ['51星', [30,90],[35,105],[45,null]],
  ['65星', [30,90],[35,105],[45,null]],
  ['66星', [35,105],[40,120],[50,null]],
  ['80星', [35,105],[40,120],[50,null]],
  ['81星', [40,120],[45,135],[55,null]],
  ['100星',[40,120],[45,135],[55,null]],
  ['101星',[45,135],[50,150],[60,null]],
  ['120星',[45,135],[50,150],[60,null]],
  ['121星',[50,150],[55,165],[65,null]],
  ['135星',[50,150],[55,165],[65,null]],
  ['136星',[55,165],[60,180],[70,null]],
  ['150星',[55,165],[60,180],[70,null]],
];
for (const [svc, n, c, s] of ranks) {
  for (const [logical, arr] of [['普排',n],['包C',c],['包星',s]]) {
    const cust = logical === '包C' ? '包c' : logical;
    const label = logical;
    add(`${svc}${cust}`, 'round', arr[0], `${svc} ${label} 按局`);
    if (arr[1] !== null) add(`${svc}${cust}`, 'hour', arr[1], `${svc} ${label} 按小时`);
    else if (logical !== '包星') add(`${svc}${cust}`, 'hour', null, `${svc} ${label} 按小时(应无价)`);
  }
}
// 娱乐区
const ent = [
  ['娱乐匹配','round',13],['娱乐匹配','hour',39],
  ['技术匹配','round',17],['技术匹配','hour',51],
  ['纯连','hour',45],['哄睡','hour',50],['纯文','hour',35],
  ['一起看','hour',35],['其他手游','hour',45],['端游','hour',55],
  ['蹭金标','round',18],['鹅鸭杀','hour',35],['挂麦','hour',25],
  ['树洞','hour',42],['娱技匹配','round',15],['技术娱乐','round',17],
  ['教学单','round',6],['小国蹭标','round',28],['大国蹭标','round',48],
];
for (const [svc, st, p] of ent) add(svc, st, p, `${svc} 娱乐区`);

let pass = 0, fail = 0, broken = 0;
const fails = [];
console.log('价格库:', lib.name, '| rankRange', rules.filter(r=>r.kind==='rankRange').length, '| exact', rules.filter(r=>r.kind==='exact').length);
console.log('='.repeat(100));
for (const c of CASES) {
  const r = PriceRuleMatcher.match(rules, c.service, c.settle);
  let ok;
  if (c.expected === null) {
    ok = !r.ok && r.code === 'price_missing';
  } else {
    ok = r.ok && r.price === c.expected;
  }
  if (ok) pass++;
  else { fail++; fails.push({ ...c, got: r.ok ? r.price : `${r.code}:${r.msg}` }); }
  if (r.ok && !c.expected && c.expected !== null) broken++;
}
console.log(`用例 ${CASES.length}  通过 ${pass}  失败 ${fail}`);
if (fails.length) {
  console.log('\n失败明细:');
  for (const f of fails) console.log(`  ✗ ${f.note.padEnd(28)} 期望=${f.expected}  实际=${f.got}`);
}
// 额外：检查是否有「命中多条」冲突
console.log('\n--- 冲突扫描：每个输入是否唯一命中 ---');
let conf = 0;
const seen = new Set();
for (const c of CASES) {
  const key = c.service + '|' + c.settle;
  if (seen.has(key)) continue;
  seen.add(key);
  const r = PriceRuleMatcher.match(rules, c.service, c.settle);
  if (r.code === 'ambiguous_rule') { conf++; console.log('  ⚠ 多命中:', c.service, c.settle, r.candidates); }
}
console.log(conf === 0 ? '  ✓ 无多命中冲突' : `  ✗ ${conf} 处冲突`);

process.exit(fail === 0 && conf === 0 ? 0 : 1);
