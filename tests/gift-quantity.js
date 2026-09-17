#!/usr/bin/env node
/**
 * 「礼物码单：单价 × 个数 = 总价」专项验证（8.3.39）
 *
 * 为什么需要它
 * ------------
 * 8.3.39 让礼物码单下「自定义单价」那一排真的参与算钱：
 *     礼物单价 × 个数 = 总价
 * 这是**新增行为**，既有 14 套防线全部写于它之前，对它零覆盖。
 *
 * 这条链路上有三个曾经真实踩过、且**症状很隐蔽**的坑，本套逐一钉住：
 *
 *   ① 个数框是动态注入的，抓元素时还不存在 → 绑不上输入事件。
 *      症状：先填单价再填个数，总价不出来；反过来先填个数再填单价却能出来。
 *      这种「看顺序」的 bug 极难复现，必须靠断言钉住补绑逻辑存在。
 *   ② 清空个数后总价残留旧值，用户以为算错了。
 *   ③ 切回单子码单时礼物残留没清干净，个数与算式总价串到单子码单上。
 *      但同时——用户手填的总价**绝不能被当礼物结果清掉**。这是本条的正反两面。
 *   ④ 显隐控制。这两个控件的显隐曾被样式表里十几条同名字号/尺寸规则轮流盖回来，
 *      单子码单下个数框照样显示。现在改由 hidden 属性独家决定，
 *      本套断言「样式表里不再有 display 切换规则」+「JS 里真的在设 hidden」，
 *      并附反向验证确认断言不是假的绿。
 *
 * 反向验证方式：临时改写源码副本（不碰工作区文件），断言其必须失败。
 *
 * 用法：node tests/gift-quantity.js
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

// ── 抠方法：与其余套件保持一致的做法（花括号配平，只抠类定义） ────────────────
// 注意：签名里可能有默认参数（如 `syncGiftUnitPriceTotal(options = {})`），
// 那个 `{}` 会让朴素的「从第一个 { 开始配平」当场跑偏 —— 必须先跳过参数括号，
// 从方法体的 `{` 起算。历史上这里写错会报出莫名其妙的 SyntaxError。
function extractMethod(src, name) {
  const key = `\n ${name}(`;
  const start = src.indexOf(key);
  if (start < 0) throw new Error(`找不到方法 ${name}`);
  // 先跳过参数列表（可能含默认值对象、解构等）
  let p = src.indexOf('(', start);
  let paren = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') paren++;
    else if (src[p] === ')') { paren--; if (paren === 0) break; }
  }
  if (p >= src.length) throw new Error(`方法 ${name} 参数括号不配平`);
  // 再从方法体的第一个 { 起花括号配平
  let i = src.indexOf('{', p);
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

// ── 造一个只够跑 syncGiftUnitPriceTotal 的沙箱 ──────────────────────────────
// 它是纯计算 + 写输入框，不需要 DOM。把「假输入框」和「假输入流」注入进去。
function buildGiftEngine(htmlText) {
  const methodSrc = extractMethod(htmlText, 'syncGiftUnitPriceTotal');
  const sandbox = {
    console,
    Math,
    Number,
    String,
    Object,
    Array,
    appLogSilent: () => {},
    ProjectSettlementEngine: {
      formatNumber: n => {
        if (!Number.isFinite(n)) return '0';
        return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`class GiftEngineStub { ${methodSrc} }
globalThis.GiftEngineStub = GiftEngineStub;`, sandbox);
  return sandbox;
}

// ── 假界面：单价框 / 个数框 / 总价框 + 记录写入次数的输入流 ─────────────────
function makeGiftApp(sandbox, { mode = 2, unit = '', qty = '', total = '' } = {}) {
  const writes = [];
  const app = {
    mode,
    unitEl: { value: unit },
    qtyEl: { value: qty },
    totalEl: { value: total },
    writes,
    get currentMode() { return app.mode; },
    el: {
      giftQuantity: null,
      inputs: {
        autoUnitPrice: null,
        totalPrice: null
      }
    },
    inputFlowFeature: {
      setInputValue(key, value) {
        writes.push({ key, value });
        if (key === 'totalPrice') app.totalEl.value = value;
        if (key === 'giftQuantity') app.qtyEl.value = value;
      }
    },
    // 提示刷新：真实实现里会调它，这里只需存在即可
    updateGiftDiscountNote: () => {}
  };
  app.el.inputs.autoUnitPrice = app.unitEl;
  app.el.inputs.totalPrice = app.totalEl;
  app.el.giftQuantity = app.qtyEl;
  return app;
}

function runSync(sandbox, app) {
  const inst = new sandbox.GiftEngineStub();
  inst.currentMode = app.currentMode;
  inst.el = app.el;
  inst.app = app;
  inst._lastGiftComputedTotal = null;
  const r = inst.syncGiftUnitPriceTotal();
  // 把内部记的值带回 app，供后续断言
  app._lastGiftComputedTotal = inst._lastGiftComputedTotal;
  return { result: r, inst };
}

const html = fs.readFileSync(HTML, 'utf8');
console.log('═════ 礼物码单「单价 × 个数 = 总价」· 专项验证 ═════\n');

const sandbox = buildGiftEngine(html);
const callSync = (app, options = {}) => {
  const inst = new sandbox.GiftEngineStub();
  inst.currentMode = app.currentMode;
  inst.el = app.el;
  inst.app = app;
  inst._lastGiftComputedTotal = app._lastGiftComputedTotal ?? null;
  inst._giftTotalUserEdited = app._giftTotalUserEdited ?? false;
  const r = inst.syncGiftUnitPriceTotal(options);
  app._lastGiftComputedTotal = inst._lastGiftComputedTotal;
  app._giftTotalUserEdited = inst._giftTotalUserEdited;
  return r;
};

console.log('① 正常相乘：单价 × 个数 = 总价');
{
  const a1 = makeGiftApp(sandbox, { unit: '5', qty: '10' });
  callSync(a1);
  ck('5 × 10 → 总价 50', String(a1.totalEl.value) === '50', `总价="${a1.totalEl.value}"`);

  const a2 = makeGiftApp(sandbox, { unit: '6.5', qty: '3' });
  callSync(a2);
  ck('6.5 × 3 → 总价 19.5（小数不丢）', String(a2.totalEl.value) === '19.5', `总价="${a2.totalEl.value}"`);

  const a3 = makeGiftApp(sandbox, { unit: '0.001', qty: '9999' });
  callSync(a3);
  ck('极小单价 × 大个数 → 数值得出且不溢出为 NaN', !String(a3.totalEl.value).includes('NaN'), `总价="${a3.totalEl.value}"`);

  const a4 = makeGiftApp(sandbox, { unit: '12', qty: '1' });
  callSync(a4);
  ck('个数为 1 → 总价等于单价', String(a4.totalEl.value) === '12', `总价="${a4.totalEl.value}"`);

  const a5 = makeGiftApp(sandbox, { unit: '100', qty: '3' });
  callSync(a5);
  ck('整数结果不带小数点尾巴', String(a5.totalEl.value) === '300', `总价="${a5.totalEl.value}"`);
}

console.log('\n② 任一为空：不写脏数据，且不把用户的钱清掉');
{
  const a1 = makeGiftApp(sandbox, { unit: '5', qty: '' });
  callSync(a1);
  ck('只填单价（没填个数）→ 不写总价', String(a1.totalEl.value) === '', `总价="${a1.totalEl.value}"`);
  ck('  └ 且一次都没写过总价（不是先写后清）', !a1.writes.some(w => w.key === 'totalPrice'));

  const a2 = makeGiftApp(sandbox, { unit: '', qty: '10' });
  callSync(a2);
  ck('只填个数（没填单价）→ 不写总价', String(a2.totalEl.value) === '', `总价="${a2.totalEl.value}"`);

  // ★ 反面：用户手填的总价不能被当礼物结果清掉
  const a3 = makeGiftApp(sandbox, { unit: '5', qty: '', total: '999' });
  a3._lastGiftComputedTotal = null; // 999 不是算式算的
  callSync(a3);
  ck('用户手填的总价 999 → 必须留着', String(a3.totalEl.value) === '999', `总价="${a3.totalEl.value}"`);

  // 正面：上一步是算式算出来的，这一步清空个数 → 该清
  const a4 = makeGiftApp(sandbox, { unit: '5', qty: '10' });
  callSync(a4);
  ck('  └ 先算出 50', String(a4.totalEl.value) === '50');
  a4.qtyEl.value = '';
  callSync(a4);
  ck('清空个数 → 算式算出的 50 被清掉（不留残影）', String(a4.totalEl.value) === '', `总价="${a4.totalEl.value}"`);
}

console.log('\n③ 改一个值，总价跟着变（联动方向两个都要通）');
{
  // 先单价后个数（真实用户最常见的顺序，也是曾经坏掉的顺序）
  const a1 = makeGiftApp(sandbox, { unit: '5', qty: '' });
  callSync(a1);
  a1.qtyEl.value = '10';
  callSync(a1);
  ck('先填单价 5、再填个数 10 → 总价 50（顺序敏感 bug 已修）', String(a1.totalEl.value) === '50', `总价="${a1.totalEl.value}"`);

  // 先个数后单价
  const a2 = makeGiftApp(sandbox, { unit: '', qty: '10' });
  callSync(a2);
  a2.unitEl.value = '5';
  callSync(a2);
  ck('先填个数 10、再填单价 5 → 总价 50（反顺序也通）', String(a2.totalEl.value) === '50', `总价="${a2.totalEl.value}"`);

  // 改个数
  const a3 = makeGiftApp(sandbox, { unit: '5', qty: '10' });
  callSync(a3);
  a3.qtyEl.value = '3';
  callSync(a3);
  ck('个数改 3 → 总价跟着变 15', String(a3.totalEl.value) === '15', `总价="${a3.totalEl.value}"`);

  // 改单价
  const a4 = makeGiftApp(sandbox, { unit: '5', qty: '10' });
  callSync(a4);
  a4.unitEl.value = '8';
  callSync(a4);
  ck('单价改 8 → 总价跟着变 80', String(a4.totalEl.value) === '80', `总价="${a4.totalEl.value}"`);
}

console.log('\n③.5 用户手填总价 → 算式必须交出控制权');
{
  // 真实事故：礼物 5×10 算出 50，用户手动改成 999（也许另有减免），
  // 随后点模式按钮 —— 输入框 blur 触发一次重算，999 被 50 盖回去。
  // 用户的钱被程序改掉了。修法：总价框自己触发时标记「用户已手填」，此后不再覆盖。
  const a = makeGiftApp(sandbox, { unit: '5', qty: '10' });
  callSync(a);
  ck('先算出 50', String(a.totalEl.value) === '50', `总价="${a.totalEl.value}"`);

  // 模拟用户在总价框里手填 999（输入流以 source='totalPrice' 通知）
  a.totalEl.value = '999';
  callSync(a, { source: 'totalPrice' });
  ck('用户手填 999 → 算式立即让位，不去覆盖', String(a.totalEl.value) === '999', `总价="${a.totalEl.value}"`);

  // 之后任何一次重算（blur / 切模式）都不能把它盖回去
  callSync(a);
  ck('后续重算（blur 触发）→ 999 仍然在', String(a.totalEl.value) === '999', `总价="${a.totalEl.value}"`);

  // 用户回头动单价 / 个数 → 控制权交还算式
  const b = makeGiftApp(sandbox, { unit: '5', qty: '10' });
  callSync(b);
  b.totalEl.value = '999';
  callSync(b, { source: 'totalPrice' });
  callSync(b, { source: 'autoUnitPrice' });
  ck('用户重新去动单价 → 算式重新接管', String(b.totalEl.value) === '50', `总价="${b.totalEl.value}"`);

  const c = makeGiftApp(sandbox, { unit: '5', qty: '10' });
  callSync(c);
  c.totalEl.value = '999';
  callSync(c, { source: 'totalPrice' });
  c.qtyEl.value = '4';
  callSync(c, { source: 'giftQuantity' });
  ck('用户重新去动个数 → 算式重新接管', String(c.totalEl.value) === '20', `总价="${c.totalEl.value}"`);
}

console.log('\n④ 非礼物模式：一律不参与');{
  const a1 = makeGiftApp(sandbox, { mode: 1, unit: '5', qty: '10' });
  callSync(a1);
  ck('单子码单下填了单价与个数 → 不写总价', String(a1.totalEl.value) === '', `总价="${a1.totalEl.value}"`);
  ck('  └ 且没有任何写入动作', a1.writes.length === 0, JSON.stringify(a1.writes));

  const a2 = makeGiftApp(sandbox, { mode: 3, unit: '5', qty: '10' });
  callSync(a2);
  ck('其余模式（非礼物）下同样不参与', String(a2.totalEl.value) === '', `总价="${a2.totalEl.value}"`);
}

console.log('\n⑤ 容错：坏数据不得抛错、不得写出乱码');
{
  const cases = [
    ['单价填字母', { unit: 'abc', qty: '10' }],
    ['个数填字母', { unit: '5', qty: 'abc' }],
    ['单价填负号', { unit: '-5', qty: '10' }],
    ['个数填 0', { unit: '5', qty: '0' }],
    ['单价超长数字', { unit: '999999999', qty: '9999' }],
    ['单价填空格', { unit: '   ', qty: '10' }]
  ];
  cases.forEach(([name, cfg]) => {
    let threw = false;
    let val = null;
    try {
      const a = makeGiftApp(sandbox, cfg);
      callSync(a);
      val = String(a.totalEl.value);
    } catch (e) {
      threw = true;
    }
    ck(`${name} → 不抛错、不写 NaN/Infinity`, !threw && !/NaN|Infinity/.test(String(val)), `总价="${val}"`);
  });
}

console.log('\n⑥ 显隐控制：单子码单下不能露出来');
{
  // 曾经的做法是 CSS 类，会被十几条同名字号/尺寸规则轮流盖回来。
  // 现在唯一真源是 hidden 属性 —— 断言样式表里不再有这两个控件的 display 切换规则。
  const noClassHide = !/#autoPricePanel\s+\.gift-quantity-input\s*{[^}]*display\s*:\s*none/.test(html)
    && !/#autoPricePanel\.gift-mode-panel[^{]*{[^}]*display\s*:\s*(flex|block)/.test(html);
  ck('样式表里不再用 display 规则切换这两个控件的显隐', noClassHide);

  const hasNotHidden = /\.ap-times:not\(\[hidden\]\)[\s\S]{0,120}?gift-quantity-input:not\(\[hidden\]\)[\s\S]{0,80}?display:\s*flex\s*!important/.test(html);
  ck('可显示时的样式用 :not([hidden]) 收口（不再与 hidden 抢优先级）', hasNotHidden);

  const setsHidden = /updateGiftPriceRow\(isGiftMode\)[\s\S]{0,2200}?el\.hidden\s*=\s*!giftMode/.test(html);
  ck('切形态时真的在设置 hidden（JS 是唯一真源）', setsHidden);

  // 初次加载也必须是不显示 —— 依赖注入时的 hidden 初值与切形态时的兜底
  const initialHidden = /id="giftQuantity"[^>]*\bhidden\b/.test(html)
    || /id: 'giftQuantity'[\s\S]{0,240}?hidden/.test(html);
  ck('个数框初始即为隐藏（不显示靠初值也不靠等切换）', initialHidden);
}

console.log('\n⑦ 刷新链路：输入变化必须真的能触发到算钱');
{
  // 文案对不对是一回事，**有没有人去调它**是另一回事。
  // 若 handleMainInput 里的调用被删，总价会永远算不出来，且不会报错。
  const mainInputCall = /handleMainInput\(key, input[\s\S]{0,1600}?this\.app\.syncGiftUnitPriceTotal\?\.\(\{ source: key \}\)/.test(html);
  ck('输入流（handleMainInput）会触发重算，且把「哪个框在动」传下去', mainInputCall);

  const coversKeys = /key === 'totalPrice' \|\| key === 'autoUnitPrice' \|\| key === 'giftQuantity'/.test(html);
  ck('  └ 且单价、个数两个键都在触发条件里', coversKeys);

  const hasBridge = html.includes('syncGiftUnitPriceTotal(...args) { return this.modeFlowFeature.syncGiftUnitPriceTotal(...args); }');
  ck('app 门面上挂了 syncGiftUnitPriceTotal 转发', hasBridge);

  const hasBridge2 = html.includes('updateGiftPriceRow(...args) { return this.modeFlowFeature.updateGiftPriceRow(...args); }');
  ck('app 门面上挂了 updateGiftPriceRow 转发', hasBridge2);

  const switchCall = /updateDiscountModeHint\(\)[\s\S]{0,1400}?this\.updateGiftPriceRow\(isGiftMode\)/.test(html);
  ck('切换单子/礼物码单时会切这一排的形态', switchCall);

  // ★ 动态注入元素的补绑：这是「先单价后个数不出结果」那个 bug 的根因
  const hasLateBind = /bindLateInjectedInputs\(\)\s*{[\s\S]{0,900}?inputFlowBound/.test(html);
  ck('存在补绑机制（动态注入的个数框才能绑上事件）', hasLateBind);

  const lateBindCalled = /this\.inputFlowFeature\.bindLateInjectedInputs\?\.\(\)/.test(html);
  ck('  └ 且在这排控件注入 DOM 之后被调用', lateBindCalled);

  // 补绑必须幂等：否则每切一次模式就多绑一层，算一次变算三次
  const idempotent = /inputFlowBound === 'true'\)\s*return;[\s\S]{0,200}?inputFlowBound = 'true'/.test(html);
  ck('补绑是幂等的（重复调用不会叠加绑定）', idempotent);

  // 反面：不能在这个类里再单独绑一次（那样会和输入流的绑定叠成算两次）
  let autoPriceSrc = '';
  const apStart = html.indexOf('class AutoPriceFeature');
  if (apStart >= 0) {
    let i = html.indexOf('{', apStart);
    let depth = 0;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') { depth--; if (depth === 0) break; }
    }
    autoPriceSrc = html.slice(apStart, i + 1);
  }
  ck('没有在这个类里重复绑一次个数框（避免算两次）',
    autoPriceSrc.length > 0 && !/addEventListener\(\s*'input'/.test(autoPriceSrc));
}

console.log('\n⑧ 个数框不进 Enter 跳转序列（不干扰原键盘流）');
{
  const inOrder = /getInputFlowFieldOrder\(\)\s*{[\s\S]{0,1200}?giftQuantity/.test(html);
  ck('个数框不在 Enter 跳转顺序里', !inOrder);
}

console.log('\n⑨ 反向验证：把功能拆掉后，断言必须变红');
{
  // 反向 1：让算钱函数永远不写总价（等价于退回 8.3.38 的「填了不算」）
  const noCompute = html.replace(
    /const total = unit \* qty;[\s\S]*?return true;/,
    'return false;'
  );
  let caught = false;
  try {
    const sb = buildGiftEngine(noCompute);
    const a = makeGiftApp(sb, { unit: '5', qty: '10' });
    const inst = new sb.GiftEngineStub();
    inst.currentMode = 2;
    inst.el = a.el;
    inst.app = a;
    inst._lastGiftComputedTotal = null;
    inst.syncGiftUnitPriceTotal();
    // 旧行为下总价应保持空 —— 即正向断言本该失败
    caught = String(a.totalEl.value) === '50';
  } catch (e) {
    caught = false;
  }
  ck('拆掉算钱逻辑后，正向断言确实会失败（不是假的绿）', caught === false);

  // 反向 2：把 hidden 控制删掉，显隐断言必须变红
  const noHidden = html.replace(/if \(el && el\.hidden === giftMode\) el\.hidden = !giftMode;/, '');
  ck('删掉 hidden 控制后，显隐断言确实会失败',
    !/updateGiftPriceRow\(isGiftMode\)[\s\S]{0,2200}?el\.hidden = !giftMode/.test(noHidden));

  // 反向 3：把补绑调用删掉，补绑断言必须变红
  const noLateCall = html.replace('this.inputFlowFeature.bindLateInjectedInputs?.();', '');
  ck('删掉补绑调用后，链路断言确实会失败',
    !(/this\.inputFlowFeature\.bindLateInjectedInputs\?\.\(\)/.test(noLateCall)));

  // 反向 4：把输入流的触发条件删掉，链路断言必须变红
  const noTrigger = html.replace("if (key === 'totalPrice' || key === 'autoUnitPrice' || key === 'giftQuantity') {", 'if (false) {');
  ck('删掉输入流触发条件后，链路断言确实会失败',
    !/key === 'totalPrice' \|\| key === 'autoUnitPrice' \|\| key === 'giftQuantity'/.test(noTrigger));

  // 反向 5：改成用户手填也被无条件清掉，反面断言必须变红
  const tooAggressive = html.replace(
    /const totalEl2 = this\.el\?\.inputs\?\.totalPrice;[\s\S]*?_lastGiftComputedTotal = null;/,
    'this.app.inputFlowFeature?.setInputValue?.(\'totalPrice\', \'\', { source: \'giftUnitPrice\' }); this._lastGiftComputedTotal = null;'
  );
  let userMoneyKept = true;
  try {
    const sb = buildGiftEngine(tooAggressive);
    const a = makeGiftApp(sb, { unit: '5', qty: '', total: '999' });
    const inst = new sb.GiftEngineStub();
    inst.currentMode = 2;
    inst.el = a.el;
    inst.app = a;
    inst._lastGiftComputedTotal = null;
    inst.syncGiftUnitPriceTotal();
    userMoneyKept = String(a.totalEl.value) === '999';
  } catch (e) {
    userMoneyKept = true;
  }
  ck('改成无条件清总价后，「手填 999 要留着」断言确实会失败', userMoneyKept === false);

  // 反向 6：把「用户手填」这条通道拆掉（不认 source='totalPrice'），
  // 则「999 不被覆盖」断言必须变红 —— 这正是 8.3.39 修掉的那个真实事故。
  const noUserPriority = html.replace(
    /if \(options\.source === 'totalPrice'\) \{[\s\S]{0,200}?\}/,
    'if (false) {}'
  );
  let stillRespected = true;
  try {
    const sb = buildGiftEngine(noUserPriority);
    const a = makeGiftApp(sb, { unit: '5', qty: '10' });
    const inst = new sb.GiftEngineStub();
    inst.currentMode = 2;
    inst.el = a.el;
    inst.app = a;
    inst._lastGiftComputedTotal = null;
    inst._giftTotalUserEdited = false;
    inst.syncGiftUnitPriceTotal();
    a.totalEl.value = '999';
    inst._lastGiftComputedTotal = a.totalEl.value === '50' ? '50' : inst._lastGiftComputedTotal;
    inst.syncGiftUnitPriceTotal({ source: 'totalPrice' });
    stillRespected = String(a.totalEl.value) === '999';
  } catch (e) {
    stillRespected = true;
  }
  ck('拆掉「用户手填优先」后，999 被覆盖的断言确实会失败', stillRespected === false);
}

console.log('\n═════ 判定 ═════');
if (fail) {
  console.log(` 失败 ${fail} 项`);
  process.exit(1);
}
console.log(' 全部通过（单价×个数算得对、该清的清、该留的留、断言不是假的绿）');
