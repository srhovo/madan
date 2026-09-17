#!/usr/bin/env node
/**
 * 第 10 套防线 · 礼物组合与按模式隐藏（8.3.41）
 *
 * 守的是三件事：
 *   ① GiftComboEngine 的解析与结算规则（纯函数，直接跑真实现）
 *   ② 礼物码单下「服务时长」那一组的隐藏是「规则」而非「偏好」——
 *      用户勾不掉，切模式立即生效
 *   ③ 服务类型提示按码单类型分流，且单子码单的长文案有字号兜底
 *
 * 为什么这些必须钉死：
 *   · 组合语法的边界（数量在前/在后、没写数量、查不到价）是钱的计算依据，
 *     错一条就是给用户算错账，不是显示问题。
 *   · 「按模式隐藏」如果退化成「写进 hiddenModules」，用户只要动过一次布局
 *     偏好就可能把它勾回来，时长框又冒出来。
 *   · 提示文案分流依赖 placeholder 的「渲染时选值」+「切模式时刷新」两步，
 *     少了后者就会出现「切到礼物码单还显示单子码单的示例」——实测踩过。
 *
 * 运行: node tests/gift-combo.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let passed = 0;
const failures = [];

const ok = (name, cond, detail = '') => {
  if (cond) { passed += 1; return true; }
  failures.push(`${name}${detail ? ' → ' + detail : ''}`);
  return false;
};
const eq = (name, actual, expected) => ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);

/* ---------- 从 index.html 里取出真实现来跑，不用复制品 ---------- */
// 抓一个 class 的完整源码（从 `class X {` 到对应收尾 `}`）
function extractClass(name) {
  const start = HTML.indexOf(`class ${name} {`);
  if (start < 0) return null;
  let depth = 0, i = HTML.indexOf('{', start);
  const from = i;
  for (; i < HTML.length; i += 1) {
    if (HTML[i] === '{') depth += 1;
    else if (HTML[i] === '}') { depth -= 1; if (depth === 0) return HTML.slice(start, i + 1); }
  }
  return null;
}

const appLogSilent = () => {};
let PriceRuleEngine, ProjectSettlementEngine, GiftMemoryEngine, GiftComboEngine;

// AppTextUtils 是顶层冻结对象（纯函数），PriceRuleEngine 依赖它的 normalizeText
function extractConst(name) {
  const start = HTML.indexOf(`const ${name} = Object.freeze({`);
  if (start < 0) return null;
  let depth = 0, i = HTML.indexOf('{', start);
  for (; i < HTML.length; i += 1) {
    if (HTML[i] === '{') depth += 1;
    else if (HTML[i] === '}') { depth -= 1; if (depth === 0) return HTML.slice(start, i + 2); }
  }
  return null;
}

try {
  const src = [extractConst('AppTextUtils'), extractClass('PriceRuleEngine'), extractClass('ProjectSettlementEngine'), extractClass('GiftMemoryEngine'), extractClass('GiftComboEngine')]
    .filter(Boolean).join('\n');
  if (!src.trim()) throw new Error('未能从 index.html 抓到引擎源码');
  const factory = new Function('appLogSilent', `${src}\nreturn { AppTextUtils, PriceRuleEngine, ProjectSettlementEngine, GiftMemoryEngine, GiftComboEngine };`);
  ({ PriceRuleEngine, ProjectSettlementEngine, GiftMemoryEngine, GiftComboEngine } = factory(appLogSilent));
} catch (error) {
  console.error('无法加载引擎源码:', error.message);
  process.exit(1);
}

console.log('=== 第 10 套防线 · 礼物组合与按模式隐藏（8.3.41）===\n');

/* ============ ① 解析规则 ============ */
console.log('① 组合解析');

const p1 = GiftComboEngine.parse('5满天星+3同心结');
ok('两种礼物混合能拆成两项', p1.ok && p1.items.length === 2, JSON.stringify(p1));
eq('第一项名称', p1.items?.[0]?.name, '满天星');
eq('第一项数量', p1.items?.[0]?.quantity, 5);
eq('第二项名称', p1.items?.[1]?.name, '同心结');
eq('第二项数量', p1.items?.[1]?.quantity, 3);

const p2 = GiftComboEngine.parse('同心结');
ok('单个礼物也能解析', p2.ok && p2.items.length === 1);
eq('不带数字时数量按 1 算', p2.items?.[0]?.quantity, 1);

const p3 = GiftComboEngine.parse('满天星6');
eq('数量写在后面也认', p3.items?.[0]?.quantity, 6);
eq('数量写在后面时名称仍然正确', p3.items?.[0]?.name, '满天星');

