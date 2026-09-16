#!/usr/bin/env node
/**
 * 版本号单一真源检查（B2）
 *
 * 背景
 * ----
 * 发版时需要改的版本号**只应有两处**：<title> 和 APP_VERSION。
 * 其余 8.3.x 字样全部是注释（历史 Release note / CSS 注释 / HTML 注释），
 * 属于有价值的变更考古，应当保留。
 *
 * 风险在于：将来有人写了一处「参与运行时判断的硬编码版本号」，
 * 比如 compareVersions('8.3.20', ...) 或 if (APP_VERSION < '8.3.20')，
 * 这会形成一个静默的第二真源 —— 发版时忘了改它，功能就会悄悄走错分支。
 *
 * 本检查剥离所有注释（// 、/* *\/ 、<!-- -->）后统计版本号字面量，
 * 只允许出现在白名单的 2 个位置（index.html 内）。
 * 另校验 package.json 的 version —— 它不参与运行时，但必须跟着产品版本走，
 * 否则日后看依赖清单会误判项目停在哪一版。
 *
 * 另有两类**结构性排除**，它们物理上不可能是「版本号」：
 *   1. 标签属性值内部（如 svg 的 viewBox / path 的 d="... a.326.326 0 0 0 ..."）
 *      —— 坐标数字里天然会出现 x.y.z 形状的片段。
 *   2. 更一般的：被引号包裹的 HTML 属性内部。
 * 排除后只统计「裸在代码里」的版本号字面量。
 *
 * 用法：node tests/version-single-source.js [--allow-no-git | --release-flow]
 *   --allow-no-git  在校验不含 .git 的裸发布目录时显式声明跳过 git 跟踪检查。
 *                   默认（不加）时，非 git 环境同样判失败 —— 防线不许静默跳空。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');
const PKG = path.join(ROOT, 'package.json');
const src = fs.readFileSync(HTML, 'utf8');
const lines = src.split('\n');

// 允许出现「参与代码的版本号」的位置（按行号动态匹配内容，不写死行号）
const ALLOWED = [
  { name: '<title> 标题', test: (l) => /<title>[^<]*\d+\.\d+\.\d+<\/title>/.test(l) },
  { name: 'APP_VERSION 常量', test: (l) => /const\s+APP_VERSION\s*=\s*['"]\d+\.\d+\.\d+['"]/.test(l) },
];

// 逐字符剥离注释（// 行注释、/* */ 块注释、<!-- --> HTML 注释）
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

const state = { block: false, html: false };

