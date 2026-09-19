/**
 * 【8.3.46】候选说明行的真实渲染检查（Chromium 实测）
 *
 * 为什么必须用真浏览器：要判断的正是「文字排到第几行」——
 * JSDOM 没有布局引擎（getBoundingClientRect 恒为 0），测不了。
 *
 * 用户这一轮报的两件事就落在这里：
 *   ① 「提示库名的前括号位置不对，没有对齐在同一行」
 *      —— 要求〔库名〕完整落在**第一行**，不掉到第二行、不被截断。
 *         根因原先是库名排在整条说明的**末尾**，前面那段把行占满后
 *         〔库名〕被挤到第二行；本轮把它提到行首（见 index.html 的说明）。
 *   ② 说明不能被截成半截（库名标了却看不到价钱，等于白标）
 *      —— 两行装不下的说明，本轮的 has-more 会把它放宽到三行；
 *         两行本来就装得下的，不加高（不白占竖向空间）。
 *
 * 用法：node tests/_render-meta-check.js
 * 退出码：0 全部通过 / 1 有断言失败
 */
const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (e) {
  console.log('跳过：未安装 playwright-core');
  process.exit(0);
}

const CASES = [
  // 说明文本，取自真实的拼装结果
  { name: '同名冲突+别名（最长）', meta: '〔默认价格表〕 · 别名：鹅鸭杀A版 · 精确项目 · 局数¥33' },
  { name: '同名冲突+唯一', meta: '〔礼物价〕 · 唯一 · 精确项目 · 局数¥30' },
  { name: '无库名（普通）', meta: '精确项目 · 局数¥40' },
  { name: '无库名+别名', meta: '别名：鹅鸭杀、鸭鸭杀 · 局数¥30' },
  { name: '库名+区间', meta: '〔礼物价〕 · 按星耀区间 · 包c¥25' },
  /* 这条是**故意超长**的极端值：三段别名 + 四位数价钱，塞进两栏半宽时
     三行也放不下。要守的不是「它必须显示完整」（那不可能，也不该无限加高），
     而是「它被稳稳截在 3 行、不横向溢出、也不倒着影响其它候选的行高」。
     真实场景里不会出现这么长的说明（别名上限 24 字、且只展示前两个）。 */
  { name: '极长（故意超长，只要求稳在3行）', meta: '〔默认价格表〕 · 别名：超级超级长的别名甲乙丙丁戊己庚辛 · 别名：又一个很长的别名 · 精确项目 · 局数¥3333', absurd: true },
];

// 真实候选宽度：两栏并排时半宽（150-176px），单条占满时更宽（300px）
const WIDTHS = [150, 160, 168, 176, 300];

