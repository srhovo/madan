// 引擎单元测试（L3 核心回归）：SurchargeRuleEngine 手动数字加价 + 关键词→规则名替换 + 备注不参与加价
// 从 index.html 提取类源码后在 Node 中隔离运行
// 用法：node test-engine.js [目标HTML路径] [期望版本号]
//   例：node test-engine.js index.html 8.3.28
// 注意：期望版本号需与 index.html 的 APP_VERSION 同步；引擎行为有意变更时需同步本文件期望值。
const path = require('path');
const fs = require('fs');
const args = process.argv.slice(2);
const targetHtml = args[0] ? path.resolve(args[0]) : path.join(__dirname, 'index.html');
const expectedVersion = args[1] || null;
const html = fs.readFileSync(targetHtml, 'utf8');

function extractClass(name) {
  const start = html.indexOf(`class ${name}`);
  if (start < 0) throw new Error('class not found: ' + name);
  let i = html.indexOf('{', start);
  let depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces: ' + name);
}

const appLogSilent = () => {};
const src = [
  appLogSilent.toString(),
  'const ORDER_PROJECT_SCHEMA_VERSION = 2;',
  `const AppTextUtils = {
 normalizeText(value) {
 let normalized = String(value ?? '');
 try { if (typeof normalized.normalize === 'function') normalized = normalized.normalize('NFKC'); } catch (error) { appLogSilent(error); }
 return normalized.replace(/\\s+/g, ' ').trim();
 },
};`,
  extractClass('PriceRuleEngine'),
  extractClass('ProjectSettlementEngine'),
  extractClass('SurchargeRuleEngine'),
].join('\n\n');

// 运行时依赖检查（引擎可能引用的全局）
const sandbox = { appLogSilent, console };
const vm = require('vm');
const ctx = vm.createContext(sandbox);
vm.runInContext(src + '\n;globalThis.__exports = { PriceRuleEngine, ProjectSettlementEngine, SurchargeRuleEngine };', ctx);
const { PriceRuleEngine, ProjectSettlementEngine, SurchargeRuleEngine } = sandbox.__exports;

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++; else { failed++; console.log('FAIL:', name, '\n  actual:', JSON.stringify(actual), '\n  expected:', JSON.stringify(expected)); }
}

const rules = [
  { id: 'r1', name: '甜蜜暗恋单', keywords: ['甜蜜单'], prices: { round: 10, hour: 20 }, enabled: true },
  { id: 'r2', name: '连麦加成', keywords: ['连麦'], prices: { round: 5 }, enabled: true },
  { id: 'r3', name: '停用规则', keywords: ['停用词'], prices: { round: 99 }, enabled: false },
];

// ---------- parseManualSurcharge ----------
check('parse 15', SurchargeRuleEngine.parseManualSurcharge('15'), 15);
check('parse 15.5', SurchargeRuleEngine.parseManualSurcharge('15.5'), 15.5);
check('parse fullwidth １５', SurchargeRuleEngine.parseManualSurcharge('１５'), 15);
check('parse spaces', SurchargeRuleEngine.parseManualSurcharge(' 15 '), 15);
check('parse empty', SurchargeRuleEngine.parseManualSurcharge(''), null);
check('parse keyword', SurchargeRuleEngine.parseManualSurcharge('甜蜜单'), null);
check('parse mixed', SurchargeRuleEngine.parseManualSurcharge('15/局'), null);
check('parse 0', SurchargeRuleEngine.parseManualSurcharge('0'), null); // normalizePositivePrice 拒绝非正数
check('parse negative', SurchargeRuleEngine.parseManualSurcharge('-5'), null);