/**
 * 把引号包裹的 HTML 属性值整体抹掉（替换为等长占位，保持列位不偏移）。
 * 只处理 HTML 标签内的属性；遇到 `<` 进入标签态，`>` 退出。
 * 目的：SVG 的 path d="..." / viewBox="..." 等坐标数据里天然含 x.y.z 片段。
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

const hits = [];
for (let i = 0; i < lines.length; i++) {
  const code = stripComments(lines[i], state);
  // 先抹掉标签属性值（含跨行引号由上层 state 无关，逐行处理足够：本项目属性均单行闭合）
  const masked = maskTagAttributes(code);
  if (/\d+\.\d+\.\d+/.test(masked)) {
    const allowed = ALLOWED.some((a) => a.test(code.trim()));
    hits.push({ line: i + 1, code: code.trim(), allowed });
  }
}

let fail = 0;
console.log('--- 版本号单一真源检查 ---');
const bad = hits.filter((h) => !h.allowed);
console.log(`  参与代码的版本号出现位置：${hits.length} 处（应为 ${ALLOWED.length} 处）`);

for (const a of ALLOWED) {
  const found = hits.some((h) => a.test(h.code));
  console.log(`  ${found ? '✓' : '✗'} ${a.name} 存在`);
  if (!found) fail++;
}

if (bad.length) {
  fail += bad.length;
  console.log(`\n  ✗ 发现 ${bad.length} 处未在白名单中的版本号字面量：`);
  bad.forEach((h) => console.log(`      L${h.line}: ${h.code.slice(0, 110)}`));
  console.log('      → 若它确实参与运行时判断，请改为引用 APP_VERSION（避免形成第二真源）；');
  console.log('        若只是注释，请确认它被正确注释掉（本检查会剥离注释）。');
} else {
  console.log('  ✓ 无游离的版本号字面量');
}

// 顺带校验 <title> 与 APP_VERSION 两者一致
const titleV = (src.match(/<title>[^<]*?(\d+\.\d+\.\d+)<\/title>/) || [])[1];
const constV = (src.match(/const\s+APP_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/) || [])[1];
const same = titleV && constV && titleV === constV;
console.log(`  ${same ? '✓' : '✗'} <title>(${titleV}) 与 APP_VERSION(${constV}) 一致`);
if (!same) fail++;

// package.json 的 version 必须跟着产品版本走。
// 它不参与运行时判断（只给 npm 工具链看），但漂移了会让人误判项目版本。
if (fs.existsSync(PKG)) {
  let pkgV = null;
  try {
    pkgV = JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
  } catch (e) {
    console.log(`  ✗ package.json 解析失败：${e.message}`);
    fail++;
  }
  if (pkgV !== null) {
    const okP = pkgV === constV;
    console.log(`  ${okP ? '✓' : '✗'} package.json(${pkgV}) 与 APP_VERSION(${constV}) 一致`);
    if (!okP) fail++;
  }
}

// 顺带校验 version.json 与 APP_VERSION 一致（发布物与代码对齐）
const vjPath = path.join(ROOT, 'version.json');
if (fs.existsSync(vjPath)) {
  const vj = JSON.parse(fs.readFileSync(vjPath, 'utf8'));
  const ok = vj.version === constV;
  console.log(`  ${ok ? '✓' : '✗'} version.json(${vj.version}) 与 APP_VERSION(${constV}) 一致`);
  if (!ok) fail++;
  // checksum 与实际 zip 是否一致
  const zip = path.join(ROOT, `madan-${vj.version}.zip`);
  if (fs.existsSync(zip)) {
    const crypto = require('crypto');
    const h = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    const ok2 = h === vj.checksum;
    console.log(`  ${ok2 ? '✓' : '✗'} version.json.checksum 与 madan-${vj.version}.zip 实际 sha256 一致`);
    if (!ok2) console.log(`      记录的: ${vj.checksum}\n      实际的: ${h}`);
    if (!ok2) fail++;

    // zip 是否已被 git 跟踪。
    // 背景：madan-<版本>.zip 必须提交到仓库 —— Cloudflare Pages 从仓库根目录直出，
    // version.json.url 指向它，漏提交会让已安装设备的 OTA 下载 404。
    // 本检查只能证明「本地文件存在且哈希对」，无法证明「它会进仓库」，
    // 所以额外查一次 git 跟踪状态，把「忘了 git add zip」挡在推送前。
    //
    // 两个豁免参数，语义不同，别混用：
    //   --allow-no-git    校验对象本身就不是 git 工作目录（如解压出来的裸发布目录）
    //   --release-flow    处于发版流程中：zip 是刚打出来的，尚未 git add 属
    //                     预期的中间态（收尾会强制提示 git add，CI 兜底拦截）
    // 默认（都不给）时一律判失败 —— 静默跳过的防线等于没有防线，
    // 8.3.24 事故正是「检查看着跑了，其实什么都没查」的形状。
    const { execFileSync } = require('child_process');
    const allowNoGit = process.argv.includes('--allow-no-git');
    const releaseFlow = process.argv.includes('--release-flow');
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', `madan-${vj.version}.zip`], {
        cwd: ROOT, stdio: 'pipe',
      });
      console.log(`  ✓ madan-${vj.version}.zip 已被 git 跟踪（上传后 OTA 才不会 404）`);
    } catch (e) {
      // 区分「不是 git 仓库」与「文件未被跟踪」
      let inRepo = true;
      try {
        execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, stdio: 'pipe' });
      } catch (e2) {
        inRepo = false;
      }
      if (!inRepo) {
        if (allowNoGit) {
          console.log('  · 非 git 工作目录，已按 --allow-no-git 跳过「zip 是否被跟踪」检查');
        } else {
          console.log('  ✗ 非 git 工作目录，无法验证 zip 是否会被提交 —— 该检查不可跳空');
          console.log('     若确实在校验一个不含 .git 的裸发布目录，请显式加 --allow-no-git。');
          fail++;
        }
      } else if (releaseFlow) {
        console.log('  · 发版流程中：zip 刚生成、尚未 git add，属预期中间态');
        console.log('     （收尾会提示 git add；CI 不带 --release-flow，会在此强制拦截）');
      } else {
        console.log(`  ✗ madan-${vj.version}.zip 没有被 git 跟踪 —— 提交后 OTA 会 404`);
        console.log('     修复：git add madan-' + vj.version + '.zip');
        fail++;
      }
    }
  } else {
    console.log(`  · madan-${vj.version}.zip 不存在（仅改代码未打包时属正常，跳过 checksum 校验）`);
    console.log('    注意：发版场景请改用 bash tests/run-all.sh --require-package，让此处判为失败。');
  }
}

console.log('\n' + (fail === 0 ? '=== 版本号单一真源成立 ===' : `=== 失败 ${fail} 项 ===`));
process.exit(fail === 0 ? 0 : 1);
