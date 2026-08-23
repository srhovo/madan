/**
 * 码单器 OTA 热更新检查脚本
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

  var CURRENT_VERSION = (typeof APP_VERSION !== 'undefined' && APP_VERSION) ? APP_VERSION : '0.0.0';

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
        log('发现新版本 ' + manifest.version + '（当前 ' + CURRENT_VERSION + '）');
        showUpdatePrompt(manifest);
      })
      .catch(function (e) {
        // 网络不好 / 服务器暂时打不开时静默失败，绝不影响本地正常使用
        warn('检查更新失败（不影响当前使用）', e);
      });
  }

  // ---- 更新提示条：用户主动点"更新"才会触发下载，不做静默强推 ----
  function showUpdatePrompt(manifest) {
    if (document.getElementById('madanUpdateToast')) return; // 避免重复弹出

    var toast = document.createElement('div');
    toast.id = 'madanUpdateToast';
    toast.style.cssText = [
      'position:fixed', 'left:12px', 'right:12px', 'bottom:calc(16px + env(safe-area-inset-bottom, 0px))',
      'z-index:99999', 'background:#1f2937', 'color:#fff', 'padding:12px 14px',
      'border-radius:12px', 'font-size:14px', 'line-height:1.5',
      'box-shadow:0 6px 20px rgba(0,0,0,.28)', 'display:flex', 'align-items:center', 'gap:10px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif'
    ].join(';');

    var text = document.createElement('span');
    text.style.cssText = 'flex:1;min-width:0;';
    text.textContent = '发现新版本 ' + manifest.version + '，点击更新（不会清空本地数据）';

    var updateBtn = document.createElement('button');
    updateBtn.type = 'button';
    updateBtn.textContent = '更新';
    updateBtn.style.cssText = 'flex:0 0 auto;background:#2563eb;color:#fff;border:0;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:600;';

    var dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.setAttribute('aria-label', '关闭');
    dismissBtn.textContent = '×';
    dismissBtn.style.cssText = 'flex:0 0 auto;background:transparent;color:#9ca3af;border:0;font-size:20px;line-height:1;padding:0 4px;';

    dismissBtn.addEventListener('click', function () { toast.remove(); });
    updateBtn.addEventListener('click', function () {
      text.textContent = '正在下载更新…';
      updateBtn.remove();
      dismissBtn.remove();
      applyUpdate(manifest, toast, text);
    });

    toast.appendChild(text);
    toast.appendChild(updateBtn);
    toast.appendChild(dismissBtn);
    document.body.appendChild(toast);
  }

  function applyUpdate(manifest, toast, textEl) {
    // 暂时不传 checksum：插件校验哈希的具体算法/格式没有把握确认，
    // 先排除这个变量，确认下载+切换这条主链路本身没问题。
    // 之后确认好格式了，可以在这里加回 { checksum: manifest.checksum }。
    var downloadOpts = { version: manifest.version, url: manifest.url };

    Updater.download(downloadOpts)
      .then(function (bundle) {
        textEl.textContent = '下载完成，正在切换到新版本…';
        return Updater.set(bundle);
      })
      .catch(function (e) {
        var detail = (e && (e.message || e.errorMessage || e.code)) ? String(e.message || e.errorMessage || e.code) : JSON.stringify(e);
        warn('更新失败', e);
        textEl.textContent = '更新失败：' + detail;
        setTimeout(function () {
          if (toast && toast.parentNode) toast.remove();
        }, 8000);
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
