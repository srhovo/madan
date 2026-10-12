#!/usr/bin/env node
/**
 * 「赛季配对切换」端到端回归验证（真实 DOM + 真实 Feature）。
 *
 * 复现用户报的现象：切到「常驻」后仍然用不了它，服务类型候选取到的
 * 全是「赛季初」的价。
 *
 * 用法：node tests/season-pair-switch.js [index.html 路径]
 * 退出码：0 全部通过 / 1 有断言失败
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = path.resolve(process.argv[2] || path.join(__dirname, '..', 'index.html'));
const html = fs.readFileSync(HTML, 'utf8');

let fail = 0;
const ck = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const nm = n => String(n || '').replace('下次见CLUB·', '');

async function boot(source) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('jsdomError: ' + (e && e.message || e)));
  const dom = new JSDOM(source, {
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
      w.HTMLCanvasElement.prototype.getContext = function () {
        return { measureText() { return { width: 0 }; }, fillRect() {}, clearRect() {} };
      };
      w.fetch = () => Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' });
    },
  });
  const w = dom.window;
  for (let i = 0; i < 200 && !w.orderCalculator; i++) await wait(25);
  const app = w.orderCalculator;
  if (!app) throw new Error('应用未初始化：' + errors.slice(0, 3).join(' / '));
  await wait(200);
  return { dom, w, app, store: app.priceLibraryStore };
}

function useLibraries(app, store, data) {
  const normalized = store.normalizeData(data);
  app.priceLibraries = normalized;
  if (app.priceMemoryFeature) app.priceMemoryFeature.priceLibraries = normalized;
  if (app.priceRuleEditorFeature) app.priceRuleEditorFeature.priceLibraries = normalized;
  store.persist(normalized, {});
  app.priceRuleEditorFeature?.updatePriceLibraryUI?.({ forceName: true });
  return normalized;
}

/* 造两个赛季对库：
     常驻  = 鹅鸭杀 ¥40 / 树洞 ¥42 / 挂麦 ¥25
     赛季初 = 鹅鸭杀 ¥35 / 树洞 ¥48 / 哄睡 ¥45
   两边都有「鹅鸭杀」「树洞」且价不同 —— 用来分辨究竟取到了谁的价。 */
function buildPair(app, store, w) {
  /* 库顺序刻意做成 [赛季初, 常驻] —— 与用户线上的真实顺序一致。
     这一点是复现的关键：出问题的分支只在「当前库不是 libraries[0]」时才暴露。 */
  const seed = store.normalizeData(JSON.parse(w.localStorage.getItem('pw_ultimate_priceLibraries') || 'null'));
  const data = JSON.parse(JSON.stringify(seed));
  const first = data.libraries[0];
  first.name = '下次见CLUB·赛季初';
  first.items = [
    { serviceType: '鹅鸭杀', unitPrice: 35, settleType: 'hour' },
    { serviceType: '树洞', unitPrice: 48, settleType: 'hour' },
    { serviceType: '哄睡', unitPrice: 45, settleType: 'hour' },
  ];
  first.rules = [];
  first.surcharges = [];
  first.giftMemories = [];
  first.updatedAt = Date.now();
  data.libraries = [first];
  data.activeLibraryId = first.id;
  data.mergedLibraryIds = [first.id];
  useLibraries(app, store, data);
  const seasId = first.id;

  const r = store.createLibrary(useLibraries(app, store, data), '下次见CLUB·常驻');
  if (!r.ok) throw new Error('建常驻库失败：' + r.reason);
  const d2 = r.data;
  const permId = d2.activeLibraryId;
  const perm = d2.libraries.find(l => l.id === permId);
  perm.items = [
    { serviceType: '鹅鸭杀', unitPrice: 40, settleType: 'hour' },
    { serviceType: '树洞', unitPrice: 42, settleType: 'hour' },
    { serviceType: '挂麦', unitPrice: 25, settleType: 'hour' },
  ];
  perm.rules = [];
  /* createLibrary 会把新库自动纳入查价范围（既有设计）。这里显式收敛成
     「只勾了常驻」，模拟用户的真实起点。 */
  d2.mergedLibraryIds = [permId];
  useLibraries(app, store, d2);
  return { permId, seasId };
}

function mergedNames(app, store) {
  return store.getMergedLibraries(app.priceLibraries).map(l => nm(l.name));
}
function activeName(app, store) {
  return nm(store.getActiveLibrary(app.priceLibraries)?.name || '');
}
function priceOf(app, store, w, svc, settle) {
  const data = store.normalizeData(app.priceLibraries);
  const merged = store.getMergedLibraries(app.priceLibraries);
  const matcher = w.eval('PriceRuleMatcher');
  const r = matcher.matchActiveLibrary({ ...data, mergedLibraries: merged }, svc, settle);
  return r.ok ? { price: r.unitPrice, lib: nm(r.libraryName) } : { price: null, lib: '', code: r.code };
}

