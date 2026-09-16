/**
 * 内联一致性 + 运行时完整性校验
 *
 * 背景：8.3.30 起 update-checker.js 与 analytics.js 的内容被内联进
 * index.html（不再用 <script src> 引用）。这带来一个维护风险：
 * 有人改了 .js 源文件却忘了同步 index.html 里的内联副本。
 *
 * 本脚本做两件事：
 *   1) 一致性：index.html 里确实包含两份 .js 的完整内容（逐字节比对）
 *   2) 运行时：用完整 index.html 在模拟原生壳内加载，验证
 *      notifyAppReady 被调用、读到的版本号正确、零未捕获异常
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ucSrc = fs.readFileSync(path.join(ROOT, 'update-checker.js'), 'utf8');
const anSrc = fs.readFileSync(path.join(ROOT, 'analytics.js'), 'utf8');

let fail = 0;
const ck = (n, c, e) => { console.log(`  ${c ? '✓' : '✗'} ${n}${e ? '  ' + e : ''}`); if (!c) fail++; };

console.log('--- 1. 内联一致性（index.html 是否含两份源文件的完整内容）---');
ck('index.html 不再引用外部 update-checker.js', !/<script[^>]*src\s*=\s*["']update-checker\.js/.test(html));
ck('index.html 不再引用外部 analytics.js', !/<script[^>]*src\s*=\s*["']analytics\.js/.test(html));
ck('index.html 未引用任何本地外部脚本', !/<script[^>]*src\s*=\s*["'](?!https?:|\/\/)/.test(html));

// 逐字节比对：源文件内容应原样出现在 html 中
ck('update-checker.js 的内容已完整内联', html.includes(ucSrc),
   html.includes(ucSrc) ? '' : '（源文件与内联副本不一致，请重新内联）');
ck('analytics.js 的内容已完整内联', html.includes(anSrc),
   html.includes(anSrc) ? '' : '（源文件与内联副本不一致，请重新内联）');

console.log('\n--- 2. 运行时（在模拟 Capacitor 原生壳内加载完整 index.html）---');
const logs = [];
const errors = [];
let readyCalled = false;

const vc = new VirtualConsole();
vc.on('log', (...a) => logs.push(a.join(' ')));
vc.on('warn', (...a) => logs.push('WARN ' + a.join(' ')));
vc.on('error', (...a) => logs.push('ERR ' + a.join(' ')));
vc.on('jsdomError', (e) => errors.push(e.message));

new JSDOM(html, {
  runScripts: 'dangerously',
  virtualConsole: vc,
  pretendToBeVisual: true,
  url: 'http://localhost/',
  beforeParse(w) {
    if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    if (!w.fetch) w.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    w.Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        CapacitorUpdater: {
          notifyAppReady: () => { readyCalled = true; return Promise.resolve(); },
          download: () => Promise.resolve({ id: 'b' }),
          set: () => Promise.resolve(),
        },
      },
    };
  },
});

setTimeout(() => {
  const expected = (html.match(/const APP_VERSION = '([^']+)'/) || [])[1];
  const verLine = logs.find((l) => /启动正常/.test(l)) || '';
  const got = (verLine.match(/当前版本\s*([\d.]+)/) || [])[1];

  ck('notifyAppReady 被调用（否则原生层会误判包不健康并回退）', readyCalled);
  ck(`读到的版本号正确（期望 ${expected}）`, got === expected, `实际 "${got}"`);
  ck('版本号非空、非 0.0.0（旧兜底会导致无限判定有新版本）',
     Boolean(got) && got !== '0.0.0');
  ck('页面零未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));

  console.log('\n' + (fail === 0 ? '=== 全部通过 ===' : `=== 失败 ${fail} 项 ===`));
  process.exit(fail === 0 ? 0 : 1);
}, 4000);