const p4 = GiftComboEngine.parse('6满天星');
eq('数量写在前面', p4.items?.[0]?.quantity, 6);

const p5 = GiftComboEngine.parse('５满天星＋３同心结');
ok('全角数字与全角加号能归一', p5.ok && p5.items.length === 2, JSON.stringify(p5));
eq('全角场景下第一项数量', p5.items?.[0]?.quantity, 5);

const p6 = GiftComboEngine.parse('');
eq('空串不算组合', p6.ok, false);
eq('空串的原因标记', p6.reason, 'empty');

const p7 = GiftComboEngine.parse('满天星++同心结');
ok('连续加号不产生空项', p7.ok && p7.items.length === 2, JSON.stringify(p7));

const p8 = GiftComboEngine.parse('x6 满天星');
eq('x 前缀能被识别', p8.items?.[0]?.quantity, 6);
eq('x 前缀下名称正确', p8.items?.[0]?.name, '满天星');

/* 名称里带数字不能被误当数量：这是最容易出错的一类，必须钉死 */
const p9 = GiftComboEngine.parse('AWM98K');
eq('名称末尾的数字不当作数量', p9.items?.[0]?.quantity, 1);
eq('名称末尾带数字时名称完整保留', p9.items?.[0]?.name, 'AWM98K');

const p10 = GiftComboEngine.parse('2个满天星');
ok('带量词的写法名称保真（不做过度解读）', p10.ok && p10.items.length === 1, JSON.stringify(p10));

/* ============ ② 结算规则 ============ */
console.log('\n② 组合结算');

const memories = [
  { serviceType: '满天星', mode: 'fixed', unitPrice: 10, usageCount: 3 },
  { serviceType: '同心结', mode: 'fixed', unitPrice: 25, usageCount: 2 },
  { serviceType: '神秘礼物', mode: 'variable', unitPrice: null, usageCount: 1 }
];

const r1 = GiftComboEngine.resolve('5满天星+3同心结', memories);
ok('两种礼物都查到价 → 可结算', r1.ok, JSON.stringify(r1));
eq('总价 = 5×10 + 3×25', r1.totalPrice, 125);
eq('礼物总数量 = 5+3', r1.total, 8);
eq('查不到的单列为空', r1.missing.length, 0);

const r2 = GiftComboEngine.resolve('同心结+6满天星', memories);
eq('省略数量的一项按 1 个算：1×25 + 6×10', r2.totalPrice, 85);
eq('礼物总数量 = 1+6', r2.total, 7);

const r3 = GiftComboEngine.resolve('6满天星', memories);
eq('单个礼物带数量：6×10', r3.totalPrice, 60);
eq('礼物总数量 = 6', r3.total, 6);

/* 查不到价的三种情况都要「不给总价」，绝不能拿半个数糊弄用户 */
const r4 = GiftComboEngine.resolve('5满天星+3未知礼物', memories);
eq('含未知礼物时不给总价', r4.totalPrice, null);
eq('含未知礼物时 ok 为假', r4.ok, false);
ok('未知礼物被列进 missing', r4.missing.includes('未知礼物'), JSON.stringify(r4.missing));
eq('但查得到的那部分数量仍然统计出来', r4.total, 8);

const r5 = GiftComboEngine.resolve('神秘礼物', memories);
eq('「随机金额」礼物没有固定单价 → 不给总价', r5.totalPrice, null);
ok('它被列进 noPrice 而不是 missing', r5.noPrice.includes('神秘礼物') && r5.missing.length === 0, JSON.stringify({ m: r5.missing, n: r5.noPrice }));

const r6 = GiftComboEngine.resolve('满天星', memories);
eq('名称忽略大小写与空格：完全一致能查到', r6.ok, true);
eq('单价取到 10', r6.items?.[0]?.unitPrice, 10);

/* 罗马数字/大小写不该影响匹配 */
const r7 = GiftComboEngine.resolve('  满天星  ', memories);
ok('前后空格不影响匹配', r7.ok && r7.totalPrice === 10);

/* ============ ③ 该不该接管服务类型框 ============ */
console.log('\n③ 接管判定');

eq('带加号 → 接管', GiftComboEngine.looksLikeCombo('5满天星+3同心结', memories), true);
eq('单个已记录的礼物 → 接管', GiftComboEngine.looksLikeCombo('同心结', memories), true);
eq('单个带数字的礼物 → 接管', GiftComboEngine.looksLikeCombo('6满天星', memories), true);
/* 关键：单子码单的服务名不能被礼物逻辑抢走 —— 这是同一个输入框，识别错就全乱 */
eq('未记录的服务名 → 不接管', GiftComboEngine.looksLikeCombo('星耀包c', memories), false);
eq('空串 → 不接管', GiftComboEngine.looksLikeCombo('', memories), false);

