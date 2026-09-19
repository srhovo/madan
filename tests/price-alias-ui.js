#!/usr/bin/env node
/**
 * 精确项目「其他名字」（多别名）· 真实界面链路验证
 *
 * 为什么必须另起一套（而不是加在 tests/price-alias.js 里）
 * ------------------------------------------------------
 * tests/price-alias.js 是把引擎类抠出来、在 vm 里跑，**完全不碰界面**。
 * 它测的是「引擎会不会算」—— 这一层一直是好的。
 *
 * 但用户真正报的 bug 不在引擎里：
 *   在界面上填了「其他名字」→ 点添加 → 保存后发现名字没了、也搜不到。
 *   根因是**保存那一步**只把「单价 / 结算方式 / 项目名」写进了记录，
 *   填在框里的名字**根本没跟着进去**。
 *   引擎再对，它拿不到名字也就无从命中。
 *
 * vm 那套之所以一直是绿的，恰恰因为它不经过保存这一步 ——
 * 覆盖面缺的就是「用户手指真正走到的那条路」。
 * 所以本套件只做一件事：**从界面上的输入框开始，走到用户能看到的结果为止**，
 * 一步都不跳。三段：
 *   【1】填了名字 → 点添加 → 名字真的留在库里
 *   【2】用名字搜索 → 出候选 → 点它 → 单价真的填上
 *   【3】导出 → 导入 → 名字不丢
 * 每一段都配一条反向验证（把修复拆掉，断言必须变红），
 * 否则这些断言只是「源码里碰巧有这几个字」的假绿。
 *
 * 用法：node tests/price-alias-ui.js
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

/* ── 起一个只读的 JSDOM（与 tests/multi-library.js 同一套打桩）──────── */
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
  return { dom, w, app, errors };
}

/* 重置成一个干净的库，并把三处引用一起同步。
   （这个应用里 app.priceLibraries / priceMemoryFeature.priceLibraries /
     priceRuleEditorFeature.priceLibraries 是三处引用，只改一处会让各 Feature
     看到不一致的库 —— 实测踩过，所以统一走这里。） */
function useLibraries(app, store, data) {
  const normalized = store.normalizeData(data);
  app.priceLibraries = normalized;
  if (app.priceMemoryFeature) app.priceMemoryFeature.priceLibraries = normalized;
  if (app.priceRuleEditorFeature) app.priceRuleEditorFeature.priceLibraries = normalized;
  store.persist(normalized, {});
  return normalized;
}

/* 清空当前库，避免上一段留下的记录干扰下一段。 */
function clearAll(app, store) {
  const d = store.normalizeData(app.priceLibraries);
  d.libraries.forEach(lib => { lib.items = []; });
  return useLibraries(app, store, d);
}

/* 走界面填「添加单价记录」的表单：单价 / 结算方式 / 项目名 / 其他名字。
   注意这里**不调用内部函数**，全部写真实输入框 —— 本套件要测的就是这条路。 */
function fillForm(doc, { unitPrice, settleType, serviceType, aliases }) {
  const set = (id, value) => {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`找不到输入框 #${id}`);
    el.value = String(value);
    el.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
    el.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
    return el;
  };
  set('pmUnitPrice', unitPrice);
  set('pmSettleType', settleType || 'round');
  set('pmServiceType', serviceType);
  if (aliases !== undefined) set('pmServiceAliases', aliases);
}

/* 从界面上读当前库里的记录（走 Feature 真正渲染列表用的那份数据）。 */
function activeItems(app, store) {
  const d = store.normalizeData(app.priceLibraries);
  const lib = d.libraries.find(l => l.id === d.activeLibraryId);
  return lib?.items || [];
}

/* 读单价框。必须遍历所有 input 找 name/id ——
   app.el 是懒挂载的代理，直接用 app.el.inputs.autoUnitPrice 会拿到 undefined（实测踩过）。 */
function readUnitPrice(doc) {
  const el = [...doc.querySelectorAll('input')].find(i => i.name === 'autoUnitPrice' || i.id === 'autoUnitPrice');
  return el ? String(el.value || '') : '';
}

