/**
 * POST /api/track
 * 接收码单器 App 端上报的匿名使用事件，写入 Analytics Engine（明细，
 * 3个月自动过期）和 KV（永久累计计数器）。
 *
 * 绑定要求（在 Cloudflare Pages 项目设置里配置，不需要 wrangler）：
 * - Analytics Engine 数据集绑定，变量名 ANALYTICS
 * - KV 命名空间绑定，变量名 COUNTERS
 *
 * 数据点结构（写入 Analytics Engine 的字段有限，按用途分配）：
 * - indexes[0]：device_id（唯一允许索引的高基数字段，用于按设备去重计数）
 * - blobs：[event_type, app_version, country, os_hint]
 * - doubles：[duration_sec]（仅 session_end 事件有意义，其余为 0）
 */

const ALLOWED_ORIGINS = new Set([
  'https://localhost', // Capacitor Android 默认本地资源 origin
  'capacitor://localhost',
  'https://madan.pages.dev'
]);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://localhost';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function parseOsHint(userAgent) {
  if (!userAgent) return '';
  const androidMatch = userAgent.match(/Android\s([\d.]+)/);
  if (androidMatch) return 'Android ' + androidMatch[1];
  return 'Unknown';
}

function isValidDeviceId(id) {
  return typeof id === 'string' && id.length >= 8 && id.length <= 64;
}

async function bumpTotalLaunchCounters(env, deviceId) {
  // 永久计数器：总启动次数（每次事件都加）。
  // KV 没有原子自增，小体量应用下"读出来+1再写回"够用；
  // 极端并发下可能有极小误差，属于可接受范围，不引入额外的队列/锁机制。
  const totalKey = 'counter:total_launches';
  const rawTotal = await env.COUNTERS.get(totalKey);
  const total = (parseInt(rawTotal, 10) || 0) + 1;
  await env.COUNTERS.put(totalKey, String(total));

  // 永久计数器：历史累计独立设备数（"这台设备是否第一次出现"）。
  const seenKey = 'seen:' + deviceId;
  const alreadySeen = await env.COUNTERS.get(seenKey);
  if (!alreadySeen) {
    await env.COUNTERS.put(seenKey, '1');
    const uniqueKey = 'counter:total_unique_devices';
    const rawUnique = await env.COUNTERS.get(uniqueKey);
    const unique = (parseInt(rawUnique, 10) || 0) + 1;
    await env.COUNTERS.put(uniqueKey, String(unique));
  }
}

export async function onRequestOptions(context) {
  const origin = context.request.headers.get('Origin') || '';
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  const headers = corsHeaders(origin);

  if (!env.ANALYTICS) {
    return new Response(JSON.stringify({ ok: false, error: 'analytics binding missing' }), {
      status: 500, headers: { ...headers, 'Content-Type': 'application/json' }
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid json' }), {
      status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
    });
  }

  const deviceId = payload && payload.device_id;
  if (!isValidDeviceId(deviceId)) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid device_id' }), {
      status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
    });
  }

  const eventType = typeof payload.event_type === 'string' ? payload.event_type.slice(0, 32) : 'unknown';
  const appVersion = typeof payload.app_version === 'string' ? payload.app_version.slice(0, 16) : '';
  const durationSec = typeof payload.duration_sec === 'number' && isFinite(payload.duration_sec) ? payload.duration_sec : 0;

  const country = request.cf && request.cf.country ? String(request.cf.country) : 'XX';
  const osHint = parseOsHint(request.headers.get('User-Agent'));

  env.ANALYTICS.writeDataPoint({
    indexes: [deviceId],
    blobs: [eventType, appVersion, country, osHint],
    doubles: [durationSec]
  });

  // 计数器只在真实"启动"事件上累加，session_end 不重复计入启动次数
  if (eventType === 'launch' && env.COUNTERS) {
    try {
      await bumpTotalLaunchCounters(env, deviceId);
    } catch (e) {
      // KV 写入失败不影响本次上报被视为成功（Analytics Engine 已经写入）
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { ...headers, 'Content-Type': 'application/json' }
  });
}
