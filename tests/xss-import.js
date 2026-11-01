#!/usr/bin/env node
/**
 * 导入恶意备份 → 历史列表渲染 → 脚本执行（XSS）回归防线
 *
 * 背景（为什么需要这一套）
 * ------------------------
 * 8.3.57 修了一个真实的安全缺陷：历史列表里「团抽 / 派抽 / 到手比例」和「人数」
 * 四个字段直接拼进 innerHTML，没有转义。它们正常是数字，但历史记录可以由
 * 「导入备份」写入，而备份的完整性校验只是 FNV32 校验和 —— 任何人都能重算，
 * 不构成信任边界。于是一份构造过的备份，能在应用自己的源里执行脚本，
 * 读走全部本地数据。
 *
 * 修的时候补了 escapeHtml，但**当时没有加任何断言守着它**。
 * 这个项目的失败模式已经被验证过一次：tests/hint-layout.js 的反向验证
 * 从 8.3.49 起静默失效（锚点字符串失配 → 注入变成空转 → 测试一直绿），
 * 直到 8.3.57 才发现。靠「某一行写了 escapeHtml」维持的安全，是同一个形状：
 * 任何一次重构删掉那个调用，全绿，漏洞复活。
 *
 * 这一套做三件事
 * --------------
 *   ① 直接喂 renderListItem 一个恶意 order 对象，断言输出 HTML 里没有可执行标记；
 *   ② 端到端：把恶意备份写进 localStorage（历史记录的真实落点），启动应用，
 *      断言渲染出来的历史节点里同样干净 —— 覆盖 normalize 之后的真实路径；
 *   ③ 反向验证：把 4 处 escapeHtml 拆掉，本套件必须变红。
 *      没有 ③，本套件就只是一堆恒真的假断言。
 *
 * 用法: node tests/xss-import.js [index.html]
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
  return s === undefined ? '' : String(s).slice(0, 200);
}
function section(t) { console.log(`\n  ${t}`); }
const wait = ms => new Promise(r => setTimeout(r, ms));

/* 注入载荷：三种都写，覆盖「属性事件 / 标签 / 协议」三条常见路径。
   用 img + onerror 是刻意选的 —— 它不需要用户点击，渲染即触发。 */
const P = '<img src=x onerror="window.__xssFired=(window.__xssFired||0)+1">';
const P2 = '<script>window.__xssFired=1</script>';

/** 判断一段 HTML 里是否出现了「可执行的东西」。
 *
 *  必须解析成 DOM 再判断，不能只对字符串跑正则：
 *  转义正确的输出里，载荷会变成 `&lt;img src=x onerror="…"&gt;` —— 字符串里
 *  依然能找到 ` onerror=`，但它只是**文本**，不构成属性。用正则判会把
 *  「修好了」误判成「还坏着」，从而让这条防线永远红着、最后被人关掉。
 *  反过来，只要解析后真的出现了 img/script 节点、或元素上真的挂了 on* 属性，
 *  就说明这个位置没有转义，与攻击者用哪种写法无关。 */
function inspect(htmlText) {
  const t = String(htmlText || '');
  const d = new JSDOM(`<div id="__probe">${t}</div>`);
  const root = d.window.document.getElementById('__probe');
  const tags = [...new Set([...root.querySelectorAll('img,script,iframe,svg,object,embed')]
    .map(e => e.tagName.toLowerCase()))];
  const attrs = [];
  root.querySelectorAll('*').forEach(el => {
    el.getAttributeNames().forEach(name => {
      if (/^on/i.test(name)) attrs.push(`${el.tagName.toLowerCase()}@${name}`);
      if (name === 'href' || name === 'src') {
        if (/^\s*(javascript|data:text\/html)/i.test(el.getAttribute(name) || '')) attrs.push(`${el.tagName.toLowerCase()}@${name}:协议`);
      }
    });
  });
  return { tags, attrs: [...new Set(attrs)], root, hits: [...tags, ...new Set(attrs)] };
}

async function boot(src, seed) {
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
      if (typeof seed === 'function') seed(w);
    }
  });
  const w = dom.window;
  for (let i = 0; i < 200 && !w.orderCalculator; i++) await wait(25);
  const app = w.orderCalculator;
  if (!app) throw new Error('app 未初始化（index.html 未能在 jsdom 里启动）');
  await wait(150);
  if (typeof app.ensureLazyFeature === 'function' && app.lazyFeatures) {
    for (const name of Object.keys(app.lazyFeatures)) {
      try { await app.ensureLazyFeature(name); } catch (e) { errs.push('lazy:' + name + ':' + e.message); }
    }
  }
  await wait(200);
  return { w, app, errs };
}

/** 构造一条「每个可注入位置都带载荷」的历史订单。
 *  字段名严格对齐 renderListItem 实际读取的那几个（ratio / peiPeiCount / 项目数 / 库名）。 */