/* ============ ④ 建议文案 ============ */
console.log('\n④ 建议文案');

const s1 = GiftComboEngine.buildSuggestion('5满天星+3同心结', memories);
eq('文本被规范化成「数量+名称」', s1.text, '5满天星+3同心结');
eq('建议里带总价', s1.totalPrice, 125);
eq('建议里带总数量', s1.total, 8);
eq('全部查到价时不给提示', s1.note, '');

const s2 = GiftComboEngine.buildSuggestion('5满天星+3未知礼物', memories);
eq('有缺失时不给总价', s2.totalPrice, null);
ok('有缺失时给出提示文字', s2.note.includes('未知礼物'), s2.note);

/* ============ ⑤ 按码单类型隐藏「服务时长」那一组 ============ */
console.log('\n⑤ 按码单类型隐藏时长那一组');

const cfgBlock = HTML.slice(HTML.indexOf('getModeForcedHiddenConfigs()'), HTML.indexOf('getModeForcedHiddenIds()'));
ok('存在按模式强制隐藏的配置方法', cfgBlock.length > 50);
ok('服务时长输入框在其中', /id:\s*'duration'[\s\S]*?modes:\s*\[2\]/.test(cfgBlock), cfgBlock.slice(0, 400));
ok('时长计算按钮在其中', /id:\s*'durationCalcBtn'[\s\S]*?modes:\s*\[2\]/.test(cfgBlock));
ok('时长小计提示也在其中', /id:\s*'durationSubtotalNote'[\s\S]*?modes:\s*\[2\]/.test(cfgBlock));

/* 反向验证：这三个模块必须**不**出现在用户可勾选的布局清单里可被「留存」——
   实际上 duration 在布局清单里是合理的（单子码单允许用户自己藏），
   关键是「礼物码单的隐藏」不能只靠布局清单，否则用户偏好一变就失效。
   下面这条断言守的就是这个 —— 生效集合必须是把「模式强制」并进去的那个。 */
