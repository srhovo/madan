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
    failDownload: false,
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
            download: () => {
              device.downloads++;
              return device.failDownload
                ? Promise.reject(new Error('network down'))
                : Promise.resolve({ id: 'bundle' });
            },
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

  /* 【审计补丁·3】场景五：下载失败必须可重试。
     旧逻辑在 download 之前就写「已尝试」，于是弱网失败一次，这一版在本机
     就永久失去更新机会（之后每次启动都被闸门挡回）。修复后记账点在
     「下载成功之后、切换之前」：失败不入库，下次启动照常再试。 */
  console.log('\n【场景五】下载连续失败两次后恢复网络 —— 应能重试并最终装上');
  const dev5 = makeDevice({});
  dev5.localAppVersion = '8.3.29';
  dev5.failDownload = true;
  await boot(dev5, '8.3.30');
  await boot(dev5, '8.3.30');
  const attemptedAfterFail = dev5.store['pw_ultimate_updateAttemptedVersion'] || '';
  console.log(`    两次失败后：下载 ${dev5.downloads} 次 / 切换 ${dev5.sets} 次 / 记录 "${attemptedAfterFail}"`);
  assert('下载失败不写「已尝试」记录', attemptedAfterFail === '', `实际 "${attemptedAfterFail}"`);
  assert('下载失败不切换资源包', dev5.sets === 0, `实际 ${dev5.sets}`);
  dev5.failDownload = false;
  await boot(dev5, '8.3.30');
  console.log(`    恢复网络后：下载 ${dev5.downloads} 次 / 切换 ${dev5.sets} 次`);
  assert('恢复网络后能重试并成功切换（旧逻辑会永久卡在旧版）', dev5.sets === 1, `实际 ${dev5.sets}`);
  assert('成功切换后才写「已尝试」记录', dev5.store['pw_ultimate_updateAttemptedVersion'] === '8.3.30');
  await boot(dev5, '8.3.30');
  assert('切换成功之后不再重复下载（循环闸门仍然有效）', dev5.downloads === 3, `实际 ${dev5.downloads}`);

  console.log('\n' + (fail === 0 ? '=== 全部通过 ===' : `=== 失败 ${fail} 项 ===`));
  process.exit(fail === 0 ? 0 : 1);
}

main();