(async () => {
  console.log('═════ 「其他名字」界面链路 · 专项验证 ═════\n');

  // ══════════════════════════════════════════════════════════════
  // 【1】在界面上填名字 → 点「添加」→ 名字必须真的留在库里
  // ══════════════════════════════════════════════════════════════
  console.log('【1】界面上填了「其他名字」，点添加后名字要真的存住');
  {
    const ctx = await boot(html);
    const { w, app } = ctx;
    const doc = w.document;
    const store = app.priceLibraryStore;
    const editor = app.priceRuleEditorFeature;
    clearAll(app, store);

    fillForm(doc, { unitPrice: 30, settleType: 'round', serviceType: '鹅鸭杀', aliases: '鸭鸭杀、鹅杀' });
    ck('点添加前，框里确实写着这个名字（先确认输入这一步本身是通的）',
      doc.getElementById('pmServiceAliases').value === '鸭鸭杀、鹅杀',
      JSON.stringify(doc.getElementById('pmServiceAliases').value));

    await editor.addPriceMemoryItem();
    await wait(200);

    const items = activeItems(app, store);
    const item = items.find(i => i.serviceType === '鹅鸭杀');
    ck('记录本身存进去了', !!item, `当前库里 ${items.length} 条记录`);
    ck('名字存成了一个列表（两个都在）',
      !!item && Array.isArray(item.aliases) && item.aliases.length === 2, item && JSON.stringify(item.aliases));
    ck('两个名字内容正确', !!item && item.aliases.includes('鸭鸭杀') && item.aliases.includes('鹅杀'),
      item && JSON.stringify(item.aliases));
    ck('第一个名字也单独留了一份（老版本与旧备份读它）', !!item && item.alias === '鸭鸭杀', item && item.alias);
    ck('添加后输入框被清空（不把上一条的名字粘到下一条）',
      doc.getElementById('pmServiceAliases').value === '', JSON.stringify(doc.getElementById('pmServiceAliases').value));

    /* 编辑时名字要能回填到框里 —— 这是用户「保存后再点开看」的路径。 */
    if (item) {
      editor.editPriceMemoryItem(item.id || item.key || w.eval('PriceLibraryStore').prototype ? '' : '');
    }
    const back = items.find(i => i.serviceType === '鹅鸭杀');
    if (back) {
      const key = app.priceMemoryStore.buildKey(app.priceMemoryStore.normalize(activeItems(app, store)).find(r => r.serviceType === '鹅鸭杀'));
      editor.editPriceMemoryItem(key);
      await wait(100);
      ck('再点编辑时，名字会回填到框里（用户能看见自己填过什么）',
        doc.getElementById('pmServiceAliases').value === '鸭鸭杀、鹅杀',
        JSON.stringify(doc.getElementById('pmServiceAliases').value));
    } else {
      ck('再点编辑时，名字会回填到框里（用户能看见自己填过什么）', false, '找不到刚存的记录');
    }

    ctx.dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 【2】用名字搜索 → 出候选 → 点它 → 单价真的填上
  // ══════════════════════════════════════════════════════════════
  console.log('\n【2】用「其他名字」搜索要能出候选，点它要能填上单价');
  {
    const ctx = await boot(html);
    const { w, app } = ctx;
    const doc = w.document;
    const store = app.priceLibraryStore;
    const editor = app.priceRuleEditorFeature;
    const sugg = app.features.serviceSuggestionFeature;
    clearAll(app, store);

    fillForm(doc, { unitPrice: 30, settleType: 'round', serviceType: '鹅鸭杀', aliases: '鸭鸭杀、鹅杀' });
    await editor.addPriceMemoryItem();
    await wait(200);

    // 写进去之后，用别名搜 —— 走的是候选清单真正的那条路
    const list1 = sugg.getServiceRuleSuggestions('鸭鸭杀');
    ck('用第一个名字能搜到这个项目',
      list1.some(i => i.displayName === '鹅鸭杀'), list1.map(i => i.displayName).join('/') || '（空）');
    const list2 = sugg.getServiceRuleSuggestions('鹅杀');
    ck('用第二个名字同样能搜到',
      list2.some(i => i.displayName === '鹅鸭杀'), list2.map(i => i.displayName).join('/') || '（空）');
    const resolved = sugg.buildResolvedServiceSuggestion('鸭鸭杀');
    ck('用名字能直接补出价钱（¥30）', !!resolved && Number(resolved.unitPrice) === 30,
      resolved && resolved.unitPrice);

    /* 真的在服务类型框里敲名字、真的点候选。
       候选点击绑在 mousedown 上（不是 click）—— 用 click 点不动，实测踩过。 */
    const typeEl = doc.getElementById('type') || [...doc.querySelectorAll('input')].find(i => i.name === 'type');
    ck('找得到服务类型输入框', !!typeEl);
    if (typeEl) {
      typeEl.value = '鸭鸭杀';
      typeEl.dispatchEvent(new w.Event('input', { bubbles: true }));
      await wait(400);
      const cards = [...doc.querySelectorAll('.type-suggest-item')];
      ck('敲名字后候选卡片真的弹出来了', cards.length > 0,
        cards.map(el => (el.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 3).join(' ｜ ') || '（无）');
      const hitCard = cards.find(el => /鹅鸭杀/.test(el.textContent || '')) || cards[0];
      if (hitCard) {
        hitCard.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        await wait(600);
        const got = readUnitPrice(doc);
        ck('点候选后单价框真的被填上了（不是空的）', got !== '', `实得 ${JSON.stringify(got)}`);
        ck('填的是那条记录的价（¥30）', got === '30', `实得 ${JSON.stringify(got)}`);
      } else {
        ck('点候选后单价框真的被填上了（不是空的）', false, '没有可点的候选卡片');
        ck('填的是那条记录的价（¥30）', false, '没有可点的候选卡片');
      }
    } else {
      ck('敲名字后候选卡片真的弹出来了', false, '取不到服务类型输入框');
      ck('点候选后单价框真的被填上了（不是空的）', false, '取不到服务类型输入框');
      ck('填的是那条记录的价（¥30）', false, '取不到服务类型输入框');
    }

    /* 同一条记录不该被显示成两条。
       去重键原先带上了「说明文字」，而用别名命中时两条候选的说明不一样
       （一条写「别名匹配」，一条写「别名：鸭鸭杀」），于是同一条记录、同一个价
       被摆成两张一模一样的卡片，用户不知道该点哪张。 */
    const dupCards = sugg.getServiceRuleSuggestions('鸭鸭杀').filter(i => i.displayName === '鹅鸭杀');
    ck('同一条记录只出现一次（不会因为用别名命中就变成两条）',
      dupCards.length === 1, `实得 ${dupCards.length} 条：${dupCards.map(i => i.meta).join(' ｜ ')}`);

    ctx.dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 【3】导出 → 导入，名字不丢
  // ══════════════════════════════════════════════════════════════
  console.log('\n【3】导出备份再导入，名字不能丢');
  {
    const ctx = await boot(html);
    const { w, app } = ctx;
    const doc = w.document;
    const store = app.priceLibraryStore;
    const editor = app.priceRuleEditorFeature;
    const dp = app.features.dataPortabilityFeature;
    clearAll(app, store);

    fillForm(doc, { unitPrice: 30, settleType: 'round', serviceType: '鹅鸭杀', aliases: '鸭鸭杀、鹅杀' });
    await editor.addPriceMemoryItem();
    await wait(200);

    ck('找得到导出/导入功能', !!dp);
    if (dp) {
      /* 导出面板必须先渲染一次，勾选框才存在；
         否则读勾选框会拿到空数组、导出直接报「请至少选择一个价格库」——
         那是测试没准备好，不是产品坏了（实测踩过）。 */
      dp.renderExportModules();
      await wait(100);
      const boxes = [...doc.querySelectorAll('.dp-price-library-export')];
      ck('导出面板里能勾到价格库', boxes.length > 0, `共 ${boxes.length} 个`);
      const exported = dp.buildPriceLibrariesExport([store.normalizeData(app.priceLibraries).activeLibraryId]);
      const exportedText = JSON.stringify(exported);
      ck('导出内容里带着名字', /鸭鸭杀/.test(exportedText) && /鹅杀/.test(exportedText), exportedText.slice(0, 160));

      // 兼容副本（老格式）也要带 —— 它是价格库数据出问题时的回退来源
      const compat = store.toLegacyItems(exported.libraries[0].items || []);
      const compatItem = (compat || []).find(i => i.serviceType === '鹅鸭杀');
      ck('同时导出的老格式副本里也带着名字',
        !!compatItem && Array.isArray(compatItem.aliases) && compatItem.aliases.length === 2,
        compatItem && JSON.stringify(compatItem.aliases));

      // 清空后导回来
      clearAll(app, store);
      const roundTrip = dp.normalizeIncomingPriceLibraries(JSON.parse(exportedText));
      const rtItem = (roundTrip.libraries[0].items || []).find(i => i.serviceType === '鹅鸭杀');
      ck('导入回来后名字还在', !!rtItem && Array.isArray(rtItem.aliases) && rtItem.aliases.length === 2,
        rtItem && JSON.stringify(rtItem.aliases));
      ck('导入回来的名字内容也对',
        !!rtItem && rtItem.aliases.includes('鸭鸭杀') && rtItem.aliases.includes('鹅杀'),
        rtItem && JSON.stringify(rtItem.aliases));

      // 导回来后拿去查价，仍然能用名字命中
      const na = useLibraries(app, store, roundTrip);
      const found = store.findLookupItemByService(na, '鸭鸭杀', '');
      ck('导入回来的数据用名字查得到（¥30）', !!found && Number(found.unitPrice) === 30,
        found && found.unitPrice);
    } else {
      ['导出面板里能勾到价格库', '导出内容里带着名字', '同时导出的老格式副本里也带着名字',
        '导入回来后名字还在', '导入回来的名字内容也对', '导入回来的数据用名字查得到（¥30）',
      ].forEach(n => ck(n, false, '找不到 dataPortabilityFeature'));
    }

    ctx.dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 【4】两个库各存一条「同名」记录时，名字要能区分是哪一条
  // ══════════════════════════════════════════════════════════════
  console.log('\n【4】两个库里各有一条同名记录时，靠名字要能分清是哪一条');
  {
    const ctx = await boot(html);
    const { w, app } = ctx;
    const store = app.priceLibraryStore;
    const sugg = app.features.serviceSuggestionFeature;
    clearAll(app, store);

    /* 为什么单独测这一段：两条候选的项目名一模一样，用户只能靠
       「库名 + 库内的区分特征（就是这里填的『其他名字』）」来挑。
       若这层信息取错了库，两条候选会长得一模一样，用户没法选。 */
    const now = Date.now();
    const base = store.normalizeData(app.priceLibraries);
    const createRes = store.createLibrary(base, '礼物价');
    const bId = createRes.data.activeLibraryId;
    const aId = createRes.data.libraries.find(l => l.id !== bId).id;
    const d = createRes.data;
    d.libraries.find(l => l.id === aId).items = [
      { serviceType: '鹅鸭杀', unitPrice: 30, settleType: 'round', aliases: '鸭鸭杀、鹅杀', createdAt: now, lastUsed: now, updatedAt: now },
    ];
    d.libraries.find(l => l.id === bId).items = [
      { serviceType: '鹅鸭杀', unitPrice: 44, settleType: 'round', aliases: '大鹅', createdAt: now, lastUsed: now, updatedAt: now },
    ];
    // 两个库的创建时间也压成同一个 —— 这是导入备份之后的真实形态
    d.libraries.find(l => l.id === aId).createdAt = now;
    d.libraries.find(l => l.id === bId).createdAt = now;
    const sw = store.switchActiveLibrary(d, aId);
    const data = useLibraries(app, store, sw.data);

    const itemsA = data.libraries.find(l => l.id === aId).items[0];
    const itemsB = data.libraries.find(l => l.id === bId).items[0];
    ck('两个库的同名记录各有各的身份编号（不会撞成同一个）',
      !!itemsA && !!itemsB && itemsA.id !== itemsB.id, `${itemsA?.id} / ${itemsB?.id}`);
    ck('每条记录都知道自己在哪个库（查价时靠它认出处）',
      itemsA?.scope === aId && itemsB?.scope === bId, `${itemsA?.scope} / ${itemsB?.scope}`);

    const cards = sugg.getServiceRuleSuggestions('鹅鸭杀').filter(i => i.displayName === '鹅鸭杀');
    ck('两条候选都出得来', cards.length === 2, `实得 ${cards.length} 条`);
    ck('两条各标自己的库名（不会都标成主库）',
      cards.some(i => /〔默认价格表〕/.test(i.meta)) && cards.some(i => /〔礼物价〕/.test(i.meta)),
      cards.map(i => i.meta).join(' ｜ '));
    ck('两条各标自己的名字（用户能看出哪条是哪条）',
      cards.some(i => /鸭鸭杀/.test(i.meta)) && cards.some(i => /大鹅/.test(i.meta)),
      cards.map(i => i.meta).join(' ｜ '));
    ck('两条候选的价分别是两库各自的（30 / 44）',
      cards.map(i => Number(i.unitPrice)).sort((x, y) => x - y).join('/') === '30/44',
      cards.map(i => i.unitPrice).join('/'));

    ctx.dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 【5】反向验证：把修复拆掉，上面的断言必须变红
  // ══════════════════════════════════════════════════════════════
  console.log('\n【5】反向验证：拆掉修复后，本套件必须变红（防「假的绿」）');
  {
    /* 反向 1：把「名字随记录一起存」拆掉 —— 恢复成改动前的写法。
       锚点是 addPriceMemoryItem 里那行 record；拆掉后名字只用于查重、
       不落库，于是【1】和【2】整段都会失败。
       注：index.html 主脚本用 1 空格缩进，锚点必须按实际文本写。 */
    const recordAnchor = ' const record = { unitPrice, settleType, serviceType, aliases: aliasRaw, alias: aliasRaw };';
    const noRecord = html.replace(recordAnchor, ' const record = { unitPrice, settleType, serviceType };');
    ck('反向验证 1 的锚点确实命中了源码（否则本条是假绿）', noRecord !== html);
    if (noRecord !== html) {
      let gone = false;
      try {
        const c = await boot(noRecord);
        const st = c.app.priceLibraryStore;
        clearAll(c.app, st);
        fillForm(c.w.document, { unitPrice: 30, settleType: 'round', serviceType: '鹅鸭杀', aliases: '鸭鸭杀、鹅杀' });
        await c.app.priceRuleEditorFeature.addPriceMemoryItem();
        await wait(200);
        const it = activeItems(c.app, st).find(i => i.serviceType === '鹅鸭杀');
        // 拆掉后：记录还在，但名字没了 —— 正是用户报的症状
        gone = !!it && !(it.aliases || []).length;
        c.dom.window.close();
      } catch (e) {
        gone = false;
      }
      ck('拆掉「名字随记录存」后，名字整体消失（断言确实能变红）', gone === true);
    } else {
      ck('拆掉「名字随记录存」后，名字整体消失（断言确实能变红）', false, '锚点未命中');
    }

    /* 反向 2：把候选清单的去重键退回「展示名 + 说明文字」。
       退回后，同一条记录用别名命中时会因为说明不同而没被判重，
       变成两张一模一样的卡片 —— 【2】段那条断言必须失败。 */
    const dedupAnchor = " const key = `${item.ruleId || this.normalizeServiceSuggestQuery(item.displayName)}|${item.settleType || ''}|${sourceLib}`;";
    const noDedup = html.replace(
      dedupAnchor,
      " const key = `${item.displayName}|${item.meta}`;"
    );
    ck('反向验证 2 的锚点确实命中了源码（否则本条是假绿）', noDedup !== html);
    if (noDedup !== html) {
      let dupBack = false;
      try {
        const c = await boot(noDedup);
        const st = c.app.priceLibraryStore;
        const sg = c.app.features.serviceSuggestionFeature;
        clearAll(c.app, st);
        fillForm(c.w.document, { unitPrice: 30, settleType: 'round', serviceType: '鹅鸭杀', aliases: '鸭鸭杀、鹅杀' });
        await c.app.priceRuleEditorFeature.addPriceMemoryItem();
        await wait(200);
        const cards = sg.getServiceRuleSuggestions('鸭鸭杀').filter(i => i.displayName === '鹅鸭杀');
        dupBack = cards.length > 1;
        c.dom.window.close();
      } catch (e) {
        dupBack = false;
      }
      ck('退回旧去重键后，同一条记录会变成两条（断言确实能变红）', dupBack === true);
    } else {
      ck('退回旧去重键后，同一条记录会变成两条（断言确实能变红）', false, '锚点未命中');
    }

    /* 反向 3：把「项目编号里带上它属于哪个库」这层拆掉。
       拆掉后，两个库的同名记录只要创建时间落在同一毫秒就会算出同一个编号，
       靠编号反查出处永远命中第一个库 —— 【4】段那组断言必须全部失败。
       这是导入备份之后的真实形态（一次导入会把各库的创建时间刷成同一个值）。 */
    const saltAnchor = " const salt = String(librarySalt || '').trim();";
    const noSalt = html.replace(saltAnchor, " const salt = '';");
    ck('反向验证 3 的锚点确实命中了源码（否则本条是假绿）', noSalt !== html);
    if (noSalt !== html) {
      let clash = false;
      try {
        const c = await boot(noSalt);
        const st = c.app.priceLibraryStore;
        const sg = c.app.features.serviceSuggestionFeature;
        clearAll(c.app, st);
        const now = Date.now();
        const cr = st.createLibrary(st.normalizeData(c.app.priceLibraries), '礼物价');
        const b2 = cr.data.activeLibraryId;
        const a2 = cr.data.libraries.find(l => l.id !== b2).id;
        const d2 = cr.data;
        d2.libraries.find(l => l.id === a2).items = [{ serviceType: '鹅鸭杀', unitPrice: 30, settleType: 'round', aliases: '鸭鸭杀', createdAt: now, lastUsed: now, updatedAt: now }];
        d2.libraries.find(l => l.id === b2).items = [{ serviceType: '鹅鸭杀', unitPrice: 44, settleType: 'round', aliases: '大鹅', createdAt: now, lastUsed: now, updatedAt: now }];
        d2.libraries.find(l => l.id === a2).createdAt = now;
        d2.libraries.find(l => l.id === b2).createdAt = now;
        const sw2 = st.switchActiveLibrary(d2, a2);
        const n = useLibraries(c.app, st, sw2.data);
        const iA = n.libraries.find(l => l.id === a2).items[0];
        const iB = n.libraries.find(l => l.id === b2).items[0];
        const cards = sg.getServiceRuleSuggestions('鹅鸭杀').filter(i => i.displayName === '鹅鸭杀');
        // 变红形态：两条编号撞成同一个，或两条候选的库名/区分特征分不出来
        clash = (iA?.id === iB?.id)
          || !(cards.some(i => /鸭鸭杀/.test(i.meta)) && cards.some(i => /大鹅/.test(i.meta)));
        c.dom.window.close();
      } catch (e) {
        clash = false;
      }
      ck('去掉编号里的「库」这层后，两条同名记录会分不出是哪一条（断言确实能变红）', clash === true);
    } else {
      ck('去掉编号里的「库」这层后，两条同名记录会分不出是哪一条（断言确实能变红）', false, '锚点未命中');
    }

    /* 反向 4：让「按名字找记录」退回只认项目名、不认「其他名字」。
       退回后，用户在输入框里敲别名时，程序会认为「库里没这个项目」，
       于是要么弹不出候选、要么把同一条记录又存一遍 —— 【2】段必须失败。 */
    const nameAnchor = ' return list.some(name => this.buildServiceKey(name) === serviceKey);';
    const noNameMatch = html.replace(nameAnchor, ' return false;');
    ck('反向验证 4 的锚点确实命中了源码（否则本条是假绿）', noNameMatch !== html);
    if (noNameMatch !== html) {
      let aliasBlind = false;
      try {
        const c = await boot(noNameMatch);
        const st = c.app.priceLibraryStore;
        clearAll(c.app, st);
        fillForm(c.w.document, { unitPrice: 30, settleType: 'round', serviceType: '鹅鸭杀', aliases: '鸭鸭杀、鹅杀' });
        await c.app.priceRuleEditorFeature.addPriceMemoryItem();
        await wait(200);
        const found = st.findActiveItemByService(c.app.priceLibraries, '鸭鸭杀', '');
        aliasBlind = found === null;
        c.dom.window.close();
      } catch (e) {
        aliasBlind = false;
      }
      ck('退回「只认项目名」后，用名字就找不到这条记录了（断言确实能变红）', aliasBlind === true);
    } else {
      ck('退回「只认项目名」后，用名字就找不到这条记录了（断言确实能变红）', false, '锚点未命中');
    }
  }

  console.log('\n' + (fail === 0
    ? '=== 全部通过（「其他名字」从界面填入到查价、到导出导入，整条路都通，且断言不是假的绿）==='
    : `=== 失败 ${fail} 项 ===`));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log(' 运行异常：' + (e && e.stack || e));
  process.exit(1);
});
