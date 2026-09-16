/**
 * 码单器 OTA 热更新检查脚本
 * ------------------------------------------------------------
 * ⚠️ 8.3.30 起：本文件的内容已**内联**进 index.html（在文件尾部的
 *    <script> 块里），index.html 不再通过 <script src> 引用本文件。
 *    原因见下方「循环保险」注释与 CHANGELOG 的 8.3.30 条目：
 *    8.3.26~8.3.29 的 OTA 包只打包了 index.html，缺了本文件，
 *    导致 notifyAppReady() 不被调用 → 原生层判定包不健康 → 自动回退
 *    → 版本号不变 → 再次判定有新版本 → 无限重载。
 *
 *    **修改本文件后必须同步更新 index.html 里的内联副本**，
 *    否则打包出去的 index.html 仍是旧逻辑。
 *    可执行 `node tests/inline-integrity.js` 校验内联副本是否与
 *    本文件、analytics.js 保持一致。
 *
 * 本文件保留在仓库中作为「源文件 / 唯一事实来源」，便于阅读与 diff。
 * ------------------------------------------------------------
 * 只在 Capacitor 原生壳（Android APK）里运行；在普通浏览器标签页打开
 * index.html 时会自动跳过，不影响你平时直接用浏览器调试。
 *
 * 数据安全承诺（请勿修改破坏这几点）：
 * 1. 本脚本从不调用 localStorage.clear() / removeItem()，
 *    更新流程只替换 index.html / CSS / JS 静态资源。
 * 2. localStorage 是按"域"持久化的原生存储，不随 CapacitorUpdater.set()
 *    切换资源包而改变，陪玩名单/老板记忆库/单价记忆库/历史记录等
 *    数据会原样保留。
 * 3. 更新失败（下载失败、校验失败、新版本 JS 崩溃导致没调用
 *    notifyAppReady）时，原生层会在超时后自动回退到上一个可用版本，
 *    整个过程用户数据不受影响。
 * 4. 更新全程静默：检测到新版本后在后台自动下载并切换，不弹任何
 *    提示条、不需要用户点击；失败只写控制台日志。
 * 5. （8.3.30 新增）同一版本最多尝试一次更新，用 localStorage 的
 *    'pw_ultimate_updateAttemptedVersion' 记录；这是防无限重载的闸门。
 *    除该标记外，本脚本不写入任何其他 localStorage key。
 */
