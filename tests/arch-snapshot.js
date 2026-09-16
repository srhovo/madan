#!/usr/bin/env node
/**
 * 架构边界快照测试（A3 遗留防线）
 *
 * 为什么需要这个
 * --------------
 * 8.3.33 修掉的两类问题都是「静默失效」：
 *   ① RatioFeature.bindToApp() 在运行时把 12 个方法动态挂到 app 上 —— 隐式动态挂载；
 *   ② refreshAfterImport() 用字符串数组 + this.app[method]() 做动态派发。
 * 这类问题不会报错、不会崩，只是「某个功能悄悄不刷新了」。静态扫描抓不住
 * （本项目已验证：静态扫描会给出假绿灯），唯一可靠的办法是运行时原型链内省。
 *
 * 本测试把三个「架构不变量」冻结下来，任何变化都必须显式更新基线快照，
 * 从而迫使改动者回答：「这个新增/删除是有意的吗？」
 *
 *   1. app 上可调用的方法集合（含原型链，排除 Object.prototype）
 *      —— 防「隐式动态挂载」重新引入（app 上凭空多出方法）
 *   2. this.state 的键集合
 *      —— state 是业务状态唯一来源，键集合变化意味着存储契约可能变了
 *   3. featureOrder（已注册 Feature 名单与顺序）
 *      —— 防「独立功能岛」绕过 Feature Registry
 *
 * 用法：
 *   node tests/arch-snapshot.js            # 校验（有差异则 exit 1）
 *   node tests/arch-snapshot.js --update    # 有意改动后更新基线
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');
const BASELINE = path.join(__dirname, 'arch-baseline.json');
const UPDATE = process.argv.includes('--update');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 从原型链收集全部方法名（这是唯一可靠的「app 上有什么方法」判定方式）
function collectMethods(obj) {
  const set = new Set();
  let p = obj;
  while (p && p !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(p)) {
      const d = Object.getOwnPropertyDescriptor(p, k);
      if (d && typeof d.value === 'function') set.add(k);
    }
    p = Object.getPrototypeOf(p);
  }
  return [...set].sort();
}

(async () => {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));

  const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
    url: 'https://madan.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.alert = () => {}; w.confirm = () => true; w.prompt = () => '';
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.requestAnimationFrame = (cb) => w.setTimeout(() => cb(Date.now()), 0);
      w.cancelAnimationFrame = (id) => w.clearTimeout(id);
      w.requestIdleCallback = (cb) => w.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
      w.visualViewport = { height: 800, width: 400, addEventListener() {}, removeEventListener() {} };
      w.navigator.clipboard = { writeText: async () => {}, readText: async () => '' };
      w.document.execCommand = () => true;
      w.URL.createObjectURL = () => 'blob:t'; w.URL.revokeObjectURL = () => {};
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.Element.prototype.scrollIntoView = function () {};
      w.HTMLMediaElement.prototype.pause = function () {};
      w.HTMLMediaElement.prototype.load = function () {};
      w.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      w.HTMLCanvasElement.prototype.getContext = function () { return { measureText() { return { width: 0 }; }, fillRect() {}, clearRect() {} }; };
      w.fetch = () => Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' });
    },
  });

  const w = dom.window;
  for (let i = 0; i < 200 && !w.orderCalculator; i++) await wait(25);
  if (!w.orderCalculator) {
    console.error('✗ 无法获取 window.orderCalculator，页面可能启动失败');
    process.exit(1);
  }
  const app = w.orderCalculator;
  await wait(300);

  const current = {
    methods: collectMethods(app),
    stateKeys: Object.keys(app.state || {}).sort(),
    featureOrder: (app.featureOrder || []).map((f) => (typeof f === 'string' ? f : (f && f.name) || String(f))),
  };

  if (UPDATE || !fs.existsSync(BASELINE)) {
    fs.writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n', 'utf8');
    console.log(`已写入基线 ${path.relative(ROOT, BASELINE)}`);
    console.log(`  app 方法 ${current.methods.length} · state 键 ${current.stateKeys.length} · feature ${current.featureOrder.length}`);
    try { w.close(); } catch (e) {}
    return;
  }

  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  let fail = 0;

  const compare = (label, got, want) => {
    const miss = want.filter((x) => !got.includes(x));
    const extra = got.filter((x) => !want.includes(x));
    if (!miss.length && !extra.length) {
      console.log(`  ✓ ${label}（${got.length} 项）与基线一致`);
      return;
    }
    fail++;
    console.log(`  ✗ ${label} 与基线不一致：现在 ${got.length} / 基线 ${want.length}`);
    if (miss.length) console.log(`       消失: ${miss.join(', ')}`);
    if (extra.length) console.log(`       新增: ${extra.join(', ')}`);
  };

  console.log('--- 架构边界快照 ---');
  compare('app 可调用方法集合', current.methods, base.methods);
  compare('state 键集合', current.stateKeys, base.stateKeys);
  compare('featureOrder', current.featureOrder, base.featureOrder);

  const realErrs = errors.filter((m) => !/Could not parse CSS|Not implemented/.test(m));
  if (realErrs.length) {
    fail++;
    console.log(`  ✗ 启动期出现 ${realErrs.length} 条未捕获异常`);
    realErrs.slice(0, 3).forEach((m) => console.log('       ' + m.split('\n')[0].slice(0, 160)));
  } else {
    console.log('  ✓ 启动期零未捕获异常');
  }

  console.log('\n' + (fail === 0
    ? '=== 架构边界未被突破 ==='
    : `=== 出现 ${fail} 处差异。若属有意改动，请运行 node tests/arch-snapshot.js --update 更新基线并在提交信息中说明理由 ===`));

  try { w.close(); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
})();
