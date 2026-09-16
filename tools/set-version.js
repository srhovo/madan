#!/usr/bin/env node
/**
 * 版本号落点改写器（A1）
 *
 * 背景
 * ----
 * index.html 里 8.3.x 形状的字样共 165 处，其中 163 处是变更考古注释
 * （Release note、CSS 注释、HTML 注释），**必须原样保留** —— 它们是
 * 「这个功能为什么长这样」的唯一线索。
 *
 * 真正参与代码的只有两处：
 *   1. <title>码单器8.3.x</title>          （浏览器标签 / 分享预览）
 *   2. const APP_VERSION = '8.3.x';        （运行时唯一真源）
 * 另有第三处「跟随项」：
 *   3. package.json 的 version 字段        （不参与运行时，但需与产品版本同步，
 *                                          免得日后看依赖清单误判项目停在哪一版）
 * 以及第四处「文档项」：
 *   4. README.md 的「当前版本：`8.3.x`」    （给人和 agent 看的入口说明）
 *
 * 第 4 条是补上的：此前它不在任何改写落点里，从 8.3.33 起一路停在原地，
 * 到 8.3.36 时已落后 3 个版本 —— 而这种「文档里的版本号过期」正是让
 * 接手的人和 agent 判断失误的源头。
 *
 * 前 3 条位于代码/清单，属**强制**落点（写错会让 OTA 判定出错）；
 * 第 4 条位于 Markdown 文档，属**尽力**落点（格式被人改过就跳过，不阻断发版）。
 *
 * 危险的正是「批量替换」：一个 sed s/8\.3\.35/8.3.36/g 会把这 163 处
 * 历史记录一并篡改，还会命中 SVG path 里 x.y.z 形状的坐标数字。
 * 本脚本因此只认这几条白名单规则，且**要求每条恰好命中 1 次**，
 * 多一处少一处都拒绝写入 —— 让「落点被意外改动」在发版前就暴露。
 *
 * 用法：
 *   node tools/set-version.js --check            # 只校验各落点是否一致且合法
 *   node tools/set-version.js --to 8.3.36        # 改写
 *   node tools/set-version.js --to 8.3.36 --dry-run   # 只看会怎么改，不落盘
 *
 * 退出码：0 通过 / 1 失败
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'index.html');
const PKG_PATH = path.join(ROOT, 'package.json');
const README_PATH = path.join(ROOT, 'README.md');

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const DRY_RUN = argv.includes('--dry-run');
const toIdx = argv.indexOf('--to');
const TARGET = toIdx >= 0 ? argv[toIdx + 1] : null;

const VER_RE = '\\d+\\.\\d+\\.\\d+';

/**
 * 落点规则。每条必须**恰好命中 1 次**。
 * `file` 指明改写哪个文件（'html' | 'pkg'）；`rebuild` 用捕获组保留前后缀，
 * 只替换中间的数字部分。
 */
const RULES = [
  {
    name: '<title> 标题',
    file: 'html',
    re: new RegExp('(<title>[^<]*?)(' + VER_RE + ')(</title>)'),
    rebuild: (m, v) => m[1] + v + m[3],
  },
  {
    name: 'APP_VERSION 常量',
    file: 'html',
    re: new RegExp("(const\\s+APP_VERSION\\s*=\\s*['\"])(" + VER_RE + ")(['\"])"),
    rebuild: (m, v) => m[1] + v + m[3],
  },
  {
    name: 'package.json version',
    file: 'pkg',
    // 只认顶层的 version 字段：行首两空格 + "version"（package.json 用 2 空格缩进）。
    // 不会命中 devDependencies 里依赖自己的 version —— 那些是更深缩进的键。
    re: new RegExp('(^\\s{2}"version"\\s*:\\s*")([^"]+)(")', 'm'),
    rebuild: (m, v) => m[1] + v + m[3],
  },
];

/**
 * 「尽力」落点：README.md 的「当前版本」。
 *
 * 与 RULES 分开的理由：README 是给人看的 Markdown，措辞随时可能被人改动。
 * 若把它混进 RULES 的「必须恰好命中 1 次」里，一旦有人改了这句话的写法，
 * **整个发版流程会被阻断** —— 一个文档排版问题不该拦下发布。
 * 所以这里单独处理：命中就改，未命中只提示、不失败。
 */
const README_RULE = {
  name: 'README.md 当前版本',
  re: new RegExp('(当前版本[：:]\\s*`?)(' + VER_RE + ')(`?)'),
  rebuild: (m, v) => m[1] + v + m[3],
};

function countMatches(text, re) {
  // 必须保留原 re 的 flags（尤其 package.json 规则依赖 'm' 做行首锚定），
  // 再补 'g' 以便统计全部命中。
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const g = new RegExp(re.source, flags);
  return (text.match(g) || []).length;
}

