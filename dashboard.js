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
 * 这几个查询用的 SQL 语法是 Cloudflare Analytics Engine 自己的方言，
 * 参考自官方文档；如果部署后某条查询报语法错误，把返回的报错信息
 * 发出来，照着调整对应函数名即可，不影响其余部分。
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
    const [totalToday, totalYesterday, dau, wau, mau, trend7, trend30] = await Promise.all([
      runSql(env, `SELECT COUNT(*) AS c FROM ${DATASET_NAME} WHERE blob1='launch' AND timestamp > toStartOfDay(NOW())`),
      runSql(env, `SELECT COUNT(*) AS c FROM ${DATASET_NAME} WHERE blob1='launch' AND timestamp >= toStartOfDay(NOW()) - INTERVAL '1' DAY AND timestamp < toStartOfDay(NOW())`),
      runSql(env, `SELECT COUNT(DISTINCT index1) AS c FROM ${DATASET_NAME} WHERE blob1='launch' AND timestamp > toStartOfDay(NOW())`),
      runSql(env, `SELECT COUNT(DISTINCT index1) AS c FROM ${DATASET_NAME} WHERE blob1='launch' AND timestamp > NOW() - INTERVAL '7' DAY`),
      runSql(env, `SELECT COUNT(DISTINCT index1) AS c FROM ${DATASET_NAME} WHERE blob1='launch' AND timestamp > NOW() - INTERVAL '30' DAY`),
      runSql(env, `SELECT toDate(timestamp) AS day, COUNT(*) AS launches, COUNT(DISTINCT index1) AS uniques FROM ${DATASET_NAME} WHERE blob1='launch' AND timestamp > NOW() - INTERVAL '7' DAY GROUP BY day ORDER BY day`),
      runSql(env, `SELECT toDate(timestamp) AS day, COUNT(*) AS launches, COUNT(DISTINCT index1) AS uniques FROM ${DATASET_NAME} WHERE blob1='launch' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY day ORDER BY day`)
    ]);

    const totalLaunchesAllTime = env.COUNTERS ? parseInt((await env.COUNTERS.get('counter:total_launches')) || '0', 10) : 0;
    const totalUniqueDevicesAllTime = env.COUNTERS ? parseInt((await env.COUNTERS.get('counter:total_unique_devices')) || '0', 10) : 0;

    stats = {
      totalLaunchesAllTime,
      totalUniqueDevicesAllTime,
      today: scalar(totalToday, 'c', 0),
      yesterday: scalar(totalYesterday, 'c', 0),
      dau: scalar(dau, 'c', 0),
      wau: scalar(wau, 'c', 0),
      mau: scalar(mau, 'c', 0),
      trend7: trend7 || [],
      trend30: trend30 || []
    };
  } catch (e) {
    queryError = e && e.message ? e.message : String(e);
    stats = {
      totalLaunchesAllTime: 0, totalUniqueDevicesAllTime: 0,
      today: 0, yesterday: 0, dau: 0, wau: 0, mau: 0, trend7: [], trend30: []
    };
  }

  const html = renderPage(stats, queryError);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function renderPage(s, queryError) {
  const trend30Labels = JSON.stringify(s.trend30.map(r => r.day));
  const trend30Launches = JSON.stringify(s.trend30.map(r => r.launches));
  const trend30Uniques = JSON.stringify(s.trend30.map(r => r.uniques));

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
