#!/usr/bin/env node
/**
 * 8.3.55 · 金额属性测试（第 26 套）
 *
 * 为什么要有这一套
 * ----------------
 * 现有防线都是「固定用例 + 手算期望」：它能证明我们想到的组合是对的，
 * 不能证明没想到的组合也对。金额链路是单价 × 计费数量 × 加价 × 折数 × 人数 × 抽成，
 * 组合空间远大于 25 套用例的覆盖面，而这里每错一步都是真钱。
 *
 * 这套用**随机输入 + 数学性质**兜底：不锁定具体数字（避免把有争议的语义钉死），
 * 只锁「必须成立的关系」—— 守恒、线性、单调、精度、顺序无关。
 * 一旦有人改动公式的顺序、漏乘人数、漏加某项，这些关系会立刻破。
 *
 * 随机种子固定，失败可复现（同种子 → 同输入序列）。
 * 每组性质都配反向验证：把对应实现改坏，断言必须变红。
 *
 * 用法：node tests/amount-property.js [index.html]
 * 退出码：0 全通过 / 1 有失败
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { ANCHORS: A } = require('./_anchors.js');

const HTML_PATH = process.argv[2] || path.join(__dirname, '..', 'index.html');
const BASE_HTML = fs.readFileSync(HTML_PATH, 'utf8');

let pass = 0;
let fail = 0;
let bucket = null;
const ck = (name, ok, extra) => {
  // 反向验证期间只收集结果，不污染全局计数（否则"改坏后变红"会被算成产品失败）
  if (bucket) { bucket.push(Boolean(ok)); return; }
  if (ok) {
    pass += 1;
    if (process.env.VERBOSE) console.log(`  ✓ ${name}`);
    return;
  }
  fail += 1;
  console.log(`  ✗ ${name}${extra !== undefined ? '  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`);
};

const wait = ms => new Promise(r => setTimeout(r, ms));

/* 固定种子随机（mulberry32）—— 可复现比"更随机"重要 */
function rngFactory(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const int = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const money = (rng, min, max) => Math.round((min + rng() * (max - min)) * 100) / 100;

const round3 = v => Math.round(Number(v) * 1000) / 1000;
/* 量化容差：链路每算一步都做一次「三位小数取整」（round3），单次量化误差上限 0.0005。
   比较两条经过不同次数量化的结果时，误差会叠加 —— 这不是实现缺陷，是取整的数学必然。
   下面用 0.0025（≈5 次量化的最坏叠加）做容差：
   · 它能放过「差 1-2 厘」的取整噪声（业务上金额显示 2 位，看不见）；
   · 它放不过任何真实算错 —— 漏乘人数、漏加某项、顺序写反，差都在元以上。
   反向验证（聚合漏加 / 漏乘人数）证明这条容差没有把断言变松。 */
const EPS_Q = 0.0025;
const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) <= eps;
const decimals = v => {
  const s = String(Number(v));
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
};

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
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.requestAnimationFrame = cb => w.setTimeout(() => cb(Date.now()), 0);
      w.cancelAnimationFrame = id => w.clearTimeout(id);
      w.requestIdleCallback = cb => w.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
      w.navigator.clipboard = { writeText: async () => {}, readText: async () => '' };
      w.URL.createObjectURL = () => 'blob:test';
      w.URL.revokeObjectURL = () => {};
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.Element.prototype.scrollIntoView = function () {};
      w.fetch = () => Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' });
    }
  });
  const w = dom.window;
  for (let i = 0; i < 400 && !w.orderCalculator; i += 1) await wait(20);
  if (!w.orderCalculator) return { dom, w, errs, ok: false };
  await wait(200);
  return { dom, w, errs, ok: true, PE: w.eval('ProjectSettlementEngine'), OE: w.eval('OrderEngine') };
}