/**
 * 逐字符剥离注释（// 行注释、/* *\/ 块注释、<!-- --> HTML 注释）。
 * 与 tests/version-single-source.js 的同名函数保持同一套规则。
 */
function stripComments(line, state) {
  let out = '';
  let j = 0;
  while (j < line.length) {
    if (state.html) { if (line.startsWith('-->', j)) { state.html = false; j += 3; } else j++; continue; }
    if (state.block) { if (line.startsWith('*/', j)) { state.block = false; j += 2; } else j++; continue; }
    if (line.startsWith('//', j)) break;
    if (line.startsWith('/*', j)) { state.block = true; j += 2; continue; }
    if (line.startsWith('<!--', j)) { state.html = true; j += 4; continue; }
    out += line[j]; j++;
  }
  return out;
}

/**
 * 抹掉 HTML 标签内被引号包裹的属性值（替换为等长空格，保持列位）。
 * SVG 的 path d="..." / viewBox="..." 坐标里天然含 x.y.z 形状的数字片段，
 * 不排除会产生误报（历史上确实误报过一处微信图标的 path）。
 */
function maskTagAttributes(text) {
  let out = '';
  let inTag = false;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (c === quote) { quote = null; out += c; } else { out += ' '; }
      continue;
    }
    if (c === '<') { inTag = true; out += c; continue; }
    if (inTag && c === '>') { inTag = false; out += c; continue; }
    if (inTag && (c === '"' || c === "'")) { quote = c; out += c; continue; }
    out += c;
  }
  return out;
}

/**
 * 找出「游离的版本号字面量」——排除两处白名单落点之后仍剩下的。
 */
function findStrayVersions(html) {
  const state = { block: false, html: false };
  const lines = html.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const code = stripComments(lines[i], state);
    const masked = maskTagAttributes(code);
    if (!/\d+\.\d+\.\d+/.test(masked)) continue;
    const trimmed = code.trim();
    const isAllowed = RULES.some((r) => r.re.test(trimmed));
    if (!isAllowed) hits.push({ line: i + 1, code: trimmed });
  }
  return hits;
}

