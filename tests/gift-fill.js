#!/usr/bin/env node
/**
 * 第 18 套防线 · 逐项补价与纯数字候选（8.3.42）
 *
 * 守的是本版修掉的两个真实缺陷，以及版本号机制：
 *
 *   ① 多礼物组合里，每一个礼物都要能补单价
 *      背景：原先「礼物单价 × 个数」那一排只投影组合的第一项，
 *      用户写「5满天星+3同心结」时第二个礼物根本没地方填价，总价永远算不出来。
 *      现在的规则是「一次补一个，按确定换下一个」，所以必须钉死：
 *        · 判据是「这一单的价格表」，不是结算结果（结算恒不可靠，见下）
 *        · 缺价时那一排让出来，全部补完后回到算式投影
 *        · 按确定要能推进进度，且当次重算不得被级联刷新打回去
 *        · 服务类型框、单价框必须现取现用（缓存引用会被记忆库面板重绘换掉）
 *
 *   ② 只输一个数字也要出候选
 *      背景：extractGiftComboNamePart 早先要求「名字至少一个字符」，
 *      纯数字匹配不到就把 "5" 当成礼物名去查库，一个都不中，候选当场收起。
 *      用户感受是「输数字候选就没了」。这里连同 looksLikeCombo 一起钉。
 *
 *   ③ 版本号：测试版不占正式号
 *      背景：在 AI 应用里反复改动的中间产物不该占用交付版本序列。
 *      约定「未推送 = 测试版（带 -test.N 后缀），正式发行时对照仓库已发行版顺位」。
 *
 * 运行: node tests/gift-fill.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

/* ---------- 从 index.html 里取真实现来跑，不用复制品 ---------- */
function extractClass(name) {
  const start = HTML.indexOf(`class ${name} {`);
  if (start < 0) return null;
  let depth = 0, i = HTML.indexOf('{', start);
  for (; i < HTML.length; i += 1) {
    if (HTML[i] === '{') depth += 1;
    else if (HTML[i] === '}') { depth -= 1; if (depth === 0) return HTML.slice(start, i + 1); }
  }
  return null;
}

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

/** 抓一个方法体的源码（从签名到配对的收尾大括号）
 *
 * 注意：不能简单地找签名后的第一个 `{` —— 默认参数里可能就有花括号，
 * 例如 `resetGiftState({ hideSuggestions = false } = {})`。
 * 这里先扫过参数列表（括号配平），再往下找方法体的 `{`。 */
function extractMethod(signature) {
  const start = HTML.indexOf(signature);
  if (start < 0) return '';
  // 先跳过参数列表：从签名里第一个 ( 开始做圆括号配平
  let i = HTML.indexOf('(', start);
  if (i < 0) return '';
  let paren = 0;
  for (; i < HTML.length; i += 1) {
    if (HTML[i] === '(') paren += 1;
    else if (HTML[i] === ')') { paren -= 1; if (paren === 0) { i += 1; break; } }
  }
  // 再跳过返回类型与空白，找方法体的 {
  while (i < HTML.length && HTML[i] !== '{') {
    if (HTML[i] === ';') return ''; // 不是方法体（可能是抽象声明）
    i += 1;
  }
  const from = i;
  let depth = 0;
  for (; i < HTML.length; i += 1) {
    if (HTML[i] === '{') depth += 1;
    else if (HTML[i] === '}') { depth -= 1; if (depth === 0) return HTML.slice(start, i + 1); }
  }
  return HTML.slice(start, from + 1);
}

const appLogSilent = () => {};
let PriceRuleEngine, ProjectSettlementEngine, GiftMemoryEngine, GiftComboEngine;

try {
  const src = [extractConst('AppTextUtils'), extractClass('PriceRuleEngine'), extractClass('ProjectSettlementEngine'), extractClass('GiftMemoryEngine'), extractClass('GiftComboEngine')].join('\n');
  const sandbox = new Function('appLogSilent', `${src}\nreturn { PriceRuleEngine, ProjectSettlementEngine, GiftMemoryEngine, GiftComboEngine };`);
  const bag = sandbox(appLogSilent);
  PriceRuleEngine = bag.PriceRuleEngine;
  ProjectSettlementEngine = bag.ProjectSettlementEngine;
  GiftMemoryEngine = bag.GiftMemoryEngine;
  GiftComboEngine = bag.GiftComboEngine;
} catch (error) {
  failures.push(`无法从 index.html 装载引擎：${error.message}`);
}

