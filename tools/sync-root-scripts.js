#!/usr/bin/env node
/**
 * 根级内联脚本同步器
 *
 * 背景
 * ----
 * 8.3.30 起 update-checker.js / analytics.js 的内容被内联进 index.html
 * （不再用 <script src> 引用），目的是让 OTA 包自包含。
 * 之后这两份源文件与 index.html 里的副本是「同一份代码的两个位置」，
 * 改了源文件必须同步内联副本，否则线上跑的仍是旧逻辑 —— 而且没有任何报错。
 *
 * 本脚本按 index.html 中的 <script>…</script> 块做整块替换：
 *   用源文件内容替换 html 中对应的内联副本（逐字节）。
 *
 * 用法：
 *   node tools/sync-root-scripts.js          # 同步（有变化才写）
 *   node tools/sync-root-scripts.js --check  # 只校验，不写（CI 用）
 *
 * 校验与同步共用同一套「定位 + 比对」逻辑，避免两边判断不一致。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'index.html');
const FILES = ['update-checker.js', 'analytics.js'];
const CHECK_ONLY = process.argv.includes('--check');

// 源文件开头 N 个字符作为「指纹」，用于在 html 中定位其内联副本
const PROBE = 120;

function findCopySpan(html, src) {
  const head = src.slice(0, PROBE);
  const pos = html.indexOf(head);
  if (pos < 0) return null;
  // 副本长度 = 源文件长度（两者应当逐字节相同）；若不同则说明已漂移，
  // 此时用「源文件末尾指纹」定位终点，取两者间更大的范围防止截断。
  const tail = src.slice(-PROBE);
  const tailPos = html.indexOf(tail, pos);
  if (tailPos < 0) return { start: pos, end: pos + src.length, drifted: true };
  return { start: pos, end: tailPos + PROBE, drifted: false };
}

function main() {
  let html = fs.readFileSync(HTML_PATH, 'utf8');
  let fail = 0;
  let changed = 0;

  console.log('--- 根级脚本内联同步（' + FILES.join(' / ') + '）---');

  for (const name of FILES) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) { console.log(`  ✗ 缺少源文件 ${name}`); fail++; continue; }
    const src = fs.readFileSync(p, 'utf8');
    const span = findCopySpan(html, src);

    if (!span) { console.log(`  ✗ ${name}: 在 index.html 中找不到内联副本`); fail++; continue; }

    const copy = html.slice(span.start, span.end);
    if (copy === src) {
      console.log(`  ✓ ${name} 与内联副本一致`);
      continue;
    }

    // 差异定位（只报首个差异行，便于人工核对）
    const a = src.split('\n');
    const b = copy.split('\n');
    let firstDiff = -1;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) { firstDiff = i; break; }
    }
    console.log(`  ${CHECK_ONLY ? '✗' : '↻'} ${name}: 内联副本与源文件不一致（首个差异第 ${firstDiff + 1} 行）`);
    if (firstDiff >= 0) {
      console.log(`       src : ${JSON.stringify((a[firstDiff] || '').slice(0, 90))}`);
      console.log(`       html: ${JSON.stringify((b[firstDiff] || '').slice(0, 90))}`);
    }
    fail++;

    if (!CHECK_ONLY) {
      html = html.slice(0, span.start) + src + html.slice(span.end);
      changed++;
    }
  }

  if (!CHECK_ONLY && changed > 0) {
    fs.writeFileSync(HTML_PATH, html, 'utf8');
    console.log(`\n已重新内联 ${changed} 个脚本到 index.html。请接着运行全量测试。`);
    return;
  }

  if (CHECK_ONLY) {
    console.log('\n' + (fail === 0 ? '=== 一致 ===' : `=== 不一致 ${fail} 项，请运行 node tools/sync-root-scripts.js 同步 ===`));
    process.exit(fail === 0 ? 0 : 1);
  }
  console.log('\n=== 全部一致 ===');
}

main();