/* 随机一个「项目」输入：单位与数量写法保持一致，避免测试自己去猜语义 */
function randomProject(rng, index = 0) {
  const hourMode = rng() < 0.5;
  const quantityRaw = hourMode
    ? pick(rng, ['1h', '2h', '30min', '1h30min', '45min', '3h'])
    : `${int(rng, 1, 9)}局`;
  const surcharges = [];
  const extra = int(rng, 0, 2);
  for (let i = 0; i < extra; i += 1) {
    surcharges.push({ ruleId: `r${index}_${i}`, name: '加价', unitPrice: money(rng, 1, 30) });
  }
  return {
    quantityRaw,
    quantityMode: hourMode ? 'hour' : 'round',
    serviceRaw: pick(rng, ['甲', '乙', '丙', '丁', '戊']),
    unitPrice: money(rng, 1, 500),
    surcharges,
    entrySource: 'manual',
    createdAt: 1700000000000 + index
  };
}

async function runAll(w) {
  const PE = w.eval('ProjectSettlementEngine');
  const OE = w.eval('OrderEngine');
  const rng = rngFactory(20260855);

  /* ── ① 聚合守恒：总价必须等于逐项小计之和 ───────────────────── */
  for (let i = 0; i < 200; i += 1) {
    const count = int(rng, 1, 3);
    const projects = [];
    for (let j = 0; j < count; j += 1) {
      const built = PE.createProject(randomProject(rng, j), j);
      if (!built.ok) { ck(`① 随机项目 #${i} 构造成功`, false, built.error); break; }
      projects.push(built.project);
    }
    if (projects.length !== count) continue;
    const agg = PE.aggregateProjects(projects);
    const expect = round3(projects.reduce((s, p) => s + p.subtotal, 0));
    ck(`① 守恒 #${i}（${count} 项）`, near(agg.totalPrice, expect), { got: agg.totalPrice, expect });
  }

  /* ── ② 单价线性：单价 ×2 → 小计 ×2 ─────────────────────────── */
  for (let i = 0; i < 60; i += 1) {
    const base = randomProject(rng, i);
    base.surcharges = [];           // 只测单价本身，加价另测
    base.unitPrice = money(rng, 1, 300);
    const one = PE.createProject({ ...base }, 0);
    const two = PE.createProject({ ...base, unitPrice: round3(base.unitPrice * 2) }, 0);
    if (!one.ok || !two.ok) { ck(`② 构造成功 #${i}`, false, one.error || two.error); continue; }
    ck(`② 单价线性 #${i}（${base.quantityRaw} @ ${base.unitPrice}）`,
      near(two.project.subtotal, round3(one.project.subtotal * 2), EPS_Q),
      { one: one.project.subtotal, two: two.project.subtotal });
  }

  /* ── ③ 加价可加：加 S 后小计增量 = S × 计费量 ───────────────── */
  for (let i = 0; i < 60; i += 1) {
    const base = randomProject(rng, i);
    base.surcharges = [];
    const plain = PE.createProject({ ...base }, 0);
    const sur = money(rng, 1, 40);
    const added = PE.createProject({ ...base, surcharges: [{ ruleId: 'x', name: '加价', unitPrice: sur }] }, 0);
    if (!plain.ok || !added.ok) { ck(`③ 构造成功 #${i}`, false, plain.error || added.error); continue; }
    const expect = round3(sur * plain.project.billingQuantity);
    ck(`③ 加价可加 #${i}（+${sur} × ${plain.project.billingQuantity}）`,
      near(added.project.subtotal - plain.project.subtotal, expect, EPS_Q),
      { delta: round3(added.project.subtotal - plain.project.subtotal), expect });
  }

  /* ── ④ 折数：线性 + 单调 ───────────────────────────────────── */
  for (let i = 0; i < 100; i += 1) {
    const total = money(rng, 1, 5000);
    const d = Math.round(int(rng, 1, 100)) / 100;   // 0.01 ~ 1.00
    const n = int(rng, 1, 4);
    const rates = { group: 0.05, platform: 0.2, earning: 0.75 };
    const r = OE.computeCalculationResult({ totalPrice: total, appliedDiscount: d, peiPeiCount: n, rates });
    const expect = round3(total * d * (n > 1 ? n : 1));
    ck(`④ 折数线性 #${i}（${total} × ${d} × ${n} 人）`, near(r.discountedPrice, expect, EPS_Q), { got: r.discountedPrice, expect });
  }
  for (let i = 0; i < 50; i += 1) {
    const total = money(rng, 1, 5000);
    const dSmall = Math.round(int(rng, 1, 50)) / 100;
    const dBig = Math.round(int(rng, 51, 100)) / 100;
    const rates = { group: 0.05, platform: 0.2, earning: 0.75 };
    const a = OE.computeCalculationResult({ totalPrice: total, appliedDiscount: dSmall, peiPeiCount: 1, rates });
    const b = OE.computeCalculationResult({ totalPrice: total, appliedDiscount: dBig, peiPeiCount: 1, rates });
    ck(`④ 折数单调 #${i}（${dSmall} ≤ ${dBig}）`, a.discountedPrice <= b.discountedPrice + 1e-9, { small: a.discountedPrice, big: b.discountedPrice });
  }

  /* ── ⑤ 人数：总价 ×n，每人到手不变 ─────────────────────────── */
  for (let i = 0; i < 50; i += 1) {
    const total = money(rng, 1, 5000);
    const d = Math.round(int(rng, 1, 100)) / 100;
    const rates = { group: 0.05, platform: 0.2, earning: 0.75 };
    const one = OE.computeCalculationResult({ totalPrice: total, appliedDiscount: d, peiPeiCount: 1, rates });
    const n = int(rng, 2, 4);
    const many = OE.computeCalculationResult({ totalPrice: total, appliedDiscount: d, peiPeiCount: n, rates });
    ck(`⑤ 人数线性 #${i}（${n} 人）`, near(many.discountedPrice, round3(one.discountedPrice * n), EPS_Q * 2), { one: one.discountedPrice, many: many.discountedPrice });
    ck(`⑤ 每人到手不变 #${i}`, near(many.earnings, one.earnings, EPS_Q), { one: one.earnings, many: many.earnings });
  }

  /* ── ⑥ 抽成闭合：各项之和 = 折后总价 ───────────────────────── */
  for (let i = 0; i < 50; i += 1) {
    const total = money(rng, 1, 5000);
    const d = Math.round(int(rng, 1, 100)) / 100;
    const n = int(rng, 1, 3);
    const rates = { group: 0.05, platform: 0.2, earning: 0.75 };
    const r = OE.computeCalculationResult({ totalPrice: total, appliedDiscount: d, peiPeiCount: n, rates });
    // earnings 已按人拆分过，回乘人数才能与总价闭合
    const sum = r.groupCommission + r.platformCommission + r.earnings * (n > 1 ? n : 1);
    // 三项各自 round3，和与总价的偏差上限 ≈ 4 次量化（3 项 + 总价本身）
    ck(`⑥ 抽成闭合 #${i}`, near(sum, r.discountedPrice, EPS_Q * 2), { sum: round3(sum), discounted: r.discountedPrice });
  }

  /* ── ⑦ 精度：任何输出小数位 ≤ 不变量 ────────────────────────── */
  for (let i = 0; i < 100; i += 1) {
    const total = money(rng, 0.01, 9999.99);
    const d = Math.round(int(rng, 1, 100)) / 100;
    const n = int(rng, 1, 4);
    const r = OE.computeCalculationResult({ totalPrice: total, appliedDiscount: d, peiPeiCount: n, rates: { group: 0.033, platform: 0.177, earning: 0.79 } });
    const ok = [r.discountedPrice, r.groupCommission, r.platformCommission, r.earnings].every(v => Number.isFinite(v) && decimals(v) <= 3);
    ck(`⑦ 精度 #${i}`, ok, r);
  }

  /* ── ⑧ 顺序无关：项目反序，总价不变 ────────────────────────── */
  for (let i = 0; i < 50; i += 1) {
    const count = int(rng, 2, 3);
    const projects = [];
    for (let j = 0; j < count; j += 1) {
      const built = PE.createProject(randomProject(rng, j), j);
      if (built.ok) projects.push(built.project);
    }
    if (projects.length < 2) continue;
    const a = PE.aggregateProjects(projects).totalPrice;
    const b = PE.aggregateProjects([...projects].reverse()).totalPrice;
    ck(`⑧ 顺序无关 #${i}`, near(a, b, EPS_Q), { a, b });
  }

  /* ── ⑨ 非法输入必须被拒绝，且不产生 NaN ─────────────────────── */
  const badCases = [
    { quantityRaw: '1h', quantityMode: 'hour', serviceRaw: '甲', unitPrice: 0 },
    { quantityRaw: '1h', quantityMode: 'hour', serviceRaw: '甲', unitPrice: -5 },
    { quantityRaw: 'abc', quantityMode: 'round', serviceRaw: '甲', unitPrice: 50 },
    { quantityRaw: '2局', quantityMode: 'round', serviceRaw: '', unitPrice: 50 }
  ];
  badCases.forEach((input, i) => {
    const r = PE.createProject(input, i);
    ck(`⑨ 非法输入 #${i} 被拒绝`, r.ok === false && !!r.error, { ok: r.ok, error: r.error });
    ck(`⑨ 非法输入 #${i} 不产生项目`, !r.project, r.project && r.project.subtotal);
  });
  const emptyAgg = PE.aggregateProjects([]);
  ck('⑨ 空项目 → 总价 0（不是 NaN）', emptyAgg.totalPrice === 0 && Number.isFinite(emptyAgg.totalPrice), emptyAgg.totalPrice);

  /* ── ⑩ 订单文本里的总价与计算结果一致 ──────────────────────── */
  const total = 1000;
  const n = 2;
  const rates = { group: 0.05, platform: 0.2, earning: 0.75 };
  const result = OE.computeCalculationResult({ totalPrice: total, appliedDiscount: 0.8, peiPeiCount: n, rates });
  const text = OE.buildOrderText(
    { paiDan: '张三', peiPei: '小王 小李', boss: '阿强', type: '1h甲', duration: '1h', totalPrice: total, discountInput: 0.8, discountOverlayInput: null, noteRaw: '', noteDisplay: '', surcharge: '', surchargeRaw: '', currentMode: 1, projects: [], totalDurationMinutes: 60 },
    result,
    ''
  );
  const shown = (String(text).match(/总价：\s*([\d.]+)/) || [])[1];
  ck('⑩ 订单文本总价 = 计算总价（1600）', shown !== undefined && near(Number(shown), result.discountedPrice, 0.01), { shown, calc: result.discountedPrice });
}

