/**
 * GET /dashboard?key=xxx
 * 私人查看用的统计仪表盘。用一个简单的口令保护（在 Cloudflare Pages
 * 项目的环境变量里配置 DASHBOARD_KEY，不写在代码里）。
 *
 * 绑定/变量要求：
 * - Analytics Engine 数据集绑定：ANALYTICS（跟 track.js 用同一个）
 * - KV 命名空间绑定：COUNTERS（跟 track.js 用同一个）
 * - 环境变量：DASHBOARD_KEY（自己设一个不容易猜的字符串）
 * - 环境变量：CF_ACCOUNT_ID（你的 Cloudflare 账号 ID）
 * - 环境变量：CF_API_TOKEN（有 Account Analytics Read 权限的 API Token）
 *
 * SQL 语法要点（Cloudflare Analytics Engine 自己的方言，跟一般 SQL 不完全一样）：
 * - COUNT() 必须不带任何参数，COUNT(*) / COUNT(DISTINCT x) 都不支持。
 * - 去重计数改用"先 GROUP BY 折叠成一行一个值，再 COUNT() 这些行"的写法。
 * - 官方文档确认存在的函数：NOW()、INTERVAL、toStartOfDay()、COUNT()、SUM()。
 *   没有直接证据的函数（比如 toDate()）一律不用，全部用 toStartOfDay() 分桶。
 */

const DATASET_NAME = 'madan_events';

async function runSql(env, sql) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'text/plain'
    },
    body: sql
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SQL API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return (json && json.data) || [];
}

function scalar(rows, field, fallback) {
  if (!rows || !rows.length) return fallback;
  const v = rows[0][field];
  return v === undefined || v === null ? fallback : v;
}

