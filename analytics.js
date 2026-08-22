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
 * 会话时长（仅在能可靠获取时上报）。国家/地区、操作系统等由服务端
 * 从请求本身解析，客户端不主动采集。
 */
(function () {
  'use strict';

  var ENDPOINT = 'https://madan.pages.dev/api/track';
  var DEVICE_ID_KEY = 'pw_ultimate_analyticsDeviceId';
  var QUEUE_KEY = 'pw_ultimate_analyticsQueue';
  var MAX_QUEUE_LENGTH = 50;
  var START_DELAY_MS = 1200;

  function safe(fn) {
    try { return fn(); } catch (e) { return undefined; }
  }

  function getOrCreateDeviceId() {
    return safe(function () {
      var existing = window.localStorage.getItem(DEVICE_ID_KEY);
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
      window.localStorage.setItem(DEVICE_ID_KEY, id);
      return id;
    });
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
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
    // 页面即将隐藏/关闭时，用 sendBeacon 优先（更可能真正发出去），fetch 兜底
    safe(function () {
      if (navigator.sendBeacon) {
        var blob = new Blob([JSON.stringify(event)], { type: 'application/json' });
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
  });

  setTimeout(function () { safe(trackLaunch); }, START_DELAY_MS);
})();
