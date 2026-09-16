#!/usr/bin/env node
/**
 * 历史记录「编辑回填」详情同步专项验证
 *
 * 背景（为什么需要这一套）：
 *   8.3.37 修复了一个长期存在的隐性缺陷 —— 从历史记录点「编辑」回填后，
 *   右侧结果区（总价 / 团抽 / 派抽 / 到手）与备注里的「项目小计 / 时长小计」
 *   不会立即刷新，仍停留在上一条的内容或为空；用户必须再点一下某个输入框、
 *   再点掉，内容才会突然正确显示。
 *
 *   根因：HistoryFeature.editHistoryItem() 调 populateOrderForm 时传了
 *   recalculate:false，跳过了那一次重算；而「项目小计 / 时长小计」这两行详情
 *   是 autoPriceFeature.syncUI() 在重算过程中写出来的，于是它们停在旧值。
 *
 *   这一套验证同时做两件事：
 *   ① 正向：编辑回填后，结果区与详情应当【立刻】正确，无需任何额外点击；
 *   ② 反向：把 recalculate 改回 false（还原旧行为）后，本套件必须变红。
 *      没有 ②，本套件就只是一堆恒真的假断言 —— 项目历史上踩过这个坑
 *      （见 tests/README.md：初版 114/114 全绿但捕捉率仅 1/9）。
 *
 * 用法: node tests/history-refill.js [index.html]
 * 退出码: 0 通过 / 1 失败
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = process.argv[2] || path.join(ROOT, 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, actual) {
  if (ok) { pass += 1; console.log(`    ✓ ${name}${actual !== undefined ? '  ' + fmt(actual) : ''}`); }
  else { fail += 1; failures.push(name); console.log(`    ✗ ${name}  ${fmt(actual)}`); }
}
function fmt(v) {
  if (v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? '' : String(s).slice(0, 160);
}
function section(title) { console.log(`\n  ${title}`); }

const wait = ms => new Promise(r => setTimeout(r, ms));

/** 用给定 HTML 启动一次应用，返回 { w, app, errs } */
async function boot(src) {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push('jsdomError: ' + String((e && e.message) || e)));
  vc.on('error', e => errs.push('console.error: ' + String(e)));
  const dom = new JSDOM(src, {
    url: 'https://madan.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.alert = () => {};
      w.confirm = () => true;
      w.prompt = () => '';
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.requestAnimationFrame = cb => w.setTimeout(() => cb(Date.now()), 0);
      w.cancelAnimationFrame = id => w.clearTimeout(id);
      w.requestIdleCallback = cb => w.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
      w.visualViewport = { height: 800, width: 400, addEventListener() {}, removeEventListener() {} };
      w.navigator.clipboard = { writeText: async () => {}, readText: async () => '' };
      w.document.execCommand = () => true;
      w.URL.createObjectURL = () => 'blob:test';
      w.URL.revokeObjectURL = () => {};
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.Element.prototype.scrollIntoView = function () {};
      w.HTMLMediaElement.prototype.pause = function () {};
      w.HTMLMediaElement.prototype.load = function () {};
      w.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      w.HTMLCanvasElement.prototype.getContext = function () { return { measureText() { return { width: 0 }; }, fillRect() {}, clearRect() {} }; };
      w.fetch = () => Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' });
    }
  });
  const w = dom.window;
  for (let i = 0; i < 200 && !w.orderCalculator; i++) await wait(25);
  const app = w.orderCalculator;
  if (!app) throw new Error('app 未初始化');
  await wait(150);
  if (typeof app.ensureLazyFeature === 'function' && app.lazyFeatures) {
    for (const name of Object.keys(app.lazyFeatures)) {
      try { await app.ensureLazyFeature(name); } catch (e) { errs.push('lazy:' + name + ':' + e.message); }
    }
  }
  await wait(200);
  return { w, app, errs };
}

/** 造「多项目」历史订单 —— 这是会暴露该缺陷的形态。
 *  为什么必须用多项目：单项目的「类型 / 时长」是分别写进两个输入框的，
 *  回填时本身就会显示；而「项目小计 / 时长小计」这两行详情【只有多项目才有】，
 *  且完全由 autoPriceFeature.syncUI() 在重算过程中写出 —— 这正是旧版不刷新的那部分。
 *
 *  注意：单价 × 数量必须与 subtotal 对得上，否则回填重算后总价与 subtotal 不等，
 *        验证就失去意义（这层一致性本身就是「详情靠重算写出」的证明）。 */