// ---------- buildDisplayText ----------
check('replace keyword', SurchargeRuleEngine.buildDisplayText('甜蜜单@技术匹配', rules), '甜蜜暗恋单@技术匹配');
check('replace bare', SurchargeRuleEngine.buildDisplayText('来个甜蜜单', rules), '来个甜蜜暗恋单');
check('no rules matched', SurchargeRuleEngine.buildDisplayText('普通备注', rules), '普通备注');
check('disabled rule not replaced', SurchargeRuleEngine.buildDisplayText('停用词', rules), '停用词');
check('single-pass no corruption', SurchargeRuleEngine.buildDisplayText('aa', [
  { id: 'a', name: 'XX甜蜜单XX', keywords: ['aa'], prices: { round: 1 }, enabled: true },
  { id: 'b', name: 'YY', keywords: ['甜蜜单'], prices: { round: 2 }, enabled: true },
]), 'XX甜蜜单XX');
check('empty text', SurchargeRuleEngine.buildDisplayText('', rules), '');

// ---------- buildSurchargeDisplay ----------
check('numeric display', SurchargeRuleEngine.buildSurchargeDisplay('15', rules), '加价15');
check('numeric decimal display', SurchargeRuleEngine.buildSurchargeDisplay('15.50', rules), '加价15.5');
check('keyword display', SurchargeRuleEngine.buildSurchargeDisplay('甜蜜单@全部', rules), '甜蜜暗恋单@全部');
check('empty display', SurchargeRuleEngine.buildSurchargeDisplay('', rules), '');

// ---------- apply: 手动数字加价 ----------
function makeProjects() {
  return [
    ProjectSettlementEngine.createProject({ serviceRaw: '技术匹配', serviceDisplay: '技术匹配', quantityRaw: '3', quantityMode: 'round', unitPrice: 30 }, 0).project,
    ProjectSettlementEngine.createProject({ serviceRaw: '语音聊天', serviceDisplay: '语音聊天', quantityRaw: '2小时', quantityMode: 'hour', unitPrice: 40 }, 1).project,
  ];
}

const base = ProjectSettlementEngine.aggregateProjects(makeProjects());
check('base total', base.totalPrice, 30 * 3 + 40 * 2); // 170

const numRes = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '15' });
check('numeric triggered', numRes.triggered, true);
check('numeric ok', numRes.ok, true);
check('numeric applications count', numRes.applications.length, 2);
check('numeric round app', [numRes.applications[0].name, numRes.applications[0].settleType, numRes.applications[0].unitPrice], ['加价', 'round', 15]);
check('numeric hour app', [numRes.applications[1].name, numRes.applications[1].settleType, numRes.applications[1].unitPrice], ['加价', 'hour', 15]);
check('numeric total = 170 + 15*3 + 15*2', numRes.aggregate.totalPrice, 170 + 45 + 30);

// ---------- apply: 加价输入框关键词触发 ----------
const kwRes = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '甜蜜单@技术匹配' });
check('kw in surcharge box triggered', kwRes.triggered, true);
check('kw app rule', [kwRes.applications[0].name, kwRes.applications[0].unitPrice], ['甜蜜暗恋单', 10]);
check('kw total = 170 + 10*3', kwRes.aggregate.totalPrice, 170 + 30);

// ---------- apply: 加价框裸关键词在多项目下需要指定范围（8.3.19 报错行为保留） ----------
const kwBareMulti = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '甜蜜单' });
check('kw bare multi project not ok', kwBareMulti.ok, false);
check('kw bare multi error code', kwBareMulti.errors[0] && kwBareMulti.errors[0].code, 'target-required');

// ---------- apply: 备注不参与加价（8.3.19 行为变更） ----------
// 8.3.19 起「加价职能完全归加价输入框」：备注框回归纯备注，
// 在备注里写 关键词 / 关键词@项目名 均不再触发加价。
// 原「在备注写关键词加价」的用法已废弃，等价能力改由加价框提供（见下方 kwInBox 用例）。
// 若此处断言失败，说明备注又被接回了加价链路 —— 属于对 8.3.19 决策的回归，需要显式确认。
const noteKwRes = SurchargeRuleEngine.apply('甜蜜单@技术匹配', makeProjects(), rules);
check('note no longer triggers surcharge', noteKwRes.triggered, false);
check('note-only keeps base total 170', noteKwRes.aggregate.totalPrice, 170);
check('note-only no application', noteKwRes.applications.length, 0);

