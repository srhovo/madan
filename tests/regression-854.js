#!/usr/bin/env node
/**
 * 8.3.54 回归防线（第 25 套）
 *
 * 这套只钉四件事，每件都配了「把修复拆掉必须变红」的反向验证 ——
 * 因为它们的共同点是「错了也不报错，只是钱/数据悄悄变了」：
 *
 *   ① 手输单价跟着项目名走，不再按「第几项」硬套（含：换项目后旧总价不得残留）
 *   ② 老板记忆「编辑中删另一条」不再把第三个人覆盖掉
 *   ③ 名字提取不再把时间/正文吃进名字（接龙 / @ / 拍一拍三种模式）
 *   ④ 输入框里 Ctrl+C 不被全局快捷键劫持；清空字段后状态灯与预览一起复位
 *
 * 用法：node tests/regression-854.js [index.html]
 * 退出码：0 全通过 / 1 有失败
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML_PATH = process.argv[2] || path.join(__dirname, '..', 'index.html');
const BASE_HTML = fs.readFileSync(HTML_PATH, 'utf8');

let fail = 0;
// 反向验证期间把结果收进 bucket，跑完再统一判定 —— 不依赖全局计数器，
// 也不会被上一个场景里延迟触发的断言污染。
let bucket = null;
const ck = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra !== undefined ? '  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`);
  if (bucket) bucket.push(Boolean(cond));
  else if (!cond) fail++;
};
const wait = ms => new Promise(r => setTimeout(r, ms));

async function boot(htmlText) {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(String((e && e.message) || e)));
  const dom = new JSDOM(htmlText, {
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
      w.navigator.clipboard = { writeText: async () => { w.__copied = (w.__copied || 0) + 1; }, readText: async () => '' };
      w.document.execCommand = () => true;
      w.URL.createObjectURL = () => 'blob:test';
      w.URL.revokeObjectURL = () => {};
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.Element.prototype.scrollIntoView = function () {};
      w.HTMLMediaElement.prototype.pause = function () {};
      w.HTMLMediaElement.prototype.load = function () {};
      w.HTMLMediaElement.prototype.play = () => Promise.resolve();
      w.HTMLCanvasElement.prototype.getContext = function () { return { measureText() { return { width: 0 }; }, fillRect() {}, clearRect() {} }; };
      w.fetch = () => Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' });
    }
  });
  const w = dom.window;
  for (let i = 0; i < 300 && !w.orderCalculator; i += 1) await wait(20);
  return { dom, w, app: w.orderCalculator, errs };
}

const setInput = (w, id, value) => {
  const el = w.document.getElementById(id);
  if (!el) return false;
  el.value = value;
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
  el.dispatchEvent(new w.Event('change', { bubbles: true }));
  return true;
};

const projectsOf = app => (app.autoPriceFeature.getOrderAggregate().projects || [])
  .map(p => ({ svc: p.serviceDisplay, unit: p.unitPrice, qty: p.quantityRaw }));

/* ─────────────── ① 手输单价跟着项目走 ─────────────── */
async function checkManualPrice(app, w) {
  console.log('\n① 手输单价不能串到别的项目');
  setInput(w, 'type', '1h甲');
  await wait(220);
  setInput(w, 'autoUnitPrice', '50');
  await wait(260);
  setInput(w, 'type', '1h甲+1h乙');
  await wait(220);
  setInput(w, 'autoUnitPrice', '25');
  await wait(260);
  ck('两项各自定价（甲50 / 乙25）', JSON.stringify(projectsOf(app).map(p => p.unit)) === '[50,25]', projectsOf(app));

  setInput(w, 'type', '2局乙');
  await wait(320);
  const after = projectsOf(app);
  ck('删掉第一项后，剩下的乙拿到的是自己的 25', after.length === 1 && after[0].unit === 25, after);

  setInput(w, 'type', '1h甲');
  await wait(200);
  setInput(w, 'autoUnitPrice', '50');
  await wait(240);
  setInput(w, 'type', '2h甲');
  await wait(320);
  const durationKeep = projectsOf(app);
  ck('只改时长（1h→2h）时价仍然保留', durationKeep.length === 1 && durationKeep[0].unit === 50, durationKeep);
}

