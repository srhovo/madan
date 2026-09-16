/**
 * 8.3.30 循环闸门验证 —— 用真实 update-checker.js 在模拟 Capacitor 环境里跑
 *
 * 场景：云端 8.3.30，设备本地 APP_VERSION 固定为 8.3.29（模拟「切换后又被回退」）。
 * 期望：只尝试下载 1 次，之后各次启动都安静跳过，不再重复下载。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'update-checker.js'), 'utf8');

function makeDevice(initialStore) {
  return {
    store: Object.assign({}, initialStore),
    downloads: 0,
    sets: 0,
    readyCalls: 0,
  };
}

// 模拟一次「App 启动」：构造沙箱 → 跑 update-checker → 等待其异步完成
function boot(device, cloudVersion) {
  return new Promise((resolve) => {
    const listeners = [];
    const sandbox = {
      console,
      Date,
      JSON,
      Promise,
      setTimeout: (fn) => { listeners.push(fn); return 0; },
      fetch: () => Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          version: cloudVersion,
          url: 'https://madan.pages.dev/madan-' + cloudVersion + '.zip',
        }),
      }),
      APP_VERSION: device.localAppVersion,   // 模拟当前运行包的版本
      window: null,
    };
    sandbox.window = {
      localStorage: {
        getItem: (k) => (k in device.store ? device.store[k] : null),
        setItem: (k, v) => { device.store[k] = String(v); },
        removeItem: (k) => { delete device.store[k]; },
        clear: () => { device.store = {}; },
      },
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          CapacitorUpdater: {
            notifyAppReady: () => { device.readyCalls++; return Promise.resolve(); },
            download: () => { device.downloads++; return Promise.resolve({ id: 'bundle' }); },
            set: () => { device.sets++; return Promise.resolve(); },
          },
        },
      },
    };
    sandbox.window.window = sandbox.window;
    sandbox.window.localStorage = sandbox.window.localStorage;

    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);

    // 触发被 setTimeout 延迟的 checkForUpdate
    listeners.forEach((fn) => fn());
    // 让 fetch 的 promise 链跑完
    setImmediate(() => setImmediate(() => setImmediate(() => setImmediate(() => resolve()))));
  });
}

async function main() {
  let fail = 0;
  const assert = (name, cond, extra) => {
    console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
    if (!cond) fail++;
  };

  console.log('\n【场景一】设备本地 8.3.29（永远回退），云端 8.3.30 —— 模拟无限重载源');
  const dev = makeDevice({});
  dev.localAppVersion = '8.3.29';
  for (let i = 1; i <= 5; i++) await boot(dev, '8.3.30');
  console.log(`    5 次启动后：下载 ${dev.downloads} 次 / 切换 ${dev.sets} 次 / notifyAppReady ${dev.readyCalls} 次`);
  assert('只下载 1 次（不再无限重载）', dev.downloads === 1, `实际 ${dev.downloads}`);
  assert('notifyAppReady 每次都调用（不让原生层误判包坏）', dev.readyCalls === 5, `实际 ${dev.readyCalls}`);

  console.log('\n【场景二】设备本地已升到 8.3.30，云端仍 8.3.30 —— 应直接跳过');
  const dev2 = makeDevice({});
  dev2.localAppVersion = '8.3.30';
  await boot(dev2, '8.3.30');
  console.log(`    下载 ${dev2.downloads} 次`);
  assert('无更新时不下载', dev2.downloads === 0);

  console.log('\n【场景三】云端出现 8.3.31（比已尝试过的 8.3.30 更高）—— 应允许一次新尝试');
  const dev3 = makeDevice({});           // 注意：store 为空，即「没记录」
  dev3.localAppVersion = '8.3.29';
  await boot(dev3, '8.3.30');            // 第一次：下载并记录 8.3.30
  await boot(dev3, '8.3.31');            // 第二次：云端更高版本，应允许
  console.log(`    下载 ${dev3.downloads} 次（期望 2）`);
  assert('更高版本仍能更新（闸门不会误伤正常升级）', dev3.downloads === 2, `实际 ${dev3.downloads}`);

  console.log('\n【场景四】读不到 APP_VERSION —— 应放弃检查，不下载、不误判');
  const dev4 = makeDevice({});
  dev4.localAppVersion = undefined;      // 模拟 const 不可见/TDZ
  await boot(dev4, '8.3.30');
  console.log(`    下载 ${dev4.downloads} 次 / notifyAppReady ${dev4.readyCalls} 次`);
  assert('读不到版本号时不下载（旧逻辑会永远判有新版本）', dev4.downloads === 0, `实际 ${dev4.downloads}`);
  assert('读不到版本号时仍调用 notifyAppReady', dev4.readyCalls === 1);

  console.log('\n' + (fail === 0 ? '=== 全部通过 ===' : `=== 失败 ${fail} 项 ===`));
  process.exit(fail === 0 ? 0 : 1);
}

main();
