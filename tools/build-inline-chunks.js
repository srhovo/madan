#!/usr/bin/env node
/**
 * 内联 chunk 生成器 —— A4
 *
 * 背景与解决的问题
 * ----------------
 * index.html 是单文件产物（无构建链的代价与优势）。其中 dataPortability /
 * durationCalculator 两个 Feature 的实现代码被 JSON 转义后存在
 * __INLINE_CHUNKS_RAW__ 这一个超长单行字符串里，由 InlineChunkLoader 延迟加载。
 *
 * 风险：这段代码在编辑器里无法索引、无法 diff、无法 review ——
 *       它是全项目最大的维护盲区。
 *
 * 本脚本做的事
 * ------------
 * 把「源码」与「产物」分离：
 *   src/chunks/<name>.js  ← 真正的代码，可索引 / 可 diff / 可 review（人写这里）
 *   index.html 中的字符串  ← 由本脚本生成（不手改）
 *
 * 用法：
 *   node tools/build-inline-chunks.js          # 从 src/chunks 重新生成 index.html 字符串
 *   node tools/build-inline-chunks.js --check  # 只校验：src 与 index.html 是否一致（CI 用）
 *
 * 编码配方（必须与 InlineChunkLoader 的解码严格互逆）：
 *   JSON.stringify(obj, null, ' ')  →  再 replace(换行+缩进, '')
 *   最后转义反斜杠、反引号、美元加大括号
 *
 * 注意：写完 index.html 后，必须跑 tests/inline-integrity.js 与全量测试。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'index.html');
const SRC_DIR = path.join(ROOT, 'src', 'chunks');
const MARKER = 'window.__INLINE_CHUNKS_RAW__ = `';
const CHECK_ONLY = process.argv.includes('--check');

// —— 编码：源码对象 → index.html 里的单行字符串（与现有产物同配方）——
function encodeChunks(obj) {
  return JSON.stringify(obj, null, ' ')
    .replace(/\n\s*/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

// —— 解码：index.html 里的单行字符串 → 源码对象（复刻 InlineChunkLoader）——
function decodeChunks(rawInner) {
  const ctx = vm.createContext({});
  const tpl = vm.runInContext('`' + rawInner + '`', ctx);
  return JSON.parse(tpl);
}

function readHtml() {
  return fs.readFileSync(HTML_PATH, 'utf8');
}

function locateMarkerLine(lines) {
  const idx = lines.findIndex((l) => l.includes(MARKER));
  if (idx < 0) throw new Error('未找到 ' + MARKER + ' 所在行，index.html 结构可能已变更');
  return idx;
}

function extractRawInner(line) {
  const s = line.indexOf('`');
  const e = line.lastIndexOf('`');
  if (s < 0 || e <= s) throw new Error('无法定位 __INLINE_CHUNKS_RAW__ 的反引号边界');
  return line.slice(s + 1, e);
}

// —— 读取 srcdir 下所有 chunk 源文件，顺序以 index.html 现有键序为准 ——
function readSources(order) {
  const obj = {};
  for (const name of order) {
    const p = path.join(SRC_DIR, name + '.js');
    if (!fs.existsSync(p)) throw new Error('缺少源文件: ' + path.relative(ROOT, p));
    obj[name] = fs.readFileSync(p, 'utf8');
  }
  return obj;
}

function main() {
  const html = readHtml();
  const lines = html.split('\n');
  const idx = locateMarkerLine(lines);
  const rawInner = extractRawInner(lines[idx]);

  // 现有键序（不硬编码，从产物里推导，保持稳定）
  const current = decodeChunks(rawInner);
  const order = Object.keys(current);

  const sources = readSources(order);
  const regenerated = encodeChunks(sources);

  if (CHECK_ONLY) {
    let fail = 0;
    console.log('--- 内联 chunk 源文件一致性检查（' + order.length + ' 个 chunk）---');
    for (const name of order) {
      const same = sources[name] === current[name];
      console.log(`  ${same ? '✓' : '✗'} src/chunks/${name}.js 与 index.html 中的副本一致`);
      if (!same) {
        fail++;
        const a = sources[name].split('\n');
        const b = (current[name] || '').split('\n');
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] !== b[i]) {
            console.log(`      首个差异在第 ${i + 1} 行`);
            console.log(`        src : ${JSON.stringify((a[i] || '').slice(0, 100))}`);
            console.log(`        html: ${JSON.stringify((b[i] || '').slice(0, 100))}`);
            break;
          }
        }
      }
    }
    // 顺带验证：重新编码后与现存字符串逐字节相同（配方未漂移）
    const recipeOk = regenerated === rawInner;
    console.log(`  ${recipeOk ? '✓' : '✗'} 编码配方未漂移（重新编码结果与现存字符串逐字节一致）`);
    if (!recipeOk) fail++;
    console.log('\n' + (fail === 0 ? '=== 一致 ===' : `=== 不一致 ${fail} 项，请运行 node tools/build-inline-chunks.js 重新生成 ===`));
    process.exit(fail === 0 ? 0 : 1);
  }

  if (regenerated === rawInner) {
    console.log('无需改动：src/chunks 与 index.html 已逐字节一致。');
    return;
  }

  const newLine = lines[idx].slice(0, lines[idx].indexOf('`')) + '`' + regenerated + '`' + lines[idx].slice(lines[idx].lastIndexOf('`') + 1);
  lines[idx] = newLine;
  fs.writeFileSync(HTML_PATH, lines.join('\n'), 'utf8');
  console.log(`已重新生成 ${Object.keys(sources).length} 个内联 chunk（原 ${rawInner.length} 字符 → 新 ${regenerated.length} 字符）`);
  console.log('请接着运行：node tests/inline-integrity.js && bash tests/run-all.sh');
}

main();