function seedHistory(app, w) {
  const stamp = new Date().toISOString();
  const project = (id, svc, qty, unit, hours) => ({
    id,
    quantityRaw: qty,
    quantityMode: 'hour',
    serviceRaw: svc,
    serviceDisplay: svc,
    baseUnitPrice: unit,
    unitPrice: unit,
    subtotal: unit * hours,
    settleType: 'hour',
    durationMinutes: hours * 60,
    surcharges: [],
    entrySource: 'manual',
    createdAt: id
  });
  // 三条多项目记录，服务名与总价各不相同，便于识别「是否停在上一条」
  const rows = [
    { pei: '陪陪A', projects: [project('a1', '技术陪', '1h', 100, 1), project('a2', '娱乐陪', '2h', 50, 2)], total: 200 },
    { pei: '陪陪B', projects: [project('b1', '上分陪', '3h', 100, 3), project('b2', '聊天单', '1h', 100, 1)], total: 400 },
    { pei: '陪陪C', projects: [project('c1', '新手陪', '5h', 100, 5), project('c2', '教学单', '2h', 50, 2)], total: 600 }
  ];
  app.history = rows.map((row, i) => ({
    historySchemaVersion: 4,
    mode: 1,
    totalPrice: row.total,
    totalDurationMinutes: row.projects.reduce((s, p) => s + p.durationMinutes, 0),
    projects: row.projects,
    surchargeApplications: [],
    priceLibrary: null,
    discount: '',
    discountInput: '',
    discountOverlay: '',
    discountOverlayInput: '',
    appliedDiscount: 1,
    paiDan: `派单${i + 1}`,
    peiPei: row.pei,
    boss: `老板${i + 1}`,
    type: row.projects.map(p => `${p.quantityRaw}${p.serviceRaw}`).join('+'),
    duration: '',
    note: '',
    noteRaw: '',
    surchargeRaw: '',
    noteDisplayBase: '',
    noteDisplay: '',
    timestamp: stamp,
    _seedIndex: i
  }));
  try { app.historyFeature.save(app.history); } catch (e) { /* 落盘失败不影响内存态验证 */ }
  return app.history;
}