(async () => {
  console.log(`源文件：${HTML}`);
  console.log('═════ 赛季配对切换 · 端到端验证 ═════\n');
  const { dom, w, app, store } = await boot(html);
  const doc = w.document;
  const { permId, seasId } = buildPair(app, store, w);

  console.log('① 初始状态（赛季对已识别）');
  const groups = store.buildSeasonalGroups(app.priceLibraries);
  ck('两个库被识别成一对赛季配对', groups.has(permId) && groups.has(seasId),
    [...groups.keys()].length + ' 个库有配对');
  ck('当前库 = 常驻', activeName(app, store) === '常驻', activeName(app, store));
  ck('查价范围 = [常驻]', mergedNames(app, store).join(',') === '常驻', mergedNames(app, store).join(','));

  // ② 点 ⟳ 切到赛季初
  console.log('\n② 点 ⟳ 标签切到「赛季初」');
  app.priceRuleEditorFeature.updatePriceLibraryUI({ forceName: true });
  const tag = doc.querySelector('[data-library-season]');
  ck('折叠态下画出了 ⟳ 切换标签', !!tag, tag ? tag.textContent.trim() : '(无)');
  if (tag) {
    tag.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(120);
  }
  ck('切换后当前库 = 赛季初', activeName(app, store) === '赛季初', activeName(app, store));
  ck('切换后查价范围 = [赛季初]', mergedNames(app, store).join(',') === '赛季初', mergedNames(app, store).join(','));
  let p = priceOf(app, store, w, '鹅鸭杀', 'hour');
  ck('查「鹅鸭杀」取到赛季初的价 ¥35', p.price === 35, `¥${p.price} 来自 ${p.lib}`);

  // ③ 点整行切回常驻（本次修复的核心路径）
  console.log('\n③ 点「常驻」那一行切回来（修复前这条路不会收敛查价范围）');
  const rowPick = doc.querySelector(`[data-library-pick="${permId}"]`);
  ck('折叠态下能拿到常驻行的点击入口（若被折叠则先展开）', !!rowPick, rowPick ? '可点' : '(被折叠)');
  if (rowPick) {
    rowPick.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(120);
  } else {
    // 折叠态只画当前库那一行：先展开再点
    const exp = doc.querySelector('[data-library-expand]');
    if (exp) { exp.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); await wait(80); }
    const rp2 = doc.querySelector(`[data-library-pick="${permId}"]`);
    rp2?.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(120);
  }
  ck('切回后当前库 = 常驻', activeName(app, store) === '常驻', activeName(app, store));
  ck('切回后查价范围 = [常驻]（不含赛季初）',
    mergedNames(app, store).join(',') === '常驻', mergedNames(app, store).join(','));
  p = priceOf(app, store, w, '鹅鸭杀', 'hour');
  ck('查「鹅鸭杀」取到常驻的价 ¥40', p.price === 40, `¥${p.price} 来自 ${p.lib}`);
  p = priceOf(app, store, w, '树洞', 'hour');
  ck('查「树洞」取到常驻的价 ¥42', p.price === 42, `¥${p.price} 来自 ${p.lib}`);
  p = priceOf(app, store, w, '挂麦', 'hour');
  ck('查常驻独有项目「挂麦」能查到 ¥25', p.price === 25, `¥${p.price} 来自 ${p.lib}`);

  // ④ 卡死态：当前库=常驻，查价范围却停在赛季初
  console.log('\n④ 直接制造「卡死态」：当前库=常驻、查价范围=[赛季初]');
  {
    const d = store.normalizeData(JSON.parse(JSON.stringify(app.priceLibraries)));
    d.activeLibraryId = permId;
    d.mergedLibraryIds = [seasId];
    useLibraries(app, store, d);
    ck('查价名单首个 = 当前库「常驻」', mergedNames(app, store)[0] === '常驻', mergedNames(app, store).join(','));
    ck('查价名单里没有重复库',
      new Set(store.getMergedLibraries(app.priceLibraries).map(l => l.id)).size
      === store.getMergedLibraries(app.priceLibraries).length);
    for (const [svc, want] of [['鹅鸭杀', 40], ['树洞', 42], ['挂麦', 25]]) {
      const q = priceOf(app, store, w, svc, 'hour');
      ck(`卡死态下查「${svc}」仍取常驻价 ¥${want}`, q.price === want, `¥${q.price} 来自 ${q.lib}`);
    }
  }

  // ⑤ 第三方库当当前库（8.3.52 曾把当前库整条漏掉）
  console.log('\n⑤ 当前库是赛季对之外的第三方库');
  {
    let d = store.normalizeData(JSON.parse(JSON.stringify(app.priceLibraries)));
    let r = store.createLibrary(d, '默认价格表');
    d = r.data;
    const thirdId = d.activeLibraryId;
    d.libraries.find(l => l.id === thirdId).items = [{ serviceType: '其他手游', unitPrice: 45, settleType: 'hour' }];
    d.mergedLibraryIds = [permId, seasId];
    d.activeLibraryId = thirdId;
    useLibraries(app, store, d);
    ck('查价名单首个 = 第三方当前库「默认价格表」',
      mergedNames(app, store)[0] === '默认价格表', mergedNames(app, store).join(','));
    ck('第三方当前库也在名单里',
      mergedNames(app, store).includes('默认价格表'));
    ck('无重复',
      new Set(store.getMergedLibraries(app.priceLibraries).map(l => l.id)).size
      === store.getMergedLibraries(app.priceLibraries).length);
    const q = priceOf(app, store, w, '其他手游', 'hour');
    ck('第三方库自己的项目能取到 ¥45', q.price === 45, `¥${q.price} 来自 ${q.lib}`);
  }

  console.log('\n═════ 判定 ═════');
  console.log(fail ? ` 失败 ${fail} 项` : ' 全部通过');
  try { dom.window.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('运行异常：', e); process.exit(1); });