const noteBareRes = SurchargeRuleEngine.apply('甜蜜单', [makeProjects()[0]], rules);
check('note bare keyword not triggered', noteBareRes.triggered, false);
check('note bare keeps base total 90', noteBareRes.aggregate.totalPrice, 90);

// ---------- apply: 备注 + 加价框数字（备注被忽略，只有数字生效） ----------
const comboRes = SurchargeRuleEngine.apply('甜蜜单@技术匹配', makeProjects(), rules, { surchargeText: '15' });
check('combo ignores note, numeric only apps', comboRes.applications.length, 2);
check('combo total = 170 + 15*3 + 15*2', comboRes.aggregate.totalPrice, 170 + 45 + 30);
check('combo no keyword rule applied', comboRes.applications.every(a => a.name === '加价'), true);

// ---------- apply: 无项目时数字加价 ----------
const emptyRes = SurchargeRuleEngine.apply('', [], rules, { surchargeText: '15' });
check('no project numeric ok', emptyRes.ok, true);
check('no project numeric not triggered', emptyRes.triggered, false);

// ---------- apply: 非关键词非数字文本 ----------
const noneRes = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '随便写' });
check('non-matching text not triggered', noneRes.triggered, false);

// ==========================================================================
// 以下为 8.3.28 补充：本次新增覆盖 8.3.19 / 8.3.21 引入但此前零覆盖的能力。
// 所有期望值均由真实引擎实测得出（先用探针脚本枚举全部输入输出，再固化断言），
// 不是凭文档推断的。若断言失败，先跑探针确认是「行为有意变更」还是「回归」。
// ==========================================================================

// ---------- resolveProjectTarget: 目标解析全分支 ----------
const tpProjects = makeProjects(); // [技术匹配(round), 语音聊天(hour)]
check('target empty', SurchargeRuleEngine.resolveProjectTarget(tpProjects, ''), { ok: false, code: 'target-empty', indexes: [] });
check('target 全部', SurchargeRuleEngine.resolveProjectTarget(tpProjects, '全部'), { ok: true, code: 'all', indexes: [0, 1] });
check('target all 英文别名', SurchargeRuleEngine.resolveProjectTarget(tpProjects, 'all'), { ok: true, code: 'all', indexes: [0, 1] });
check('target exact 全名', SurchargeRuleEngine.resolveProjectTarget(tpProjects, '技术匹配'), { ok: true, code: 'exact', indexes: [0] });
check('target partial 前缀', SurchargeRuleEngine.resolveProjectTarget(tpProjects, '技术'), { ok: true, code: 'partial', indexes: [0] });
check('target not found', SurchargeRuleEngine.resolveProjectTarget(tpProjects, '不存在'), { ok: false, code: 'target-not-found', indexes: [] });

// ---------- apply: 裸关键词 + targetIndex 定向（8.3.19 候选选择器） ----------
// 多项目下裸关键词必须显式指定范围；targetIndex 是候选选择器点选后传入的项目下标。
const tiDefault = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '甜蜜单' });
check('bare kw multi no target -> not ok', tiDefault.ok, false);
check('bare kw multi no target -> target-required', tiDefault.errors[0] && tiDefault.errors[0].code, 'target-required');
check('bare kw multi no target -> keeps base 170', tiDefault.aggregate.totalPrice, 170);
check('bare kw multi no target -> no applications', tiDefault.applications.length, 0);

const ti0 = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '甜蜜单', targetIndex: 0 });
check('bare kw targetIndex=0 ok', ti0.ok, true);
check('bare kw targetIndex=0 single app', ti0.applications.length, 1);
check('bare kw targetIndex=0 target name', ti0.applications[0].target, '技术匹配');
check('bare kw targetIndex=0 round price 10', ti0.applications[0].unitPrice, 10);
check('bare kw targetIndex=0 total = 170 + 10*3', ti0.aggregate.totalPrice, 170 + 30);

const ti1 = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '甜蜜单', targetIndex: 1 });
check('bare kw targetIndex=1 single app', ti1.applications.length, 1);
check('bare kw targetIndex=1 hour price 20', ti1.applications[0].unitPrice, 20);
check('bare kw targetIndex=1 total = 170 + 20*2', ti1.aggregate.totalPrice, 170 + 40);

