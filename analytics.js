/**
 * 码单器 匿名使用统计（独立模块）
 * ------------------------------------------------------------
 * 设计原则（不允许被后续修改破坏）：
 * 1. 任何环节出错都必须被吞掉，绝不能抛出未捕获异常影响主应用。
 * 2. 不读取、不上报任何业务数据（陪玩名单/老板记忆库/订单内容等）。
 * 3. 不使用任何需要原生权限的 API，纯标准 Web API，可随 OTA 更新推送。
 * 4. 网络失败时静默降级，绝不阻塞或拖慢应用本身的启动与使用。
 *
 * 收集的数据：匿名设备 ID（本地随机生成）、事件类型、App 版本号、
 * 会话时长（仅在能可靠获取时上报）、是否主屏幕网页 App（iOS 添加到
 * 主屏幕 / Android 安装的 standalone 模式）。国家/地区、操作系统等
 * 由服务端从请求本身解析，客户端不主动采集。
 *
 * iOS 兼容要点（standalone 主屏幕 App 场景实测踩坑）：
 * - 请求体 Content-Type 用 text/plain 而非 application/json：
 *   text/plain 属于 CORS 简单请求，无需预检（iOS Safari 的跨域预检
 *   在 standalone 模式下不稳定）；服务端 request.json() 不校验
 *   Content-Type，解析不受影响。
 * - fetch 加 keepalive: true：用户快速切走 App、页面被挂起时请求
 *   仍能发出，避免启动事件丢失。
 * - 设备 ID 读写 localStorage 失败时逐级降级 sessionStorage、内存，
 *   绝不因存储不可用而完全停止上报。
 * - 会话结束同时监听 visibilitychange 与 pagehide：iOS 杀掉
 *   standalone App 时 pagehide 更可靠。
 */
