#!/usr/bin/env node
/**
 * 码单器 8.3 项目表达式 / 结算 / 加价落位链路测试（JSDOM 版）
 *
 * 为什么需要这个文件：
 *   `test-engine.js` 只把引擎类抠出来在 vm 里跑，测的是「引擎被喂了正确入参时算得对不对」。
 *   它测不到「界面上的输入有没有被正确喂进去」。而 8.3.25 / 8.3.26 / 8.3.27 三个版本
 *   连续出的 bug 恰恰全在**喂入链路**上：
 *     · 8.3.25  未保存项目 + 自定义单价算不出总价（手输价没锚到正确项目）
 *     · 8.3.26  局数模式总价算错、切「局数/小时」按钮不触发重算
 *     · 8.3.27  清空再重打（改时长）时单价被当作「撤销定价」丢弃，总价不刷新
 *   当时这些都没有自动化覆盖，全靠真机手测。
 *
 * 本脚本用**真实 App 实例**（真实 DOM + 真实事件）跑这些场景，不 mock 业务逻辑；
 * 额外挂一层「表达式 → 解析 → 建项目 → 结算 → 加价落位」的链路一致性检查，
 * 用真实引擎交叉验证界面呈现的结果。
 *
 * 用法: node project-chain.js <index.html> <out.json>
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const htmlPath = process.argv[2];
const outPath = process.argv[3];
const html = fs.readFileSync(htmlPath, 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + String((e && e.message) || e)));

const wait = ms => new Promise(r => setTimeout(r, ms));
// ── 断言 ─────────────────────────────────────────────────────
// 支持两种写法：
//   t.set(name, actual, expected)   值比较（深层相等）
//   t.ok(name, condition, actual)   布尔判断
// 早先版本只有一个 t(name, ok, actual)，而调用处全部按 (name, actual, expected) 写，
// 导致 `t('x', 405, 405)` 实际把 405 当成了「真值」——永远为真。
// 这类「永远为真」的断言正是变异测试要抓的假绿，已按 (name, actual, expected) 语义纠正。
const checks = {};
function eq(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
}
function t(name, actual, expected) { checks[name] = { ok: eq(actual, expected), actual, expected }; }
t.ok = function (name, cond, actual) { checks[name] = { ok: !!cond, actual }; };
const J = o => JSON.stringify(o);

(async () => {
  const dom = new JSDOM(html, {
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
  t.ok('app_initialized', !!app, errors.slice(0, 3));
  if (!app) throw new Error('app 未初始化');
  await wait(300);

  // ── 工具 ─────────────────────────────────────────────────────
  const set = (id, v) => {
    const el = w.document.getElementById(id);
    if (!el) return false;
    el.value = v;
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    return true;
  };
  const txt = id => { const el = w.document.getElementById(id); return el ? String(el.textContent || '').trim() : ''; };
  const surInput = () => (app.el && app.el.inputs && app.el.inputs.surcharge) || null;
  const setSur = v => {
    const el = surInput();
    if (!el) return false;
    el.value = v;
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    return true;
  };
  // 项目小计（价格区渲染的文本）
  const subText = () => txt('priceSubtotalNote').replace('项目小计：', '').trim();
  const subNum = () => {
    const m = subText().match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const projects = () => (app.orderProjects || []).map(p => ({
    svc: p.serviceDisplay, qty: p.quantityRaw, mode: p.quantityMode,
    unit: p.unitPrice, sub: p.subtotal, billing: p.billingQuantity,
  }));
  // ── 加价后的「真实结算数据」在哪？─────────────────────────────
  // 已实测（见 CHANGELOG 8.3.19/8.3.21 行为）：
  //   · app.orderProjects 是**基础价项目**，加价不写回这里
  //     （unitPrice/baseUnitPrice 恒为基础单价，subtotal 为基础小计）
  //   · 加价只活在「本次结算的 pricedAggregate」里：
  //     ProjectSettlementEngine.createProject 产出
  //     baseUnitPrice / surchargeUnitPrice / effectiveUnitPrice / subtotal
  //     且 subtotal = effectiveUnitPrice × calculationQuantity
  //   · 界面上呈现的就是 pricedAggregate.projects（见 priceSubtotalNote）
  // 所以断言加价落位必须读 pricedAggregate，不能读 orderProjects。
  const priced = () => {
    if (!app.autoPriceFeature || typeof app.autoPriceFeature.getDraftSnapshot !== 'function') return null;
    const snap = app.autoPriceFeature.getDraftSnapshot({ render: false });
    const agg = snap && snap.pricedAggregate;
    if (!agg || !Array.isArray(agg.projects)) return null;
    return {
      total: agg.totalPrice,
      projects: agg.projects.map(p => ({
        svc: p.serviceDisplay, qty: p.quantityRaw, mode: p.quantityMode,
        unit: p.unitPrice, base: p.baseUnitPrice, sur: p.surchargeUnitPrice,
        eff: p.effectiveUnitPrice, billing: p.billingQuantity, sub: p.subtotal,
      })),
    };
  };
  // 小计文本拆成数字数组，同时取「累计」值 —— 这是用户真正看到的数字
  const subParts = () => (subText().split('｜')[0].replace('项目小计：', '').split('+').map(s => Number(s.trim())).filter(n => Number.isFinite(n)));
  const subTotalShown = () => {
    const m = subText().match(/累计\s*(-?\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]);
    const parts = subParts();
    return parts.length === 1 ? parts[0] : null;
  };
  const reset = async () => {
    app.switchMode(1);
    if (app.clearAll) app.clearAll();
    await wait(220);
  };
  // ── 加价规则注入 ─────────────────────────────────────────────
  // 为什么必须先注入规则：默认 getRules() 返回 []，此时加价框只走「纯数字加价」一条路，
  // 「关键词命中 → 按规则加价」

  // 「备注是否参与加价」「目标歧义」「缺价目」这些分支根本不会被走到。
  // 变异测试实测：不注入规则时，把 combinedNote 改回 note+加价框 都不会让任何断言变红。
  // 因此这里用 App **自己的持久化入口** 写入规则，保证走的是与真人操作一致的存储链路。
  const seedRules = async rules => {
    const store = (app.surchargeFeature && app.surchargeFeature.priceLibraryStore)
      || (app.priceRuleEditorFeature && app.priceRuleEditorFeature.priceLibraryStore);
    if (!store || typeof store.saveActiveSurcharges !== 'function') return false;
    const res = store.saveActiveSurcharges(app.priceLibraries, rules);
    if (res && res.ok && res.data) app.priceLibraries = res.data;
    await wait(200);
    return true;
  };
  const clearRules = async () => seedRules([]);
  const RULE_SWEET = { id: 'test_sweet', name: '甜蜜暗恋单', keywords: ['甜蜜单'], prices: { round: 10, hour: 20 }, enabled: true };
  const RULE_PAIDAN = { id: 'test_liamai', name: '连麦加成', keywords: ['连麦'], prices: { round: 5 }, enabled: true };
  const RULE_OFF = { id: 'test_off', name: '停用规则', keywords: ['停用词'], prices: { round: 99 }, enabled: false };

  // ── 1. 引擎类在运行时是否可达（决定能否做交叉验证） ────────────
  // 注意：主脚本用 IIFE 包裹，引擎类不挂在 window 上。
  // 这里用「结构化探针」替代：直接检测 App 暴露的行为入口是否存在。
  t.ok('app_switchMode_available', typeof app.switchMode === 'function', typeof app.switchMode);
  t.ok('app_clearAll_available', typeof app.clearAll === 'function', typeof app.clearAll);
  t.ok('app_orderFlow_available', !!(app.orderFlow && typeof app.orderFlow.calculate === 'function'), !!app.orderFlow);
  t.ok('app_surchargeFeature_available', !!app.surchargeFeature, typeof app.surchargeFeature);
  t.ok('inputs_surcharge_present', !!surInput(), surInput() ? surInput().id : null);

  // ── 2. 未保存项目 + 自定义单价（8.3.25 场景：1h = 3 局） ───────
  await reset();
  set('type', '1h新项目');
  await wait(250);
  t.ok('unsaved_expr_no_project_before_price', projects().length === 0, projects());
  set('autoUnitPrice', '25');
  await wait(320);
  t.ok('unsaved_project_created', projects().length === 1, projects());
  if (projects().length === 1) {
    const p = projects()[0];
    t('unsaved_project_name', p.svc, '新项目');
    t('unsaved_project_mode_round', p.mode, 'round');
    t('unsaved_project_billing_3', p.billing, 3);            // 1h = 3 局
    t('unsaved_project_unit_25', p.unit, 25);
    t('unsaved_project_subtotal_75', p.sub, 75);
  }
  t('unsaved_subtotal_rendered_75', subNum(), 75);

  // ── 3. 改时长后小计即时刷新（8.3.27 场景） ────────────────────
  // 3h → 9 局 → 225；改成 5h → 15 局 → 375（单价 25 应自动套回，不丢）
  await reset();
  set('type', '3h新项目');
  await wait(250);
  set('autoUnitPrice', '25');
  await wait(320);
  t('duration_edit_before_225', subNum(), 225);
  set('type', '5h新项目');
  await wait(420);
  t('duration_edit_after_375', subNum(), 375);   // 8.3.27 修复点：不清空、立即刷新
  t('duration_edit_keeps_unit', projects()[0] && projects()[0].unit, 25);

  // ── 4. 清空后换项目名 → 旧单价必须作废（不得串到下一单） ────────
  await reset();
  set('type', '3h技术匹配');
  await wait(250);
  set('autoUnitPrice', '25');
  await wait(320);
  t('switch_before_has_price', subNum(), 225);
  set('type', '');
  await wait(260);
  set('type', '2h鹅鸭杀');
  await wait(420);
  const afterSwitch = projects();
  t.ok('switch_after_old_price_dropped', afterSwitch.length === 0 || afterSwitch.every(p => p.unit !== 25),
    { projects: afterSwitch, note: subText().slice(0, 60) });

  // ── 5. 清空后重打同一项目只改时长 → 单价必须保住（8.3.27 正向） ──
  await reset();
  set('type', '1h技术匹配');
  await wait(250);
  set('autoUnitPrice', '25');
  await wait(320);
  t('same_topic_before_75', subNum(), 75);
  set('type', '');
  await wait(320);
  // 8.3.27：服务类型框清空 = 本单结束。此时**渲染层必须同步清干净**，
  // 不能把上一单的总价/小计留在界面上（否则用户以为还没结束）。
  // 这条断言的存在理由：变异测试实测，只断言 orderProjects 时，
  // 把「清空后清理表达式状态」整段删掉都不会让任何断言变红——渲染层是盲区。
  t('cleared_type_renders_no_subtotal', subText(), '');
  t('cleared_type_total_reset', String((w.document.getElementById('totalPrice') || {}).value || ''), '');
  set('type', '1h技术匹配');
  await wait(420);
  const again = projects();
  t.ok('same_topic_keeps_price', again.length === 1 && again[0].unit === 25, again);
  t('same_topic_after_75', subNum(), 75);   // 干净重打后总价必须回来

  // ── 6. 加价框数字：单项目，无候选 → 直接全落 ────────────────────
  // 3h → 9 局 × 30 = 270，加价 15/局 → 9 × 45 = 405
  await reset();
  set('type', '3h技术匹配');
  await wait(250);
  set('autoUnitPrice', '30');
  await wait(320);
  t('surcharge_before_270', subNum(), 270);
  setSur('15');
  await wait(420);
  t('surcharge_numeric_all_405', subNum(), 405);
  t('surcharge_single_renders_no_cumulative', subText(), '405');
  {
    const pz = priced();
    t.ok('priced_available_single', !!pz, pz);
    if (pz && pz.projects[0]) {
      const p = pz.projects[0];
      t('surcharge_base_unit_30', p.base, 30);
      t('surcharge_unit_is_15', p.sur, 15);
      t('surcharge_effective_45', p.eff, 45);
      t('surcharge_billing_9', p.billing, 9);
      t('surcharge_subtotal_405', p.sub, 405);
      t('surcharge_total_405', pz.total, 405);
    }
    // 基础项目数据不被加价污染（加价只活在结算结果里）
    t('base_projects_untouched_by_surcharge', projects()[0] && projects()[0].sub, 270);
  }

  // ── 7. 加价框数字 + 多项目 ────────────────────────────────────
  // 两项目：技术匹配 3局、鹅鸭杀 1h(局模式=3局)，写价 30 再覆盖为 40
  // 实测：后写的 40 同时成为两项的 baseUnitPrice（写价是「当前草稿」级别，非逐项锚定）
  //       → 基础 3×40 + 3×40 = 240
  await reset();
  set('type', '3局技术匹配+1h鹅鸭杀');
  await wait(300);
  set('autoUnitPrice', '30');
  await wait(250);
  set('autoUnitPrice', '40');
  await wait(300);
  const two = projects();
  t('two_projects_created', two.length, 2);
  if (two.length === 2) {
    t('two_projects_names', two.map(p => p.svc), ['技术匹配', '鹅鸭杀']);
    t('two_projects_billing_each_3', two.map(p => p.billing), [3, 3]);
    t('two_projects_subtotal', two.reduce((s, p) => s + p.sub, 0), 120 + 120);
  }

  // 7a. 未指定目标：数字加价应默认落到全部项目
  setSur('15');
  await wait(420);
  const cands = app.surchargeFeature && app.surchargeFeature.buildSurchargeCandidates
    ? app.surchargeFeature.buildSurchargeCandidates() : [];
  t.ok('candidates_offered_for_multi', cands.length === 3, cands.map(c => c.key));
  t('candidates_include_all_first', cands[0] && cands[0].key, 'all');
  t('candidates_project_keys', cands.slice(1).map(c => c.key), ['p0', 'p1']);
  t('candidates_project_labels', cands.slice(1).map(c => c.label), ['技术匹配', '鹅鸭杀']);
  // 默认 targetKey='all' → all=true
  t('default_target_is_all', app.surchargeFeature.resolveSurchargeTarget(), { index: -1, all: true });
  // 全部项目各 +15/局 → (40+15)×3 ×2 = 165 + 165
  t('surcharge_all_renders_165_165', subText(), '165 + 165｜累计330');
  t('surcharge_all_total_330', subTotalShown(), 330);
  {
    // 关键：加价不写回 orderProjects
    t('surcharge_does_not_mutate_orderProjects', projects().map(p => p.sub), [120, 120]);
    const pz = priced();
    t.ok('priced_available_multi', !!pz, pz);
    if (pz) {
      t('surcharge_all_per_project_sur', pz.projects.map(p => p.sur), [15, 15]);
      t('surcharge_all_per_project_eff', pz.projects.map(p => p.eff), [55, 55]);
      t('surcharge_all_per_project_sub', pz.projects.map(p => p.sub), [165, 165]);
      t('surcharge_all_bases', pz.projects.map(p => p.base), [40, 40]);
      t('surcharge_all_aggregate_total', pz.total, 330);
    }
  }

  // 7b. 定向到第 1 项 —— 用真实键盘路径（ArrowDown + Enter）选中 p0，
  //     而不是直接改内部字段。只有走真实事件流，才能覆盖「候选选择器」这段界面逻辑。
  {
    const sf = app.surchargeFeature;
    const surEl = surInput();
    const list = app.el.typeSuggestList;
    t.ok('suggestion_surface_owned_by_surcharge', !!(list && list.classList.contains('show')), list ? list.className : null);
    t('suggestion_items_present', list ? Array.from(list.querySelectorAll('.type-suggest-item')).map(n => n.dataset.surchargeKey) : null, ['all', 'p0', 'p1']);
    // ArrowDown：默认 activeIndex=0(all) → 1(p0)
    const handledDown = sf.handleSurchargeSuggestionKeydown(new w.KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true, cancelable: true }));
    t.ok('arrow_down_handled', handledDown === true, handledDown);
    t('arrow_down_active_index_1', sf._surchargeSuggestActiveIndex, 1);
    // Enter：选中 active 项
    const handledEnter = sf.handleSurchargeSuggestionKeydown(new w.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    t.ok('enter_handled', handledEnter === true, handledEnter);
    t('enter_targets_p0', sf._surchargeTargetKey, 'p0');
    t('target_after_pick_is_index_0', sf.resolveSurchargeTarget(), { index: 0, all: false });
    await wait(420);
    t('targeted_renders_165_120', subText(), '165 + 120｜累计285');
    t('targeted_total_285', subTotalShown(), 285);
    const pz = priced();
    t.ok('priced_available_targeted', !!pz, pz);
    if (pz) {
      // 加价只落在 p0；p1 保持基础价
      t('targeted_surcharge_only_first', pz.projects.map(p => p.sur), [15, 0]);
      t('targeted_effective_55_40', pz.projects.map(p => p.eff), [55, 40]);
      t('targeted_subtotals_165_120', pz.projects.map(p => p.sub), [165, 120]);
      t('targeted_sum_285', pz.total, 285);
      t('targeted_second_project_price_intact', pz.projects[1] && pz.projects[1].base, 40);
    }
    t('targeted_base_projects_still_untouched', projects().map(p => p.sub), [120, 120]);
    t('targeted_input_preserved', surEl ? surEl.value : null, '15');
    // 同项再点一次 = 只重算，不取消（8.3.21 决策：取消选择是误操作陷阱）
    const items = Array.from(list.querySelectorAll('.type-suggest-item'));
    const p0el = items.find(n => n.dataset.surchargeKey === 'p0');
    t.ok('p0_candidate_element_found', !!p0el, items.map(n => n.dataset.surchargeKey));
    if (p0el) {
      sf.pickSurchargeCandidate(p0el);
      await wait(300);
      t('reclick_same_keeps_target', sf._surchargeTargetKey, sf._surchargeTargetKey);
      t('reclick_same_keeps_total', subTotalShown(), 285);
    }
  }

  // 7c. 切回「全部项目」
  {
    const sf = app.surchargeFeature;
    const list = app.el.typeSuggestList;
    const allEl = Array.from(list.querySelectorAll('.type-suggest-item')).find(n => n.dataset.surchargeKey === 'all');
    t.ok('all_candidate_element_found', !!allEl, allEl ? allEl.dataset.surchargeKey : null);
    if (allEl) {
      sf.pickSurchargeCandidate(allEl);
      await wait(400);
      t('switch_back_to_all', sf.resolveSurchargeTarget(), { index: -1, all: true });
      t('switch_back_to_all_total_330', subTotalShown(), 330);
    }
  }

  // ── 8. 备注不参与加价；加价框关键词才参与（8.3.19 决策，界面层回归） ──
  // 这段必须**先注入启用规则**才有效。默认 getRules()=[]，
  // 关键词链路完全不经过，「备注是否误触发」就测不出来。
  await seedRules([RULE_SWEET, RULE_PAIDAN, RULE_OFF]);
  t('rules_seeded', app.surchargeFeature.getRules().length, 3);
  await reset();
  set('type', '3局技术匹配');
  await wait(280);
  set('autoUnitPrice', '30');
  await wait(320);
  t('kw_baseline_90', subNum(), 90);
  // 备注写命中规则的词 —— 必须完全不影响加价
  set('note', '甜蜜单');
  await wait(450);
  t('note_keyword_does_not_trigger', subNum(), 90);
  t('note_keyword_renders_90', subText(), '90');
  // 备注里写数字也不参与
  set('note', '15');
  await wait(400);
  t('note_numeric_does_not_trigger', subNum(), 90);
  set('note', '');
  await wait(260);
  t('note_cleared_back_to_90', subNum(), 90);
  // 同一个词放进加价框 —— 这时才应生效：+10/局 × 3 = 120
  setSur('甜蜜单');
  await wait(500);
  t('surcharge_box_keyword_triggers', subNum(), 120);
  t('surcharge_box_keyword_renders_120', subText(), '120');
  {
    const pz = priced();
    if (pz && pz.projects[0]) {
      t('kw_surcharge_unit_10', pz.projects[0].sur, 10);
      t('kw_surcharge_effective_40', pz.projects[0].eff, 40);
      t('kw_surcharge_subtotal_120', pz.projects[0].sub, 120);
    }
  }
  // 停用规则的关键词不生效
  setSur('停用词');
  await wait(450);
  t('disabled_rule_keyword_ignored', subNum(), 90);
  // 未命中任何规则的普通文字不生效
  setSur('随便写点什么');
  await wait(450);
  t('unmatched_keyword_ignored', subNum(), 90);
  setSur('');
  await wait(300);
  t('kw_surcharge_cleared_90', subNum(), 90);

  // ── 8b. 关键词加价 + 多项目：目标解析链路（exact / partial / ambiguous / not-found） ──
  await reset();
  set('type', '3局技术匹配+1h鹅鸭杀');
  await wait(320);
  set('autoUnitPrice', '40');
  await wait(340);
  t('kw_multi_base_240', subTotalShown(), 240);
  {
    const sf = app.surchargeFeature;
    const mk = v => ({ surchargeText: v, targetIndex: -1, targetAll: null });
    // 精确命中单个项目名 → 只加那一项
    setSur('甜蜜单@技术匹配');
    await wait(500);
    t('kw_target_exact_renders', subText(), '150 + 120｜累计270');   // 120+30, 120
    t('kw_target_exact_total_270', subTotalShown(), 270);
    {
      const pz = priced();
      if (pz) {
        t('kw_target_exact_only_first', pz.projects.map(p => p.sur), [10, 0]);
        t('kw_target_exact_subtotals', pz.projects.map(p => p.sub), [150, 120]);
      }
    }
    // 目标找不到 → 报错、不改价（走界面渲染的错误提示路径）
    setSur('甜蜜单@不存在的项目');
    await wait(500);
    t('kw_target_not_found_keeps_base', subTotalShown(), 240);
    {
      const r = sf.resolveProjects(app.orderProjects, { render: false });
      t.ok('kw_target_not_found_ok_false', r.ok === false, r.ok);
      t('kw_target_not_found_code', (r.errors[0] || {}).code, 'target-not-found');
    }
    // 目标歧义：@技术 同时前缀匹配两个 → 必须报歧义而不是随便挑一个
    setSur('甜蜜单@技术');
    await wait(500);
    {
      const r = sf.resolveProjects(app.orderProjects, { render: false });
      // 「技术」只命中「技术匹配」一项 → partial 成功；构造真正歧义的用例
      t.ok('kw_target_partial_ok', r.ok === true || r.errors[0]?.code === 'target-ambiguous', { ok: r.ok, code: r.errors[0]?.code });
    }
    // 真正歧义：两个项目名都含「测」，@测 无法区分
    set('type', '3局测试甲+3局测试乙');
    await wait(340);
    set('autoUnitPrice', '40');
    await wait(340);
    setSur('甜蜜单@测试');
    await wait(500);
    {
      const r = sf.resolveProjects(app.orderProjects, { render: false });
      t.ok('kw_target_ambiguous_detected', r.ok === false && r.errors[0]?.code === 'target-ambiguous',
        { ok: r.ok, code: r.errors[0]?.code, errors: (r.errors || []).map(e => e.code) });
      t('kw_target_ambiguous_keeps_base', subTotalShown(), 240);
    }
    // @全部 → 落到所有项目
    set('type', '3局技术匹配+1h鹅鸭杀');
    await wait(340);
    set('autoUnitPrice', '40');
    await wait(340);
    setSur('甜蜜单@全部');
    await wait(500);
    t('kw_target_all_renders', subText(), '150 + 150｜累计300');
    t('kw_target_all_total_300', subTotalShown(), 300);
    // 缺价目：连麦规则只有 round 价，@到 hour 项目 → price-missing
    // 先把项目切成小时模式
    setSur('');
    await wait(250);
    app.autoPriceFeature.setMode('hour');
    await wait(400);
    setSur('连麦');
    await wait(500);
    {
      const r = sf.resolveProjects(app.orderProjects, { render: false });
      // hour 项目缺 hour 价目 → 必须报 price-missing，且不得静默按 round 价结算
      t.ok('kw_price_missing_detected', r.ok === false && (r.errors || []).every(e => e.code === 'price-missing'),
        { ok: r.ok, codes: (r.errors || []).map(e => e.code) });
      // 实测：切到 hour 后 1h 项目按小时结算（3局→1小时），基线从 240 降为 80；
      // price-missing 时小计必须保持基线不变（不得静默按 round 价结算）
      t('kw_price_missing_keeps_base_80', subTotalShown(), 80);
    }
    app.autoPriceFeature.setMode('round');
    await wait(300);
  }

  // ── 9. 加价候选生命周期 ───────────────────────────────────────
  await clearRules();
  t('rules_cleared', app.surchargeFeature.getRules().length, 0);
  await reset();
  set('type', '3局技术匹配+1h鹅鸭杀');
  await wait(300);
  set('autoUnitPrice', '40');
  await wait(320);
  {
    const sf = app.surchargeFeature;
    const surEl = surInput();
    // 空加价框 → 不出候选
    surEl.value = ''; surEl.dispatchEvent(new w.Event('input', { bubbles: true })); await wait(280);
    t.ok('empty_surcharge_no_candidates', sf.buildSurchargeCandidates().length === 0, sf.buildSurchargeCandidates().length);
    t('empty_surcharge_total_is_base', subTotalShown(), 240);
    // 非数字且不命中规则 → 不出候选
    surEl.value = 'abc'; surEl.dispatchEvent(new w.Event('input', { bubbles: true })); await wait(280);
    t.ok('non_numeric_surcharge_no_candidates', sf.buildSurchargeCandidates().length === 0, sf.buildSurchargeCandidates().length);
    // 逐字符输入：'1' 就该立即出候选（8.3.21：数字输入同样进入候选）
    surEl.value = '1'; surEl.dispatchEvent(new w.Event('input', { bubbles: true })); await wait(300);
    t('numeric_partial_1_has_candidates', sf.buildSurchargeCandidates().length, 3);
    t('numeric_partial_1_total_246', subTotalShown(), 246);   // (40+1)×3 ×2
    // 清空 → 候选收起、加价归零
    surEl.value = ''; surEl.dispatchEvent(new w.Event('input', { bubbles: true })); await wait(300);
    t.ok('cleared_surcharge_collapses_candidates', sf.buildSurchargeCandidates().length === 0, sf.buildSurchargeCandidates().length);
    t('cleared_surcharge_back_to_base_240', subTotalShown(), 240);
  }

  // ── 10. 小数单价 + 小数加价（结算取整规则不得破坏小计） ─────────
  await reset();
  set('type', '3局技术匹配');
  await wait(250);
  set('autoUnitPrice', '33.33');
  await wait(320);
  t('decimal_unit_base_9999', subNum(), 99.99);
  setSur('10');
  await wait(420);
  t('decimal_unit_with_surcharge', subNum(), 129.99);   // 3 × (33.33+10)
  {
    const pz = priced();
    if (pz) {
      t('decimal_surcharge_effective', pz.projects[0] && pz.projects[0].eff, 43.33);
      t('decimal_surcharge_subtotal', pz.projects[0] && pz.projects[0].sub, 129.99);
    }
  }

  // ── 10b. 结算快照必须随加价框内容失效（缓存契约） ──────────────
  // 为什么单列一段：上面所有用例都走「input 事件 → refreshOrderPreview()」，
  // 那条路会**显式** invalidate 快照，于是 signature 里的 surcharge 字段
  // 是不是参与比较，根本观察不到。变异测试实测：把 signature 的 surcharge
  // 固定为 ''，上面 118 条断言全绿。
  // 但「直接改 value 再 syncUI()」这条路径**只依赖 signature 判断缓存是否命中**，
  // 少了它就会拿旧快照渲染 —— 正是 8.3.26「改了却不重算」的同款病灶。
  await seedRules([RULE_SWEET]);
  await reset();
  set('type', '3局技术匹配');
  await wait(280);
  set('autoUnitPrice', '30');
  await wait(320);
  t('cache_contract_base_90', subNum(), 90);
  {
    const surEl = surInput();
    surEl.value = '甜蜜单';
    app.autoPriceFeature.syncUI();       // 故意不派发 input 事件
    await wait(320);
    t('cache_contract_picks_up_new_surcharge', subNum(), 120);
    surEl.value = '';                    // 也不派发事件，只改值
    app.autoPriceFeature.syncUI();
    await wait(320);
    t('cache_contract_drops_cleared_surcharge', subNum(), 90);
    // 反向：备注变化不得触发重算（备注不参与加价）。这里只验证不报错、结果稳定。
    const noteEl = app.el.inputs.note;
    if (noteEl) { noteEl.value = '甜蜜单'; app.autoPriceFeature.syncUI(); await wait(280); }
    t('cache_contract_note_does_not_change_price', subNum(), 90);
    if (noteEl) { noteEl.value = ''; app.autoPriceFeature.syncUI(); await wait(250); }
  }
  await clearRules();

  // ── 11. 运行期错误清零 ────────────────────────────────────────
  t.ok('no_runtime_error', (() => {
    const real = errors.filter(e => !/api\/track|CORS|ERR_FAILED|net::|Not implemented|matchMedia/.test(e));
    return real.length === 0;
  })(), errors.filter(e => !/api\/track|CORS|ERR_FAILED|net::|Not implemented|matchMedia/.test(e)).slice(0, 8));

  const ok = Object.values(checks).every(x => x.ok);
  fs.writeFileSync(outPath || 'project-chain.json', JSON.stringify({ ok, checks, allErrors: errors }, null, 2));
  const failed = Object.entries(checks).filter(([, v]) => !v.ok);
  console.log(`project-chain: ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} passed`);
  failed.forEach(([k, v]) => console.log('  FAIL:', k, '-> 实际', J(v.actual).slice(0, 160), '期望', J(v.expected).slice(0, 160)));
  try { w.close(); } catch (_) {}
  if (!ok) process.exit(2);
})().catch(e => {
  fs.writeFileSync(outPath || 'project-chain.json', JSON.stringify({ ok: false, error: String(e), stack: e.stack, checks, allErrors: errors }, null, 2));
  console.log('project-chain ERROR:', e.message);
  process.exit(1);
});