function maliciousOrder() {
  return {
    historySchemaVersion: 4,
    mode: 1,
    peiPei: P,
    boss: P2,
    type: P,
    timestamp: P,
    totalPrice: 100,
    discountedPrice: 90,
    totalDurationMinutes: 60,
    isMultiMode: true,
    peiPeiCount: P,
    ratio: { id: 'evil', group: P, platform: P, earning: P },
    projects: [{ id: 'p1' }, { id: 'p2' }],
    priceLibrary: { id: 'lib_evil', name: P },
    noteDisplayBase: P
  };
}

(async () => {
  console.log('  ── 导入恶意备份 → 历史渲染 XSS 防线 ──');

  // ── ① 直接调用渲染函数（修复的最内层）────────────────────────────
  section('① renderListItem 直接喂恶意字段');
  const { app, w } = await boot(html);
  const order = maliciousOrder();
  const htmlOut = app.historyFeature.renderListItem(order, 0);
  const probe = inspect(htmlOut);
  check('输出里没有可执行标签或事件属性', probe.hits.length === 0, probe.hits.join(',') || '干净');
  check('合法文本被保留（不是靠「什么都不输出」蒙过的）', htmlOut.includes('history-item'), `长度 ${htmlOut.length}`);
  check('解析后 DOM 里没有 img 节点', probe.root.querySelectorAll('img').length === 0, probe.root.querySelectorAll('img').length);
  check('解析后 DOM 里没有 script 节点', probe.root.querySelectorAll('script').length === 0, probe.root.querySelectorAll('script').length);

  // ── ② 端到端：恶意备份写进 localStorage 后启动 ────────────────────
  section('② 恶意历史写进 localStorage → 启动 → 渲染');
  const seeded = await boot(html, (win) => {
    const payloadOrder = {
      historySchemaVersion: 4,
      mode: 1,
      peiPei: P,
      boss: P2,
      type: P,
      timestamp: P,
      totalPrice: 100,
      discountedPrice: 90,
      totalDurationMinutes: 60,
      isMultiMode: true,
      peiPeiCount: P,
      ratio: { id: 'evil', group: P, platform: P, earning: P },
      projects: [],
      priceLibrary: { id: 'lib_evil', name: P }
    };
    win.localStorage.setItem('pw_ultimate_history', JSON.stringify([payloadOrder]));
  });
  const seededApp = seeded.app;
  // 渲染一次历史（loadAllData 通常已渲染，这里显式再来一次，确保测的是渲染而不是时序）
  try { seededApp.historyFeature.updateUI(); } catch (e) { /* 渲染失败的断言在下面 */ }
  await wait(200);
  const listRoot = seeded.w.document.getElementById('historyList') || seeded.w.document.querySelector('.history-list') || seeded.w.document.querySelector('#historySection');
  const domHtml = listRoot ? listRoot.innerHTML : '';
  const domProbe = inspect(domHtml);
  check('端到端渲染后 DOM 里没有可执行标记', domProbe.hits.length === 0, domProbe.hits.join(',') || '干净');
  check('历史区确实渲染出了条目（不是空渲染骗过断言）',
    !!listRoot && /history-item/.test(domHtml), listRoot ? `${domHtml.length} 字节` : '找不到历史容器');

  // 真实浏览器里 onerror 才会触发；jsdom 不加载图片，所以用「节点存在」判定。
  // 这里再补一条：应用自身没有在 window 上挂过 __xssFired。
  check('没有脚本被触发（window.__xssFired 未出现）', seeded.w.__xssFired === undefined, String(seeded.w.__xssFired));

  // ── ③ 反向验证：拆掉 4 处转义，必须变红 ──────────────────────────
  section('③ 反向验证：拆掉转义后必须变红');
  const anchors = [
    'this.escapeHtml(String(order.ratio.group))',
    'this.escapeHtml(String(order.ratio.platform))',
    'this.escapeHtml(String(order.ratio.earning))',
    'this.escapeHtml(String(order.peiPeiCount))'
  ];
  for (const a of anchors) {
    const n = html.split(a).length - 1;
    check(`锚点唯一：${a.slice(11, 40)}…`, n === 1, `命中 ${n} 处`);
  }
  let broken = html;
  for (const a of anchors) broken = broken.split(a).join(a.replace('this.escapeHtml(', '('));
  // 上面这行把 escapeHtml(x) 变成 (x)，等价于「忘了转义」。
  const brokenRun = await boot(broken);
  const brokenHtml = brokenRun.app.historyFeature.renderListItem(maliciousOrder(), 0);
  const brokenProbe = inspect(brokenHtml);
  check('拆掉转义后，同一份恶意数据必须出现可执行标记', brokenProbe.hits.length > 0, brokenProbe.hits.join(',') || '竟然还是干净的（断言失效）');

  // ── 汇总 ────────────────────────────────────────────────────────
  console.log(`\n  通过 ${pass} / 失败 ${fail}`);
  if (fail) {
    console.log('  失败项：');
    failures.forEach(f => console.log('   · ' + f));
    process.exit(1);
  }
  console.log('  全部通过（含 4 条锚点唯一性 + 1 组反向验证）');
})().catch(e => {
  console.error('  ✗ 套件异常：' + (e && e.message));
  process.exit(1);
});
