#!/usr/bin/env node
/**
 * 「辅助提示随实际情况变化」专项验证（8.3.38）
 *
 * 为什么需要它
 * ------------
 * 8.3.38 把礼物码单折数提示从一句静态说明改成了**跟着状态走**的动态文案：
 *   ① 折数未填            → 默认说明「折数仅记录，不参与计算」
 *   ② 折数已填、无总价    → 「不影响总价，填多少都不会改变总价」
 *   ③ 折数已填、有总价    → 「不影响总价，总价仍为 X」（X 跟着总价走）
 * 这是**新增行为**，既有 13 套防线全部写于它之前，对它零覆盖。
 *
 * 更要紧的是它有一条**容易悄悄断掉的链路**：提示的刷新依赖
 *   InputFlowFeature.handleMainInput → app.updateGiftDiscountNote → ModeFlowFeature
 * 这一串转发，任何一环改名/漏挂，都会表现为「文案永远停在默认那句」——
 * 而默认那句本身是合法的，所以只测「有没有这句话」的断言根本发现不了。
 * 因此本脚本测的是「文案会不会随状态改变」，并附反向验证确认断言不是假的绿。
 *
 * 反向验证方式：临时改写源码副本（不碰工作区文件），断言其必须失败。
 *
 * 用法：node tests/hint-dynamic.js
 * 退出码：0 全部通过 / 1 有断言失败
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');

let fail = 0;
const ck = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

/* 【8.3.45】判断「全部清除」里那句提示刷新是否排在结果归位之后。
   必须限定在 clearAll 作用域内：runInputClearSideEffects 里也有一对
   `resetResults()` + 刷新调用，用全文正则会把顺序错位的 clearAll 误判为正确。
   提到模块作用域是因为正向断言与反向验证都要用它，写在块里会取不到。 */
const orderInClearAll = (src) => {
  const start = src.indexOf('clearAll() {');
  if (start < 0) return false;
  const seg = src.slice(start, start + 1400);
  const reset = seg.indexOf('this.orderFlow.resetResults();');
  const note = seg.indexOf('this.app.updateGiftDiscountNote?.()');
  return reset >= 0 && note >= 0 && note > reset;
};

// ── 抠出 updateGiftDiscountNote 与它依赖的格式化函数，在 vm 里跑 ──────────────
// 做法与 test-engine.js / price-alias.js 一致：只抠类定义，不碰 DOM。
function extractMethod(src, name) {
  const key = `\n ${name}(`;
  const start = src.indexOf(key);
  if (start < 0) throw new Error(`找不到方法 ${name}`);
  // 花括号配平，找到方法体结束
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start + 1, i + 1);
    }
  }
  throw new Error(`方法 ${name} 括号不配平`);
}

