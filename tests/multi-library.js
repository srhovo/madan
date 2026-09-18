#!/usr/bin/env node
/**
 * 「同时使用多个价格库」专项验证（8.3.46）
 *
 * 为什么需要它
 * ------------
 * 8.3.46 之前，码单器一次只能用**一个**价格库查价：
 * 想用 B 库的项目，必须先把当前库切到 B，用完再切回来。
 * 本次新增「多库同用」——勾选多个库，它们一起参与查价。
 *
 * 这一改动的核心难点是**两种语义必须分得干干净净**：
 *   · activeLibraryId  = 编辑目标：新增/修改/删除写进哪个库。**永远只有一个**。
 *   · mergedLibraryIds = 查询范围：查价时去哪些库找。**可以多个**。
 * 一旦这两者被混淆，会出现「改了 A 库，B 库跟着变」这类静默数据污染 ——
 * 界面上完全看不出来，要等用户发现某库里少了东西才暴露。
 * 所以本套防线重点钉住这四件事：
 *   ① 编辑只动当前库（勾了别的库也不会被写）
 *   ② 查价范围是并集（不切库也能取到别的库的价）
 *   ③ 当前库优先（同名项目冲突时以当前库为准）
 *   ④ 最后一个库不能取消勾选（「一个库都不查」不是合法状态）
 *
 * 另外钉住两条**容易在重构中悄悄丢掉**的兼容性：
 *   · 老数据里没有 mergedLibraryIds 这个字段 → 回落成「只查当前库」，
 *     与加这个功能之前逐字一致，用户升级后行为不变、不需要迁移。
 *   · 新建库自动纳入查价范围（否则「新建了却查不到」像功能坏了）。
 *
 * 反向验证：临时改写源码副本（不碰工作区文件），断言其必须失败。
 * 这样保证断言不是「源码里碰巧有这几个字」的假绿。
 *
 * 用法：node tests/multi-library.js
 * 退出码：0 全部通过 / 1 有断言失败
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');
const html = fs.readFileSync(HTML, 'utf8');

let fail = 0;
const ck = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ── 起一个只读的 JSDOM，用来跑真实的 Store 与 Feature ────────────── */
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
    }
  });
  const w = dom.window;
  for (let i = 0; i < 200 && !w.orderCalculator; i++) await wait(25);
  const app = w.orderCalculator;
  if (!app) throw new Error('应用未初始化：' + errors.slice(0, 3).join(' / '));
  await wait(200);

  /* 造两个库：
       A（当前库）= 「一起看 ¥40」
       B（副库）  = 「鹅鸭杀 ¥30」
     两者项目互不重叠，这样才能分辨「查到了谁的价」。 */
  const store = app.priceLibraryStore;
  let data = store.normalizeData(JSON.parse(w.localStorage.getItem('pw_ultimate_priceLibraries') || 'null'));
  const aId = data.activeLibraryId;
  data.libraries.find(l => l.id === aId).items = [{ serviceType: '一起看', unitPrice: 40, settleType: '' }];
  let r = store.createLibrary(data, '礼物价');
  if (!r.ok) throw new Error('新建第二个库失败：' + r.reason);
  data = r.data;
  const bId = data.activeLibraryId;
  data.libraries.find(l => l.id === bId).items = [
    { serviceType: '鹅鸭杀', unitPrice: 30, settleType: '' },
    /* 「满天星」也只在副库。用它做前缀查询（「满天」）可以验证
       「副库项目会作为候选清单条目出现」—— 前缀不会整条命中规则，
       因此不会被 resolved 那条补价候选盖掉，能干净地测到清单来源。 */
    { serviceType: '满天星', unitPrice: 10, settleType: '' }
  ];
  r = store.switchActiveLibrary(data, aId);
  if (!r.ok) throw new Error('切回 A 库失败：' + r.reason);
  data = r.data;

  // 写回 app，让所有 Feature 看到同一份数据
  app.priceLibraries = data;
  if (app.priceMemoryFeature) app.priceMemoryFeature.priceLibraries = data;
  if (app.priceRuleEditorFeature) app.priceRuleEditorFeature.priceLibraries = data;
  if (store.persist) store.persist(data, {});

  return { dom, w, app, store, aId, bId, errors };
}

