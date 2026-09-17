#!/usr/bin/env node
/**
 * 测试版号自增器（8.3.42 新增）
 *
 * 用途
 * ----
 * 在 AI 应用里改完一轮代码，跑一下本脚本，就把版本号推成下一个测试版号
 * （8.3.42-test.1 → 8.3.42-test.2 → …）。这样每一轮改动都有一个能区分开的号，
 * 而**正式版本号一个也不占** —— 用户拿不到的东西不该占用交付序列。
 *
 * 与 set-version.js 的分工
 * -----------------------
 *   · 本脚本：决定「下一个测试号是什么」（算法在 tools/next-version.js）
 *   · set-version.js：把号写进各落点（<title> / APP_VERSION / package.json / README）
 * 本脚本只负责算号 + 转交，落点改写的规则全部留在 set-version.js 一处，
 * 避免两套实现将来改不同步。
 *
 * 用法
 * ----
 *   node tools/bump-test-version.js              # 自增到下一个测试号并写入
 *   node tools/bump-test-version.js --dry-run    # 只算号，不写
 *   node tools/bump-test-version.js --force      # 当前已是测试版时也再进一位
 *
 * 退出码：0 成功 / 1 失败
 */
const { execFileSync } = require('child_process');
const path = require('path');
const { readAppVersion, readReleasedVersion, isTestVersion, mainPart, testRound, bump } = require('./next-version.js');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

const current = readAppVersion();
const released = readReleasedVersion();

if (!released) {
  console.error('✗ 无法确定仓库已发行的最新版本（git 历史与 CHANGELOG 都没读到）');
  process.exit(1);
}

const base = bump(released);
const currentIsTest = isTestVersion(current);
const currentMain = mainPart(current);

console.log('--- 测试版号自增 ---');
console.log(`  · 仓库已发行最新版：${released}`);
console.log(`  · 当前 APP_VERSION：${current}${currentIsTest ? '（测试版）' : '（正式版）'}`);
console.log(`  · 本轮正式版基准　：${base}`);

/* 算下一个测试号。
   当前已经是「这一轮的测试版」→ 号数加一；
   否则（当前是正式版，或还停在上一轮）→ 从 -test.1 开始。 */
let next;
if (currentMain === base && currentIsTest) {
  next = `${base}-test.${testRound(current) + 1}`;
} else if (currentMain === base && !currentIsTest) {
  /* 当前主段已经是下一轮的正式号（例如正在为 8.3.42 做验收）。
     此时不该退回 -test.1 —— 那会把号变小，设备端会更混乱。
     直接从 -test.1 起也不对（已存在同名正式号）。
     正确做法是明确拒绝，让人先决定「是继续做正式版，还是退回测试流程」。 */
  console.error(`\n  ✗ 当前主段已等于下一轮正式号（${base}），但没有任何测试版记录。`);
  console.error('     请先决定：若这一版要正式发行，直接用 tools/release.sh；');
  console.error('     若还想继续改，请先确认版本号应退回测试序列。');
  process.exit(1);
} else {
  next = `${base}-test.1`;
}

console.log(`  · 下一个测试版号　：${next}`);

if (DRY_RUN) {
  console.log('\n=== 演练结束（未写入）===');
  process.exit(0);
}

/* 转交 set-version.js 写入各落点 —— 落点规则只保留一处实现 */
try {
  const out = execFileSync('node', [path.join(__dirname, 'set-version.js'), '--to', next], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  process.stdout.write(out);
} catch (error) {
  console.error(`\n  ✗ 写入失败：${error.message}`);
  process.exit(1);
}