async function checkNoStaleProjects(app, w) {
  console.log('\n①-b 换项目后旧总价不得残留');
  setInput(w, 'type', '1h甲');
  await wait(200);
  setInput(w, 'autoUnitPrice', '50');
  await wait(240);
  const before = app.autoPriceFeature.getOrderAggregate().totalPrice;
  setInput(w, 'type', '2局丙');
  await wait(360);
  const after = app.autoPriceFeature.getOrderAggregate();
  const note = String(w.document.getElementById('priceSubtotalNote')?.textContent || '');
  ck('换成没定价的项目后，总价不再带着上一项', after.totalPrice === 0, { before, after: after.totalPrice, projects: projectsOf(app) });
  ck('  └ 并且给出「第1项…」的补价提示', /第1项/.test(note), note.slice(0, 60));
}

/* ─────────────── ② 老板记忆编辑中删除 ─────────────── */
async function checkBossMemory(app) {
  console.log('\n② 老板记忆：编辑中删另一条，保存不能写错人');
  const f = app.bossMemoryFeature;
  app.bossMemory = [
    { name: '甲', paiDan: 'A', discount: 0.9 },
    { name: '乙', paiDan: 'B', discount: 0.8 },
    { name: '丙', paiDan: 'C', discount: 0.7 }
  ];
  await wait(120);
  f.edit(1);
  await wait(80);
  f.delete(0);
  await wait(120);
  const doc = app.el;
  doc.bossNameInput.value = '乙改';
  doc.bossPaiDanInput.value = 'B';
  doc.bossDiscountInput.value = '0.8';
  f.addFromEditor();
  const names = (app.bossMemory || []).map(b => b.name);
  ck('结果是「乙改 + 丙」', JSON.stringify(names) === '["乙改","丙"]', names);
  ck('  └ 丙的派单/折数没被改写', (app.bossMemory[1] || {}).paiDan === 'C' && Number(app.bossMemory[1].discount) === 0.7, app.bossMemory[1]);
}

/* ─────────────── ③ 名字提取 ─────────────── */
async function checkExtraction(app) {
  console.log('\n③ 名字提取：时间/正文不得进名字');
  const ex = async (text, mode) => (await app.extractorService.extract(text, mode)).names;
  ck('接龙「1、阿豪 8点」→ 阿豪', JSON.stringify(await ex('1、阿豪 8点', 'chain')) === '["阿豪"]');
  ck('接龙「2、小雪 20:00-22:00」→ 小雪', JSON.stringify(await ex('2、小雪 20:00-22:00', 'chain')) === '["小雪"]');
  ck('接龙「8、阿豪 20:00-22:00 技术」→ 阿豪', JSON.stringify(await ex('8、阿豪 20:00-22:00 技术', 'chain')) === '["阿豪"]');
  ck('@「@阿豪 1h」→ 阿豪', JSON.stringify(await ex('@阿豪 1h', 'at')) === '["阿豪"]');
  ck('@「@小应 在吗」→ 小应', JSON.stringify(await ex('@小应 在吗', 'at')) === '["小应"]');
  ck('@「@Flora 来」→ Flora（英文名不被当平台前缀砍）', JSON.stringify(await ex('@Flora 来', 'at')) === '["Flora"]');
  ck('同一行两条拍一拍 → 李四 / 赵六', JSON.stringify(await ex('张三拍了拍李四，王五拍了拍赵六', 'pat')) === '["李四","赵六"]');
  ck('接龙「3、Vivi」→ Vivi', JSON.stringify(await ex('3、Vivi', 'chain')) === '["Vivi"]');
}

