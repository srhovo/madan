#!/usr/bin/env node
/**
 * 版本号顺位器（8.3.42 新增）
 *
 * 背景
 * ----
 * 这个项目在 AI 应用（如 workbuddy）里被反复修改，每改一轮都会跑一次发版脚本。
 * 如果每轮都直接占一个正式版本号（8.3.42、8.3.43……），那么「看起来发布了」的
 * 版本里混着一堆其实从没推送到仓库、用户永远拿不到的号 —— 版本历史会变得
 * 无法解读：不知道哪个号是真正交付过的，哪个只是本地实验。
 *
 * 约定（本文件是这套约定的唯一实现）
 * --------------------------------
 *   · 仓库里最后一次「release: x.y.z」提交记录的号 = 已正式发行的最新版
 *   · 没走到「提交 + 推送」这一步的版本 = 测试版，号带 -test.N 后缀
 *   · 正式发行时，版本号自动取「仓库已发行版 + 1」
 *
 * 为什么用「release:」提交当基准，而不是看 git 有没有推送
 * -------------------------------------------------------
 * 推送是网络行为，脚本判断不了（也判断不准：本地可能没有远端凭据）。
 * 但每次正式发行都必然留下一条 release 提交，且那条提交里记着号 ——
 * 这是**可离线判定**、且与「用户到底拿到了哪一版」等价的信息。
 * 「已推送」的语义因此由「存在这条 release 提交」来承载。
 *
 * 用法
 * ----
 *   node tools/next-version.js                 # 算出下一个正式版本号（如 8.3.42）
 *   node tools/next-version.js --current       # 打印仓库已发行的最新版本（如 8.3.41）
 *   node tools/next-version.js --is-test       # 当前 APP_VERSION 是不是测试版（退出码 0/1）
 *   node tools/next-version.js --next-test     # 下一个测试版本号（如 8.3.42-test.1）
 *
 * 退出码：0 成功 / 1 失败
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');

/** 三段式版本号，可带 -test.N 后缀 */
const VER_RE = String.raw`\d+\.\d+\.\d+(?:-test\.\d+)?`;
/** 取「主段」：8.3.42-test.3 → 8.3.42 */
function mainPart(version) {
  return String(version || '').split('-')[0];
}
/** 是不是测试版 */
function isTestVersion(version) {
  return /-test\.\d+$/.test(String(version || ''));
}
/** 测试版的第几轮 */
function testRound(version) {
  const m = String(version || '').match(/-test\.(\d+)$/);
  return m ? Number(m[1]) : 0;
}

/** 逐段数值比较，避免字符串比较把 8.3.10 判成小于 8.3.9 */
function compareMain(a, b) {
  const pa = mainPart(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = mainPart(b).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/** 正式版本号往上顺一位（只动第三段）：8.3.41 → 8.3.42 */
function bump(version) {
  const [major, minor, patch] = mainPart(version).split('.').map(n => parseInt(n, 10) || 0);
  return `${major}.${minor}.${patch + 1}`;
}

/** 读当前代码里的 APP_VERSION（唯一真源） */
function readAppVersion() {
  const src = fs.readFileSync(HTML, 'utf8');
  const m = src.match(new RegExp(String.raw`const\s+APP_VERSION\s*=\s*['"](${VER_RE})['"]`));
  return m ? m[1] : '';
}

/**
 * 仓库里已正式发行的最新版本。
 *
 * 判据：git 提交历史里最后一条形如「release: x.y.z ...」的提交。
 * 优先用 git log（能覆盖全部历史）；仓库被裁剪/不在 git 环境时，
 * 退一步读 CHANGELOG.md 最上面那条版本条目 —— 两者都读不到才算失败。
 */
function readReleasedVersion() {
  try {
    const out = execFileSync(
      'git',
      ['log', '--format=%s', '-n', '400'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const versions = [];
    out.split('\n').forEach(line => {
      const m = String(line).match(new RegExp(String.raw`^release:\s*(${VER_RE})`));
      if (m) versions.push(m[1]);
    });
    if (versions.length) {
      // 取主段最大的那个（提交顺序理论上就是版本顺序，但防一手乱序）
      return versions.reduce((best, v) => (compareMain(v, best) > 0 ? v : best), versions[0]);
    }
  } catch (error) { /* 非 git 环境，走下面的兜底 */ }

  // 兜底：CHANGELOG.md 第一条「## x.y.z」
  try {
    const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    const m = cl.match(new RegExp(String.raw`^##\s+(${VER_RE})`, 'm'));
    if (m) return m[1];
  } catch (error) { /* 也没有就只能失败 */ }
  return '';
}

function main() {
  const argv = process.argv.slice(2);
  const current = readAppVersion();
  const released = readReleasedVersion();

  if (argv.includes('--current')) {
    if (!released) { console.error('无法确定仓库已发行的最新版本'); process.exit(1); }
    process.stdout.write(released);
    return;
  }
  if (argv.includes('--is-test')) {
    process.exit(isTestVersion(current) ? 0 : 1);
  }
  if (argv.includes('--next-test')) {
    if (!released) { console.error('无法确定仓库已发行的最新版本'); process.exit(1); }
    const base = bump(released);
    // 当前已经是这一轮的测试版就再进一位，否则从 -test.1 开始
    const round = mainPart(current) === base && isTestVersion(current) ? testRound(current) + 1 : 1;
    process.stdout.write(`${base}-test.${round}`);
    return;
  }

  // 默认：下一个正式版本号
  if (!released) {
    console.error('无法确定仓库已发行的最新版本（git 历史与 CHANGELOG 都没读到）');
    process.exit(1);
  }
  process.stdout.write(bump(released));
}

if (require.main === module) main();

module.exports = { mainPart, isTestVersion, testRound, compareMain, bump, readAppVersion, readReleasedVersion };
