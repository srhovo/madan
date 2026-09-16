#!/usr/bin/env node
/**
 * 码单器 7.x/8.x 全链路联动测试（JSDOM 版）
 *
 * 相比上游脚本的增强：
 *  1. 适配懒加载 chunk（dataPortability / durationCalculator）——等待并主动触发 ensureLazyFeature
 *  2. Feature 数量不再硬编码 23，改为「>= 23 且核心 Feature 全在」
 *  3. 覆盖完整业务联动链：下单→计价→历史→老板记忆→价格库→加价→数据备份往返→清空
 *  4. DOM 元素改为「存在即可」，不再要求懒加载面板在初始同步阶段就绪
 *
 * 用法: node dom-full.js <index.html> <out.json>
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const htmlPath = process.argv[2];
const outPath = process.argv[3];
const html = fs.readFileSync(htmlPath, 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + String(e && e.message || e)));
vc.on('error', e => errors.push('console.error: ' + String(e)));

const wait = ms => new Promise(r => setTimeout(r, ms));
const checks = {};
function t(name, ok, actual) { checks[name] = { ok: !!ok, actual }; }

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
      // 屏蔽外部统计请求（离线环境）
      w.fetch = () => Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' });
    }
  });

  const w = dom.window;
  // 等待 app 初始化
  for (let i = 0; i < 200 && !w.orderCalculator; i++) await wait(25);
  const app = w.orderCalculator;
  t('app_initialized', !!app, errors.slice(0, 5));
  if (!app) throw new Error('app 未初始化');

  await wait(150);

  // ── 1. 核心结构 ────────────────────────────────────────────
  t('feature_count_ge_23', app.featureOrder.length >= 23, app.featureOrder.length);

  const CORE_FEATURES = ['uiRender', 'orderFlow', 'historyFeature', 'ratioFeature', 'modeFlowFeature',
    'inputFlowFeature', 'clearAllCoordinatorFeature', 'layoutFeature', 'bossMemoryFeature',
    'priceQuickPickFeature', 'priceRuleEditorFeature', 'surchargeFeature', 'giftMemoryFeature',
    'priceMemoryFeature', 'autoPriceFeature', 'extractionFeature'];
  const missingFeat = CORE_FEATURES.filter(f => !app.features || !app.features[f]);
  t('core_features_present', missingFeat.length === 0, missingFeat);

  const ids = ['totalPrice', 'discount', 'discountOverlay', 'paiDan', 'peiPei', 'boss', 'duration', 'type',
    'note', 'calculateBtn', 'clearAllBtn', 'orderOutput', 'historyList', 'mode1Btn', 'mode2Btn'];
  const missDom = ids.filter(id => !w.document.getElementById(id));
  t('core_dom_present', missDom.length === 0, missDom);

  // ── 2. 主动触发懒加载 chunk ────────────────────────────────
  if (typeof app.ensureLazyFeature === 'function' && app.lazyFeatures) {
    for (const name of Object.keys(app.lazyFeatures)) {
      try { await app.ensureLazyFeature(name); } catch (e) { errors.push('lazy:' + name + ':' + e.message); }
    }
  }
  await wait(200);
  const lazyKeys = app.lazyFeatures ? Object.keys(app.lazyFeatures) : [];
  const lazyLoaded = lazyKeys.filter(k => !!app.features[k]);
  t('lazy_chunks_loaded', lazyLoaded.length === lazyKeys.length, { total: lazyKeys.length, loaded: lazyLoaded });

  const set = (id, v) => {
    const el = w.document.getElementById(id);
    if (!el) return false;
    el.value = v;
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    return true;
  };
  const txt = id => (w.document.getElementById(id) || {}).textContent;

  // ── 3. 手动下单 + 计价 ────────────────────────────────────
  app.switchMode(1);
  set('totalPrice', '100');
  set('discount', '8');
  set('paiDan', '佳一');
  set('peiPei', '小帆 小阮');
  set('boss', '土豆');
  set('type', '一起看');
  set('duration', '1h');
  set('note', '测试');
  const calcOk = app.orderFlow.calculate({ showSuccess: false });
  t('manual_order_calculate', calcOk === true, calcOk);
  t('manual_order_discounted', txt('discountedPrice') === '160', txt('discountedPrice'));
  t('manual_order_group', txt('groupCommission') === '8', txt('groupCommission'));
  t('manual_order_platform', txt('platformCommission') === '32', txt('platformCommission'));
  t('manual_order_earning', txt('earnings') === '60', txt('earnings'));

  // ── 4. 礼物模式 ───────────────────────────────────────────
  app.switchMode(2);
  t('gift_mode_switch', app.currentMode === 2, app.currentMode);
  t('gift_mode_percent', txt('groupPercent') === '10%', txt('groupPercent'));
  app.switchMode(1);
  t('mode_back_to_1', app.currentMode === 1, app.currentMode);

  // ── 5. 锁定 + 清空恢复 ────────────────────────────────────
  app.lockedPeiPei = '固定陪陪';
  set('peiPei', '临时值');
  set('boss', '临时老板');
  app.clearAll();
  t('clear_restores_locked_peipei', w.document.getElementById('peiPei').value === '固定陪陪',
    w.document.getElementById('peiPei').value);
  t('clear_clears_boss', w.document.getElementById('boss').value === '',
    w.document.getElementById('boss').value);

  // ── 6. 提交订单 → 历史记录 ────────────────────────────────
  set('totalPrice', '100');
  set('paiDan', '佳一');
  set('peiPei', '小帆');
  set('boss', '土豆');
  set('type', '一起看');
  set('duration', '1h');
  app.orderFlow.commitOrder({ showSuccess: false, recordBoss: false });
  t('history_state_saved', app.history.length === 1, app.history.length);
  t('history_dom_rendered', w.document.querySelectorAll('#historyList .history-item').length === 1,
    w.document.querySelectorAll('#historyList .history-item').length);

  // ── 7. 数据备份往返（依赖懒加载 dataPortability）───────────
  const dp = app.dataPortabilityFeature || app.dataPortability;
  t('dataPortability_available', !!dp, typeof dp);
  if (dp) {
    let backup = null, parsed = null;
    try {
      backup = dp.buildBackup(['history']);
      parsed = dp.parseBackupText(JSON.stringify(backup));
    } catch (e) { errors.push('backup:' + e.message); }
    t('backup_built', !!backup, backup && Object.keys(backup));
    t('backup_roundtrip_schema', !!parsed && parsed.schemaVersion === 4, parsed && parsed.schemaVersion);
    t('backup_integrity_present', !!parsed && !!parsed.integrity, parsed && !!parsed.integrity);
  }

  // ── 8. 事件绑定幂等 ───────────────────────────────────────
  let count = 0;
  const orig = app.orderFlow.calculate.bind(app.orderFlow);
  app.orderFlow.calculate = (...a) => { count++; return orig(...a); };
  app.bindEvents();
  const m2 = w.document.getElementById('mode2Btn');
  if (m2) m2.click();
  await wait(50);
  t('event_binding_idempotent', count === 1, count);

  // ── 9. 老板记忆联动 ───────────────────────────────────────
  const bm = app.bossMemoryFeature;
  t('bossMemory_available', !!bm, typeof bm);
  if (bm && typeof bm.getRecords === 'function') {
    const recs = bm.getRecords();
    t('bossMemory_readable', Array.isArray(recs), Array.isArray(recs) ? recs.length : typeof recs);
  }

  // ── 10. 价格库可用 ────────────────────────────────────────
  const pl = app.priceLibraryStore;
  t('priceLibraryStore_available', !!pl, typeof pl);
  if (pl && typeof pl.loadOrMigrate === 'function') {
    const r = pl.loadOrMigrate();
    t('priceLibrary_schema_ok', r && r.ok !== false, r && r.status && r.status.state);
  }

  // ── 11. 无运行时错误 ──────────────────────────────────────
  const realErrors = errors.filter(e => !/api\/track|CORS|ERR_FAILED|net::|Not implemented/.test(e));
  t('no_runtime_error', realErrors.length === 0, realErrors.slice(0, 10));

  const ok = Object.values(checks).every(x => x.ok);
  fs.writeFileSync(outPath, JSON.stringify({ ok, checks, allErrors: errors }, null, 2));
  try { w.close(); } catch {}
  if (!ok) process.exit(2);
})().catch(e => {
  fs.writeFileSync(outPath, JSON.stringify({ ok: false, error: String(e), stack: e.stack, checks, allErrors: errors }, null, 2));
  process.exit(1);
});
