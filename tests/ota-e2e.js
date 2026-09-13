/**
 * 端到端 OTA 行为验证 —— 用「从 madan-8.3.30.zip 真实解压出来的 index.html」
 * 在模拟 Capacitor 环境里跑，并把真实的 version.json 喂给它。
 *
 * 验证两件事：
 *  A) 新包自包含：加载后能读到正确版本、notifyAppReady 被调用、零未捕获异常
 *  B) 与云端 version.json 比对时判定正确（不会误判「有新版本」而重复下载）
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const TMP = '/tmp/ota-e2e';
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
execSync(`unzip -q -o "${path.join(ROOT, 'madan-8.3.30.zip')}" -d "${TMP}"`);

const html = fs.readFileSync(path.join(TMP, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));

console.log(`包内 index.html: ${html.length} 字符`);
console.log(`云端 version.json: version=${manifest.version}`);

const logs = [];
const errors = [];
let readyCalled = false;
const downloads = [];

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
    // fetch 返回真实的 version.json 内容
    w.fetch = () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(manifest),
    });
    w.Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        CapacitorUpdater: {
          notifyAppReady: () => { readyCalled = true; return Promise.resolve(); },
          download: (o) => { downloads.push(o && o.version); return Promise.resolve({ id: 'b' }); },
          set: () => Promise.resolve(),
        },
      },
    };
  },
});

setTimeout(() => {
  let fail = 0;
  const ck = (n, c, e) => { console.log(`  ${c ? '✓' : '✗'} ${n}${e ? '  ' + e : ''}`); if (!c) fail++; };

  console.log('\n--- 更新器日志 ---');
  logs.filter((l) => /码单器更新|notifyAppReady/.test(l)).forEach((l) => console.log('  ' + l));

  console.log('\n--- 断言 ---');
  const verLine = logs.find((l) => /启动正常/.test(l)) || '';
  const got = (verLine.match(/当前版本\s*([\d.]+)/) || [])[1];

  ck('A1 包内 index.html 的版本号 = 8.3.30', got === '8.3.30', `实际 "${got}"`);
  ck('A2 notifyAppReady 被调用（原生层不会误判包不健康）', readyCalled);
  ck('A3 零未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
  ck('B1 本地=云端=8.3.30 时不再重复下载', downloads.length === 0, `下载了 ${JSON.stringify(downloads)}`);

  console.log('\n' + (fail === 0 ? '=== 全部通过 ===' : `=== 失败 ${fail} 项 ===`));
  process.exit(fail === 0 ? 0 : 1);
}, 4000);
