// 引擎单元测试（L3 核心回归）：SurchargeRuleEngine 手动数字加价 + 关键词→规则名替换
// 从 index.html 提取类源码后在 Node 中隔离运行
// 用法：node test-engine.js [目标HTML路径] [期望版本号]
//   例：node test-engine.js index.html 8.3.8
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

// ---------- apply: 备注关键词 + 数字加价叠加 ----------
const comboRes = SurchargeRuleEngine.apply('甜蜜单@技术匹配', makeProjects(), rules, { surchargeText: '15' });
check('combo apps', comboRes.applications.length, 3);
check('combo total = 170 + 30 + 75', comboRes.aggregate.totalPrice, 170 + 30 + 75);

// ---------- apply: 备注关键词（旧行为回归） ----------
const legacyRes = SurchargeRuleEngine.apply('甜蜜单@技术匹配', makeProjects(), rules);
check('legacy triggered', legacyRes.triggered, true);
check('legacy total', legacyRes.aggregate.totalPrice, 200);
const legacyBare = SurchargeRuleEngine.apply('甜蜜单', [makeProjects()[0]], rules);
check('legacy bare single project', legacyBare.aggregate.totalPrice, 90 + 30);

// ---------- apply: 无项目时数字加价 ----------
const emptyRes = SurchargeRuleEngine.apply('', [], rules, { surchargeText: '15' });
check('no project numeric ok', emptyRes.ok, true);
check('no project numeric not triggered', emptyRes.triggered, false);

// ---------- apply: 非关键词非数字文本 ----------
const noneRes = SurchargeRuleEngine.apply('', makeProjects(), rules, { surchargeText: '随便写' });
check('non-matching text not triggered', noneRes.triggered, false);

// ---------- 目标文件与版本号核对 ----------
const versionMatch = html.match(/const APP_VERSION = '([^']+)'/);
const actualVersion = versionMatch ? versionMatch[1] : null;
console.log(`target: ${targetHtml}`);
console.log(`APP_VERSION: ${actualVersion}${expectedVersion ? ` (expected ${expectedVersion})` : ''}`);
if (!actualVersion) { failed++; console.log('FAIL: APP_VERSION not found'); }
if (expectedVersion && actualVersion !== expectedVersion) { failed++; console.log(`FAIL: version mismatch, actual=${actualVersion} expected=${expectedVersion}`); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