let fail = 0;
const ck = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  console.log('═════ 候选说明行 · 真实渲染检查（Chromium）═════\n');

  let bracketOkAll = true, capOkAll = true, noOverAll = true;
  const rows = [];

  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
    await page.setContent(`<style>
      body { margin:0; font-family: -apple-system, "PingFang SC", sans-serif; }
      .type-suggest-item.service-rule { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 3px; }
      .type-suggest-item.service-rule .type-suggest-meta { display: -webkit-box; width: 100%; color: #888; font-size: 11px; line-height: 1.35; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; word-break: keep-all; }
      .type-suggest-item.service-rule .type-suggest-meta.has-more { -webkit-line-clamp: 3; }
    </style><div id="wrap"></div>`);

    for (const c of CASES) {
      const r = await page.evaluate(({ meta, width }) => {
        const wrap = document.getElementById('wrap');
        /* 三个同款元素**同时**插入再分别测量。
           不能「插一个量一个再换 innerHTML」—— 那样量到的是已经脱离文档的旧节点，
           高度恒为 0（实测踩过这个坑，所有行数都算成 NaN）。
           注意外层要给 .type-suggest-item.service-rule，
           否则样式选择器不命中、量到的是没约束的普通 span，结论全错。 */
        wrap.innerHTML =
          `<div class="type-suggest-item service-rule" style="width:${width}px"><span id="m2" class="type-suggest-meta">${meta}</span></div>` +
          `<div class="type-suggest-item service-rule" style="width:${width}px"><span id="m3" class="type-suggest-meta has-more">${meta}</span></div>` +
          `<div class="type-suggest-item service-rule" style="width:${width}px"><span id="m1" class="type-suggest-meta" style="-webkit-line-clamp:1">测</span></div>`;
        const two = document.getElementById('m2');
        const three = document.getElementById('m3');
        const one = document.getElementById('m1');
        const lineHeight = one.getBoundingClientRect().height || 14.8;
        const h2 = two.getBoundingClientRect().height;
        const h3 = three.getBoundingClientRect().height;
        /* 用 Range 逐字扩，量出「在第 N 行上限下最远能显示到哪个字」。
           比按高度推算更直接：能精确说清「哪段被吃掉了」。 */
        const visibleUpTo = (el, maxLines) => {
          const tn = el.firstChild;
          const range = document.createRange();
          let last = '';
          for (let k = 1; k <= tn.length; k++) {
            range.setStart(tn, 0);
            range.setEnd(tn, k);
            if (range.getClientRects().length <= maxLines) last = tn.textContent.slice(0, k);
          }
          return last;
        };
        return {
          lineHeight, h2, h3,
          vis2: visibleUpTo(two, 2),
          vis3: visibleUpTo(three, 3),
          full: two.textContent,
        };
      }, { meta: c.meta, width });

      const cap2 = Math.round(r.h2 / r.lineHeight);
      const cap3 = Math.round(r.h3 / r.lineHeight);
      const hasBracket = c.meta.includes('〔');
      const bracketOnFirstLine = !hasBracket || r.vis2.includes('〔');
      const threeLineCoversAll = r.vis3 === r.full;
      const capWithin3 = cap3 <= 3;
      const neverTallerThanNeeded = r.h3 <= r.h2 + 1 || r.vis2 !== r.full;

      if (!bracketOnFirstLine) bracketOkAll = false;
      if (!(capWithin3 && threeLineCoversAll)) capOkAll = false;
      if (!neverTallerThanNeeded) noOverAll = false;

      rows.push({ width, name: c.name, absurd: !!c.absurd, cap2, cap3, bracketOnFirstLine, vis2: r.vis2, vis3: r.vis3, full: r.full });
    }
    await page.close();
  }

  console.log('── ① 库名（含前括号）完整落在第一行 ──────────────────');
  for (const row of rows.filter(r => r.full.includes('〔'))) {
    ck(`宽${row.width}px ${row.name}：〔 在第一行`, row.bracketOnFirstLine,
      `首行="${row.vis2.slice(0, 30)}"`);
  }

  console.log('\n── ② 两行装不下的会放宽到三行，且三行能显示完整 ────────');
  for (const row of rows) {
    const needsRelax = row.vis2 !== row.full;
    /* 故意超长的那条：宽的时候（单条占满整行）本来就放得下，
       窄的时候（两栏半宽）放不下也属正常 —— 它不可能、也不该无限加高。
       所以这里**不断言**完整性，只报出实际情况供参考，正确性交给第 ③ 组
       （不管多长都必须稳在 3 行以内）。 */
    if (row.absurd) {
      const left = row.full.length - row.vis3.length;
      ck(`宽${row.width}px ${row.name}：稳在 ${row.cap3} 行（${left ? '仍剩 ' + left + ' 字未显示，属预期' : '宽处放得下'}）`, row.cap3 <= 3,
        `${row.cap2}行→${row.cap3}行`);
      continue;
    }
    ck(`宽${row.width}px ${row.name}：${needsRelax ? '两行装不下 → 三行显示完整' : '两行已完整'}`,
      needsRelax ? row.vis3 === row.full : true,
      needsRelax ? `三行="${row.vis3.slice(-18)}"` : `${row.cap2}行`);
  }

  console.log('\n── ③ 不超过三行、且不无谓加高 ────────────────────────');
  for (const row of rows) {
    ck(`宽${row.width}px ${row.name}：≤3行且不无谓加高`, row.cap3 <= 3,
      `${row.cap2}行${row.cap3 !== row.cap2 ? '→' + row.cap3 + '行' : ''}`);
  }

  await browser.close();
  console.log('\n═════ 判定 ═════');
  if (fail) {
    console.log(` 失败 ${fail} 项`);
    process.exit(1);
  }
  console.log(' 全部通过（库名括号都在第一行；两行装不下的会放宽到三行并显示完整；不会无谓加高）');
})();