function buildNoteEngine(htmlText) {
  const methodSrc = extractMethod(htmlText, 'updateGiftDiscountNote');
  const sandbox = {
    console,
    Math,
    Number,
    String,
    Object,
    Array,
    // ProjectSettlementEngine.formatNumber 是纯格式化，这里给等价实现
    ProjectSettlementEngine: {
      formatNumber: n => {
        if (!Number.isFinite(n)) return '0';
        return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // 用 class 包一层，把方法挂上去（保留 this.currentMode / this.el 的取用方式）
  // 注意：class 是词法声明，不会自动成为 sandbox 属性，必须显式导出到 globalThis。
  vm.runInContext(`class ModeFlowFeatureStub { ${methodSrc} }
globalThis.ModeFlowFeatureStub = ModeFlowFeatureStub;`, sandbox);
  return sandbox;
}

// ── 构造一个可用的「假界面」 ────────────────────────────────────────────────
function makeApp(sandbox, { mode, discount, total }) {
  const note = { textContent: '礼物码单：折数仅记录，不参与计算' };
  return {
    currentMode: mode,
    el: {
      giftDiscountNote: note,
      inputs: {
        discount: { value: discount },
        totalPrice: { value: total }
      }
    },
    note
  };
}

const html = fs.readFileSync(HTML, 'utf8');
console.log('═════ 辅助提示随实际情况变化 · 专项验证 ═════\n');

const sandbox = buildNoteEngine(html);
const call = (app) => {
  const inst = new sandbox.ModeFlowFeatureStub();
  inst.currentMode = app.currentMode;
  inst.el = app.el;
  inst.updateGiftDiscountNote();
  return app.note.textContent;
};

const DEFAULT_TEXT = '礼物码单：折数仅记录，不参与计算';

console.log('① 礼物码单折数提示：文案随状态变化');
{
  const giftNoDiscount = call(makeApp(sandbox, { mode: 2, discount: '', total: '' }));
  ck('折数未填 → 默认说明', giftNoDiscount === DEFAULT_TEXT, giftNoDiscount);

  const giftDiscountNoTotal = call(makeApp(sandbox, { mode: 2, discount: '8', total: '' }));
  ck('折数已填、无总价 → 直说「不影响总价」', giftDiscountNoTotal.includes('不影响总价') && !giftDiscountNoTotal.includes('仍为'), giftDiscountNoTotal);
  ck('该状态下文案已与默认说明不同（证明真的会变）', giftDiscountNoTotal !== DEFAULT_TEXT);

  const giftDiscountWithTotal = call(makeApp(sandbox, { mode: 2, discount: '8', total: '200' }));
  ck('折数+总价 200 → 文案带出金额', giftDiscountWithTotal.includes('总价仍为') && giftDiscountWithTotal.includes('200'), giftDiscountWithTotal);

  const giftTotalChanged = call(makeApp(sandbox, { mode: 2, discount: '8', total: '350' }));
  ck('总价改 350 → 金额同步（不会停在旧值）', giftTotalChanged.includes('350') && !giftTotalChanged.includes('200'), giftTotalChanged);

  const giftDecimal = call(makeApp(sandbox, { mode: 2, discount: '8', total: '1234.5' }));
  ck('小数总价正常展示', giftDecimal.includes('1234.5'), giftDecimal);
}

console.log('\n② 非礼物模式与清理：必须回到默认、不残留');
{
  const singleMode = call(makeApp(sandbox, { mode: 1, discount: '8', total: '200' }));
  ck('单子码单下 → 回到默认说明', singleMode === DEFAULT_TEXT, singleMode);

  const giftCleared = call(makeApp(sandbox, { mode: 2, discount: '', total: '350' }));
  ck('礼物模式下清空折数 → 回到默认说明', giftCleared === DEFAULT_TEXT, giftCleared);

  // 先前是礼物态算出过带金额的文案，切到单子模式后不能留残影
  const app = makeApp(sandbox, { mode: 2, discount: '8', total: '350' });
  call(app);
  app.currentMode = 1;
  call(app);
  ck('从「带金额文案」切到单子码单 → 不残留旧文案', app.note.textContent === DEFAULT_TEXT, app.note.textContent);
}

console.log('\n③ 容错：坏数据不得抛错、不得写出乱码');
{
  const badTotal = call(makeApp(sandbox, { mode: 2, discount: '8', total: 'abc' }));
  ck('总价填非数字 → 退化为「不改变总价」而不是 NaN', !badTotal.includes('NaN') && badTotal.includes('不影响总价'), badTotal);

  const app = makeApp(sandbox, { mode: 2, discount: '8', total: '100' });
  app.el.giftDiscountNote = null;
  // 注意：本套件跑在 vm 里、没有 document，所以这里必须能走「元素找不到 → 静默跳过」，
  // 而不是把异常抛出去。这正是线上「元素尚未注入」时的真实处境。
  let threw = false;
  try {
    const inst = new sandbox.ModeFlowFeatureStub();
    inst.currentMode = 2;
    inst.el = app.el;
    inst.updateGiftDiscountNote();
  } catch (e) {
    threw = true;
  }
  ck('提示元素缺失 → 不抛错（静默跳过）', !threw);
}

console.log('\n④ 刷新链路：输入变化必须真的能触发到这段逻辑');
{
  // 这是本套最要紧的一条：文案对不对是一回事，**有没有人去调它**是另一回事。
  // 若 handleMainInput 里的调用被删，文案会永远停在默认那句，而默认那句是合法的，
  // 光测文案值发现不了 —— 必须单独断言「调用点存在」。
  const hasBridge = html.includes('updateGiftDiscountNote(...args) { return this.modeFlowFeature.updateGiftDiscountNote(...args); }');
  ck('app 门面上挂了 updateGiftDiscountNote 转发', hasBridge);

  const mainInputCall = /handleMainInput\(key, input[\s\S]{0,900}?this\.app\.updateGiftDiscountNote\?\.\(\)/.test(html);
  ck('输入流（handleMainInput）会刷新该提示', mainInputCall);

  const giftCall = /handleGiftPriceInput\(\)[\s\S]{0,700}?this\.app\.updateGiftDiscountNote\?\.\(\)/.test(html);
  ck('礼物价格联动（handleGiftPriceInput）会刷新该提示', giftCall);

  const switchCall = /updateDiscountModeHint\(\)[\s\S]{0,900}?this\.updateGiftDiscountNote\(isGiftMode\)/.test(html);
  ck('切换单子/礼物码单时会刷新该提示', switchCall);

  /* 【8.3.45】清除路径也必须刷新。
     8.3.38 只覆盖了「用户打字」这条路径。清除走的是另一条路
     （InputFlowFeature.clearInput → runInputClearSideEffects、
       ClearAllCoordinatorFeature.clearAll），
     那里原先只 resetResults，没人通知提示，于是清空之后那句
     「总价仍为 280」还挂在界面上 —— 用户报上来的就是这个残留。
     这里钉住两个清除出口各自都有刷新调用。 */
  const clearInputCall = /runInputClearSideEffects\(targetId\)\s*\{[\s\S]{0,1400}?targetId === 'discount'[\s\S]{0,200}?updateGiftDiscountNote/.test(html);
  ck('单字段清除（清除小叉）会刷新该提示', clearInputCall);

  /* 光有 discount 不够：清空「总价」同样让那句话不成立
     （总价没了，却还说「总价仍为 X」），所以总价也必须进这条分支。 */
  const clearCoversTotal = /targetId === 'discount' \|\| targetId === 'discountOverlay' \|\| targetId === 'totalPrice'[\s\S]{0,160}?updateGiftDiscountNote/.test(html);
  ck('清空总价也走同一条刷新（否则「总价仍为 X」同样残留）', clearCoversTotal);

  const clearAllCall = /clearAll\(\)\s*\{[\s\S]{0,1200}?updateGiftDiscountNote/.test(html);
  ck('「全部清除」会刷新该提示', clearAllCall);

  /* 顺序断言：必须锚在 clearAll 作用域内做，不能用「全文第一个 resetResults + 之后有刷新」
     这种宽泛写法 —— runInputClearSideEffects 里也有一对 `resetResults()` + 刷新，
     它会把顺序错位的 clearAll 也判成正确的（假绿，真踩过）。
     实现见文件顶部的 orderInClearAll（供正向与反向验证共用）。 */
  ck('「全部清除」里的刷新排在结果归位之后（顺序不能反）', orderInClearAll(html));

  // 反向陷阱：InputFlowFeature 上没有 currentMode，若在调用点自行判断模式会永远不成立
  const wrongGuard = /handleMainInput[\s\S]{0,900}?Number\(this\.currentMode\) === 2[\s\S]{0,120}?updateGiftDiscountNote/.test(html);
  ck('调用点没有误用 this.currentMode 做守门（该处取不到，会静默失效）', !wrongGuard);
}

console.log('\n⑤ 文案落地：其余提示的改动');
{
  const ph = (id) => {
    const m = html.match(new RegExp(`id: '${id}'[\\s\\S]{0,600}?placeholder: '([^']*)'`));
    return m ? m[1] : null;
  };
  /* 8.3.40：本组原先钉的是 8.3.38 的具体措辞（「填了服务类型，这里多半会自动算」、
     派单/陪陪留空、加价「填数字直接加/填关键词套用规则」）。
     8.3.40 按用户要求回到参考版的形式后措辞变了，所以这里改为钉**意图**而不是字面：
       · 服务时长 —— 仍要传达「多数不用自己算」这层意思，且不得退回「例如：1小时」
       · 派单/陪陪 —— 必须有可见提示（不许空白）
       · 加价 —— 仍要两行，且能区分「数字」与「关键词」两种填法
     这样将来再改措辞时，只要意图还在就不会误报，意图丢了才会红。 */
  const dur = ph('duration');
  ck('服务时长提示仍传达「自动算」这层意思', /自动算|会自动/.test(String(dur)), String(dur));
  ck('服务时长不得退回「例如：1小时」误导示例', dur !== '例如：1小时');

  // 8.3.40：派单/陪陪恢复示例（8.3.38 曾留空，实测空框更难看懂）
  ck('派单框有可见提示（不许空白）', String(ph('paiDan')).trim().length > 0, JSON.stringify(ph('paiDan')));
  ck('陪陪框有可见提示（不许空白）', String(ph('peiPei')).trim().length > 0, JSON.stringify(ph('peiPei')));

  ck('老板框提示仍点出「自动带出派单折数」', ph('boss') === '填过自动带出派单折数', String(ph('boss')));

  // 8.3.40：加价框回到两行短文案（长文案在 106px 宽的框里会被折成三行、压扁）
  const sur = html.match(/inlineHint: \[([^\]]*)\]/g) || [];
  const surLines = sur.map(s => (s.match(/'([^']*)'/g) || []).map(x => x.replace(/'/g, '')));
  const surFlat = surLines.flat();
  ck('加价框仍是两行提示', surLines.some(l => l.length === 2), JSON.stringify(surLines));
  ck('加价框两行分别指向「数字」与「关键词」两种填法',
    surFlat.some(t => /数字/.test(t)) && surFlat.some(t => /关键词/.test(t)), JSON.stringify(surFlat));
  ck('加价框每行不超过 6 个字（窄框里不折行）', surFlat.every(t => t.length <= 6), JSON.stringify(surFlat));
}

console.log('\n⑥ 反向验证：把功能拆掉后，断言必须变红');
{
  // 反向 1：让 updateGiftDiscountNote 永远返回默认文案（等价于退回 8.3.37 的静态行为）
  const brokenSrc = html.replace(
    /const text = hasTotal[\s\S]*?note\.textContent = text;/,
    'if (note.textContent !== DEFAULT_TEXT) note.textContent = DEFAULT_TEXT;'
  );
  let brokenOk = true;
  try {
    const sb = buildNoteEngine(brokenSrc);
    const app = makeApp(sb, { mode: 2, discount: '8', total: '200' });
    const inst = new sb.ModeFlowFeatureStub();
    inst.currentMode = 2;
    inst.el = app.el;
    inst.updateGiftDiscountNote();
    // 旧行为下文案应停在默认那句 —— 即我们的断言本该失败
    brokenOk = app.note.textContent !== DEFAULT_TEXT;
  } catch (e) {
    brokenOk = false;
  }
  ck('拆掉动态文案后，正向断言确实会失败（不是假的绿）', brokenOk === false);

  // 反向 2：删掉 app 门面的转发，链路断言必须变红
  const noBridge = html.replace(
    'updateGiftDiscountNote(...args) { return this.modeFlowFeature.updateGiftDiscountNote(...args); }',
    ''
  );
  ck('删掉门面转发后，链路断言确实会失败', !noBridge.includes('updateGiftDiscountNote(...args) { return this.modeFlowFeature'));

  // 反向 3：把调用点改成误用 this.currentMode，陷阱断言必须变红
  const wrongGuardSrc = html.replace(
    'if (key === \'totalPrice\' || key === \'discount\' || key === \'discountOverlay\') {\n this.app.updateGiftDiscountNote?.();',
    'if (Number(this.currentMode) === 2 && (key === \'totalPrice\' || key === \'discount\' || key === \'discountOverlay\')) {\n this.app.updateGiftDiscountNote?.();'
  );
  const trapHit = /handleMainInput[\s\S]{0,900}?Number\(this\.currentMode\) === 2[\s\S]{0,120}?updateGiftDiscountNote/.test(wrongGuardSrc);
  ck('误用 this.currentMode 守门时，陷阱断言确实会失败', trapHit === true);

  /* 反向 4【8.3.45】：把新增的两个清除路径刷新删掉，对应断言必须变红。
     否则这四条断言只是「源码里碰巧有这几个字」，挡不住以后被删。 */
  const noClearInput = html.replace(
    " if (targetId === 'discount' || targetId === 'discountOverlay' || targetId === 'totalPrice') this.app.updateGiftDiscountNote?.();\n",
    ''
  );
  const clearInputGone = /targetId === 'discount'[\s\S]{0,200}?updateGiftDiscountNote/.test(noClearInput);
  ck('删掉单字段清除的刷新后，该断言确实会失败', clearInputGone === false);

  const noClearAll = html.replace(
    ' this.app.updateGiftDiscountNote?.();\n this.bossMemoryFeature.hideBossSuggestions();',
    ' this.bossMemoryFeature.hideBossSuggestions();'
  );
  const clearAllGone = /clearAll\(\)\s*\{[\s\S]{0,1200}?updateGiftDiscountNote/.test(noClearAll);
  ck('删掉「全部清除」的刷新后，该断言确实会失败', clearAllGone === false);

  /* 反向 5：把 clearAll 里的刷新挪到 resetResults 之前（顺序错），顺序断言必须变红。
     两个坑都踩过，记在这里：
       ① 锚点必须唯一 —— `this.orderFlow.resetResults();` 在文件里有两处
          （另一处在 runInputClearSideEffects），用它会替换错地方；
       ② 锚点不能跨过中间的注释，否则匹配不到，反向验证就成了永远为真的假绿。
     所以这里用 clearAll 里 `initClearButtons()` 紧跟的那一处作为唯一锚点。 */
  const clearAllAnchor = ' this.inputFlowFeature.initClearButtons();\n this.orderFlow.resetResults();';
  const wrongOrder = html.replace(
    clearAllAnchor,
    ' this.inputFlowFeature.initClearButtons();\n this.app.updateGiftDiscountNote?.();\n this.orderFlow.resetResults();'
  );
  const replaced = wrongOrder !== html;
  ck('顺序反向验证的锚点确实命中了源码（否则本条是假绿）', replaced);
  ck('把刷新提到结果归位之前时，顺序断言确实会失败', orderInClearAll(wrongOrder) === false);
}

console.log('\n═════ 判定 ═════');
if (fail) {
  console.log(` 失败 ${fail} 项`);
  process.exit(1);
}
console.log(' 全部通过（提示会随实际情况变化，且断言不是假的绿）');
