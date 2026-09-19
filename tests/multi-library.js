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

/* 把一份库数据同时挂到所有 Feature 上并落盘。
   为什么需要它：这个应用里 app.priceLibraries / priceMemoryFeature.priceLibraries /
   priceRuleEditorFeature.priceLibraries 是三处引用，测试里**只改一处**会让
   各 Feature 看到不一致的库（实测踩过：改完没同步，③ 段断言看到的是上一段留下的
   数据）。统一走这个函数，避免每段各写一遍、漏掉某一处。 */
function useLibraries(app, store, data) {
  const normalized = store.normalizeData(data);
  app.priceLibraries = normalized;
  if (app.priceMemoryFeature) app.priceMemoryFeature.priceLibraries = normalized;
  if (app.priceRuleEditorFeature) app.priceRuleEditorFeature.priceLibraries = normalized;
  store.persist(normalized, {});
  return normalized;
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
    /* 【8.3.46】来源标注收紧为「只在同名冲突时标」。
       A 库和 B 库这里的项目是**互不重叠**的（A=一起看，B=鹅鸭杀/满天星），
       所以「鹅鸭杀」只有 B 库有、没有歧义 → 不该标库名。
       早先的断言要求这里必须出现〔礼物价〕，那是「只要多库就每条都标」的
       旧行为，正是本轮要改掉的东西（用户原话：「我希望只有完全相同的再提示库名」）。
       同名冲突的标注验证在下面 ②-b 专段，那里才构造了两个库都有的名字。 */
    ck('副库独有项目不标库名（无同名歧义）', !!two && !/〔/.test(two.meta), two && two.meta);
  } else {
    ck('服务类型候选能补出副库的价', false, '找不到 serviceSuggestionFeature');
    ck('副库独有项目不标库名（无同名歧义）', false, '找不到 serviceSuggestionFeature');
  }

  /* ── ②-b 来源标注：只在同名冲突时标，且标在说明行首 ─────────────
     【8.3.46 本轮新增】用户两条明确要求：
       ① 「我希望只有完全相同的再提示库名」
          —— 只有 A 库独有的项目不该标（标了是噪音、还把候选行占长）
       ② 「库名那个前括号错行了，要对齐到与后续内容同一行」
          —— 根因是库名原本排在整条说明**末尾**，前面那段（匹配方式 + 价格）
             把行占满后，〔库名〕被挤到第二行，看着就像括号掉了。
             位置改到**行首**后永远留在第一行，多张卡片之间也天然对齐。
     这一段专门造「两个库都有同名项目」的场景来钉住这两条。 */
  if (sugg) {
    console.log('\n②-b 来源标注只在同名冲突时出现，且落在说明行首');
    /* 在 A 库里也加一个「鹅鸭杀」，制造同名冲突（价格故意不同，便于区分）；
       并给 A 库那条挂一个别名 —— 用来验证「同名时靠什么区分」：
       两条候选项目名一模一样，只有把**库内的区分特征**（别名）标出来，
       用户才知道该点哪条。这段同时钉住「有别名时报别名」这条通路。 */
    const d2b = store.normalizeData(libData());
    d2b.libraries.find(l => l.id === aId).items = [
      { serviceType: '一起看', unitPrice: 40, settleType: '' },
      { serviceType: '鹅鸭杀', unitPrice: 33, settleType: '', aliases: ['鹅鸭杀A版'] },
    ];
    useLibraries(app, store, d2b);

    const dup = sugg.buildResolvedServiceSuggestion('鹅鸭杀');
    ck('同名项目会标出库名', !!dup && /〔/.test(dup.meta), dup && dup.meta);
    ck('库名标在说明最前面（不在末尾，避免被挤到第二行）',
      !!dup && /^〔/.test(dup.meta), dup && dup.meta);
    ck('同名时取当前库的价（当前库优先）', !!dup && dup.unitPrice === 33, dup && dup.unitPrice);
    /* 【8.3.46 新增】同名冲突时还要给出**库内的区分特征**。
       只有库名的话，两条候选除库名外长得一样，用户只能靠猜。 */
    ck('同名冲突时标出库内的区分特征（别名）', !!dup && /别名：鹅鸭杀A版/.test(dup.meta), dup && dup.meta);

    const solo = sugg.buildResolvedServiceSuggestion('一起看');
    ck('A 库独有的项目仍不标库名', !!solo && !/〔/.test(solo.meta), solo && solo.meta);

    const dupList = sugg.getServiceRuleSuggestions('鹅鸭杀').filter(i => i.displayName === '鹅鸭杀');
    /* 【8.3.47】按「来源库名」把两条分出来，**不能**再按 key 是不是 `exact|` 开头分。
       为什么改：清单里那条已解析的候选（key 是 `resolved|`）也算一条正经候选 ——
       当前库那条正好命中输入内容时，它会以 `resolved|` 的形态出现，
       按 `exact|` 筛就会把它漏掉，误判成「少了一条」。
       本段真正要钉的是「两个库的同名项目都能看到、且能分清来自哪个库」，
       所以判据直接用元信息开头的〔库名〕—— 这与用户的观感一致，
       也与实现无关（无论那条是 `exact|` 还是 `resolved|`，都得带着库名出现）。 */
    const libOf = item => (String(item.meta || '').match(/^〔([^〕]*)〕/) || [])[1] || '';
    const libNames = dupList.map(libOf);
    ck('清单里同名项目两条都会出现', dupList.length === 2, `实得 ${dupList.length} 条（总 ${dupList.length} 条）`);
    ck('清单里同名项库名也标在行首', dupList.every(i => /^〔/.test(i.meta)),
      dupList.map(i => i.meta).join(' || '));
    /* 两条的**来源库名**必须分得清 —— 这正是 findLibraryNameByRuleId 漏查 items
       时暴露出来的 bug（两条都标「默认价格表」）。 */
    ck('清单里两条的来源库名能分清',
      libNames.includes('默认价格表') && libNames.includes('礼物价'),
      dupList.map(i => i.meta).join(' || '));
    /* 副库那条没有别名 → 给出「唯一」（该库里这个名字只有一条记录），
       与 A 库的「别名：鹅鸭杀A版」形成可分辨的一对。 */
    ck('没别名的那条给出「唯一」之类的区分特征',
      dupList.some(i => /唯一/.test(i.meta)), dupList.map(i => i.meta).join(' || '));
    /* 库名和区分特征之间不能出现空档（早先拼串时 hint 为空会留下「 ·  · 」）。 */
    ck('说明里没有连续的分隔符空档', dupList.every(i => !/·\s*·/.test(i.meta)),
      dupList.map(i => i.meta).join(' || '));

    const soloList = sugg.getServiceRuleSuggestions('一起看').find(i => i.displayName === '一起看');
    ck('清单里独有项不标库名', !!soloList && !/〔/.test(soloList.meta), soloList && soloList.meta);

    /* 复原成「A 库只有一起看、B 库只有鹅鸭杀/满天星」，避免影响后面的断言。 */
    const restore = store.normalizeData(libData());
    restore.libraries.find(l => l.id === aId).items = [{ serviceType: '一起看', unitPrice: 40, settleType: '' }];
    restore.libraries.find(l => l.id === bId).items = [
      { serviceType: '鹅鸭杀', unitPrice: 30, settleType: '' },
      { serviceType: '满天星', unitPrice: 10, settleType: '' },
    ];
    useLibraries(app, store, restore);
    ck('②-b 结束时数据复原回「两库项目互不重叠」',
      store.findLookupItemByService(libData(), '鹅鸭杀', '').unitPrice === 30,
      store.findLookupItemByService(libData(), '鹅鸭杀', '')?.unitPrice);
  } else {
    ['同名项目会标出库名', '库名标在说明最前面（不在末尾，避免被挤到第二行）',
      '同名时取当前库的价（当前库优先）', 'A 库独有的项目仍不标库名',
      '同名冲突时标出库内的区分特征（别名）',
      '清单里同名项目两条都会出现', '清单里同名项库名也标在行首',
      '清单里两条的来源库名能分清', '没别名的那条给出「唯一」之类的区分特征',
      '说明里没有连续的分隔符空档', '清单里独有项不标库名',
      '②-b 结束时数据复原回「两库项目互不重叠」',
    ].forEach(n => ck(n, false, '找不到 serviceSuggestionFeature'));
  }

  /* ── ②-c 别名要能穿过「价格库」这套数据活下来 ──────────────────
     【8.3.46 本轮修】实测发现：在价格库里给项目填了别名，归一化时会被丢掉 ——
     PriceMemory.normalizeEntry 已经算出了 aliases，但拼装 item 时没带上。
     后果不止「别名没了」：
       · items 是规则的上游（normalizeLibrary 用 mergeWithLegacyItems 由 items 生成 rules），
         这里丢了别名，从 items 升上来的规则就全都没别名；
       · 同名冲突时用来区分两条候选的「库内特征」也读不到，只能退化成「唯一」；
       · legacy 副本（价格库数据出问题时的回退来源）若也丢，回退后别名整体消失。
     下面钉住「写进去 → 归一化 → 读出来」这条往返路径。 */
  console.log('\n②-c 别名要能穿过价格库的归一化活下来');
  {
    const withAlias = store.normalizeData(libData());
    withAlias.libraries.find(l => l.id === bId).items = [
      { serviceType: '鹅鸭杀', unitPrice: 30, settleType: '', aliases: ['鹅鸭杀A版', '鸭鸭杀'] },
      { serviceType: '满天星', unitPrice: 10, settleType: '' },
    ];
    const na = useLibraries(app, store, withAlias);
    const item = (na.libraries.find(l => l.id === bId).items || []).find(i => i.serviceType === '鹅鸭杀');
    ck('归一化后 item 上还留着别名数组', !!item && Array.isArray(item.aliases) && item.aliases.length === 2,
      item && JSON.stringify(item.aliases));
    ck('归一化后首个别名也留在 alias 上（老代码/DOM 读它）', !!item && item.alias === '鹅鸭杀A版',
      item && item.alias);
    const rule = (na.libraries.find(l => l.id === bId).rules || []).find(r => r.serviceName === '鹅鸭杀');
    ck('由 items 升上来的规则也带着别名（不被中途丢掉）',
      !!rule && Array.isArray(rule.aliases) && rule.aliases.includes('鹅鸭杀A版'),
      rule && JSON.stringify(rule.aliases));
    /* legacy 副本也要带别名 —— 它是价格库出错时的回退来源。 */
    const legacyCopy = store.toLegacyItems(na.libraries.find(l => l.id === bId).items || []);
    const legacyHit = (legacyCopy || []).find(i => i.serviceType === '鹅鸭杀');
    ck('legacy 副本（回退来源）里也带着别名', !!legacyHit && !!legacyHit.alias,
      legacyHit && JSON.stringify(legacyHit.alias));
    /* 别名要能用于联想：按别名查能得到这个项目。 */
    if (sugg) {
      const byAlias = sugg.getServiceRuleSuggestions('鸭鸭杀');
      ck('按别名能查到这条项目', byAlias.some(i => i.displayName === '鹅鸭杀'),
        byAlias.map(i => i.displayName).join('/'));
    } else {
      ck('按别名能查到这条项目', false, '找不到 serviceSuggestionFeature');
    }
    // 复原
    const back2 = store.normalizeData(libData());
    back2.libraries.find(l => l.id === bId).items = [
      { serviceType: '鹅鸭杀', unitPrice: 30, settleType: '' },
      { serviceType: '满天星', unitPrice: 10, settleType: '' },
    ];
    useLibraries(app, store, back2);
  }


  if (sugg && typeof sugg.getServiceRuleSuggestions === 'function') {
    const list = sugg.getServiceRuleSuggestions('鹅鸭杀');
    const names = list.map(i => i.displayName);
    ck('候选清单里能看到副库的项目', names.includes('鹅鸭杀'), names.join('/'));
    const item = list.find(i => i.displayName === '鹅鸭杀');
    /* 【8.3.46】同 ②-b：A/B 项目互不重叠时「鹅鸭杀」是 B 库独有，无同名歧义 → 不标。 */
    ck('清单里副库独有项不标库名', !!item && !/〔/.test(item.meta), item && item.meta);

    const listA = sugg.getServiceRuleSuggestions('一起看');
    const itemA = listA.find(i => i.displayName === '一起看');
    ck('清单里当前库独有项也不标库名', !!itemA && !/〔/.test(itemA.meta), itemA && itemA.meta);

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
  /* 【8.3.46】合成出的「虚拟库」里**两条同名项目都要在**，不能被当成重复项吞掉一条。
     原先这里是按「项目名 + 结算方式」做键、先到先得，键里没有价钱，
     于是两个库都存了「一起看」而价钱不同时，副库那条会被静默丢弃 ——
     界面上看不出任何异常，用户只会拿到当前库的价、而且不知道还有另一条可选。
     多库同用的意义恰恰在于这种同名不同价交给用户自己挑，所以两条都必须留着。
     这里断言的是「数量」，配合上面「取价仍取当前库的 40」一起看：
     一条没少 + 优先取当前库，才算语义完整。 */
  const sameNameItems = (virt.items || []).filter(i => i.serviceType === '一起看');
  ck('合成出的「虚拟库」里同名项目两条都在（副库那条没被当重复项吞掉）',
    sameNameItems.length === 2, `实得 ${sameNameItems.length} 条`);
  /* 【8.3.46】候选清单里的同名项目也必须两条都在 —— 这是用户能看见的那一层。
     上面断言的是数据层，这里断言的是「用户点得到第二条」，
     两者缺一用户就仍然只能拿到主库的价。

     注意这里**不能**只筛 `exact|` 开头的 key：当前库那条会被「已解析候选」
     接管（key 是 `resolved|...`），因为它的名字与输入框里的字完全一致。
     只筛 `exact|` 会把它当成「少了一条」而误报。所以按**项目名**筛。 */
  if (sugg) {
    const dupEntries = sugg.getServiceRuleSuggestions('一起看', []).filter(i => i.displayName === '一起看');
    ck('候选清单里同名项目两条都能点（副库的价点得到）',
      dupEntries.length === 2, `实得 ${dupEntries.length} 条`);
    ck('候选清单里两条的价钱分别是两库各自的（40 / 99）',
      dupEntries.map(i => i.unitPrice).sort((x, y) => x - y).join('/') === '40/99',
      dupEntries.map(i => i.unitPrice).join('/'));
    ck('候选清单里两条都标了各自的来源库名（不会都标成主库）',
      dupEntries.some(i => /〔默认价格表〕/.test(i.meta)) && dupEntries.some(i => /〔礼物价〕/.test(i.meta)),
      dupEntries.map(i => i.meta).join(' ｜ '));
  } else {
    ck('候选清单里同名项目两条都能点（副库的价点得到）', false, '找不到 serviceSuggestionFeature');
  }
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

  /* ── ⑧-b 候选点选后「能真正填上价」的跨库归属 ──────────────────
     【8.3.46 本轮修的真 bug】用户原话：
       「目前只有主库才能正确填充单价相关信息。例如当我使用 a 库和 b 库时，
         主库为 a 库时，b 库的项目只能弹出候选，但是选择候选后无法填充
         单价信息。」
     根因（已实测复现）：点候选时走 selectTemporaryRule，它**固定**把
     「本次用哪条规则」的选择记在**当前库**的键上；
     而查价时 matchLibrary 是按「拥有该规则的库」读那个键。
     候选来自 B 库、当前库是 A 时，写进「A|名字|结算」、读的是「B|名字|结算」
     → 读不到 → 卡在 ambiguous_rule → 单价填不上。
     修法：按 ruleId 反查规则真正属于哪个库，把选择写对键。
     下面用真实链路（点候选 → 等一帧 → 读单价框）验证它真的填上了。 */
  if (sugg && app.priceMemoryFeature) {
    console.log('\n⑧-b 点副库来的候选，单价要真的填上（本轮修的 bug）');
    const pm = app.priceMemoryFeature;
    const priceInputId = 'autoUnitPrice';
    const readPrice = () => {
      const el = doc.getElementById(priceInputId) || app.el.inputs?.autoUnitPrice;
      return el ? String(el.value || '') : '';
    };
    const d3 = store.normalizeData(libData());
    // A 库 = 一起看 ¥40；B 库 = 鹅鸭杀 ¥30。当前库是 A。
    d3.libraries.find(l => l.id === aId).items = [{ serviceType: '一起看', unitPrice: 40, settleType: '' }];
    d3.libraries.find(l => l.id === bId).items = [{ serviceType: '鹅鸭杀', unitPrice: 30, settleType: '' }];
    /* 三处引用一起换 —— 只改一处会让候选先看到旧的副库条目（实测踩过：
       副库条目的 id 取不到、这一整段断言全变成「取不到副库条目」）。 */
    const d3n = useLibraries(app, store, d3);
    /* 副库条目的 id 要**从归一化后的数据里取**。
       归一化会重算 items 的 id，若用换之前那份数据里的 id，
       点候选时带的是个已失效的 id，匹配不到任何规则 → 单价填不上（会误判成 bug）。 */
    const bItem = d3n.libraries.find(l => l.id === bId).items[0];
    const typeEl = doc.getElementById('type') || app.el.inputs?.type;
    if (typeEl && bItem?.id) {
      typeEl.value = '鹅鸭杀';
      readPrice(); // 触碰一次
      sugg.applyServiceRuleSuggestionElement({
        dataset: { type: '鹅鸭杀', ruleId: String(bItem.id), settleType: 'round', serviceRule: 'true' },
      });
      // 匹配走 requestAnimationFrame / setTimeout，等一帧
      await new Promise(r => setTimeout(r, 400));
      const got = readPrice();
      ck('点副库候选后单价被填上（不是空的）', got !== '', `实得 ${JSON.stringify(got)}`);
      ck('填的是副库那条的价（¥30）', got === '30', `实得 ${JSON.stringify(got)}`);

      /* 归属必须落在 B 库 —— 这正是修复点。
         若退回「固定写当前库」，这条会变成「A 库有记录」，与查价的读法错位。 */
      const matcher = w.eval('PriceRuleMatcher');
      const onB = matcher.getTemporaryChoice(d3.libraries.find(l => l.id === bId), '鹅鸭杀', 'round');
      const onA = matcher.getTemporaryChoice(d3.libraries.find(l => l.id === aId), '鹅鸭杀', 'round');
      ck('选择记在「拥有该规则的库」（B 库）上', !!onB, onB ? String(onB.ruleId) : '无记录');
      ck('没有错记到当前库（A 库）上', !onA, onA ? String(onA.ruleId) : '无记录（正确）');
    } else {
      ['点副库候选后单价被填上（不是空的）', '填的是副库那条的价（¥30）',
        '选择记在「拥有该规则的库」（B 库）上', '没有错记到当前库（A 库）上',
      ].forEach(n => ck(n, false, '取不到服务类型输入框或副库条目'));
    }
  } else {
    ['点副库候选后单价被填上（不是空的）', '填的是副库那条的价（¥30）',
      '选择记在「拥有该规则的库」（B 库）上', '没有错记到当前库（A 库）上',
    ].forEach(n => ck(n, false, '找不到 serviceSuggestionFeature / priceMemoryFeature'));
  }

  /* ── ⑧-c 同名但结算方式不同的两条候选，点哪条就得填哪条的价 ─────────
     【8.3.46 本轮实测抓到的第二个真 bug】
     场景：A 库（当前库）有「鹅鸭杀 ¥7 按局数」，B 库有「鹅鸭杀 ¥35 按小时」。
     候选清单里两条都出来了、库名也标得清清楚楚，**但点副库那条，填进去的是主库的价**。
     根因：点候选时走的是一条「先替换输入框文字、再重新自动匹配」的链路，
     而自动匹配只拿得到「项目名」和一个全局的「当前按小时还是按局数」——
     它会在两库里重新挑一条，挑的顺序是「当前库优先」，于是永远挑回主库那条。
     用户在候选里点的那条**具体是哪条**，在中途被丢掉了。
     修法：把「用户点的是哪一条、那条按什么结算」短暂记下来，
     自动匹配时优先照它取价（见 getCurrentAutoPriceSettleType 的说明）。
     这条链路只有走**真实事件**才会经过，直接调函数会绕开它 ——
     所以下面用真的 mousedown 事件点 DOM 上的候选项。 */
  if (sugg && app.priceMemoryFeature) {
    console.log('\n⑧-c 同名两条结算方式不同时，点副库那条要填副库的价');
    const d4 = store.normalizeData(libData());
    d4.libraries.find(l => l.id === aId).items = [{ serviceType: '鹅鸭杀', unitPrice: 7, settleType: 'round' }];
    d4.libraries.find(l => l.id === bId).items = [{ serviceType: '鹅鸭杀', unitPrice: 35, settleType: 'hour' }];
    useLibraries(app, store, d4);
    const typeEl4 = doc.getElementById('type') || app.el.inputs?.type;
    const priceEl4 = () => [...doc.querySelectorAll('input')].find(i => i.name === 'autoUnitPrice' || i.id === 'autoUnitPrice');
    if (typeEl4) {
      typeEl4.value = '鹅鸭杀';
      typeEl4.dispatchEvent(new w.Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const items4 = [...doc.querySelectorAll('.type-suggest-item')];
      const bEl4 = items4.find(el => /礼物价/.test(el.textContent || ''));
      ck('候选里能同时看到副库那条（标着副库名）', !!bEl4,
        items4.map(el => (el.textContent || '').replace(/\s+/g, ' ').trim()).join(' ｜ '));
      if (bEl4) {
        /* 真实交互走的是 mousedown（程序里就是绑在这个事件上），
           用 click 点不动 —— 实测踩过：click 之后处理函数一次都没被调用。 */
        bEl4.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 500));
        const gotP = String(priceEl4()?.value || '');
        ck('点副库那条后填的是副库的价（¥35，不是主库的 ¥7）', gotP === '35', `实得 ${JSON.stringify(gotP)}`);
      } else {
        ck('点副库那条后填的是副库的价（¥35，不是主库的 ¥7）', false, '候选里找不到副库那条');
      }
    } else {
      ck('候选里能同时看到副库那条（标着副库名）', false, '取不到服务类型输入框');
      ck('点副库那条后填的是副库的价（¥35，不是主库的 ¥7）', false, '取不到服务类型输入框');
    }
  } else {
    ck('候选里能同时看到副库那条（标着副库名）', false, '找不到 serviceSuggestionFeature / priceMemoryFeature');
    ck('点副库那条后填的是副库的价（¥35，不是主库的 ¥7）', false, '找不到 serviceSuggestionFeature / priceMemoryFeature');
  }

  // ── ⑨ 反向验证：断言必须真的能变红 ────────────────────────────
  console.log('\n⑨ 反向验证（确认上面的断言不是假绿）');

  /* 反向 0：把「临时选择记到规则的归属库」退回「固定记当前库」，
     ⑧-b 的归属断言必须失败。
     锚点是 selectTemporaryRule 里那行 owner 判定 —— 退回后选择又会被
     写错键，正是「只有主库能填价」那个 bug 的写法。
     注意这里必须**替换**那一行，不能在前面再插一行同名 const ——
     插进去会变成 `Identifier 'owner' has already been declared` 的语法错误，
     整个页面起不来，断言就测不到想测的东西（实测踩过这个坑）。 */
  const ownerAnchor = ' const owner = this.findLibraryOwningRule(ruleId) || this.priceLibraryStore.getActiveLibrary(this.priceLibraries);';
  const alwaysActive = html.replace(
    ownerAnchor,
    ' const owner = this.priceLibraryStore.getActiveLibrary(this.priceLibraries);'
  );
  ck('反向验证 0 的锚点确实命中了源码（否则本条是假绿）', alwaysActive !== html);
  try {
    const c0 = await boot(alwaysActive);
    const st0 = c0.app.priceLibraryStore;
    const a0 = c0.aId, b0 = c0.bId;
    let d0 = st0.normalizeData(c0.app.priceLibraries);
    d0.libraries.find(l => l.id === a0).items = [{ serviceType: '一起看', unitPrice: 40, settleType: '' }];
    d0.libraries.find(l => l.id === b0).items = [{ serviceType: '鹅鸭杀', unitPrice: 30, settleType: '' }];
    c0.app.priceLibraries = d0;
    c0.app.priceMemoryFeature.priceLibraries = d0;
    st0.persist(d0, {});
    const bItem0 = d0.libraries.find(l => l.id === b0).items[0];
    const t0 = c0.w.document.getElementById('type');
    t0.value = '鹅鸭杀';
    c0.app.features.serviceSuggestionFeature.applyServiceRuleSuggestionElement({
      dataset: { type: '鹅鸭杀', ruleId: String(bItem0.id), settleType: 'round', serviceRule: 'true' },
    });
    await new Promise(r => setTimeout(r, 300));
    const m0 = c0.w.eval('PriceRuleMatcher');
    const wrong = m0.getTemporaryChoice(d0.libraries.find(l => l.id === a0), '鹅鸭杀', 'round');
    ck('反向验证 0：退回写法后选择会错记到当前库（断言确实能变红）', !!wrong,
      wrong ? '错记到 A 库，符合预期' : '未复现错记');
    c0.dom.window.close();
  } catch (e) {
    ck('反向验证 0：退回写法后选择会错记到当前库（断言确实能变红）', false, '运行异常：' + e.message);
  }

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
    /* 这一段依赖「满天星只存在于副库」这个前提，而 ⑧-b 段把副库条目换成了
       只有「鹅鸭杀」（那段要一个干净的跨库点选场景）—— 所以这里先复原。
       步骤之间互相改数据是这个文件的固有形态，每段用完自己复原，
       否则后面的断言会看到上一段的残留（这个坑先后踩过两次）。 */
    const restoreB = store.normalizeData(libData());
    restoreB.libraries.find(l => l.id === bId).items = [
      { serviceType: '鹅鸭杀', unitPrice: 30, settleType: '' },
      { serviceType: '满天星', unitPrice: 10, settleType: '' },
    ];
    useLibraries(app, store, restoreB);

    // 「满天星」只存在于副库，且用「满天」这个前缀去查 —— 不会整条命中规则，
    // 因此不会生成 resolved 补价候选，能干净地测到「清单来源」这条路。
    const listByPrefix = sugg.getServiceRuleSuggestions('满天');
    const bEntry = listByPrefix.find(i => i.displayName === '满天星');
    ck('副库项目会出现在候选清单里（不依赖整条命中）', !!bEntry, listByPrefix.map(i => i.displayName).join('/'));
    /* 【8.3.46】「满天星」只存在于副库，无同名歧义 → 按新规则不该标库名。
       原先这里断言必须出现〔礼物价〕，锁的是「只要多库就每条都标」的旧行为。 */
    ck('副库独有项目在清单里不标库名（无同名歧义）', !!bEntry && !/〔/.test(bEntry.meta), bEntry && bEntry.meta);
  } else {
    ck('副库项目会出现在候选清单里（不依赖整条命中）', false, '找不到 getServiceRuleSuggestions');
    ck('副库独有项目在清单里不标库名（无同名歧义）', false, '找不到 getServiceRuleSuggestions');
  }

  /* 反向 7：把「各库分别归一化再拼起来」退回「跨库一起归一化」，
     跨库同名规则就会被去重吞掉，同名两条断言必须失败。
     这正是用户报的「只有主库能填价」的深层原因：副库的同名规则
     在中途被合并掉，候选里根本没有它。 */
  const lookupAnchor = ' return merged.flatMap(library => PriceRuleEngine.normalizeRules(library.rules).rules);';
  const crossDedup = html.replace(
    lookupAnchor,
    ' return PriceRuleEngine.normalizeRules(merged.flatMap(library => library.rules || [])).rules;'
  );
  ck('反向验证 7 的锚点确实命中了源码（否则本条是假绿）', crossDedup !== html);
  if (crossDedup !== html) {
    let swallowed = false;
    try {
      const c7 = await boot(crossDedup);
      const st7 = c7.app.priceLibraryStore;
      const ed7 = c7.app.priceRuleEditorFeature;
      const sg7 = c7.app.features.serviceSuggestionFeature;
      /* 造同名冲突：两库都有「鹅鸭杀」。 */
      const d7 = st7.normalizeData(c7.app.priceLibraries);
      d7.libraries.find(l => l.id === c7.aId).items = [
        { serviceType: '一起看', unitPrice: 40, settleType: '' },
        { serviceType: '鹅鸭杀', unitPrice: 33, settleType: '' },
      ];
      c7.app.priceLibraries = d7;
      c7.app.priceMemoryFeature.priceLibraries = d7;
      ed7.priceLibraries = d7;
      st7.persist(d7, {});
      // 退回跨库去重后，两库同名的「鹅鸭杀」只剩一条规则
      const rules7 = ed7.getLookupServiceRules().filter(r => r.serviceName === '鹅鸭杀');
      const entries7 = sg7.getServiceRuleSuggestions('鹅鸭杀').filter(i => /^exact\|/.test(i.key));
      swallowed = rules7.length === 1 && entries7.length === 1;
      c7.dom.window.close();
    } catch (e) {
      swallowed = false;
    }
    ck('退回「跨库一起去重」后，副库的同名规则会被吞掉（断言确实能变红）', swallowed === true);
  } else {
    ck('退回「跨库一起去重」后，副库的同名规则会被吞掉（断言确实能变红）', false, '锚点未命中');
  }

  /* 反向 8：把规则 id 里的「库」这层盐去掉，两库同名同价的规则 id 又会撞车。
     撞车后候选的展示键相同 → 两条被当成同一条、其中一条直接消失
     （实测：清单条目从 2 条掉到 0 条，只剩一条 resolved 补价候选；
     库名也只能靠 id 反查、永远命中第一个库）。
     判据：清单里不再有两条同名条目，或两条指向同一个库名。 */
  const scopeAnchor = ' const scope = String(rule?.scope || \'\');';
  const noScope = html.replace(scopeAnchor, ' const scope = \'\';');
  ck('反向验证 8 的锚点确实命中了源码（否则本条是假绿）', noScope !== html);
  if (noScope !== html) {
    let idClash = false;
    try {
      const c8 = await boot(noScope);
      const st8 = c8.app.priceLibraryStore;
      const sg8 = c8.app.features.serviceSuggestionFeature;
      const d8 = st8.normalizeData(c8.app.priceLibraries);
      // 两库同名**同价**：这是 id 最容易撞车的组合（价钱也一样，三要素也分不开）
      d8.libraries.find(l => l.id === c8.aId).items = [
        { serviceType: '一起看', unitPrice: 40, settleType: '' },
        { serviceType: '鹅鸭杀', unitPrice: 30, settleType: '' },
      ];
      d8.libraries.find(l => l.id === c8.bId).items = [{ serviceType: '鹅鸭杀', unitPrice: 30, settleType: '' }];
      c8.app.priceLibraries = d8;
      c8.app.priceMemoryFeature.priceLibraries = d8;
      c8.app.priceRuleEditorFeature.priceLibraries = d8;
      st8.persist(d8, {});
      const src8 = sg8.getServiceRuleSuggestions('鹅鸭杀')
        .filter(i => /^exact\|/.test(i.key))
        .map(i => (i.meta.match(/^〔([^〕]*)〕/) || [])[1] || '');
      /* 实测的变红形态（比预想的更强烈）：两条同名候选因为 key 相同
         被去重逻辑当成同一条，**直接只剩 1 条**，清单条目数掉到 0
         （唯一那条还是 resolved 补价候选）。所以判据是
         「清单条目不再是两条、或两条指向同一个库名」，任一成立即算变红。 */
      idClash = src8.length !== 2 || new Set(src8).size === 1;
      c8.dom.window.close();
    } catch (e) {
      idClash = false;
    }
    ck('去掉规则 id 里的「库」这层盐后，同名两条会撞成一条/指向同一个库（断言确实能变红）', idClash === true);
  } else {
    ck('去掉规则 id 里的「库」这层盐后，同名两条会撞成一条/指向同一个库（断言确实能变红）', false, '锚点未命中');
  }

  /* 反向 9：把「别名随 item 一起存下来」拆掉（拼装 item 时不带 aliases），
     ②-c 那组断言必须失败。
     这是本轮实测抓到的真缺陷：normalizeEntry 算出了别名，
     拼 item 时却没带上，于是从 items 升上来的规则全都没别名。 */
  const aliasAnchor = ' aliases: base.aliases,\n alias: base.alias,\n usageCount: Math.max(1, Number(raw?.usageCount) || Number(base.usageCount) || 1),';
  const noAlias = html.replace(aliasAnchor, ' usageCount: Math.max(1, Number(raw?.usageCount) || Number(base.usageCount) || 1),');
  ck('反向验证 9 的锚点确实命中了源码（否则本条是假绿）', noAlias !== html);
  if (noAlias !== html) {
    let aliasGone = false;
    try {
      const c9 = await boot(noAlias);
      const st9 = c9.app.priceLibraryStore;
      const d9 = st9.normalizeData(c9.app.priceLibraries);
      d9.libraries.find(l => l.id === c9.bId).items = [
        { serviceType: '鹅鸭杀', unitPrice: 30, settleType: '', aliases: ['鹅鸭杀A版'] },
      ];
      const n9 = st9.normalizeData(d9);
      const it9 = (n9.libraries.find(l => l.id === c9.bId).items || []).find(i => i.serviceType === '鹅鸭杀');
      const rl9 = (n9.libraries.find(l => l.id === c9.bId).rules || []).find(r => r.serviceName === '鹅鸭杀');
      // 拆掉之后 item 上没有别名，规则上也传不下来
      aliasGone = !it9?.aliases?.length && !rl9?.aliases?.length;
      c9.dom.window.close();
    } catch (e) {
      aliasGone = false;
    }
    ck('拆掉「别名随 item 存下来」后，别名会整体消失（断言确实能变红）', aliasGone === true);
  } else {
    ck('拆掉「别名随 item 存下来」后，别名会整体消失（断言确实能变红）', false, '锚点未命中');
  }

  /* 反向 10：把「合成虚拟库时不去重 items」退回「按名字+结算方式去重、先到先得」，
     ④ 段那两条断言必须失败。
     这是本轮实测抓到的真缺陷：键里没有价钱，两库同名不同价时副库那条被静默丢弃，
     用户只拿得到当前库的价、而且完全不知道还有另一条可选。
     判据：合成出的虚拟库里同名项目不再有两条。
     注：8.3.47 起这段拼接语句多了「补上所属库标记」的那层 map
     （记录要知道自己在哪个库，靠 id 反查才不会永远命中第一个库），
     所以锚点要按**现在的**写法写；拆掉的方式仍然是「改成按名字去重」。 */
  const itemsFlatAnchor = [
    ' items: libraries.flatMap(library => (library.items || []).map(item => (',
  ].join('\n');
  const itemsDedup = html.replace(itemsFlatAnchor, [
    ' items: (() => { const m = new Map();',
    ' libraries.forEach(library => (library.items || []).forEach(item => {',
    ' const k = `${item.serviceKey}|${item.settleType}`;',
    ' if (!m.has(k)) m.set(k, item); }));',
    ' return [...m.values()]; })(),',
    ' _unused: libraries.flatMap(library => (library.items || []).map(item => ('
  ].join('\n'));
  ck('反向验证 10 的锚点确实命中了源码（否则本条是假绿）', itemsDedup !== html);
  if (itemsDedup !== html) {
    let swallowed2 = false;
    try {
      const c10 = await boot(itemsDedup);
      const st10 = c10.app.priceLibraryStore;
      const d10 = st10.normalizeData(c10.app.priceLibraries);
      d10.libraries.find(l => l.id === c10.aId).items = [
        { serviceType: '一起看', unitPrice: 40, settleType: '' },
        { serviceType: '鹅鸭杀', unitPrice: 30, settleType: '' },
      ];
      d10.libraries.find(l => l.id === c10.bId).items = [{ serviceType: '一起看', unitPrice: 99, settleType: '' }];
      c10.app.priceLibraries = d10;
      c10.app.priceMemoryFeature.priceLibraries = d10;
      c10.app.priceRuleEditorFeature.priceLibraries = d10;
      st10.persist(d10, {});
      const sameName10 = (st10.mergeLibrariesForLookup(d10).items || []).filter(i => i.serviceType === '一起看');
      swallowed2 = sameName10.length === 1;
      c10.dom.window.close();
    } catch (e) {
      swallowed2 = false;
    }
    ck('退回「合成虚拟库时按名字去重」后，副库的同名项目会被吞掉（断言确实能变红）', swallowed2 === true);
  } else {
    ck('退回「合成虚拟库时按名字去重」后，副库的同名项目会被吞掉（断言确实能变红）', false, '锚点未命中');
  }

  /* 反向 11：把候选自带的「按什么结算」退回「按全局偏好模式」，
     ⑧-c 那条断言必须失败。
     这是本轮实测抓到的真缺陷，也是「副库项目点了候选填不上价」的**直接原因**：
     改动前，清单里每条候选带的结算方式都是同一个值（按界面当前偏好算出来的），
     而不是「这条记录自己是怎么计价的」。于是主库那条按局数、副库那条按小时时，
     两条候选**都**说自己是「局数」—— 用户点副库那条，程序拿着「局数」
     去两库里找，主库排前面、正好有条局数的，就填了主库的价。
     修法：每条候选带上它**自己的**结算方式（哪一档有价就用哪一档）。
     实测：退回旧写法后，点副库那条匹配到的是「默认价格表 ¥7」，
     与副库的 ¥35 完全对不上 —— 正是用户描述的症状。 */
  const entrySettleAnchor = /const entrySettle = PriceRuleEngine\.normalizePositivePrice\(rule\.prices\?\.\[preferred\]\) !== null \? preferred : \(PriceRuleEngine\.normalizePositivePrice\(rule\.prices\?\.round\) !== null \? 'round' : 'hour'\);/;
  const globalSettle = html.replace(entrySettleAnchor, 'const entrySettle = preferred;');
  ck('反向验证 11 的锚点确实命中了源码（否则本条是假绿）', globalSettle !== html);
  if (globalSettle !== html) {
    let wrongPrice = false;
    try {
      const c11 = await boot(globalSettle);
      const st11 = c11.app.priceLibraryStore;
      const sg11 = c11.app.features.serviceSuggestionFeature;
      const d11 = st11.normalizeData(c11.app.priceLibraries);
      // 主库按局数 ¥7、副库按小时 ¥35 —— 同名、不同结算方式
      d11.libraries.find(l => l.id === c11.aId).items = [{ serviceType: '鹅鸭杀', unitPrice: 7, settleType: 'round' }];
      d11.libraries.find(l => l.id === c11.bId).items = [{ serviceType: '鹅鸭杀', unitPrice: 35, settleType: 'hour' }];
      c11.app.priceLibraries = d11;
      c11.app.priceMemoryFeature.priceLibraries = d11;
      c11.app.priceRuleEditorFeature.priceLibraries = d11;
      st11.persist(d11, {});
      const type11 = c11.dom.window.document.getElementById('type') || sg11.el.inputs?.type;
      const price11 = () => [...c11.dom.window.document.querySelectorAll('input')]
        .find(i => i.name === 'autoUnitPrice' || i.id === 'autoUnitPrice');
      type11.value = '鹅鸭杀';
      type11.dispatchEvent(new c11.dom.window.Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const items11 = [...c11.dom.window.document.querySelectorAll('.type-suggest-item')];
      const bEl11 = items11.find(el => /礼物价/.test(el.textContent || '')) || items11[items11.length - 1];
      if (bEl11) {
        bEl11.dispatchEvent(new c11.dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 500));
        // 退回旧写法后填进去的不是副库的 35（实测是主库的 7）
        wrongPrice = String(price11()?.value || '') !== '35';
      }
      c11.dom.window.close();
    } catch (e) {
      wrongPrice = false;
    }
    ck('若候选不带自己的结算方式，点副库那条会填成主库的价（断言确实能变红）', wrongPrice === true);
  } else {
    ck('若候选不带自己的结算方式，点副库那条会填成主库的价（断言确实能变红）', false, '锚点未命中');
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