const MEMORIES = [
  { serviceType: '满天星', mode: 'fixed', unitPrice: 10, usageCount: 1 },
  { serviceType: '同心结', mode: 'fixed', unitPrice: 25, usageCount: 1 },
  { serviceType: '玫瑰花束', mode: 'fixed', unitPrice: 30, usageCount: 1 },
];

/* ============ ① 纯数字是「还没写名字」，不是礼物名 ============ */
console.log('\n① 纯数字不再被当成礼物名');

if (PriceRuleEngine && GiftComboEngine) {
  /* looksLikeCombo 是候选出不出得来的总闸门。
     反向验证：如果它还认为「5」不像组合，下面的候选逻辑根本不会被调用。 */
  ok('纯数字「5」被判为「正在写组合」', GiftComboEngine.looksLikeCombo('5', MEMORIES) === true);
  ok('纯数字「83」同样算', GiftComboEngine.looksLikeCombo('83', MEMORIES) === true);
  ok('带数量记号的「5x」也算', GiftComboEngine.looksLikeCombo('5x', MEMORIES) === true);
  ok('空串不算组合', GiftComboEngine.looksLikeCombo('', MEMORIES) === false);

  /* 反向验证：名字里含数字的礼物不能被误伤。
     这是本改动最容易踩的坑 —— 把「AWM98K」当成「数量 98 + 名字 K」。 */
  const awm = GiftComboEngine.parseItem('AWM98K');
  ok('名字里含数字的礼物不被拆成数量', awm && awm.name === 'AWM98K' && awm.quantity === 1, JSON.stringify(awm));
  ok('「满天星」照旧按 1 个算', (GiftComboEngine.parseItem('满天星') || {}).quantity === 1);
  ok('「6满天星」照旧数量 6', (GiftComboEngine.parseItem('6满天星') || {}).quantity === 6);

  /* 组合里的数量段：解析上仍是「名字叫 5 的礼物」，这不影响候选
     （候选只看 looksLikeCombo 这个闸门），但必须确认不会算出个天价。 */
  const bare = GiftComboEngine.resolve('5', MEMORIES);
  ok('单纯「5」的结算不带金额', bare.totalPrice === null, JSON.stringify(bare.totalPrice));
} else {
  ok('引擎装载成功', false, '引擎未装载');
}

/* ============ ② 逐项补价的状态机 ============ */
console.log('\n② 逐项补价的规则');

const fillStateFn = extractMethod('getGiftComboFillState() {');
ok('存在 getGiftComboFillState', fillStateFn.length > 0);

/* 判据必须是「价源」而不是结算结果 —— 这是本版最核心的一条设计决定。
   反向验证：如果改用 resolve 的 ok / unitPrice 判，用户按下确定的那一刻
   结算已经能算出总价，就会被判定「补完了」，按钮当场收起、第二项永远补不上。

   【8.3.43 更新】价源从「只看这一单的价格表」放宽为「价格表 + 礼物单价记忆库」。
   原因是两者原先会打架：结算（resolveGiftCombo）本来就取两个价源的并集，
   而判据只看价格表 —— 记忆库里有价的礼物会被反复要求补，总价都算出来了
   提示行还在喊「还没有单价」（8.3.43 用户报的现象）。
   注意这里仍然不许看结算结果，第 155 行那条断言守的就是这件事，
   它才是「不许自己影响自己」的真正防线。 */
