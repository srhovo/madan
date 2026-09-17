#!/usr/bin/env node
/**
 * 推送前版本号正则化器（8.3.42 新增）
 *
 * 解决什么问题
 * ------------
 * 在 AI 应用里改动的中间版本号长这样：8.3.42-test.1、8.3.42-test.2 …
 * 这些号只该留在本地。一旦要推送（＝正式发行），版本号必须变成
 * 仓库已发行版顺位加一的正式号：8.3.41 → 8.3.42。
 *
 * 本脚本就是那道关口：把 -test.N 去掉，落成正式号，并把 version.json
 * 的包地址一起改对。跑完就可以提交推送了。
 *
 * 为什么不做成 git hook
 * --------------------
 * hook 是「隐式行为」——推送到远端的那一刻版本号被悄悄改掉，而那个改动
 * 不在任何一次提交里，事后没人查得出「到底发布的是哪个号」。做成显式命令，
 * 让人自己决定什么时候发行、看得见改了什么，版本历史才可读。
 *
 * 用法
 * ----
 *   node tools/pre-push-version.js              # 正则化并写入
 *   node tools/pre-push-version.js --dry-run    # 只报告会怎么改
 *   node tools/pre-push-version.js --check      # 只检查当前是不是可发行的干净正式号
 *
 * 退出码：0 成功 / 1 失败
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readAppVersion, readReleasedVersion, isTestVersion, mainPart, bump } = require('./next-version.js');

const ROOT = path.join(__dirname, '..');
const VJ = path.join(ROOT, 'version.json');
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const CHECK_ONLY = argv.includes('--check');

const current = readAppVersion();
const released = readReleasedVersion();

if (!released) {
  console.error('✗ 无法确定仓库已发行的最新版本（git 历史与 CHANGELOG 都没读到）');
  process.exit(1);
}

const expected = bump(released);
const currentIsTest = isTestVersion(current);
const currentMain = mainPart(current);

console.log('--- 推送前版本号正则化 ---');
console.log(`  · 仓库已发行最新版：${released}`);
console.log(`  · 当前 APP_VERSION：${current}${currentIsTest ? '（测试版）' : '（正式版）'}`);
console.log(`  · 应发行的正式号　：${expected}`);

if (CHECK_ONLY) {
  if (currentIsTest) {
    console.log(`\n  ✗ 仍是测试版（${current}）。发行前请先跑 node tools/pre-push-version.js`);
    process.exit(1);
  }
  if (currentMain !== expected) {
    console.log(`\n  ✗ 版本号与「已发行版顺位」不符：当前 ${currentMain}，应为 ${expected}`);
    console.log('     若这一版确实要发，请用 tools/release.sh；若只是继续改，请退回测试序列。');
    process.exit(1);
  }
  console.log('\n  ✓ 已是可发行的正式号');
  process.exit(0);
}

/* 已经就是正式号且顺位正确 —— 没什么可做的（但仍要把 version.json 对齐） */
if (!currentIsTest && currentMain === expected) {
  console.log('  · 当前已是正确的正式号，无需改号');
} else if (!currentIsTest && currentMain !== expected) {
  console.error(`\n  ✗ 当前是正式号 ${currentMain}，但与「已发行版顺位」不符（应为 ${expected}）。`);
  console.error('     拒绝自动改号：正式号一旦写出过就不该被静默改写。');
  console.error('     请人工确认这一版该用哪个号。');
  process.exit(1);
} else {
  // 当前是测试版 → 落成正式号
  if (DRY_RUN) {
    console.log(`\n  · 演练：${current} → ${expected}`);
  } else {
    try {
      const out = execFileSync('node', [path.join(__dirname, 'set-version.js'), '--to', expected], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      process.stdout.write(out);
    } catch (error) {
      console.error(`\n  ✗ 写入失败：${error.message}`);
      process.exit(1);
    }
  }
}

/* version.json 的 url 必须跟着版本号走，否则设备端会去下载一个不存在的包 */
try {
  const raw = fs.readFileSync(VJ, 'utf8');
  const json = JSON.parse(raw);
  const wantUrl = `https://madan.pages.dev/madan-${expected}.zip`;
  if (json.url !== wantUrl) {
    console.log(`  ${DRY_RUN ? '·' : '↻'} version.json url`);
    console.log(`       改前：${json.url}`);
    console.log(`       改后：${wantUrl}`);
    if (!DRY_RUN) {
      json.url = wantUrl;
      fs.writeFileSync(VJ, JSON.stringify(json, null, 2) + '\n', 'utf8');
    }
  } else {
    console.log('  · version.json url 已是目标地址');
  }
} catch (error) {
  console.error(`  ⚠ 未能改写 version.json：${error.message}`);
}

console.log('\n' + (DRY_RUN
  ? '=== 演练结束（未写入）==='
  : `=== 可以推送了（版本号 ${expected}）===`));
console.log('  提醒：version.json 的 checksum 与 notes 由 tools/release.sh 负责写入，');
console.log('        若本步改过 url，请照常走一次 release.sh 生成新包。');