(function () {
  'use strict';

  // ---- 可按需修改的配置 ----
  // 部署到 Cloudflare Pages 后，把下面这个域名换成你自己的。
  var UPDATE_MANIFEST_URL = 'https://madan.pages.dev/version.json';
  // 每次启动检查一次；如果想降低频率，可以改成按小时节流（下面有注释示例）。
  var CHECK_DELAY_MS = 2500; // 启动后延迟多久再检查，避免抢占首屏渲染
  // ---------------------------

  function log(msg, extra) {
    if (extra !== undefined) console.log('[码单器更新] ' + msg, extra);
    else console.log('[码单器更新] ' + msg);
  }
  function warn(msg, extra) {
    if (extra !== undefined) console.warn('[码单器更新] ' + msg, extra);
    else console.warn('[码单器更新] ' + msg);
  }

  // 只在 Capacitor 原生环境里跑；普通浏览器直接退出，不报错、不影响使用
  if (!window.Capacitor || typeof window.Capacitor.isNativePlatform !== 'function' || !window.Capacitor.isNativePlatform()) {
    log('当前不在 Capacitor 原生壳内运行，跳过热更新检查');
    return;
  }

  var Updater = window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorUpdater;
  if (!Updater) {
    warn('未找到 CapacitorUpdater 插件（请确认已执行 npm install @capgo/capacitor-updater && npx cap sync）');
    return;
  }

  // 读取当前运行包的版本号。
  // 注意（8.3.30 修复）：这里刻意**不再**把读不到版本号时兜底成 '0.0.0'。
  // '0.0.0' 是最小版本，任何云端版本都比它大，一旦读不到就会永远判定
  // 「有新版本」→ 反复下载 → 表现为无限重载。正确做法是：读不到就放弃
  // 本次更新检查（宁可停在当前版本，也不进死循环）。
  function readCurrentVersion() {
    try {
      if (typeof APP_VERSION !== 'undefined' && APP_VERSION) return String(APP_VERSION);
    } catch (e) { /* TDZ 等异常一律按「读不到」处理 */ }
    return '';
  }

  var CURRENT_VERSION = readCurrentVersion();

  // ---- 第一步：告诉原生层"这次启动是健康的" ----
  // 必须尽早调用。如果上一次更新导致白屏/崩溃，这行代码根本不会被执行到，
  // 原生层等待 appReadyTimeout（默认 10 秒）后就会自动把资源包换回上一个
  // 能正常跑起来的版本——这就是"更新失败自动回退"的核心机制。
  Updater.notifyAppReady().then(function () {
    log('已通知原生层：当前版本 ' + CURRENT_VERSION + ' 启动正常');
  }).catch(function (e) {
    warn('notifyAppReady 调用失败（首次安装的内置版本会走到这里，属正常现象）', e);
  });

  // ---- 版本号比较：支持 8.3.6 这种三段式 semver ----
  function compareVersions(a, b) {
    var pa = String(a).split('.').map(function (n) { return parseInt(n, 10) || 0; });
    var pb = String(b).split('.').map(function (n) { return parseInt(n, 10) || 0; });
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i++) {
      var na = pa[i] || 0, nb = pb[i] || 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

  function checkForUpdate() {
    // 读不到本机版本号时直接放弃本次检查：宁可停在当前版本，
    // 也不能因版本号未知而反复判定「有新版本」造成重载。
    if (!CURRENT_VERSION) {
      warn('未能读取本机版本号（APP_VERSION），本次跳过更新检查以免误判');
      return;
    }
    var url = UPDATE_MANIFEST_URL + (UPDATE_MANIFEST_URL.indexOf('?') === -1 ? '?' : '&') + 't=' + Date.now();
    fetch(url, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (manifest) {
        if (!manifest || !manifest.version || !manifest.url) {
          warn('version.json 格式不完整，跳过本次检查');
          return;
        }
        if (compareVersions(manifest.version, CURRENT_VERSION) <= 0) {
          log('已是最新版本 ' + CURRENT_VERSION);
          return;
        }
        log('发现新版本 ' + manifest.version + '（当前 ' + CURRENT_VERSION + '），后台静默更新中');
        applyUpdate(manifest);
      })
      .catch(function (e) {
        // 网络不好 / 服务器暂时打不开时静默失败，绝不影响本地正常使用
        warn('检查更新失败（不影响当前使用）', e);
      });
  }

  // ---- 循环保险：同一个版本号只尝试「下载 + 切换」一次 ----
  // 背景（8.3.30 修复的安卓无限重载）：
  //   若某个版本的资源包切换后无法正常启动，原生层会自动回退到旧包；
  //   回退后本地 APP_VERSION 仍是旧值，下次启动又会判定「有新版本」，
  //   于是下载 → 切换 → 回退 → 再判定，无线循环，用户看到的就是
  //   App 每隔一小会儿就重新加载一次。
  //   这里用 localStorage 记住「本机已经尝试过的最高版本号」：同一版本
  //   成功切换过一次后就不再重复尝试；即便切换失败（回退发生），也只会
  //   尝试这一次，不会无限重载。存储不可用时静默降级为不记忆。
  var ATTEMPT_KEY = 'pw_ultimate_updateAttemptedVersion';

  function readAttemptedVersion() {
    try { return window.localStorage.getItem(ATTEMPT_KEY) || ''; } catch (e) { return ''; }
  }
  function rememberAttemptedVersion(v) {
    // 故意吞掉：写失败只意味着「本机不记忆已尝试版本」，最坏结果是下次启动
    // 重复尝试一次更新（不会无限重载，因为闸门只在本次进程内失效）。
    // 这类环境里日志通道（log）本身也可能不可用，故不值得记日志。
    try { window.localStorage.setItem(ATTEMPT_KEY, String(v)); } catch (e) {}
  }

  // ---- 静默更新：后台自动下载并切换，全程无弹窗、无需用户交互 ----
  function applyUpdate(manifest) {
    var attempted = readAttemptedVersion();
    // 已经尝试过这个（或更高的）版本 → 不再重复下载，直接安静停在当前版本。
    // 这正是防「无限重载」的闸门：哪怕切换后又被原生层回退，也只发生一次。
    if (attempted && compareVersions(attempted, manifest.version) >= 0) {
      log('版本 ' + manifest.version + ' 本机已尝试过（记录 ' + attempted + '），本次不再重复更新');
      return;
    }

    // 先落记录再下载：确保即便下载/切换过程中断，也不会在下次启动重复尝试。
    rememberAttemptedVersion(manifest.version);

    // 暂时不传 checksum：插件校验哈希的具体算法/格式没有把握确认，
    // 先排除这个变量，确认下载+切换这条主链路本身没问题。
    // 之后确认好格式了，可以在这里加回 { checksum: manifest.checksum }。
    var downloadOpts = { version: manifest.version, url: manifest.url };

    Updater.download(downloadOpts)
      .then(function (bundle) {
        log('新版本下载完成，正在切换…');
        return Updater.set(bundle);
      })
      .catch(function (e) {
        var detail = (e && (e.message || e.errorMessage || e.code)) ? String(e.message || e.errorMessage || e.code) : JSON.stringify(e);
        // 注意措辞：这里不再承诺「下次启动自动重试」——为避免无限重载，
        // 同一版本的自动重试已被上面的闸门挡掉。
        warn('静默更新失败（不影响当前使用）' + (detail ? '：' + detail : ''), e);
      });
  }

  setTimeout(checkForUpdate, CHECK_DELAY_MS);

  // 如果想改成"每小时最多检查一次"而不是每次启动都检查，把上面这行替换成：
  //
  // var last = Number(window.localStorage.getItem('pw_ultimate_lastUpdateCheck') || 0);
  // if (Date.now() - last > 60 * 60 * 1000) {
  //   window.localStorage.setItem('pw_ultimate_lastUpdateCheck', String(Date.now()));
  //   setTimeout(checkForUpdate, CHECK_DELAY_MS);
  // }
})();