/* ─────────────── ④ 排除词 / 快捷键 / 清空复位 ─────────────── */
async function checkExcludeWords(app) {
  console.log('\n④ 名字合法性：不再用子串误杀');
  const e = app.enhancedExtractor;
  ['Vivi', '小V', '应采儿', '宝宝巴士', '刚刚好', '技术流'].forEach(name => {
    ck(`「${name}」是合法名字`, e.isValidName(name) === true, e.isValidName(name));
  });
  ck('「拍一拍」这种噪声仍被判非法', e.isValidName('拍一拍') === false);
}

async function checkShortcutAndClear(app, w) {
  console.log('\n⑤ Ctrl+C / 清空后的状态复位');
  setInput(w, 'peiPei', '小王');
  setInput(w, 'boss', '阿强');
  setInput(w, 'totalPrice', '1000');
  await wait(120);
  app.orderFlow.commitOrder({ showSuccess: false });
  await wait(120);

  const note = w.document.getElementById('note');
  const evInField = new w.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
  note.dispatchEvent(evInField);
  ck('备注框里按 Ctrl+C 不被拦截', evInField.defaultPrevented === false);

  const evOnBody = new w.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
  w.document.body.dispatchEvent(evOnBody);
  ck('页面空白处按 Ctrl+C 仍然复制整单', evOnBody.defaultPrevented === true);

  const btn = w.document.getElementById('calculateBtn');
  app.orderFlow.syncGenerationReadiness();
  ck('填了总价 → 按钮进入「可生成」态', btn.className.includes('generation-ready'));
  app.inputFlowFeature.clearInput('totalPrice');
  await wait(160);
  ck('清空总价 → 按钮退出「可生成」态', !btn.className.includes('generation-ready'));

  setInput(w, 'totalPrice', '1000');
  setInput(w, 'discount', '0.8');
  await wait(120);
  app.orderFlow.syncGenerationReadiness();
  await wait(120);
  app.inputFlowFeature.clearInput('discount');
  await wait(200);
  const out = String(w.document.getElementById('orderOutput').textContent || '');
  ck('清空折数 → 预览按不打折重算（不是停在「请填写…」）', /总价：1000/.test(out), out.split('\n').find(l => l.startsWith('总价')) || out.slice(0, 40));
}


/* ─────────────── ⑥ 改动关联面（防连带回归） ───────────────
   本轮改动落在「单价归属 → 表达式结算 → 草稿/聚合 → 生成文本」这条链上，
   以及「库列表 DOM/布局」和「老板记忆下标」。这些上下游代码本身没改，
   但它们跟改动点共享状态，必须一起跑一遍，否则「改 A 崩 B」不会被发现。
   本节不配反向验证：它守的是「没被改动的既有能力不许退化」。 */