(async () => {
  console.log('===================================================================');
  console.log(' 历史记录「编辑回填」详情同步专项验证');
  console.log('===================================================================');

  // ────────────────────────────────────────────────────────────────
  section('【1】正向：编辑回填后，结果区与详情应当立刻正确');
  // ────────────────────────────────────────────────────────────────
  const { w, app, errs } = await boot(html);
  const doc = w.document;
  const txt = id => (doc.getElementById(id) || {}).textContent;
  const val = id => (doc.getElementById(id) || {}).value;

  seedHistory(app, w);
  app.historyFeature.updateUI();
  await wait(120);

  // 先切到第 1 条作为背景态，再编辑第 2 条，确保「变化」是可观测的
  app.historyFeature.loadFromHistory(0);
  await wait(150);
  const baselineTotal = txt('discountedPrice');
  const baselinePei = val('peiPei');

  // 点「编辑」第 2 条（陪陪B / 400）
  const okEdit = app.historyFeature.editHistoryItem(1);
  check('编辑第 2 条历史成功返回', okEdit === true, okEdit);
  await wait(250);

  check('总价（结果区）立刻显示为 400，而非上一条',
    txt('discountedPrice') === '400', `实际 ${txt('discountedPrice')}（上一条是 ${baselineTotal}）`);
  check('陪陪立刻换为 陪陪B，而非上一条',
    val('peiPei') === '陪陪B', `实际 ${val('peiPei')}（上一条是 ${baselinePei}）`);
  check('订单文本总价立刻为 400',
    /总价：400\b/.test(String(txt('orderOutput'))), (String(txt('orderOutput')).match(/总价：[^\n]*/) || [''])[0]);

  // 关键差异点：多项目的「项目小计 / 时长小计」详情由重算写出，旧版正是它不刷新。
  // 它们渲染在 priceSubtotalNote / durationSubtotalNote 两个独立元素里（不是备注输入框）。
  const noteText = String(txt('priceSubtotalNote') || '');
  const durNote = String(txt('durationSubtotalNote') || '');
  check('「项目小计」详情已写出（旧版此处为空）',
    noteText.includes('项目小计'), `priceSubtotalNote=${JSON.stringify(noteText)}`);
  check('「项目小计」数值为第 2 条的 300 + 100',
    /300\s*\+\s*100/.test(noteText), noteText.replace(/\n/g, ' / '));
  check('累计总价显示为 400',
    /累计\s*400/.test(noteText), noteText.replace(/\n/g, ' / '));
  check('「时长小计」详情已写出',
    durNote.includes('时长小计'), `durationSubtotalNote=${JSON.stringify(durNote)}`);

  // ★ 这条是整套验证的核心：不做任何额外点击。
  // 旧行为坏的是「右侧结果区」（总价/团抽/派抽/到手）—— 它会一直停在编辑前那一条，
  // 必须用户再点一下输入框、触发一次重算才会显示。这里四个数字一起验，才是完整还原。
  check('【核心】无需任何额外点击，结果区四个数字立刻全部正确',
    txt('discountedPrice') === '400' && txt('groupCommission') === '20'
    && txt('platformCommission') === '80' && txt('earnings') === '300',
    `总价=${txt('discountedPrice')} 团抽=${txt('groupCommission')} 派抽=${txt('platformCommission')} 到手=${txt('earnings')}`);
  check('【核心】无需任何额外点击，项目小计 / 时长小计立刻正确',
    /300\s*\+\s*100/.test(noteText) && /累计\s*400/.test(noteText) && /时长小计/.test(durNote),
    `项目小计=${noteText.replace(/\n/g, ' / ')}；时长小计=${durNote.replace(/\n/g, ' / ')}`);

  // 连续编辑第 3 条，验证每次都刷新（不是只有第一次生效）
  app.historyFeature.editHistoryItem(2);
  await wait(250);
  check('连续编辑第 3 条：总价立刻变 600', txt('discountedPrice') === '600', txt('discountedPrice'));
  check('连续编辑第 3 条：详情立刻变 500 + 100',
    /500\s*\+\s*100/.test(String(txt('priceSubtotalNote') || '')), String(txt('priceSubtotalNote') || '').replace(/\n/g, ' / '));

  // 回编辑第 1 条，验证反向也刷新（不是单向变化）
  app.historyFeature.editHistoryItem(0);
  await wait(250);
  check('再回编辑第 1 条：总价立刻变 200', txt('discountedPrice') === '200', txt('discountedPrice'));
  check('再回编辑第 1 条：详情立刻变 100 + 100',
    /100\s*\+\s*100/.test(String(txt('priceSubtotalNote') || '')), String(txt('priceSubtotalNote') || '').replace(/\n/g, ' / '));

  // 运行期报错：只关心业务异常，Cookie 备份超限是 jsdom 环境固有噪声（存储容量小），不算错
  const realErrs = errs.filter(e => !/Cookie 备份失败|silentCatch/.test(e));
  check('无业务运行期报错', realErrs.length === 0, realErrs.slice(0, 3));

  // ────────────────────────────────────────────────────────────────
  section('【2】反向验证：把 recalculate 改回 false 后，本套件必须变红');
  // ────────────────────────────────────────────────────────────────
  // 说明：index.html 的主脚本用 1 空格缩进（不是 2/4 空格），锚点必须按实际文本写。
  // 注意锚点刻意只取「回填调用 + 紧随其后两行」，不跨越中间那段长注释 ——
  // 注释内容将来可能被改写，不该让它把变异测试一起弄失效。
  const ANCHOR = [
    'this.populateOrderForm(order, { recalculate: true });',
    ' this.editingHistoryIndex = index;'
  ].join('\n');
  const MUTANT = [
    'this.populateOrderForm(order, { recalculate: false });',
    ' this.editingHistoryIndex = index;'
  ].join('\n');

  if (!html.includes(ANCHOR)) {
    check('变异锚点命中（能定位到 editHistoryItem 的回填调用）', false,
      '锚点未命中 —— 若 editHistoryItem 已被改写，请同步更新本套件的 ANCHOR');
  } else {
    check('变异锚点命中（能定位到 editHistoryItem 的回填调用）', true);
    const mutated = html.replace(ANCHOR, MUTANT);
    const m = await boot(mutated);
    const mtxt = id => (m.w.document.getElementById(id) || {}).textContent;
    seedHistory(m.app, m.w);
    m.app.historyFeature.updateUI();
    await wait(120);
    m.app.historyFeature.loadFromHistory(0);
    await wait(150);
    const beforeTotal = mtxt('discountedPrice');
    m.app.historyFeature.editHistoryItem(1);
    await wait(250);

    // 旧行为下唯一坏掉的是「右侧结果区」：它一直停在编辑前那一条。
    // 注意「项目小计」那行在旧行为下反而会更新 —— 因为它由输入事件触发的异步重算补上，
    // 这也正是用户所说「点一下输入框再点掉就显示了」的由来。
    // 因此反向验证必须抓「总价」，抓「项目小计」是抓不住的。
    check('「详情不刷新」的旧行为被本套件抓住（结果区总价仍停在编辑前那一条）',
      mtxt('discountedPrice') === beforeTotal && mtxt('discountedPrice') !== '400',
      `编辑前 ${beforeTotal} → 编辑后 ${mtxt('discountedPrice')}（旧行为应保持 ${beforeTotal} 不变，修复后应为 400）`);
    check('旧行为下团抽 / 派抽 / 到手同样不刷新',
      mtxt('groupCommission') !== '20',
      `团抽=${mtxt('groupCommission')}（第 2 条正确值应为 20）`);
  }

  // ────────────────────────────────────────────────────────────────
  console.log('\n===================================================================');
  if (fail === 0) {
    console.log(` 通过 ${pass} / 失败 ${fail}`);
    console.log(' === 全部通过（编辑回填详情即时刷新成立，且断言不是假的绿）===');
  } else {
    console.log(` 通过 ${pass} / 失败 ${fail}`);
    console.log(` 失败项：${failures.join('；')}`);
  }
  console.log('===================================================================');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('运行异常：', e && e.stack || e);
  process.exit(1);
});