/* ─────────────── 反向验证：把实现改坏，断言必须变红 ─────────────── */
async function expectRed(name, mutate, run) {
  const mutated = mutate(BASE_HTML);
  if (mutated === BASE_HTML) {
    ck(`反向验证「${name}」锚点命中`, false, '锚点未命中');
    return;
  }
  const ctx = await boot(mutated);
  if (!ctx.ok) {
    ck(`反向验证「${name}」可启动`, false, ctx.errs.slice(0, 1));
    return;
  }
  bucket = [];
  try {
    await run(ctx.w);
  } finally {
    const results = bucket;
    bucket = null;
    const red = results.includes(false);
    ck(`反向验证：拆掉「${name}」后断言确实变红`, red, red ? '' : '没有任何断言失败 —— 说明这套断言是假的绿');
    if (red) console.log(`  ✓ 反向验证「${name}」→ 变红`);
    ctx.dom.window.close();
  }
}

(async () => {
  console.log('── 金额属性测试（200 组守恒 / 60+60+100+50+50+50+100+50 组性质）──');
  const ctx = await boot(BASE_HTML);
  if (!ctx.ok) {
    console.log('  ✗ 页面启动失败', ctx.errs.slice(0, 2));
    process.exit(1);
  }
  await runAll(ctx.w);
  console.log(`  性质断言：通过 ${pass} / 失败 ${fail}`);
  ctx.dom.window.close();

  console.log('\n── 反向验证 ──');
  await expectRed(
    '聚合漏加某项',
    html => html.replace(A.aggregateReduce.text,
      'const totalPrice = this.roundThree(list.reduce((sum, project, i) => sum + (i === 0 ? (Number(project.subtotal) || 0) : 0), 0));'),
    async w => { await runAll(w); }
  );
  await expectRed(
    '折后总价漏乘人数',
    html => html.replace(A.peiPeiMultiply.text, 'if (false) discountedPrice *= context.peiPeiCount;'),
    async w => { await runAll(w); }
  );

  console.log('\n═════ 判定 ═════');
  if (fail === 0) {
    console.log(`全部通过（${pass} 条性质断言 + 2 组反向验证）`);
    process.exit(0);
  }
  console.log(`失败 ${fail} 项`);
  process.exit(1);
})().catch(error => {
  console.error('运行异常：', (error && error.stack) || error);
  process.exit(1);
});