async function checkLinkedSurfaces(app, w) {
  console.log('\n⑥ 改动关联面（金额链 / 价格库 / 导入导出 / 时长计算器）');
  const d = w.document;
  const total = () => app.autoPriceFeature.getOrderAggregate().totalPrice;

  d.getElementById('priceMemTabBtn').click(); await wait(80);
  app.priceRuleEditorFeature.updatePriceMemoryUI();
  const add = async (type, price, settle) => {
    d.getElementById('pmServiceType').value = type;
    d.getElementById('pmUnitPrice').value = price;
    const sel = d.getElementById('pmSettleType'); if (sel) sel.value = settle;
    await app.priceRuleEditorFeature.addPriceMemoryItem();
    await wait(120);
  };
  await add('星', 80, 'hour');
  await add('局', 20, 'round');

  setInput(w, 'type', '1h星+2局局');
  await wait(400);
  ck('库价结算：1h星(80/h) + 2局局(20/局) = 120', total() === 120, total());

  setInput(w, 'surcharge', '10');
  await wait(400);
  ck('加价按单位叠加：星 +10、局 +10×2 → 150', total() === 150, total());

  setInput(w, 'discount', '8');
  app.inputFlowFeature.normalizeDiscountInputField(d.getElementById('discount'));
  setInput(w, 'peiPei', '小王 小李');
  setInput(w, 'boss', '阿强');
  setInput(w, 'paiDan', '张三');
  await wait(150);
  app.orderFlow.commitOrder({ showSuccess: false });
  await wait(200);
  const out = String(d.getElementById('orderOutput').textContent || '');
  ck('8 折 × 2 人 = 240（150 × 0.8 × 2）', /总价：\s*240/.test(out), out.split('\n').find(l => l.startsWith('总价')) || out.slice(0, 40));

  setInput(w, 'surcharge', '');
  setInput(w, 'discount', '');
  setInput(w, 'type', '');
  await wait(300);

  // 价格库：复制不崩、id 不撞、当前库不悬空
  const store = app.priceLibraryStore;
  const activeLib = store.getActiveLibrary(app.priceLibraries);
  const beforeCount = (app.priceLibraries.libraries || []).length;
  let created = null;
  try { created = store.createLibrary(app.priceLibraries, '关联面校验库', {}); } catch (e) { created = { ok: false, error: e.message }; }
  ck('新建价格库不抛错', !!(created && created.ok), created && (created.error || created.ok));
  if (created && created.ok) { app.priceLibraries = created.data; store.persist(created.data, {}); }
  const ids = (app.priceLibraries.libraries || []).map(l => l.id);
  ck('库 id 不重复（复制后也不撞）', new Set(ids).size === ids.length, ids);
  ck('当前库指针有效（不悬空）', !!(store.getActiveLibrary && store.getActiveLibrary(app.priceLibraries)));
  ck('新建后库数量 +1（结构未被带坏）', (app.priceLibraries.libraries || []).length === beforeCount + 1, { before: beforeCount, after: (app.priceLibraries.libraries || []).length });

  // 导入导出：备份生成 + 自身备份可解析（走同一条链路，不落库）
  const dp = await app.ensureLazyFeature('dataPortabilityFeature');
  let backupOk = false, parseOk = false;
  try {
    const b = dp.buildBackup(['bossMemory']);
    backupOk = !!(b && b.modules && b.modules.bossMemory);
    d.getElementById('dpImportText').value = JSON.stringify(b);
    dp.parseImport();
    parseOk = !d.getElementById('dpApplyImportBtn').disabled;
  } catch (e) { backupOk = false; parseOk = false; }
  ck('备份可生成且含老板记忆模块', backupOk);
  ck('自身备份可被解析（「应用」按钮可用）', parseOk);

  // 时长计算器：算得出结果（懒加载 chunk 与本轮无关，防连带）
  const dc = await app.ensureLazyFeature('durationCalculatorFeature');
  dc.openModal(); await wait(120);
  const box = (id, v) => { const el = d.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); } };
  box('dcStartH', '10'); box('dcStartM', '00'); box('dcEndH', '11'); box('dcEndM', '12');
  await wait(150);
  const std = d.getElementById('dcStandard');
  ck('时长计算器 10:00→11:12 有结果', !!std && std.textContent.trim() !== '', std && std.textContent.slice(0, 30));
}

/* ─────────────── 反向验证 ─────────────── */
async function expectRed(name, mutate, run) {
  const mutated = mutate(BASE_HTML);
  if (mutated === BASE_HTML) {
    ck(`反向验证「${name}」的锚点命中源码（否则本条是假绿）`, false, '锚点未命中');
    return;
  }
  const ctx = await boot(mutated);
  if (!ctx.app) {
    ck(`反向验证「${name}」可启动`, false, ctx.errs.slice(0, 1));
    return;
  }
  bucket = [];
  try {
    await run(ctx.app, ctx.w);
  } finally {
    const results = bucket;
    bucket = null;
    ck(`反向验证：拆掉「${name}」后断言确实变红`, results.includes(false));
    ctx.dom.window.close();
  }
}