(function () {
  'use strict';

  var ENDPOINT = 'https://madan.pages.dev/api/track';
  var DEVICE_ID_KEY = 'pw_ultimate_analyticsDeviceId';
  var QUEUE_KEY = 'pw_ultimate_analyticsQueue';
  var MAX_QUEUE_LENGTH = 50;
  // 缩短启动上报延迟：iOS 主屏幕 App 用户若快速切走，页面被挂起后
  // 延迟回调不再执行，1.2s 延迟会丢启动事件；400ms + keepalive 兜底。
  var START_DELAY_MS = 400;

  // localStorage 完全不可用（iOS 隐私模式等）时的内存兜底
  var memDeviceId = null;

  function safe(fn) {
    try { return fn(); } catch (e) { return undefined; }
  }

  function getOrCreateDeviceId() {
    return safe(function () {
      // 逐级降级：localStorage（正常持久化）→ sessionStorage（会话内稳定）
      // → 内存（本次会话内兜底）。iOS standalone 模式的 localStorage
      // 与 Safari 相互独立，且在隐私模式下可能抛错，不能只依赖它。
      var existing = null;
      try { existing = window.localStorage.getItem(DEVICE_ID_KEY); } catch (e) {}
      if (!existing) {
        try { existing = window.sessionStorage.getItem(DEVICE_ID_KEY); } catch (e) {}
      }
      if (!existing) existing = memDeviceId;
      if (existing) return existing;

      var id;
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        id = window.crypto.randomUUID();
      } else {
        // 兼容极少数不支持 randomUUID 的旧 WebView
        id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = (Math.random() * 16) | 0;
          var v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        });
      }
      try { window.localStorage.setItem(DEVICE_ID_KEY, id); } catch (e) {}
      try { window.sessionStorage.setItem(DEVICE_ID_KEY, id); } catch (e) {}
      memDeviceId = id;
      return id;
    });
  }

  // 是否以"主屏幕网页 App"（standalone）模式启动：
  // iOS「添加到主屏幕」、Android Chrome「安装应用」均为 true
  function isStandalonePwa() {
    return Boolean(safe(function () {
      // iOS 专有属性（iPhone/iPad Safari 添加到主屏幕后为 true）
      if (window.navigator && window.navigator.standalone === true) return true;
      if (window.matchMedia) {
        return window.matchMedia('(display-mode: standalone)').matches
          || window.matchMedia('(display-mode: fullscreen)').matches;
      }
      return false;
    }));
  }

  function readQueue() {
    return safe(function () {
      var raw = window.localStorage.getItem(QUEUE_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    }) || [];
  }

  function writeQueue(list) {
    safe(function () {
      var capped = list.slice(-MAX_QUEUE_LENGTH);
      window.localStorage.setItem(QUEUE_KEY, JSON.stringify(capped));
    });
  }

  function enqueue(event) {
    var list = readQueue();
    list.push(event);
    writeQueue(list);
  }

  function sendOne(event) {
    // 用 AbortController 兜底超时，避免弱网环境下请求长时间挂起
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (ok) {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      try {
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = setTimeout(function () {
          if (controller) controller.abort();
        }, 6000);
        fetch(ENDPOINT, {
          method: 'POST',
          // text/plain 是 CORS 简单请求，免去预检（iOS standalone 模式
          // 下跨域预检不稳定）；服务端按 JSON 解析 body，不受影响
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify(event),
          // 页面被挂起/关闭后请求仍能发出（iOS 快速切走 App 的关键兜底）
          keepalive: true,
          signal: controller ? controller.signal : undefined
        }).then(function (res) {
          clearTimeout(timer);
          finish(Boolean(res && res.ok));
        }).catch(function () {
          clearTimeout(timer);
          finish(false);
        });
      } catch (e) {
        finish(false);
      }
    });
  }

  function flushQueueThenSend(currentEvent) {
    var pending = readQueue();
    writeQueue([]); // 先清空，发送失败的会在下面重新入队，避免和"当前这次"重复攒积

    var all = pending.concat([currentEvent]);
    var failed = [];
    var i = 0;

    function next() {
      if (i >= all.length) {
        if (failed.length) writeQueue(failed);
        return;
      }
      var ev = all[i++];
      sendOne(ev).then(function (ok) {
        if (!ok) failed.push(ev);
        next();
      });
    }
    next();
  }

  function buildBaseEvent(eventType, extra) {
    var deviceId = getOrCreateDeviceId();
    if (!deviceId) return null;
    var event = {
      device_id: deviceId,
      app_version: (typeof APP_VERSION !== 'undefined' && APP_VERSION) ? APP_VERSION : '',
      event_type: eventType,
      pwa: isStandalonePwa() ? 1 : 0,
      client_ts: Date.now()
    };
    if (extra) {
      for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) event[k] = extra[k]; }
    }
    return event;
  }

  function trackLaunch() {
    var event = buildBaseEvent('launch');
    if (!event) return;
    flushQueueThenSend(event);
  }

  // ---- 会话时长（尽力而为，不保证 100% 触发，属于移动端统计的普遍限制）----
  var sessionStart = Date.now();
  var sessionEndSent = false;

  function trackSessionEnd() {
    if (sessionEndSent) return;
    var durationSec = Math.round((Date.now() - sessionStart) / 1000);
    if (durationSec < 1 || durationSec > 24 * 3600) return; // 明显异常值不上报
    sessionEndSent = true;
    var event = buildBaseEvent('session_end', { duration_sec: durationSec });
    if (!event) return;
    // 页面即将隐藏/关闭时，用 sendBeacon 优先（更可能真正发出去），fetch 兜底。
    // Blob 类型必须用 text/plain：sendBeacon 无法携带预检，application/json
    // 会触发 CORS 预检导致 beacon 在 Safari 上直接失败。
    safe(function () {
      if (navigator.sendBeacon) {
        var blob = new Blob([JSON.stringify(event)], { type: 'text/plain;charset=UTF-8' });
        var ok = navigator.sendBeacon(ENDPOINT, blob);
        if (ok) return;
      }
      sendOne(event);
    });
  }

  safe(function () {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') trackSessionEnd();
    });
    // iOS 杀掉主屏幕 App 时不一定触发 visibilitychange，pagehide 更可靠
    window.addEventListener('pagehide', function () { trackSessionEnd(); });
  });

  setTimeout(function () { safe(trackLaunch); }, START_DELAY_MS);
})();