ok('补价判据走统一价源判据', /giftComboItemHasPrice\s*\(/.test(fillStateFn), fillStateFn.slice(0, 300));
ok('补价判据不依赖结算结果', !/resolveGiftCombo\(/.test(fillStateFn));
ok('存在 isGiftComboPriceComplete', extractMethod('isGiftComboPriceComplete() {').length > 0);
ok('完整性判据也走统一价源判据', /giftComboItemHasPrice\s*\(/.test(extractMethod('isGiftComboPriceComplete() {')));

/* 进度不能倒退：它是「补到第几个」的游标 */
const commitFn = extractMethod('commitGiftComboFill() {');
ok('存在 commitGiftComboFill', commitFn.length > 0);
/* 进度必须写在记忆库写入之前。
   反向验证过：这两行互换位置后，upsert 触发的记忆库面板重绘会重新走一遍
   组合重算，重算里的 syncGiftComboFillProgress 把进度归零，随后那句
   「state.index + 1」再把它抬回去 —— 实际落库的名字与界面显示的进度会错开一拍，
   表现为「补完价却还停在同一个礼物」。
   注意：注释里也提到过这两句，所以必须匹配「真正的代码行」（行首缩进 + 分号结尾），
   否则会命中注释里的说明文字，断言就变成了永远为真的假绿。 */
const assignLine = '\n this._giftComboFillIndex = state.index + 1;';
const upsertCall = "this.app.giftMemoryFeature?.upsert?.({ serviceType: state.name, mode: 'fixed', unitPrice: price });";
const idxPos = commitFn.indexOf(assignLine);
const upsertPos = commitFn.indexOf(upsertCall);
ok('进度赋值行能找到（不是注释里的说明）', idxPos > 0 && upsertPos > 0, `进度 ${idxPos} / 记忆库 ${upsertPos}`);
ok('进度写在记忆库写入之前', idxPos > 0 && upsertPos > 0 && idxPos < upsertPos, `进度 ${idxPos}，记忆库写入 ${upsertPos}`);
ok('补价会存进礼物单价记忆库', /giftMemoryFeature\?\.upsert\?\./.test(commitFn));
ok('存进记忆库的是固定金额礼物', /mode:\s*'fixed'/.test(commitFn));
ok('单价非法时拒绝提交', /price === null/.test(commitFn));

/* 名称对照表：价格表的键是服务键（会小写归一），不能拿它当显示名 */
const buildFn = extractMethod('buildComboMemories() {');
ok('存在 buildComboMemories', buildFn.length > 0);
ok('用独立对照表还原显示名', /_giftComboPriceNames/.test(buildFn),
  '用服务键当名字会让记忆库里出现「未知b」，界面上再也认不出「未知B」');
ok('已确认的价覆盖记忆库', /unitPrice:\s*price/.test(buildFn));

/* ============ ③ 那一排在「补价中」与「补完后」的两种形态 ============ */
console.log('\n③ 那一排的两种形态');

const writebackFn = extractMethod('syncGiftComboPanelWriteback(result) {');
ok('存在 syncGiftComboPanelWriteback', writebackFn.length > 0);
ok('补价中把这一排让给用户', /getGiftComboFillState\(\)/.test(writebackFn));
ok('补价中不预填单价（不覆盖用户已敲的数字）',
  !/setInputValue\?\.\('autoUnitPrice',\s*''/.test(writebackFn),
  '清空单价会把用户刚敲的数字抹掉');
ok('补价中标注这一项是给谁的', /dataset\.giftComboTarget/.test(writebackFn));
ok('补完后回到算式投影', /formatNumber\(result\.total\)/.test(writebackFn) && /result\?\.items\?\.\[0\]/.test(writebackFn));

/* 按钮复用单子码单那一位，形态随状态变 */
const btnFn = extractMethod('updateManualControls(draft = null, { forceGiftPriority = false } = {}) {');
ok('存在带优先级的 updateManualControls', btnFn.length > 0);
ok('礼物模式下按补价进度决定显隐', /giftCanCommit/.test(btnFn));
ok('按钮文字带上下一个礼物名', /确定·换/.test(btnFn));
ok('按钮标记为补价用途', /dataset\.giftComboCommit/.test(btnFn));
ok('退回单子码单时恢复两行文案', /下一项/.test(btnFn));
/* 反向验证：forceGiftPriority 必须有，否则输入事件触发的 syncUI 会把按钮刷回收起 */
ok('有 forceGiftPriority 兜住时序', /forceGiftPriority/.test(btnFn) && /forceGiftPriority: true/.test(HTML),
  '补价会经输入事件触发 syncUI，那一刻按钮会被按「未补价」的旧结论刷回');

/* ============ ④ 缓存引用必须现取现用 ============ */
console.log('\n④ 现取现用的 DOM 引用');

/* 这是本版踩得最深的坑：补价里 upsert → updateUI 会重绘记忆库面板，
   顺带换掉 el.inputs 的缓存，之后从缓存读到的节点已脱离文档、value 为空。
   症状一：handleGiftComboInput 收到空值判定「不是组合」，静默退出。
   症状二：把价存到了上一轮的礼物名下。 */
const fillStateIdx = HTML.indexOf('getGiftComboFillState() {');
const fillStateBlock = HTML.slice(fillStateIdx, fillStateIdx + 1200);
ok('取服务类型框时优先用 id 现查', /getElementById\('type'\)\s*\|\|/.test(fillStateBlock),
  '缓存引用会被记忆库面板重绘换掉');
ok('服务类型框取值不直接吃缓存', !/const typeEl = this\.el\?\.inputs\?\.type;\s*$/.test(fillStateBlock));
ok('单价框取值也现查', /getElementById\('autoUnitPrice'\)\s*\|\|/.test(commitFn));

const confirmFn = extractMethod('confirmGiftComboFill() {');
ok('存在 confirmGiftComboFill', confirmFn.length > 0);
ok('重算前作废指纹（否则整段被跳过）', /_giftComboSignature = ''/.test(confirmFn));
ok('重算用的输入框现取现用', /getElementById\('type'\)\s*\|\|/.test(confirmFn));

/* 指纹必须包含价格表：否则「补价」这件事不构成内容变化，界面停在原处 */
const sigFn = extractMethod('buildGiftComboSignature(result) {');
ok('内容指纹并入价格表', /_giftComboPrices/.test(sigFn),
  '礼物名与数量都没变时，指纹相同会跳过整段重算，界面停在「还在补第 1 个」');

/* ============ ⑤ 价格表的生命周期 ============ */
console.log('\n⑤ 价格表的生命周期');

const resetFn = extractMethod('resetGiftComboPriceTable() {');
ok('存在 resetGiftComboPriceTable', resetFn.length > 0);
ok('同时清价格与对照表', /_giftComboPrices\.clear/.test(resetFn) && /_giftComboPriceNames\.clear/.test(resetFn));

/* 改数量不该让单价作废：单价是「这个礼物多少钱」，与买几个无关。
   反向验证：先前无条件重置，改个数量就得从头补一遍价。 */
const handleFn = extractMethod('handleGiftComboInput(input) {');
ok('不存在「无条件重置价格表」的写法',
  !/if \(!raw \|\| !GiftComboEngine\.looksLikeCombo[\s\S]{0,400}?this\.resetGiftComboPriceTable\(\);/.test(handleFn),
  '打字中间态会经过不成组合的状态，无条件重置会把补好的价清掉');
ok('清空时改为延后作废', /scheduleGiftComboPriceTableReset/.test(handleFn));
ok('有延后作废的实现', extractMethod('scheduleGiftComboPriceTableReset() {').length > 0);
ok('有撤销延后作废的实现', extractMethod('cancelGiftComboPriceTableReset() {').length > 0);
ok('下一次输入到来时撤销作废', /else this\.cancelGiftComboPriceTableReset\(\)/.test(handleFn));

/* 真正的清空时机是「这一单结束」 */
const resetGiftStateFn = extractMethod('resetGiftState({ hideSuggestions = false } = {}) {');
ok('单子结束时清价格表', /resetGiftComboPriceTable/.test(resetGiftStateFn));

/* ============ ⑥ 提示行说清「补到第几个」 ============ */
console.log('\n⑥ 补价提示行');

const noteFn = extractMethod('renderGiftComboNote(result) {');
ok('提示行报告进度', /正在补第/.test(noteFn));
ok('提示行带上总数', /共 \$\{state\.size\} 个/.test(noteFn));
ok('提示行预告还剩哪些', /state\.rest|rest\.length/.test(noteFn));
ok('补完后回到明细文案', /共 \$\{ProjectSettlementEngine\.formatNumber\(result\.total\)\} 个礼物/.test(noteFn));
/* 反向验证：缺价提示不能再用那套「XX 在礼物单价里还没有记录」的笼统说法当家 ——
   它在补价流程里必须让位给进度式文案。 */
ok('补价中不用笼统文案当主提示', /if \(state\) \{/.test(noteFn), 'state 分支必须排在笼统文案之前');
ok('提示行仍是独立节点（不挂在隐藏的时长行上）', noteFn.includes('giftComboNote') && !noteFn.includes('durationSubtotalNote'));

/* ============ ⑦ 版本号：测试版不占正式号 ============ */
console.log('\n⑦ 版本号机制');

ok('有顺位器', fs.existsSync(path.join(ROOT, 'tools/next-version.js')));
ok('有测试号自增器', fs.existsSync(path.join(ROOT, 'tools/bump-test-version.js')));
ok('有推送前正则化器', fs.existsSync(path.join(ROOT, 'tools/pre-push-version.js')));

try {
  const next = require(path.join(ROOT, 'tools/next-version.js'));
  ok('能读出仓库已发行版本', Boolean(next.readReleasedVersion()), `实得 ${JSON.stringify(next.readReleasedVersion())}`);
  eq('顺位只动第三段', next.bump('8.3.41'), '8.3.42');
  eq('主段剥离正确', next.mainPart('8.3.42-test.3'), '8.3.42');
  ok('认得测试版号', next.isTestVersion('8.3.42-test.3') === true);
  ok('正式号不算测试版', next.isTestVersion('8.3.42') === false);
  eq('测试轮次解析正确', next.testRound('8.3.42-test.3'), 3);
  /* 反向验证：顺位不能退回去。这是「不占正式号」的关键 ——
     若某个环节把号算小了，测试版会覆盖用户已装的正式版。 */
  ok('顺位结果大于已发行版', next.compareMain(next.bump(next.readReleasedVersion()), next.readReleasedVersion()) > 0);
} catch (error) {
  ok('顺位器可加载', false, error.message);
}

/* 设备端的版本比较必须把「8.3.42-test.N」看成「8.3.42」，不能看成更小 */
const cmpFn = extractMethod('function compareVersions(a, b) {');
ok('设备端版本比较存在', cmpFn.length > 0);
ok('比较时把号段拆成整数', /parseInt/.test(cmpFn));

/* set-version 与发版脚本都要认得测试版号 */
const setVer = fs.readFileSync(path.join(ROOT, 'tools/set-version.js'), 'utf8');
/* 后缀形状必须是「只有 -test.N 这一种」，不能宽容到任意后缀 ——
   否则 version.json、OTA 清单这些地方会冒出各种自造后缀。 */
ok('后缀形状被精确限定为 -test.N', /VER_RE\s*=\s*'\\\\d\+\\\\\.\\\\d\+\\\\\.\\\\d\+\(\?:-test\\\\\.\\\\d\+\)\?'/.test(setVer),
  `实得 VER_RE 定义：${(setVer.match(/const VER_RE = '[^']*'/) || [])[0]}`);
ok('落点改写器校验目标号格式', /-\?test\\.\\d\+\)\?\$\/\.test\(TARGET\)/.test(setVer) || /TARGET && !\//.test(setVer));

const releaseSh = fs.readFileSync(path.join(ROOT, 'tools/release.sh'), 'utf8');
ok('发版脚本拒绝测试版号', /拒绝用测试版号发版/.test(releaseSh),
  '发版产物是用户能拿到的，号必须干净');
ok('发版脚本提示自动顺位', /NEXT_BY_REPO/.test(releaseSh));
ok('发版脚本解析当前版本时剥离后缀', /CUR_VER_RAW/.test(releaseSh) && /\$\{CUR_VER_RAW%%-test\.\*\}/.test(releaseSh),
  '拿带后缀的整串去比会得到「8.3.42 不大于 8.3.42-test.3」的误导结论');

/* ============ 汇总 ============ */
console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`第 18 套防线 · 逐项补价与纯数字候选：全部通过（${passed} 项断言）`);
  process.exit(0);
} else {
  console.log(`第 18 套防线 · 逐项补价与纯数字候选：${failures.length} 项失败 / 共 ${passed + failures.length} 项\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