const tiOut = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '甜蜜单', targetIndex: 5 });
check('bare kw targetIndex out of range -> target-required', tiOut.errors[0] && tiOut.errors[0].code, 'target-required');

// ---------- apply: 裸关键词 + targetAll（显式选「全部项目」） ----------
const taRes = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '甜蜜单', targetAll: true });
check('bare kw targetAll ok', taRes.ok, true);
check('bare kw targetAll apps 2', taRes.applications.length, 2);
check('bare kw targetAll total = 170 + 10*3 + 20*2', taRes.aggregate.totalPrice, 170 + 30 + 40);

// ---------- apply: 数字加价 + targetIndex 定向（8.3.21） ----------
// 关键回归点：数字加价也必须受候选选择器约束，不能总是打到全部项目。
const ni0 = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '15', targetIndex: 0 });
check('numeric targetIndex=0 apps 1', ni0.applications.length, 1);
check('numeric targetIndex=0 only 技术匹配', ni0.applications[0].target, '技术匹配');
check('numeric targetIndex=0 total = 170 + 15*3', ni0.aggregate.totalPrice, 170 + 45);

const ni1 = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '15', targetIndex: 1 });
check('numeric targetIndex=1 apps 1', ni1.applications.length, 1);
check('numeric targetIndex=1 total = 170 + 15*2', ni1.aggregate.totalPrice, 170 + 30);

const niAll = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '15', targetAll: true });
check('numeric targetAll apps 2', niAll.applications.length, 2);
check('numeric targetAll total = 170 + 15*3 + 15*2', niAll.aggregate.totalPrice, 170 + 45 + 30);

// 全角数字与半角等价（NFKC 归一化）
const fullWidth = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '１５' });
check('fullwidth numeric apps 2', fullWidth.applications.length, 2);
check('fullwidth numeric total equals halfwidth', fullWidth.aggregate.totalPrice, niAll.aggregate.totalPrice);

// ---------- apply: @目标名 语法分支 ----------
const atPartial = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '甜蜜单@技术' });
check('@partial ok', atPartial.ok, true);
check('@partial apps 1', atPartial.applications.length, 1);
check('@partial resolves to 技术匹配', atPartial.applications[0].target, '技术匹配');

const atMissing = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '甜蜜单@不存在' });
check('@not-found ok false', atMissing.ok, false);
check('@not-found error code', atMissing.errors[0] && atMissing.errors[0].code, 'target-not-found');
check('@not-found triggered true', atMissing.triggered, true);

const atSpaced = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '甜蜜单 @ 技术匹配' });
check('@ with surrounding spaces still works', atSpaced.applications.length, 1);

// 歧义目标：两个项目都含「技术匹配」子串 → 必须报 target-ambiguous
const ambiguousProjects = [
  ProjectSettlementEngine.createProject({ serviceRaw: '技术匹配A', serviceDisplay: '技术匹配A', quantityRaw: '1', quantityMode: 'round', unitPrice: 10 }, 0).project,
  ProjectSettlementEngine.createProject({ serviceRaw: '技术匹配B', serviceDisplay: '技术匹配B', quantityRaw: '1', quantityMode: 'round', unitPrice: 10 }, 1).project,
];
check('resolveProjectTarget ambiguous', SurchargeRuleEngine.resolveProjectTarget(ambiguousProjects, '技术匹配').code, 'target-ambiguous');
const ambRes = SurchargeRuleEngine.apply('', ambiguousProjects, rules, { surchargeText: '甜蜜单@技术匹配' });
check('@ambiguous ok false', ambRes.ok, false);
check('@ambiguous error code', ambRes.errors[0] && ambRes.errors[0].code, 'target-ambiguous');

// ---------- apply: 项目缺少对应结算单位的加价价目 ----------
// 连麦加成只配了 round，语音聊天是 hour → 应用到 hour 项目时必须报 price-missing
const hourRule = [rules[1]]; // 连麦加成: prices { round: 5 }
const priceMiss = SurchargeRuleEngine.apply('', makeProjects(), hourRule, { surchargeText: '连麦@全部' });
check('price-missing ok false', priceMiss.ok, false);
check('price-missing error code', priceMiss.errors[0] && priceMiss.errors[0].code, 'price-missing');