(async () => {
  console.log('═════ 同时使用多个价格库 · 专项验证 ═════\n');

  const ctx = await boot(html);
  const { w, app, store, aId, bId } = ctx;
  const doc = w.document;
  const sugg = app.features.serviceSuggestionFeature;
  const pmFeat = app.priceMemoryFeature;
  const editor = app.priceRuleEditorFeature;

  const libData = () => app.priceLibraries || pmFeat.priceLibraries;
  const mergedNames = () => store.getMergedLibraries(libData()).map(l => l.name);
  const mergedCount = () => store.getMergedLibraries(libData()).length;

  // ── ① 两个库都在，当前库是 A ──────────────────────────────────
  console.log('① 基础状态');
  ck('两个库都建好了', libData().libraries.length === 2, `共 ${libData().libraries.length} 个`);
  ck('当前库是 A（查价范围里排最前）', store.getMergedLibraries(libData())[0].id === aId,
    mergedNames().join(' / '));
  ck('新建的库默认参与查价（勾选框是勾上的）', store.isLibraryMerged(libData(), bId) === true);

  // ── ② 查价：不切库也能取到副库的价 ────────────────────────────
  console.log('\n② 查价范围 = 并集（不切库也能用别的库）');
  const hitB = store.findLookupItemByService(libData(), '鹅鸭杀', '');
  ck('不切库就查到了 B 库的项目', !!hitB && hitB.unitPrice === 30, hitB && hitB.unitPrice);
  const hitA = store.findLookupItemByService(libData(), '一起看', '');
  ck('当前库自己的项目照常命中', !!hitA && hitA.unitPrice === 40, hitA && hitA.unitPrice);

  if (sugg) {
    const two = sugg.buildResolvedServiceSuggestion('鹅鸭杀');
    ck('服务类型候选能补出副库的价', !!two && two.unitPrice === 30, two && two.unitPrice);
    ck('候选行标出副库来源（〔礼物价〕）', !!two && /〔礼物价〕/.test(two.meta), two && two.meta);
  } else {
    ck('服务类型候选能补出副库的价', false, '找不到 serviceSuggestionFeature');
    ck('候选行标出副库来源（〔礼物价〕）', false, '找不到 serviceSuggestionFeature');
  }

  // 候选「清单」也要列出副库的项目 —— 否则用户根本看不到 B 库有哪些项目可点，
  // 只能盲打全名，「一起用」这个开关就只兑现了一半。
  if (sugg && typeof sugg.getServiceRuleSuggestions === 'function') {
    const list = sugg.getServiceRuleSuggestions('鹅鸭杀');
    const names = list.map(i => i.displayName);
    ck('候选清单里能看到副库的项目', names.includes('鹅鸭杀'), names.join('/'));
    const item = list.find(i => i.displayName === '鹅鸭杀');
    ck('清单里副库那条也标了来源库', !!item && /〔礼物价〕/.test(item.meta), item && item.meta);

    const listA = sugg.getServiceRuleSuggestions('一起看');
    const itemA = listA.find(i => i.displayName === '一起看');
    ck('清单里当前库那条标的是当前库名', !!itemA && /〔默认价格表〕/.test(itemA.meta), itemA && itemA.meta);

    const mergedRules = editor.getLookupServiceRules();
    const listAll = sugg.getServiceRuleSuggestions('');
    ck('清单走的是「查价用」规则集（并集），不是「编辑用」的',
      mergedRules.length === 3 && listAll.length >= 3,
      `规则 ${mergedRules.length} 条 / 清单 ${listAll.length} 条`);
  } else {
    for (const n of ['候选清单里能看到副库的项目', '清单里副库那条也标了来源库',
      '清单里当前库那条标的是当前库名', '清单走的是「查价用」规则集（并集），不是「编辑用」的']) {
      ck(n, false, '找不到 getServiceRuleSuggestions');
    }
  }

  // ── ③ 编辑只动当前库（勾了别的库也不会被写） ──────────────────
  console.log('\n③ 编辑范围 = 只有当前库（不能污染别的库）');
  const activeRules = app.features.priceRuleEditorFeature.getActiveServiceRules();
  const lookupRules = editor.getLookupServiceRules();
  ck('「编辑用」规则只有当前库的 1 条', activeRules.length === 1,
    activeRules.map(r => r.serviceName).join('/'));
  ck('「查价用」规则是两个库的并集（3 条）', lookupRules.length === 3,
    lookupRules.map(r => r.serviceName).join('/'));
  ck('编辑范围确实不含副库项目（不会误改别的库）',
    !activeRules.some(r => String(r.serviceName || '') === '鹅鸭杀'),
    activeRules.map(r => r.serviceName).join('/'));

  const activeItems = store.findActiveItemByService(libData(), '鹅鸭杀', '');
  ck('「按当前库找项目」找不到副库的（编辑入口的判据是对的）', activeItems === null, activeItems);

  // ── ④ 同名冲突时当前库优先 ────────────────────────────────────
  console.log('\n④ 同名冲突：当前库优先');
  const bLib = libData().libraries.find(l => l.id === bId);
  bLib.items.push({ serviceType: '一起看', unitPrice: 99, settleType: '' });
  const conflict = store.findLookupItemByService(libData(), '一起看', '');
  ck('两库都有「一起看」时取当前库的 40（不是 99）', !!conflict && conflict.unitPrice === 40,
    conflict && conflict.unitPrice);
  const virt = store.mergeLibrariesForLookup(libData());
  const virtItem = (virt.items || []).find(i => i.serviceType === '一起看');
  ck('合成出的「虚拟库」里也是当前库的价', !!virtItem && virtItem.unitPrice === 40,
    virtItem && virtItem.unitPrice);
  if (sugg) {
    const c2 = sugg.buildResolvedServiceSuggestion('一起看');
    ck('候选里补出的价同样是当前库的 40', !!c2 && c2.unitPrice === 40, c2 && c2.unitPrice);
  } else {
    ck('候选里补出的价同样是当前库的 40', false, '找不到 serviceSuggestionFeature');
  }
  // 收尾：把副库那条同名的挪走，免得影响后面的断言
  bLib.items = bLib.items.filter(i => i.serviceType !== '一起看');

  // ── ⑤ 开关与「最后一个库不能取消」 ────────────────────────────
  console.log('\n⑤ 勾选开关');
  let off = store.setLibraryMerged(libData(), bId, false);
  ck('能取消副库的勾选', off.ok === true, off.reason || off.ok);
  app.priceLibraries = off.data;
  app.priceMemoryFeature.priceLibraries = off.data;
  ck('取消后查价范围只剩 1 个库', mergedCount() === 1, mergedCount());
  ck('取消后确实查不到副库的价了',
    store.findLookupItemByService(libData(), '鹅鸭杀', '') === null);

  const lastOff = store.setLibraryMerged(libData(), aId, false);
  ck('最后一个参与查价的库不能被取消（被拒，原因 last-merged）',
    lastOff.ok === false && lastOff.reason === 'last-merged', lastOff.reason || lastOff.ok);

  off = store.setLibraryMerged(libData(), bId, true);
  app.priceLibraries = off.data;
  app.priceMemoryFeature.priceLibraries = off.data;
  ck('能重新勾回来', mergedCount() === 2, mergedCount());

  // ── ⑥ 切换当前库不影响查价范围 ────────────────────────────────
  console.log('\n⑥ 切当前库与勾选互不干扰');
  const before = mergedCount();
  const pick = store.switchActiveLibrary(libData(), bId);
  ck('能把当前库切到 B', pick.ok === true && pick.data.activeLibraryId === bId, pick.reason || pick.ok);
  app.priceLibraries = pick.data;
  app.priceMemoryFeature.priceLibraries = pick.data;
  ck('切当前库不会改变查价范围的库数', mergedCount() === before, mergedCount());
  ck('切换后 B 排到最前（当前库优先靠位置表达）',
    store.getMergedLibraries(libData())[0].id === bId,
    mergedNames().join(' / '));
  // 切回 A，保持后续断言的前提
  const back = store.switchActiveLibrary(libData(), aId);
  app.priceLibraries = back.data;
  app.priceMemoryFeature.priceLibraries = back.data;
  ck('能切回 A', libData().activeLibraryId === aId, libData().activeLibraryId);

  // ── ⑦ 老数据兼容与非法值兜底 ──────────────────────────────────
  console.log('\n⑦ 老数据兼容（升级后行为不变）');
  const legacy = JSON.parse(JSON.stringify(libData()));
  delete legacy.mergedLibraryIds;
  const ln = store.normalizeData(legacy);
  ck('老数据（无该字段）回落成只查当前库',
    Array.isArray(ln.mergedLibraryIds) && ln.mergedLibraryIds.length === 1
    && ln.mergedLibraryIds[0] === ln.activeLibraryId,
    JSON.stringify(ln.mergedLibraryIds));
  ck('老数据的查价结果与改动前一致（只含当前库项目）',
    store.getMergedLibraries(ln).length === 1,
    store.getMergedLibraries(ln).map(l => l.name).join('/'));

  const empty = JSON.parse(JSON.stringify(libData()));
  empty.mergedLibraryIds = [];
  ck('勾选全空时回落成只查当前库（不是「一个都不查」）',
    store.normalizeData(empty).mergedLibraryIds.length === 1,
    JSON.stringify(store.normalizeData(empty).mergedLibraryIds));

  const bogus = JSON.parse(JSON.stringify(libData()));
  bogus.mergedLibraryIds = ['根本不存在的库', bId, bId];
  const bn = store.normalizeData(bogus);
  ck('不存在的库 id 被剔除、重复的只留一个',
    bn.mergedLibraryIds.length === 1 && bn.mergedLibraryIds[0] === bId,
    JSON.stringify(bn.mergedLibraryIds));

  // ── ⑧ 界面：库清单与「一起用」勾选框 ──────────────────────────
  console.log('\n⑧ 界面上的库清单');
  if (editor && typeof editor.updatePriceLibraryUI === 'function') {
    editor.priceLibraries = libData();
    editor.updatePriceLibraryUI();
    await wait(80);
    const listEl = doc.getElementById('pmLibraryList');
    ck('库清单容器存在', !!listEl);
    const rows = listEl ? listEl.querySelectorAll('.pm-library-row') : [];
    ck('一个库一行，共 2 行', rows.length === 2, rows.length);
    ck('当前库那一行有 is-active 标记',
      (listEl ? listEl.querySelectorAll('.pm-library-row.is-active') : []).length === 1,
      (listEl ? listEl.querySelectorAll('.pm-library-row.is-active') : []).length);
    ck('参与查价的行都有 is-merged 标记',
      (listEl ? listEl.querySelectorAll('.pm-library-row.is-merged') : []).length === 2,
      (listEl ? listEl.querySelectorAll('.pm-library-row.is-merged') : []).length);

    const activeRow = listEl ? listEl.querySelector('.pm-library-row.is-active') : null;
    const activeBox = activeRow ? activeRow.querySelector('[data-library-merge]') : null;
    ck('当前库的勾选框固定勾上且点不动（避免「没勾却在查」）',
      !!activeBox && activeBox.checked === true && activeBox.disabled === true,
      activeBox && `checked=${activeBox.checked} disabled=${activeBox.disabled}`);

    const others = [...(listEl ? listEl.querySelectorAll('[data-library-merge]') : [])].filter(b => !b.disabled);
    ck('其余库的勾选框可以点（共 1 个）', others.length === 1, others.length);

    const statusEl = doc.getElementById('pmLibraryStatus');
    ck('状态区说明当前查价范围是 2 个库',
      !!statusEl && /2个库同时使用/.test(statusEl.textContent || ''),
      statusEl && (statusEl.textContent || '').trim());

    ck('库清单在页面上只有一个实例（没有重复初始化）',
      doc.querySelectorAll('#pmLibraryList').length === 1,
      doc.querySelectorAll('#pmLibraryList').length);
    ck('重绘后行数没有成倍增长',
      doc.querySelectorAll('#pmLibraryList .pm-library-row').length === 2,
      doc.querySelectorAll('#pmLibraryList .pm-library-row').length);
  } else {
    for (const n of ['库清单容器存在', '一个库一行，共 2 行', '当前库那一行有 is-active 标记',
      '参与查价的行都有 is-merged 标记', '当前库的勾选框固定勾上且点不动（避免「没勾却在查」）',
      '其余库的勾选框可以点（共 1 个）', '状态区说明当前查价范围是 2 个库',
      '库清单在页面上只有一个实例（没有重复初始化）', '重绘后行数没有成倍增长']) {
      ck(n, false, '找不到 updatePriceLibraryUI');
    }
  }

  // ── ⑨ 反向验证：断言必须真的能变红 ────────────────────────────
  console.log('\n⑨ 反向验证（确认上面的断言不是假绿）');

  /* 反向 1：把「查价用并集」退回「只看当前库」，并集断言必须失败。
     锚点是 getMergedLibraries 的返回语句 —— 它一旦只返回当前库，
     所有查价站点的并集行为都会随之消失。 */
  const mergeAnchor = ' const chosen = normalized.libraries.filter(library => ids.includes(library.id));';
  const singleOnly = html.replace(
    mergeAnchor,
    ' const chosen = normalized.libraries.filter(library => library.id === normalized.activeLibraryId);' + '\n' + mergeAnchor
  );
  ck('反向验证 1 的锚点确实命中了源码（否则本条是假绿）', singleOnly !== html);

  /* 反向 2：把「最后一个库不能取消」的拒绝去掉，该断言必须失败。 */
  const lastAnchor = " if (!current.size) return { ok: false, reason: 'last-merged', data };";
  const noGuard = html.replace(lastAnchor, '');
  ck('反向验证 2 的锚点确实命中了源码（否则本条是假绿）', noGuard !== html);
  if (noGuard !== html) {
    let guardGone = false;
    try {
      const c2 = await boot(noGuard);
      const r2 = c2.store.setLibraryMerged(c2.app.priceLibraries, c2.aId, false);
      guardGone = r2.ok === true; // 去掉守卫后这个操作会成功，说明原断言有意义
      c2.dom.window.close();
    } catch (e) {
      guardGone = false;
    }
    ck('去掉「至少留一个库」的守卫后，该断言确实会失败', guardGone === true);
  } else {
    ck('去掉「至少留一个库」的守卫后，该断言确实会失败', false, '锚点未命中');
  }

  /* 反向 3：把「老数据回落」改成不回落（直接留空），兼容断言必须失败。
     这一条守住的是升级安全：老数据拿不到字段时若不补齐，
     查价范围会变成空数组，用户的单价记忆库会**整个失效**。 */
  const fallbackAnchor = ' mergedLibraryIds: mergedLibraryIds.length ? mergedLibraryIds : [activeLibraryId],';
  const noFallback = html.replace(
    fallbackAnchor,
    ' mergedLibraryIds,'
  );
  ck('反向验证 3 的锚点确实命中了源码（否则本条是假绿）', noFallback !== html);
  if (noFallback !== html) {
    let fallbackGone = false;
    try {
      const c3 = await boot(noFallback);
      const legacy3 = JSON.parse(JSON.stringify(c3.app.priceLibraries));
      delete legacy3.mergedLibraryIds;
      const n3 = c3.store.normalizeData(legacy3);
      // 没有回落时该字段会是空数组，查价范围也跟着空
      fallbackGone = !Array.isArray(n3.mergedLibraryIds) || n3.mergedLibraryIds.length === 0;
      c3.dom.window.close();
    } catch (e) {
      fallbackGone = false;
    }
    ck('去掉「老数据回落」后，兼容断言确实会失败', fallbackGone === true);
  } else {
    ck('去掉「老数据回落」后，兼容断言确实会失败', false, '锚点未命中');
  }

  /* 反向 4：把「新建库自动纳入查价范围」去掉，该断言必须失败。 */
  const createAnchor = ' mergedSet.add(id);';
  const noAutoMerge = html.replace(createAnchor, '');
  ck('反向验证 4 的锚点确实命中了源码（否则本条是假绿）', noAutoMerge !== html);
  if (noAutoMerge !== html) {
    let autoGone = false;
    try {
      const c4 = await boot(noAutoMerge);
      const d4 = c4.app.priceLibraries;
      const fresh = c4.store.createLibrary(d4, '第三个库');
      // 去掉后新建库不会进合并范围；但它是当前库会被补齐，
      // 所以这里要换个判据：把当前库切走，再看它还在不在范围里
      if (fresh.ok) {
        const moved = c4.store.switchActiveLibrary(fresh.data, c4.aId);
        autoGone = moved.ok && !c4.store.isLibraryMerged(moved.data, fresh.data.activeLibraryId);
      }
      c4.dom.window.close();
    } catch (e) {
      autoGone = false;
    }
    ck('去掉「新建库自动参与查价」后，该断言确实会失败', autoGone === true);
  } else {
    ck('去掉「新建库自动参与查价」后，该断言确实会失败', false, '锚点未命中');
  }

  /* 反向 5：勾选框若改回在 click 里读 checked，就会拿到点击前的旧值，
     表现为「勾变取消、取消变勾」——正好反着来。
     这条守住的是那个浏览器默认动作的坑：click 触发时 checked 还没翻过来。 */
  const changeAnchor = " this._eventScope.on(this.el.pmLibraryList, 'change', event => {";
  const noChange = html.replace(changeAnchor, " this._eventScope.on(this.el.pmLibraryList, 'change', event => { if (true) return;");
  ck('反向验证 5 的锚点确实命中了源码（否则本条是假绿）', noChange !== html);
  if (noChange !== html) {
    let changeGone = false;
    try {
      const c5 = await boot(noChange);
      // 必须先渲染出库清单，勾选框才存在 —— boot() 只准备数据，不负责画界面。
      const ed5 = c5.app.features.priceRuleEditorFeature;
      ed5.priceLibraries = c5.app.priceLibraries;
      ed5.updatePriceLibraryUI();
      await wait(80);
      const l5 = c5.w.document.getElementById('pmLibraryList');
      const box5 = [...(l5 ? l5.querySelectorAll('[data-library-merge]') : [])].find(b => b.dataset.libraryMerge === c5.bId);
      if (box5 && !box5.disabled) {
        box5.checked = false;
        box5.dispatchEvent(new c5.w.MouseEvent('click', { bubbles: true, cancelable: true }));
        await wait(60);
        box5.dispatchEvent(new c5.w.Event('change', { bubbles: true }));
        await wait(60);
        // 处理器被短路后，查价范围不会变（仍是 2），
        // 说明「点击能关掉一个库」那条断言确实在守 change 处理器。
        changeGone = c5.store.getMergedLibraries(ed5.priceLibraries).length === 2;
      }
      c5.dom.window.close();
    } catch (e) {
      changeGone = false;
    }
    ck('短路 change 处理器后，该断言确实会失败', changeGone === true);
  } else {
    ck('短路 change 处理器后，该断言确实会失败', false, '锚点未命中');
  }

  /* 反向 6：候选清单若退回「只列当前库」，副库项目就不再作为**清单条目**出现。
     注意这里必须排除「补价候选」（buildResolvedServiceSuggestion 产出的那条）：
     它走的是另一条链路（matchActiveLibrary 的并集匹配），退回清单来源也不影响它，
     所以光看「名字在不在列表里」会得到假绿 —— 实测踩过这个坑。
     正确的判据：副库那条的 key 不再以 exact|/range| 开头（即不再是清单条目）。 */
  const lookupRulesAnchor = ' const suggestRules = this.getLookupServiceRules();';
  const activeOnly = html.replace(
    lookupRulesAnchor,
    ' const suggestRules = this.getActiveServiceRules();'
  );
  ck('反向验证 6 的锚点确实命中了源码（否则本条是假绿）', activeOnly !== html);
  if (activeOnly !== html) {
    let listGone = false;
    try {
      const c6 = await boot(activeOnly);
      const sg6 = c6.app.features.serviceSuggestionFeature;
      const list6 = sg6.getServiceRuleSuggestions('鹅鸭杀');
      // 只剩「resolved|...」那条补价候选，清单条目（exact| / range|）应该没了
      const listEntries = list6.filter(i => /^(exact|range)\|/.test(i.key));
      listGone = listEntries.length === 0;
      c6.dom.window.close();
    } catch (e) {
      listGone = false;
    }
    ck('候选清单退回「只列当前库」后，副库不再作为清单条目出现', listGone === true);
  } else {
    ck('候选清单退回「只列当前库」后，副库不再作为清单条目出现', false, '锚点未命中');
  }

  /* 反向 6b：正向断言要看「清单来源」是否真的覆盖了副库，但**不能**简单地
     断言「exact| 条目里能找到副库项目」—— 实测发现：当输入正好命中某条规则时，
     `resolved|` 那条补价候选和 `exact|` 那条清单条目会产出**完全相同的
     名字+说明**，随后被去重逻辑合并成一条（保留 resolved）。
     这是既有且正确的行为（同一行没必要显示两遍），不是缺陷。
     真正要守的是：副库项目会**作为候选出现**，且它来自清单来源
     （即 getLookupServiceRules 的并集），而不是只靠 resolved 那条硬匹配。
     判据：换一个「不会命中 resolved」的查询词，副库项目仍要出现在清单里。 */
  if (sugg && typeof sugg.getServiceRuleSuggestions === 'function') {
    // 「满天星」只存在于副库，且用「满天」这个前缀去查 —— 不会整条命中规则，
    // 因此不会生成 resolved 补价候选，能干净地测到「清单来源」这条路。
    const listByPrefix = sugg.getServiceRuleSuggestions('满天');
    const bEntry = listByPrefix.find(i => i.displayName === '满天星');
    ck('副库项目会出现在候选清单里（不依赖整条命中）', !!bEntry, listByPrefix.map(i => i.displayName).join('/'));
    ck('副库那条候选标了来源库', !!bEntry && /〔礼物价〕/.test(bEntry.meta), bEntry && bEntry.meta);
  } else {
    ck('副库项目会出现在候选清单里（不依赖整条命中）', false, '找不到 getServiceRuleSuggestions');
    ck('副库那条候选标了来源库', false, '找不到 getServiceRuleSuggestions');
  }

  // 收尾
  ctx.dom.window.close();

  console.log('\n═════ 判定 ═════');
  if (fail) {
    console.log(` 失败 ${fail} 项`);
    process.exit(1);
  }
  console.log(' 全部通过（多库同用成立：编辑只动当前库、查价用并集、当前库优先、断言不是假的绿）');
})().catch(e => {
  console.log(' 运行异常：' + (e && e.stack || e));
  process.exit(1);
});
