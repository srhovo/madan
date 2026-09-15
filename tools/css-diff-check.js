#!/usr/bin/env node
/**
 * CSS 改动等价性验证器（tools/css-diff-check.js）
 *
 * 背景
 * ----
 * 本项目的 CSS 全部内联在单文件 index.html 里（约 3,480 行）。改动 CSS 看似
 * 风险低，实则没有可靠的静态验证手段 —— 这一点在 B1 阶段被反复证实：
 *
 *   · 静态大括号配对       → 报 6 处「死声明」
 *   · 更严格的选择器解析   → 报 41 处
 *   · 运行时 CSSOM 探测    → 报 0 处安全 / 6 处不安全
 *   三者结论互相矛盾，全部是分析方法的假象。
 *
 *   · 用 jsdom 验证时得出「零差异」—— 但这个结论毫无意义：jsdom 的
 *     matchMedia 是永远返回 matches:false 的 mock，被删的媒体查询在
 *     模拟环境里从未生效过，等于什么都没验。
 *
 * 因此本工具只认一种证据：**真实 Chromium 在真实视口下的计算样式比对**。
 *
 * 它做什么
 * --------
 * 给定两份 index.html（改动前 / 改动后），在多组视口下让浏览器计算
 * 每个元素的最终样式，逐项比对；输出差异清单与统计。
 *
 * 它能证明什么、不能证明什么
 * --------------------------
 * 能证明：在**测试到的视口与属性范围内**，两份文件的渲染结果一致。
 * 不能证明：未被测到的视口 / 属性 / 交互状态（hover、focus、动画中间态、
 *           动态增删的 DOM）也一致；也不覆盖 JS 行为。
 * 所以它是**辅助证据**，不是充分证明 —— 报告里必须如实标注测试范围。
 *
 * 用法
 * ----
 *   node tools/css-diff-check.js <改动前.html> <改动后.html>
 *   node tools/css-diff-check.js --before a.html --after b.html
 *   node tools/css-diff-check.js a.html b.html --viewports 390x844,1440x900
 *   node tools/css-diff-check.js a.html b.html --json report.json
 *
 * 退出码
 * ------
 *   0  零差异（或在被测范围内未发现差异）
 *   1  发现差异
 *   2  环境不可用（缺依赖 / 缺浏览器）—— 注意：这是「工具没跑起来」，
 *      不是「发现差异」，调用方需区分对待
 *
 * 依赖
 * ----
 * 需要 playwright-core 与一份 Chromium。二者都**刻意不写进 package.json**：
 * 本工具不参与 CI 门禁（CI 不该为它付 14MB + 364MB 的代价），故依赖缺失
 * 时给出安装指引并以退出码 2 退出，不影响任何现有流程。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ── 默认比对范围 ──────────────────────────────────────────────────────
// 覆盖移动 / 平板 / 桌面，以及 B1 阶段实际命中媒体查询的三个临界视口。
const DEFAULT_VIEWPORTS = [
  { w: 390, h: 844, label: 'iPhone 竖屏' },
  { w: 820, h: 1180, label: 'iPad 竖屏（命中平板媒体查询）' },
  { w: 768, h: 1024, label: 'iPad 横屏下限（命中）' },
  { w: 1024, h: 768, label: 'iPad 横屏' },
  { w: 1024, h: 1366, label: 'iPad Pro 竖屏（命中）' },
  { w: 1440, h: 900, label: '桌面' },
];

// 比对的样式属性。选的是「布局与视觉的关键项」而非全部 ——
// 属性越多噪声越大，且部分属性（如 transform 的浮点尾数）不稳定。
const DEFAULT_PROPS = [
  'display',
  'position',
  'grid-template-columns',
  'grid-column',
  'gap',
  'width',
  'min-width',
  'max-width',
  'height',
  'max-height',
  'margin',
  'padding',
  'padding-top',
  'padding-left',
  'overflow',
  'font-size',
  'border-radius',
  'flex-direction',
];

// ── 参数解析 ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const files = [];
  const opts = { viewports: null, props: null, json: null, quiet: false, maxReport: 50 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--before': files.push({ role: 'before', p: next() }); break;
      case '--after': files.push({ role: 'after', p: next() }); break;
      case '--viewports':
        opts.viewports = next().split(',').map((s) => {
          const m = s.trim().match(/^(\d+)x(\d+)$/);
          if (!m) throw new Error(`视口格式应为 WxH，收到：${s}`);
          return { w: +m[1], h: +m[2], label: `${m[1]}×${m[2]}` };
        });
        break;
      case '--props': opts.props = next().split(',').map((s) => s.trim()); break;
      case '--json': opts.json = next(); break;
      case '--max-report': opts.maxReport = +next(); break;
      case '--quiet': opts.quiet = true; break;
      case '-h': case '--help': usage(); process.exit(0);
      default:
        if (a.startsWith('-')) throw new Error(`未知参数：${a}`);
        files.push({ role: files.length === 0 ? 'before' : 'after', p: a });
    }
  }
  const before = files.find((f) => f.role === 'before');
  const after = files.find((f) => f.role === 'after');
  if (!before || !after) {
    usage();
    process.exit(1);
  }
  return { before: before.p, after: after.p, opts };
}

function usage() {
  console.log(`用法：node tools/css-diff-check.js <改动前.html> <改动后.html> [选项]

选项：
  --viewports 390x844,1440x900   自定义视口（默认 6 组）
  --props display,padding,...    自定义比对属性
  --json <路径>                  把完整结果写为 JSON
  --max-report <N>               控制台最多列出 N 条差异（默认 50）
  --quiet                        只输出汇总

退出码：0 零差异 / 1 发现差异 / 2 环境不可用`);
}

// ── 依赖自检（刻意不做全局安装动作）──────────────────────────────────
function loadBrowser() {
  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch (e) {
    console.log('--- CSS 改动等价性验证 ---');
    console.log('  ⚠ 未安装 playwright-core，本工具无法运行（这不是测试失败）。');
    console.log('');
    console.log('    本工具不参与 CI 门禁，故依赖刻意未写进 package.json。');
    console.log('    需要时执行一次：');
    console.log('');
    console.log('      npm install --no-save playwright-core');
    console.log('      npx playwright-core install chromium');
    console.log('');
    console.log('    注意：本项目亲历过 npm install --no-save 静默删包的事故，');
    console.log('    若已用 package.json + npm ci 管理依赖，装完本工具依赖后请再跑一次 npm ci。');
    process.exit(2);
  }
  return chromium;
}

// 找一个可用的 Chromium。playwright 自带的通常在
// ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome
function findChromium(chromium) {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  try {
    const p = chromium.executablePath();
    if (p) candidates.push(p);
  } catch (e) { /* 未安装 */ }
  const base = path.join(process.env.HOME || '/root', '.cache', 'ms-playwright');
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      if (!d.startsWith('chromium-')) continue;
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        candidates.push(path.join(base, d, sub));
      }
    }
  }
  for (const c of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    candidates.push(c);
  }
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