function main() {
  console.log('--- 版本号落点改写 ---');

  if (!CHECK_ONLY && !TARGET) {
    console.log('  ✗ 缺少参数：需要 --to <版本号> 或 --check');
    console.log('    用法：node tools/set-version.js --to 8.3.36 [--dry-run]');
    process.exit(1);
  }
  if (TARGET && !/^\d+\.\d+\.\d+$/.test(TARGET)) {
    console.log(`  ✗ 版本号格式不合法：${JSON.stringify(TARGET)}（应为 X.Y.Z，如 8.3.36）`);
    process.exit(1);
  }

  let fail = 0;
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const pkgRaw = fs.existsSync(PKG_PATH) ? fs.readFileSync(PKG_PATH, 'utf8') : null;
  const src = { html, pkg: pkgRaw };

  // 逐条规则统计命中数：必须恰好 1 次
  for (const rule of RULES) {
    const text = src[rule.file];
    if (text === null) {
      console.log(`  ✗ ${rule.name}：文件缺失（${rule.file === 'pkg' ? 'package.json' : 'index.html'}）`);
      fail++;
      continue;
    }
    const n = countMatches(text, rule.re);
    const ok = n === 1;
    console.log(`  ${ok ? '✓' : '✗'} ${rule.name}：命中 ${n} 处（应为 1 处）`);
    if (!ok) fail++;
  }
  if (fail) {
    console.log(`\n  ✗ 落点数量异常（${fail} 条规则不符）。`);
    console.log('     拒绝写入：可能在别处引入了新的版本号字面量，或原有落点被改动。');
    console.log('     请先排查 index.html 的 <title> / APP_VERSION 与 package.json 的 version 写法。');
    process.exit(1);
  }

  // 游离字面量检查：除白名单外，index.html 里还有没有别的「裸在代码里的版本号」。
  // 复用 tests/version-single-source.js 的同一套剥离逻辑（注释 + 标签属性），
  // 保证两处判断口径一致 —— 否则会出现「测试红但工具放行」的割裂。
  const strayHits = findStrayVersions(html);
  if (strayHits.length) {
    console.log(`\n  ✗ 发现 ${strayHits.length} 处白名单之外的版本号字面量：`);
    strayHits.slice(0, 10).forEach((h) => console.log(`      L${h.line}: ${h.code.slice(0, 100)}`));
    console.log('     拒绝写入：这些字面量会形成「第二真源」，发版时容易被漏改。');
    console.log('     请改为引用 APP_VERSION，或确认它是注释（本检查会剥离注释）。');
    process.exit(1);
  }
  console.log(`  ✓ 无游离的版本号字面量（注释与标签属性已排除）`);

  // 读出各落点当前值
  const cur = RULES.map((r) => {
    const m = src[r.file].match(r.re);
    return m ? (r.file === 'pkg' ? m[2] : m[2]) : '(未命中)';
  });
  RULES.forEach((r, i) => console.log(`  · 当前 ${r.name} = ${cur[i]}`));

  // 尽力落点：README.md 的「当前版本」。未命中只提示，不参与 fail 计数。
  const readmeRaw = fs.existsSync(README_PATH) ? fs.readFileSync(README_PATH, 'utf8') : null;
  const rm = readmeRaw ? readmeRaw.match(README_RULE.re) : null;
  const readmeCur = rm ? rm[2] : '(未命中)';
  if (readmeRaw === null) {
    console.log(`  · 当前 ${README_RULE.name} = README.md 不存在（跳过）`);
  } else if (rm) {
    console.log(`  · 当前 ${README_RULE.name} = ${readmeCur}`);
  } else {
    console.log(`  · 当前 ${README_RULE.name} = (未命中，跳过——不阻断发版)`);
  }

  if (CHECK_ONLY) {
    const vals = [...new Set(cur)];
    const same = vals.length === 1;
    console.log(`  ${same ? '✓' : '✗'} 各落点一致${same ? `（${vals[0]}）` : `（不一致：${cur.join(' / ')}）`}`);
    if (!same) fail++;
    // README 不一致只警告：它是文档，不是运行时真源
    if (rm && rm[2] !== vals[0]) {
      console.log(`  ⚠ ${README_RULE.name} 落后（${readmeCur} ≠ ${vals[0]}），建议同步`);
    }
    console.log('\n' + (fail === 0 ? '=== 一致 ===' : `=== 失败 ${fail} 项 ===`));
    process.exit(fail === 0 ? 0 : 1);
  }

  // 提前返回的前置条件必须同时考虑尽力落点：若只按 RULES 判断，
  // 会出现「三个强制落点已一致 → 整个函数返回 → README 永远不被同步」的漏洞。
  // （这不是假设，是首次实现时真踩到的：调用后 README 仍停在 8.3.33。）
  const readmeNeedsFix = readmeRaw !== null && rm !== null && rm[2] !== TARGET;
  if (!readmeNeedsFix && cur.every((v) => v === TARGET)) {
    console.log(`  · 各落点已是 ${TARGET}，无需改动`);
    console.log('\n=== 已一致 ===');
    return;
  }

  // 执行替换
  const next = { html, pkg: pkgRaw };
  for (const rule of RULES) {
    const text = next[rule.file];
    if (text === null) continue;
    const m = text.match(rule.re);
    if (!m) continue;
    const before = m[0];
    const after = rule.rebuild(m, TARGET);
    if (before !== after) {
      console.log(`  ${DRY_RUN ? '·' : '↻'} ${rule.name}`);
      console.log(`       改前：${before.replace(/\n/g, '\\n')}`);
      console.log(`       改后：${after.replace(/\n/g, '\\n')}`);
      next[rule.file] = text.replace(rule.re, after);
    }
  }

  // 尽力落点：README.md
  let nextReadme = readmeRaw;
  if (readmeRaw !== null && rm && rm[2] !== TARGET) {
    console.log(`  ${DRY_RUN ? '·' : '↻'} ${README_RULE.name}`);
    console.log(`       改前：${rm[0]}`);
    console.log(`       改后：${README_RULE.rebuild(rm, TARGET)}`);
    nextReadme = readmeRaw.replace(README_RULE.re, README_RULE.rebuild(rm, TARGET));
  }

  if (DRY_RUN) {
    console.log('\n=== 演练结束（未写入）===');
    return;
  }

  fs.writeFileSync(HTML_PATH, next.html, 'utf8');
  if (pkgRaw !== null) fs.writeFileSync(PKG_PATH, next.pkg, 'utf8');
  if (nextReadme !== null && nextReadme !== readmeRaw) fs.writeFileSync(README_PATH, nextReadme, 'utf8');

  // 回读校验
  const verify = { html: fs.readFileSync(HTML_PATH, 'utf8'), pkg: fs.readFileSync(PKG_PATH, 'utf8') };
  const vals = RULES.map((r) => {
    const m = verify[r.file].match(r.re);
    return m ? m[2] : '(未命中)';
  });
  RULES.forEach((r, i) => console.log(`  ${vals[i] === TARGET ? '✓' : '✗'} 回读 ${r.name} = ${vals[i]}`));

  // README 回读（尽力项，不计入成败）
  if (nextReadme !== null) {
    const rm2 = fs.readFileSync(README_PATH, 'utf8').match(README_RULE.re);
    if (rm2) {
      const okR = rm2[2] === TARGET;
      console.log(`  ${okR ? '✓' : '⚠'} 回读 ${README_RULE.name} = ${rm2[2]}${okR ? '' : '（未同步，不阻断）'}`);
    }
  }

  const ok = vals.every((v) => v === TARGET);
  console.log('\n' + (ok ? '=== 已写入 ' + TARGET + ' ===' : '=== 失败 1 项 ==='));
  process.exit(ok ? 0 : 1);
}

main();