async function fetchAllStats(env) {
  const [
    totalToday, totalYesterday, dau, wau, mau,
    trend30Launches, trend30Uniques, channel30, os30
  ] = await Promise.all([
    runSql(env, `SELECT COUNT() AS c FROM ${DATASET_NAME} WHERE blob1='launch' AND timestamp > toStartOfDay(NOW())`),
    runSql(env, `SELECT COUNT() AS c FROM ${DATASET_NAME} WHERE blob1='launch' AND timestamp >= toStartOfDay(NOW()) - INTERVAL '1' DAY AND timestamp < toStartOfDay(NOW())`),
    // 去重计数：先按 index1 分组折叠成"每个设备一行"，再对这些行 COUNT()。
    runSql(env, `SELECT COUNT() AS c FROM (SELECT index1 FROM ${DATASET_NAME} WHERE blob1='launch' AND timestamp > toStartOfDay(NOW()) GROUP BY index1)`),
    runSql(env, `SELECT COUNT() AS c FROM (SELECT index1 FROM ${DATASET_NAME} WHERE blob1='launch' AND timestamp > NOW() - INTERVAL '7' DAY GROUP BY index1)`),
    runSql(env, `SELECT COUNT() AS c FROM (SELECT index1 FROM ${DATASET_NAME} WHERE blob1='launch' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY index1)`),
    // 趋势：拆成"每日启动次数"和"每日独立设备数"两条查询，代码里按日期合并，
    // 避免依赖不确定是否支持的嵌套聚合写法。
    runSql(env, `SELECT toStartOfDay(timestamp) AS day, COUNT() AS launches FROM ${DATASET_NAME} WHERE blob1='launch' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY day ORDER BY day`),
    runSql(env, `SELECT day, COUNT() AS uniques FROM (SELECT toStartOfDay(timestamp) AS day, index1 FROM ${DATASET_NAME} WHERE blob1='launch' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY day, index1) GROUP BY day ORDER BY day`),
    // 渠道分布（blob5，部署渠道识别之前的旧数据该字段为空，归入"历史"）
    runSql(env, `SELECT blob5 AS channel, COUNT() AS c FROM ${DATASET_NAME} WHERE blob1='launch' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY blob5 ORDER BY c DESC`),
    // 操作系统分布（blob4；iOS 识别上线前全部为 Unknown）
    runSql(env, `SELECT blob4 AS os, COUNT() AS c FROM ${DATASET_NAME} WHERE blob1='launch' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY blob4 ORDER BY c DESC`)
  ]);

  const uniquesByDay = {};
  (trend30Uniques || []).forEach(r => { uniquesByDay[r.day] = r.uniques; });
  const trend30 = (trend30Launches || []).map(r => ({
    day: r.day,
    launches: r.launches,
    uniques: uniquesByDay[r.day] || 0
  }));

  return {
    today: scalar(totalToday, 'c', 0),
    yesterday: scalar(totalYesterday, 'c', 0),
    dau: scalar(dau, 'c', 0),
    wau: scalar(wau, 'c', 0),
    mau: scalar(mau, 'c', 0),
    trend30,
    channels30: (channel30 || []).map(r => ({ channel: r.channel || '', count: r.c })),
    os30: (os30 || []).map(r => ({ os: r.os || '', count: r.c }))
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!env.DASHBOARD_KEY || key !== env.DASHBOARD_KEY) {
    return new Response('未授权，请在网址后面加上正确的 ?key=', { status: 401 });
  }

  let stats;
  let queryError = '';
  try {
    const queried = await fetchAllStats(env);
    const totalLaunchesAllTime = env.COUNTERS ? parseInt((await env.COUNTERS.get('counter:total_launches')) || '0', 10) : 0;
    const totalUniqueDevicesAllTime = env.COUNTERS ? parseInt((await env.COUNTERS.get('counter:total_unique_devices')) || '0', 10) : 0;
    stats = { totalLaunchesAllTime, totalUniqueDevicesAllTime, ...queried };
  } catch (e) {
    queryError = e && e.message ? e.message : String(e);
    stats = {
      totalLaunchesAllTime: 0, totalUniqueDevicesAllTime: 0,
      today: 0, yesterday: 0, dau: 0, wau: 0, mau: 0, trend30: [], channels30: [], os30: []
    };
  }

  const html = renderPage(stats, queryError);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

const CHANNEL_LABELS = {
  apk: 'Android APK',
  'web-cf': 'CF Pages 网页版',
  'web-cf-pwa': 'CF Pages 主屏幕App（添加到主屏幕）',
  'web-gh': 'GitHub Pages 网页版',
  'web-gh-pwa': 'GitHub Pages 主屏幕App（添加到主屏幕）',
  other: '其他'
};

const OS_LABELS = {
  '': '未知（历史数据）',
  Unknown: '未知（历史数据）'
};

// 通用横向条形分布列表（渠道 / 操作系统共用）
function renderBarList(rows) {
  if (!rows || !rows.length) return '<div class="channel-empty">暂无数据</div>';
  const total = rows.reduce((sum, r) => sum + (r.count || 0), 0) || 1;
  return rows.map(r => {
    const pct = Math.round(((r.count || 0) / total) * 100);
    return `<div class="channel-row"><span class="channel-name">${r.label}</span><span class="channel-bar"><span class="channel-fill" style="width:${pct}%"></span></span><span class="channel-count">${r.count} (${pct}%)</span></div>`;
  }).join('');
}

function renderPage(s, queryError) {
  const trend30Labels = JSON.stringify(s.trend30.map(r => r.day));
  const trend30Launches = JSON.stringify(s.trend30.map(r => r.launches));
  const trend30Uniques = JSON.stringify(s.trend30.map(r => r.uniques));
  const channelRows = (s.channels30 || []).map(r => ({
    label: CHANNEL_LABELS[r.channel] || '历史数据（渠道识别上线前）',
    count: r.count
  }));
  const osRows = (s.os30 || []).map(r => ({
    label: OS_LABELS[r.os] !== undefined ? OS_LABELS[r.os] : r.os,
    count: r.count
  }));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>码单器使用统计</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 20px; }
  .card { background: #1e293b; border-radius: 12px; padding: 14px; }
  .card .label { font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
  .card .value { font-size: 24px; font-weight: 700; color: #f1f5f9; }
  .chart-box { background: #1e293b; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  .chart-box h2 { font-size: 14px; margin: 0 0 12px; color: #cbd5e1; }
  .error { background: #7f1d1d; color: #fecaca; padding: 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; white-space: pre-wrap; }
  .channel-row { display: flex; align-items: center; gap: 10px; margin: 8px 0; font-size: 13px; }
  .channel-name { width: 210px; color: #cbd5e1; flex-shrink: 0; }
  .channel-bar { flex: 1; height: 10px; background: #334155; border-radius: 5px; overflow: hidden; }
  .channel-fill { display: block; height: 100%; background: #38bdf8; border-radius: 5px; }
  .channel-count { color: #94a3b8; flex-shrink: 0; min-width: 90px; text-align: right; }
  .channel-empty { color: #94a3b8; font-size: 13px; }
  canvas { max-width: 100%; }
</style>
</head>
<body>
<h1>❄ 码单器 使用统计</h1>
${queryError ? `<div class="error">查询出错，先看这个：\n${queryError}</div>` : ''}
<div class="grid">
  <div class="card"><div class="label">总启动次数（历史累计）</div><div class="value">${s.totalLaunchesAllTime}</div></div>
  <div class="card"><div class="label">历史累计用户数</div><div class="value">${s.totalUniqueDevicesAllTime}</div></div>
  <div class="card"><div class="label">今日启动</div><div class="value">${s.today}</div></div>
  <div class="card"><div class="label">昨日启动</div><div class="value">${s.yesterday}</div></div>
  <div class="card"><div class="label">DAU</div><div class="value">${s.dau}</div></div>
  <div class="card"><div class="label">WAU</div><div class="value">${s.wau}</div></div>
  <div class="card"><div class="label">MAU</div><div class="value">${s.mau}</div></div>
</div>
<div class="chart-box">
  <h2>最近 30 天启动渠道分布</h2>
  ${renderBarList(channelRows)}
</div>
<div class="chart-box">
  <h2>最近 30 天操作系统分布</h2>
  ${renderBarList(osRows)}
</div>
<div class="chart-box">
  <h2>最近 30 天趋势（启动次数 / 当日独立用户）</h2>
  <canvas id="trendChart" height="220"></canvas>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
<script>
  var ctx = document.getElementById('trendChart').getContext('2d');
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: ${trend30Labels},
      datasets: [
        { label: '启动次数', data: ${trend30Launches}, borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,.15)', tension: .3, fill: true },
        { label: '独立用户', data: ${trend30Uniques}, borderColor: '#a78bfa', backgroundColor: 'rgba(167,139,250,.15)', tension: .3, fill: true }
      ]
    },
    options: {
      responsive: true,
      scales: {
        x: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
        y: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' }, beginAtZero: true }
      },
      plugins: { legend: { labels: { color: '#e2e8f0' } } }
    }
  });
</script>
</body>
</html>`;
}