(async () => {
  console.log('═════ 8.3.54 回归防线 ═════');
  const { dom, w, app, errs } = await boot(BASE_HTML);
  ck('页面启动成功', !!app, errs.slice(0, 2));
  if (!app) process.exit(1);
  await wait(250);

  await checkManualPrice(app, w);
  await checkNoStaleProjects(app, w);
  await checkBossMemory(app);
  await checkExtraction(app);
  await checkExcludeWords(app);
  await checkShortcutAndClear(app, w);
  await checkLinkedSurfaces(app, w);

  /* ── 布局守卫（源码级，不是布局验证） ─────────────────────────────
     库名那一行曾经「右侧勾选框跑到白框外」：.pm-library-list 是 grid，
     隐式列默认 auto，会按行的最小内容宽度撑开，行宽超过容器。
     真正的验证是在 Chromium 里按 320/360/375/390/412/430/768 七个宽度量的
     （scrollWidth == clientWidth、勾选框右沿 ≤ 白框右沿）。
     jsdom 没有布局引擎，这里只能做「关键声明还在不在」的守卫，
     防止以后有人把 minmax 或 min-width 删回去。 */
  console.log('\n⑦ 布局守卫（源码级，防声明被删）');
  const ruleBlock = (selector) => {
    const i = BASE_HTML.indexOf(selector + ' {');
    if (i < 0) return '';
    const j = BASE_HTML.indexOf('}', i);
    return j > i ? BASE_HTML.slice(i, j + 1) : '';
  };
  ck('.pm-library-list 用 minmax(0,1fr) 约束轨道', /grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(ruleBlock('.pm-library-list')));
  ck('.pm-library-row 允许收缩（min-width:0）', /min-width:\s*0/.test(ruleBlock('.pm-library-row')));
  ck('窄屏库名允许折行（≤430 两行 / ≤340 三行）', /@media \(max-width: 430px\)[\s\S]{0,400}-webkit-line-clamp:\s*2/.test(BASE_HTML) && /@media \(max-width: 340px\)[\s\S]{0,200}-webkit-line-clamp:\s*3/.test(BASE_HTML));

  console.log('\n⑧ 反向验证（防「假的绿」）');
  await expectRed(
    '手输价按项目名校验',
    html => html.replace('if (registered && current && registered !== current) return null;', 'if (false) return null;'),
    async (a, win) => { await checkManualPrice(a, win); }
  );
  await expectRed(
    '换项目清掉旧项目',
    html => html.replace('if (nextNames && nextNames !== currentNames) {', 'if (false) {'),
    async (a, win) => { await checkNoStaleProjects(a, win); }
  );
  await expectRed(
    '编辑位置随删除校正',
    html => html.replace('else if (this.editingIndex > index) this.editingIndex -= 1;', 'else if (false) this.editingIndex -= 1;'),
    async a => { await checkBossMemory(a); }
  );
  await expectRed(
    '剥掉名字末尾的时间',
    html => html.replace(' stripTrailingTimeToken(value) {\n const text = String(value ?? \'\');', ' stripTrailingTimeToken(value) {\n return value;\n const text = String(value ?? \'\');'),
    async a => { await checkExtraction(a); }
  );
  await expectRed(
    '输入框内放行 Ctrl+C',
    html => html.replace('if ((event.ctrlKey || event.metaKey) && !editableTarget', 'if ((event.ctrlKey || event.metaKey) && true'),
    async (a, win) => { await checkShortcutAndClear(a, win); }
  );

  console.log('\n═════ 判定 ═════');
  if (fail === 0) {
    console.log(`全部通过（${'单价不串项 / 记忆不写错人 / 名字不吃时间 / 快捷键与复位'}，且断言不是假的绿）`);
    dom.window.close();
    process.exit(0);
  }
  console.log(`失败 ${fail} 项`);
  dom.window.close();
  process.exit(1);
})().catch(error => {
  console.error('运行异常：', error && error.stack || error);
  process.exit(1);
});