// ---------- apply: 小时项目走 hour 价目 ----------
const hourPrice = SurchargeRuleEngine.apply('', makeProjects(), [{ id: 'r1', name: '甜蜜暗恋单', keywords: ['甜蜜单'], prices: { round: 10, hour: 20 }, enabled: true }], { surchargeText: '甜蜜单@语音' });
check('hour project settleType', hourPrice.applications[0].settleType, 'hour');
check('hour project unitPrice 20', hourPrice.applications[0].unitPrice, 20);
check('hour project total = 170 + 20*2', hourPrice.aggregate.totalPrice, 170 + 40);

// ---------- apply: 无项目时的报错分支 ----------
const noProjBare = SurchargeRuleEngine.apply('', [], rules, { surchargeText: '甜蜜单' });
check('no project bare kw -> project-required', noProjBare.errors[0] && noProjBare.errors[0].code, 'project-required');
check('no project bare kw -> triggered true', noProjBare.triggered, true);

const noProjAt = SurchargeRuleEngine.apply('', [], rules, { surchargeText: '甜蜜单@技术匹配' });
check('no project @target -> target-not-found', noProjAt.errors[0] && noProjAt.errors[0].code, 'target-not-found');

const noProjAll = SurchargeRuleEngine.apply('', [], rules, { surchargeText: '甜蜜单@全部' });
check('no project @全部 -> ok true', noProjAll.ok, true);
check('no project @全部 -> not triggered', noProjAll.triggered, false);

// ---------- apply: @目标名 命中「单期价格」规则时静默忽略（重要防护） ----------
// 连麦加成只配了 round=5；@技术匹配 是 round 项目，因此正常命中。
const matchedAt = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '连麦@技术匹配' });
check('matched rule with @target triggered', matchedAt.triggered, true);
check('matched rule with @target ok', matchedAt.ok, true);
check('matched rule with @target apps 1', matchedAt.applications.length, 1);
check('matched rule with @target price 5', matchedAt.applications[0].unitPrice, 5);
check('matched rule with @target total = 170 + 5*3', matchedAt.aggregate.totalPrice, 170 + 15);

// 目标语法指向不存在规则时，不报错、不误加价（关键词不在启用规则集里 → matched 为空）
const noRuleHit = SurchargeRuleEngine.apply('', makeProjects(), [{ id: 'r1', name: '甜蜜暗恋单', keywords: ['甜蜜单'], prices: { round: 10, hour: 20 }, enabled: true }], { surchargeText: '连麦@技术匹配' });
check('unmatched keyword with @target not triggered', noRuleHit.triggered, false);
check('unmatched keyword with @target no errors', noRuleHit.errors.length, 0);
check('unmatched keyword with @target keeps base', noRuleHit.aggregate.totalPrice, 170);

// ---------- apply: 停用规则 + 加价框组合 ----------
const disabledBox = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '停用词 8' });
check('disabled rule in box not triggered', disabledBox.triggered, false);
check('disabled rule in box keeps base 170', disabledBox.aggregate.totalPrice, 170);

// ---------- apply: 关键词与数字混写（当前语义 = 明确报错，不得静默猜一个） ----------
// 快照断言：混写不是受支持用法。「15 甜蜜单」解析不出数字（带关键词）、
// 又命中裸关键词而多项目下无目标 → 必须报 target-required，绝不能悄悄按 15 算。
const mixedWrite = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '15 甜蜜单' });
check('mixed text not ok', mixedWrite.ok, false);
check('mixed text error code', mixedWrite.errors[0] && mixedWrite.errors[0].code, 'target-required');
check('mixed text produces no application', mixedWrite.applications.length, 0);
check('mixed text keeps base 170', mixedWrite.aggregate.totalPrice, 170);