ok('生效集合把模式强制项并了进去', /effectiveHiddenModules\(\)\s*\{[\s\S]*?getModeForcedHiddenIds\(\)[\s\S]*?hidden\.add\(id\)/.test(HTML));

/* 合成模块联动和防闪烁样式都必须读「生效集合」，不能读原始偏好 */
const syncEarly = HTML.slice(HTML.indexOf('syncEarlyLayoutStyle(hiddenSet)'), HTML.indexOf('syncEarlyLayoutStyle(hiddenSet)') + 700);
ok('防闪烁样式读的是生效集合', syncEarly.includes('effectiveHiddenModules'), syncEarly.slice(0, 300));
const syncComposite = HTML.slice(HTML.indexOf('syncLayoutCompositeVisibility(hiddenSet'), HTML.indexOf('syncLayoutCompositeVisibility(hiddenSet') + 500);
ok('复合模块联动读的是生效集合', syncComposite.includes('effectiveHiddenModules'));

/* 切模式必须立即重算布局，否则会挂着上一个模式的长相 */
const switchBlock = HTML.slice(HTML.indexOf('switchMode(mode) {'), HTML.indexOf('switchMode(mode) {') + 900);
ok('切模式会重算布局', switchBlock.includes('applyLayoutVisibility'), switchBlock.slice(0, 500));
ok('切模式会刷新按模式的提示文案', switchBlock.includes('applyLayoutVisibility'));

/* 根节点模式标记供 CSS 分流 */
ok('存在写根节点模式标记的方法', HTML.includes('syncModeAttribute()'));
ok('布局应用时会写该标记', /applyLayoutVisibility\(\)\s*\{\s*this\.syncModeAttribute\(\)/.test(HTML));

/* ============ ⑥ 提示文案按码单分流 ============ */
console.log('\n⑥ 服务类型提示分流');

ok('服务类型字段配了两套提示', /modePlaceholders:\s*\{\s*1:\s*'例如：1h\+2局星耀包c\+1h23min鹅鸭杀'\s*,\s*2:\s*'例如：同心结\+6满天星'\s*\}/.test(HTML), '未找到 modePlaceholders 配置');
ok('单子码单示例是长文案', HTML.includes('例如：1h+2局星耀包c+1h23min鹅鸭杀'));
ok('礼物码单示例是组合写法', HTML.includes('例如：同心结+6满天星'));

/* 渲染器必须能按传入的模式挑 —— 不能自己读 app（AppShellRenderer 不持有 app，踩过） */
const resolveFn = extractClass('AppShellRenderer');
ok('渲染器按传入模式挑提示', /resolveFieldPlaceholder\(config = \{\}, mode = null\)/.test(resolveFn || ''), '签名不对');
ok('渲染器不持有 app', !/this\.app\s*=/.test(resolveFn || ''), 'AppShellRenderer 不该有 app 引用');

/* 切模式时刷新已渲染的 placeholder */
ok('存在刷新提示文案的方法', HTML.includes('syncModePlaceholders()'));
ok('它从 appShellRenderer 取配置（不是 uiRender）', /const renderer = this\.app\.appShellRenderer;/.test(HTML));
ok('布局应用时会刷新提示文案', /applyLayoutVisibility\(\)\s*\{\s*this\.syncModeAttribute\(\);\s*this\.syncModePlaceholders\(\)/.test(HTML));

/* 长文案必须有字号兜底，否则窄屏被截断 */
ok('服务类型输入框有字号兜底规则', /#primaryFieldsContainer \.field-type > input \{\s*font-size:\s*clamp\(/.test(HTML));
ok('有按模式分流的字号规则', /html\[data-order-mode="2"\] #primaryFieldsContainer \.field-type > input/.test(HTML));

/* ============ ⑦ 订单模板「时长：」在礼物码单取礼物总数量 ============ */
console.log('\n⑦ 订单模板的时长取值');

const ctxBlock = HTML.slice(HTML.indexOf('const duration = hasStructuredProjects'), HTML.indexOf('const duration = hasStructuredProjects') + 700);
ok('礼物码单走单独的取值分支', /Number\(app\.currentMode\) === 2 \? this\.getGiftTotalCount\(\)/.test(ctxBlock), ctxBlock.slice(0, 400));
ok('存在 getGiftTotalCount', HTML.includes('getGiftTotalCount()'));
const cntFn = HTML.slice(HTML.indexOf('getGiftTotalCount() {'), HTML.indexOf('getGiftTotalCount() {') + 700);
ok('它用组合引擎现算', cntFn.includes('GiftComboEngine.resolve'));
ok('解析不出时给空串而不是 0', cntFn.includes("return ''"));

/* ============ ⑧ 软提示不得抢走数字与加号 ============ */
console.log('\n⑧ 礼物码单禁用软提示抢字');

const softFn = HTML.slice(HTML.indexOf('setSoftTypeSuggestion(serviceType, signature) {'), HTML.indexOf('setSoftTypeSuggestion(serviceType, signature) {') + 900);
ok('礼物码单直接拒绝软提示填值', /if \(Number\(this\.currentMode\) === 2\) return false;/.test(softFn), softFn.slice(0, 500));

/* ============ ⑨ 组合与「单价×个数」那一排的优先级 ============ */
console.log('\n⑨ 算式优先');

const syncFn = HTML.slice(HTML.indexOf('syncGiftUnitPriceTotal(options = {}) {'), HTML.indexOf('syncGiftUnitPriceTotal(options = {}) {') + 900);
ok('组合生效时那一排不能反向改总价', syncFn.includes('isGiftComboActive'), syncFn.slice(0, 600));
ok('组合来源的写入被跳过', /if \(options\.source === 'giftCombo'\) return false;/.test(syncFn));
ok('存在 isGiftComboActive', HTML.includes('isGiftComboActive()'));

/* ============ ⑩ 组合提示行必须是独立节点 ============ */
console.log('\n⑩ 组合提示行');

ok('有独立的提示节点', HTML.includes("id=\"giftComboNote\""));
/* 反向验证：绝不能挂在时长那一行上 —— 它在礼物码单下是被隐藏的 */
const noteFn = HTML.slice(HTML.indexOf('renderGiftComboNote(result) {'), HTML.indexOf('renderGiftComboNote(result) {') + 500);
ok('提示不挂在时长小计行上', !noteFn.includes('durationSubtotalNote'), noteFn.slice(0, 300));
ok('提示用自己的节点', noteFn.includes('giftComboNote'));
ok('有对应的样式', /\.app-list-note\.gift-combo-note \{/.test(HTML));

/* ============ 汇总 ============ */
console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`第 18 套防线 · 礼物组合：全部通过（${passed} 项断言）`);
  process.exit(0);
} else {
  console.log(`第 18 套防线 · 礼物组合：${failures.length} 项失败 / 共 ${passed + failures.length} 项\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