// ── 采集：在给定视口下取每个元素的计算样式 ───────────────────────────
async function collect(browser, htmlPath, viewports, props) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const result = {};
  for (const vp of viewports) {
    const ctx = await browser.newContext({
      viewport: { width: vp.w, height: vp.h },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    // 用 file:// 加载，避免起服务器；等 DOM 就绪即可（不依赖外部资源）
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    // 给布局一点时间（本项目有早期布局 IIFE 与字体度量）
    await page.waitForTimeout(120);

    const matched = await page.evaluate(
      (vw) => window.matchMedia(`(max-width: ${vw}px)`).matches,
      vp.w,
    );

    const data = await page.evaluate((propList) => {
      const out = [];
      const walk = (el, idxPath) => {
        const cs = getComputedStyle(el);
        const rec = { path: idxPath, tag: el.tagName.toLowerCase(), cls: el.className || '' };
        for (const p of propList) rec[p] = cs.getPropertyValue(p);
        out.push(rec);
        let i = 0;
        for (const ch of el.children) walk(ch, `${idxPath}/${i++}`);
      };
      walk(document.documentElement, '');
      return out;
    }, props);

    result[`${vp.w}x${vp.h}`] = { label: vp.label, mmMatches: matched, data };
    await ctx.close();
  }
  return result;
}

// ── 比对 ──────────────────────────────────────────────────────────────
function diff(before, after, props, maxReport) {
  const rows = [];
  let comparisons = 0;
  let elemsCompared = 0;
  const viewports = [];

  for (const key of Object.keys(before)) {
    const b = before[key];
    const a = after[key];
    if (!a) {
      rows.push({ vp: key, kind: 'viewport-missing', detail: '后一份缺少该视口数据' });
      continue;
    }
    viewports.push({ key, label: b.label, mmMatches: b.mmMatches, elems: b.data.length });
    if (b.data.length !== a.data.length) {
      rows.push({
        vp: key, kind: 'element-count',
        detail: `元素数不同：改动前 ${b.data.length}，改动后 ${a.data.length}`,
      });
    }
    const n = Math.min(b.data.length, a.data.length);
    for (let i = 0; i < n; i++) {
      const eb = b.data[i];
      const ea = a.data[i];
      elemsCompared++;
      if (eb.path !== ea.path || eb.tag !== ea.tag) {
        rows.push({ vp: key, kind: 'structure', path: eb.path, detail: `结构错位：${eb.tag} vs ${ea.tag}` });
        continue;
      }
      for (const p of props) {
        comparisons++;
        if (eb[p] !== ea[p]) {
          rows.push({
            vp: key, kind: 'style', path: eb.path, tag: eb.tag, cls: eb.cls, prop: p,
            before: eb[p], after: ea[p],
          });
        }
      }
    }
  }
  return { rows, comparisons, elemsCompared, viewports };
}

// ── 主流程 ────────────────────────────────────────────────────────────
async function main() {
  const { before, after, opts } = parseArgs(process.argv.slice(2));
  for (const [role, p] of [['改动前', before], ['改动后', after]]) {
    if (!fs.existsSync(p)) {
      console.log(`  ✗ ${role}文件不存在：${p}`);
      process.exit(2);
    }
  }
  const viewports = opts.viewports || DEFAULT_VIEWPORTS;
  const props = opts.props || DEFAULT_PROPS;

  const chromium = loadBrowser();
  const exe = findChromium(chromium);
  if (!exe) {
    console.log('--- CSS 改动等价性验证 ---');
    console.log('  ⚠ 找不到 Chromium 可执行文件，本工具无法运行（这不是测试失败）。');
    console.log('    安装：npx playwright-core install chromium');
    console.log('    或设置 CHROME_PATH 指向已有的 chrome。');
    process.exit(2);
  }

  console.log('--- CSS 改动等价性验证（真实 Chromium）---');
  console.log(`  改动前：${before}`);
  console.log(`  改动后：${after}`);
  console.log(`  浏览器：${exe}`);
  console.log(`  视口  ：${viewports.length} 组`);
  console.log(`  属性  ：${props.length} 项`);
  console.log('');

  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  let bData, aData;
  try {
    bData = await collect(browser, before, viewports, props);
    aData = await collect(browser, after, viewports, props);
  } finally {
    await browser.close();
  }

  const { rows, comparisons, elemsCompared, viewports: vpInfo } = diff(bData, aData, props, opts.maxReport);

  console.log('  视口命中情况（媒体查询是否实际生效，决定该视口是否有验证价值）：');
  for (const v of vpInfo) {
    console.log(`    ${v.mmMatches ? '✓' : '·'} ${v.key.padEnd(10)} ${v.label.padEnd(28)} 元素 ${v.elems}  ${v.mmMatches ? '（媒体查询命中）' : ''}`);
  }

  const elementDiff = rows.filter((r) => r.kind !== 'style');
  const styleDiff = rows.filter((r) => r.kind === 'style');

  console.log('');
  console.log(`  比对总量：${elemsCompared.toLocaleString()} 个元素 × ${props.length} 项属性`);
  console.log(`            = ${comparisons.toLocaleString()} 项计算样式`);
  console.log(`  其中媒体查询实际命中的视口：${vpInfo.filter((v) => v.mmMatches).length} 组`);

  if (elementDiff.length) {
    console.log('');
    console.log(`  ✗ 结构类差异 ${elementDiff.length} 条：`);
    elementDiff.slice(0, opts.maxReport).forEach((r) =>
      console.log(`      [${r.vp}] ${r.kind}: ${r.detail}`));
  }

  if (styleDiff.length) {
    console.log('');
    console.log(`  ✗ 样式差异 ${styleDiff.length} 条（最多列出 ${opts.maxReport} 条）：`);
    styleDiff.slice(0, opts.maxReport).forEach((r) =>
      console.log(`      [${r.vp}] ${r.path} <${r.tag}> .${String(r.cls).slice(0, 30)}  ${r.prop}: "${r.before}" → "${r.after}"`));
    if (styleDiff.length > opts.maxReport) {
      console.log(`      …另有 ${styleDiff.length - opts.maxReport} 条，用 --json 取全量`);
    }
  }

  // 唯一性统计：同一元素+属性的差异可能跨多个视口重复出现
  const uniq = new Set(styleDiff.map((r) => `${r.path}|${r.prop}`));

  const verdict = rows.length === 0 ? 'identical' : 'different';
  console.log('');
  console.log('===================================================================');
  if (rows.length === 0) {
    console.log(' ✓ 零差异 —— 在被测视口与属性范围内，两份文件的渲染结果一致');
    console.log(`   范围声明：${vpInfo.length} 组视口（${vpInfo.filter((v) => v.mmMatches).length} 组媒体查询命中）`);
    console.log(`             × ${props.length} 项属性，共 ${comparisons.toLocaleString()} 项比对`);
    console.log('   注意：本结论不覆盖未测视口/属性、交互态（hover/focus/动画）、JS 行为。');
  } else {
    console.log(` ✗ 发现差异：${styleDiff.length} 条样式差异（去重后 ${uniq.size} 处）+ ${elementDiff.length} 条结构差异`);
  }
  console.log('===================================================================');

  if (opts.json) {
    fs.writeFileSync(opts.json, JSON.stringify({
      before, after, viewports: vpInfo, props,
      comparisons, elemsCompared, verdict,
      styleDiffCount: styleDiff.length, elementDiffCount: elementDiff.length,
      uniqueStyleDiffs: [...uniq],
      rows,
    }, null, 2) + '\n', 'utf8');
    console.log(`  完整结果已写入：${opts.json}`);
  }

  process.exit(rows.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('  ✗ 运行失败：', e.message);
  process.exit(2);
});