// ---------- normalizeRule: 归一化契约 ----------
check('normalizeRule 关键词语义分割', SurchargeRuleEngine.normalizeRule({ name: 'A', keywords: 'a,b、c/d|e;f', prices: { round: 1 } }).keywords, ['a', 'b', 'c', 'd', 'e', 'f']);
check('normalizeRule 关键词去重', SurchargeRuleEngine.normalizeRule({ name: 'A', keywords: ['x', 'x', 'x'], prices: { round: 1 } }).keywords, ['x']);
check('normalizeRule 关键词 12 条上限', SurchargeRuleEngine.normalizeRule({ name: 'A', keywords: Array.from({ length: 20 }, (_, i) => 'k' + i), prices: { round: 1 } }).keywords.length, 12);
check('normalizeRule 空输入返回 null', SurchargeRuleEngine.normalizeRule({}), null);
check('normalizeRule null 返回 null', SurchargeRuleEngine.normalizeRule(null), null);
// 无有效正价 → 整条规则归一化为 null（不是「enabled:false 的空壳」）
check('normalizeRule prices 空 -> null', SurchargeRuleEngine.normalizeRule({ name: 'A', keywords: ['x'], prices: {} }), null);
check('normalizeRule 价为零 -> null', SurchargeRuleEngine.normalizeRule({ name: 'A', keywords: ['x'], prices: { round: 0 } }), null);
check('normalizeRule 价为负 -> null', SurchargeRuleEngine.normalizeRule({ name: 'A', keywords: ['x'], prices: { round: -1 } }), null);
check('normalizeRule 价为非数 -> null', SurchargeRuleEngine.normalizeRule({ name: 'A', keywords: ['x'], prices: { round: 'abc' } }), null);
check('normalizeRule 有价默认开启', SurchargeRuleEngine.normalizeRule({ name: 'A', keywords: ['x'], prices: { round: 1 } }).enabled, true);
check('normalizeRule 显式停用保留', SurchargeRuleEngine.normalizeRule({ name: 'A', keywords: ['x'], prices: { round: 1 }, enabled: false }).enabled, false);
check('buildId 对等价输入稳定', SurchargeRuleEngine.buildId({ name: 'A', keywords: ['x'] }), SurchargeRuleEngine.buildId({ name: 'A', keywords: ['x', 'x'] }));

// 同 id 规则按后者覆盖（normalizeRules 契约）
check('normalizeRules 同 id 后者覆盖', SurchargeRuleEngine.normalizeRules([
  { id: 'r1', name: 'A', keywords: ['a'], prices: { round: 1 }, enabled: true },
  { id: 'r1', name: 'B', keywords: ['b'], prices: { round: 2 }, enabled: true },
]).map(r => r.name), ['B']);

// ---------- 鲁棒性：null / undefined 输入不得抛异常 ----------
check('parseManualSurcharge(null)', SurchargeRuleEngine.parseManualSurcharge(null), null);
check('parseManualSurcharge(undefined)', SurchargeRuleEngine.parseManualSurcharge(undefined), null);
check('normalizeText(null)', SurchargeRuleEngine.normalizeText(null), '');
const nullRes = SurchargeRuleEngine.apply(null, null, null, {});
check('apply(null,null,null,{}) 不抛异常且不触发', nullRes.triggered, false);
const nullRulesNumeric = SurchargeRuleEngine.apply('', makeProjects(), null, { surchargeText: '15' });
check('apply(rules=null) 数字加价仍生效', nullRulesNumeric.applications.length, 2);
check('apply(rules=null) 数字加价总额', nullRulesNumeric.aggregate.totalPrice, 170 + 45 + 30);

// ---------- 目标文件与版本号核对 ----------
const versionMatch = html.match(/const APP_VERSION = '([^']+)'/);
const actualVersion = versionMatch ? versionMatch[1] : null;
console.log(`target: ${targetHtml}`);
console.log(`APP_VERSION: ${actualVersion}${expectedVersion ? ` (expected ${expectedVersion})` : ''}`);
if (!actualVersion) { failed++; console.log('FAIL: APP_VERSION not found'); }
if (expectedVersion && actualVersion !== expectedVersion) { failed++; console.log(`FAIL: version mismatch, actual=${actualVersion} expected=${expectedVersion}`); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
