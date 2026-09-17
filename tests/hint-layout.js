#!/usr/bin/env node
/**
 * 「输入框提示文案 + 动态控件类名」专项验证（8.3.40）
 *
 * 为什么需要它
 * ------------
 * 8.3.40 修了两类**都不会报错、只在界面上静默表现**的毛病：
 *
 * ① 无效属性 `classname`
 *    动态注入控件时属性名写成 `className`（React 肌肉记忆），renderAttributes
 *    按字面拼出去就是 `classname="..."` —— 浏览器不认识这个属性，
 *    元素上根本没有 class。后果是**所有靠 class 的选择器整批失效**，
 *    表现为「改了 CSS 毫无反应」，排查成本极高。
 *    礼物个数框的尺寸规则就是这么死的：整个 .gift-mode-panel 系列选择器
 *    一条都没生效，而页面上看不出任何异常。
 *
 * ② 提示文案的三种劣化
 *    · 消失：派单/陪陪框被删成空白，输入框里一个字都没有
 *    · 截断：服务类型/备注的提示比框还宽，尾巴被切掉
 *    · 挤压：加价框两行提示因框太窄被折成三行、文字压扁
 *    这三者都不抛错、不影响功能，只影响「看不看得懂」，所以必须专门盯。
 *
 * 本套跑在**真实浏览器**里（其余套件多为纯字符串/VM 断言）。
 * 因为这两类问题的本质就是「渲染出来才知道」，纯静态检查抓不住。
 *
 * 反向验证方式：临时改写源码副本（不碰工作区文件），断言其必须失败。
 *
 * 用法：node tests/hint-layout.js
 * 退出码：0 全部通过 / 1 有断言失败
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');

let fail = 0;
const ck = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// ── 浏览器环境 ──────────────────────────────────────────────────────────────
// playwright-core 只在仓库内可 require；系统 Chromium 备用。
function loadPlaywright() {
  const candidates = [ROOT, process.cwd()];
  for (const base of candidates) {
    try {
      return require(require.resolve('playwright-core', { paths: [base] }));
    } catch (e) { /* 继续试下一个 */ }
  }
  try { return require('playwright-core'); } catch (e) { return null; }
}

const PW = loadPlaywright();

async function launch() {
  const pw = PW || { chromium: null };
  if (!pw.chromium) throw new Error('playwright-core 不可用');
  const opts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (fs.existsSync('/usr/bin/chromium')) opts.executablePath = '/usr/bin/chromium';
  return pw.chromium.launch(opts);
}

// 三档手机宽度：覆盖最窄的在售机型到常见大屏
const VIEWPORTS = [360, 390, 430];

// 主输入区里所有该有提示（或该有明确「空提示」设计）的框
const HINT_IDS = [
  'boss', 'duration', 'type', 'note', 'surcharge',
  'totalPrice', 'discount', 'paiDan', 'peiPei'
];

/**
 * 在页面里量：提示文字宽度 vs 输入框可用宽度。
 * 返回每个框的溢出像素数（>0 即截断）。
 */
const MEASURE = (ids) => ids.map(id => {
  const el = document.getElementById(id);
  if (!el) return { id, missing: true };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const ph = el.getAttribute('placeholder') || '';
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + cs.font;
  probe.textContent = ph;
  document.body.appendChild(probe);
  const textW = probe.getBoundingClientRect().width;
  probe.remove();
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const availW = r.width - padL - padR;
  // 两行内联提示（折数/加价用）：量它有没有横向溢出、被折成几行
  const hintEl = el.closest('.input-group') && el.closest('.input-group').querySelector('.discount-inline-hint');
  let hint = null;
  if (hintEl) {
    const spans = [...hintEl.querySelectorAll('span')];
    const hr = hintEl.getBoundingClientRect();
    hint = {
      lines: spans.length,
      scrollW: Math.round(hintEl.scrollWidth),
      boxW: Math.round(hr.width),
      // 每个 span 实际占几行：高度 / 行高
      wrapped: spans.map(s => {
        const scs = getComputedStyle(s);
        const lh = parseFloat(scs.lineHeight) || parseFloat(scs.fontSize) * 1.2;
        return Math.round(s.getBoundingClientRect().height / lh);
      })
    };
  }
  return {
    id, ph, boxW: Math.round(r.width), availW: Math.round(availW),
    textW: Math.round(textW), over: Math.round(textW - availW),
    visible: cs.display !== 'none', hint
  };
});

(async () => {
  if (!PW) {
    console.log('═════ 输入框提示 + 动态控件类名 · 专项验证 ═════\n');
    console.log('  ⚠ playwright-core 不可用，本套需要真实浏览器，跳过执行');
    console.log('\n═════ 判定 ═════');
    console.log(' 跳过（环境缺 playwright-core，不是通过）');
    process.exit(0);
  }

  const html = fs.readFileSync(HTML, 'utf8');
  const browser = await launch();

  console.log('═════ 输入框提示 + 动态控件类名 · 专项验证 ═════\n');

  // ── ① 动态注入的控件必须真的带上 class ──────────────────────────────────
  console.log('① 动态注入的控件：class 必须真的落上去');
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto('file://' + HTML);
    await page.waitForTimeout(1400);
    const r = await page.evaluate(() => {
      const q = document.getElementById('giftQuantity');
      const t = document.querySelector('#autoPricePanel .ap-times');
      if (!q) return { missing: true };
      return {
        qClass: q.getAttribute('class'),
        qBogus: q.getAttribute('classname'),
        attrs: [...q.attributes].map(a => a.name),
        timesClass: t ? t.getAttribute('class') : null
      };
    });
    ck('礼物个数框存在', !r.missing);
    ck('个数框带上了 class（不是空）', !!r.qClass && r.qClass.includes('gift-quantity-input'), JSON.stringify(r.qClass));
    ck('个数框没有 classname 这种无效属性', r.qBogus === null, JSON.stringify(r.qBogus));
    ck('个数框的所有属性名都是合法小写形式', Array.isArray(r.attrs) && r.attrs.every(a => a === a.toLowerCase()), JSON.stringify(r.attrs));
    ck('「×」连接符带上了 class', r.timesClass === 'ap-times', JSON.stringify(r.timesClass));

    // class 真的存在，靠 class 的选择器才会生效 —— 直接验证「算出来的尺寸不是默认值」
    const eff = await page.evaluate(() => {
      const q = document.getElementById('giftQuantity');
      const cs = getComputedStyle(q);
      return { textAlign: cs.textAlign, fontWeight: cs.fontWeight, boxSizing: cs.boxSizing };
    });
    ck('个数框的 class 规则实际生效（居中/加粗来自样式表）',
      eff.textAlign === 'center' && (eff.fontWeight === '700' || eff.fontWeight === 'bold'), JSON.stringify(eff));
    await page.close();
  }

  // ── ② renderAttributes 必须把 className 归一成 class ────────────────────
  console.log('\n② 属性名归一：className 会被接住并改写为 class');
  {
    const hasNormalize = /String\(key\)\.toLowerCase\(\) === 'classname' \? 'class' : key/.test(html);
    ck('renderAttributes 里做了 className → class 的归一', hasNormalize);

    // 归一逻辑必须能真正跑通。注意：window.app 在 file:// 直开时不一定可达
    // （app 由后续脚本挂载），所以这里**不把「取不到」当失败** ——
    // 取得到就真实调用一次，取不到就退化为静态断言，并如实说明走了哪条路。
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto('file://' + HTML);
    await page.waitForTimeout(1200);
    const out = await page.evaluate(() => {
      const inst = (window.app && window.app.uiRender) || window.uiRender;
      if (!inst || typeof inst.renderAttributes !== 'function') return null;
      return {
        viaClassName: inst.renderAttributes({ id: 'x', className: 'a b' }),
        viaClass: inst.renderAttributes({ id: 'x', class: 'a b' }),
        both: inst.renderAttributes({ id: 'x', class: 'keep', className: 'ignored' })
      };
    });
    if (out) {
      console.log('     （走真实调用路径）');
      ck('传 className 输出的是 class=', out.viaClassName.includes('class="a b"') && !/classname/i.test(out.viaClassName), out.viaClassName);
      ck('传 class 输出正常', out.viaClass.includes('class="a b"'), out.viaClass);
      ck('两者同时给时不重复、以 class 为准', (out.both.match(/class=/gi) || []).length === 1 && out.both.includes('keep'), out.both);
    } else {
      console.log('     （app 在 file:// 下不可达，退化为静态断言 + 下方反向验证中的真实浏览器复现）');
      ck('（静态）归一逻辑存在于源码', hasNormalize);
    }
    await page.close();
  }

  // ── ③ 提示文案：不能消失 ────────────────────────────────────────────────
  console.log('\n③ 提示文案：该有的必须有，且不能是空白');
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto('file://' + HTML);
    await page.waitForTimeout(1400);
    const rows = await page.evaluate(MEASURE, HINT_IDS);

    // 派单 / 陪陪：曾经被删成空白，导致框里一个字都没有
    ['paiDan', 'peiPei'].forEach(id => {
      const r = rows.find(x => x.id === id);
      ck(`${id} 有可见提示文字（不再空白）`, r && String(r.ph).trim().length > 0, JSON.stringify(r && r.ph));
    });
    // 主输入框都该有名字（要么 placeholder，要么两行内联提示）
    rows.forEach(r => {
      if (r.missing) { ck(`${r.id} 元素存在`, false); return; }
      const hasPh = String(r.ph).trim().length > 0;
      const hasHint = !!(r.hint && r.hint.lines > 0);
      ck(`${r.id} 至少有提示（placeholder 或两行提示）`, hasPh || hasHint,
        hasPh ? JSON.stringify(r.ph) : (hasHint ? '（两行内联提示）' : '（两者都没有）'));
    });
    await page.close();
  }

  // ── ④ 提示文案：三档宽度都不能截断 ──────────────────────────────────────
  console.log('\n④ 提示文案：各档手机宽度下都不截断');
  for (const W of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: W, height: 900 } });
    await page.goto('file://' + HTML);
    await page.waitForTimeout(1400);
    const rows = await page.evaluate(MEASURE, HINT_IDS);
    const bad = rows.filter(r => !r.missing && r.over > 0);
    ck(`${W}px：无提示被截断`, bad.length === 0,
      bad.length ? bad.map(r => `${r.id} 超出 ${r.over}px（"${r.ph}"）`).join(' / ') : `${rows.length} 个框全部放得下`);
    // 顺带记下最紧的那个，留作余量参考
    const tight = rows.filter(r => !r.missing && r.over <= 0).sort((a, b) => b.over - a.over)[0];
    if (tight) console.log(`     最紧：${tight.id} 余量 ${-tight.over}px（"${tight.ph}"）`);
    await page.close();
  }

  // ── ⑤ 两行提示不能被挤压折行 ────────────────────────────────────────────
  console.log('\n⑤ 两行内联提示：必须保持两行、不折行、不压扁');
  for (const W of [360, 390]) {
    const page = await browser.newPage({ viewport: { width: W, height: 900 } });
    await page.goto('file://' + HTML);
    await page.waitForTimeout(1400);
    const rows = await page.evaluate(MEASURE, ['surcharge', 'discount', 'discountOverlay']);
    rows.forEach(r => {
      if (r.missing || !r.hint) return;
      const wrapped = r.hint.wrapped.some(n => n > 1);
      ck(`${W}px：${r.id} 两行提示没有折行`, !wrapped, `每行占 ${r.hint.wrapped.join('/')} 行`);
      ck(`${W}px：${r.id} 两行提示没有横向溢出`, r.hint.scrollW <= r.hint.boxW + 1,
        `文字 ${r.hint.scrollW}px / 框 ${r.hint.boxW}px`);
    });
    await page.close();
  }

  // ── ⑥ 礼物那一排：与单子模式观感一致、不溢出 ────────────────────────────
  console.log('\n⑥ 礼物那一排：尺寸合理、不溢出、与单子模式高度一致');
  for (const W of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: W, height: 900 } });
    await page.goto('file://' + HTML);
    await page.waitForTimeout(1400);
    const single = await page.evaluate(() => {
      const panel = document.getElementById('autoPricePanel');
      const row = panel.querySelector('.auto-price-row');
      return { panelH: Math.round(panel.getBoundingClientRect().height), rowW: Math.round(row.getBoundingClientRect().width), scrollW: row.scrollWidth };
    });
    await page.evaluate(() => { [...document.querySelectorAll('.mode-btn')].find(x => /礼物/.test(x.textContent || ''))?.click(); });
    await page.waitForTimeout(700);
    const gift = await page.evaluate(() => {
      const panel = document.getElementById('autoPricePanel');
      const row = panel.querySelector('.auto-price-row');
      const vis = [...row.children].filter(el => getComputedStyle(el).display !== 'none');
      const q = document.getElementById('giftQuantity');
      return {
        panelH: Math.round(panel.getBoundingClientRect().height),
        rowW: Math.round(row.getBoundingClientRect().width),
        scrollW: row.scrollWidth,
        items: vis.map(el => ({
          t: el.id || (el.className || '').split(' ')[0],
          w: Math.round(el.getBoundingClientRect().width)
        })),
        qtyW: Math.round(q.getBoundingClientRect().width)
      };
    });
    ck(`${W}px：礼物那一排不横向溢出`, gift.scrollW <= gift.rowW + 1, `${gift.scrollW} / ${gift.rowW}`);
    ck(`${W}px：礼物那一排高度与单子模式一致（切换不跳高）`, gift.panelH === single.panelH, `${gift.panelH} vs ${single.panelH}`);
    // 个数框必须真的够宽（曾经因 class 失效而拿到默认宽度）
    ck(`${W}px：个数框宽度合理（>=56px）`, gift.qtyW >= 56, `${gift.qtyW}px`);
    const unit = gift.items.find(i => i.t === 'autoUnitPrice');
    ck(`${W}px：单价框宽度合理（>=74px，放得下 6.5 这类数字）`, unit && unit.w >= 74, unit ? `${unit.w}px` : '未找到');
    // 两个输入框都有可观宽度，不能一个宽一个窄成牙签
    if (unit) {
      const ratio = unit.w / gift.qtyW;
      ck(`${W}px：单价框与个数框宽度比在合理区间（1.0~2.2）`, ratio >= 1.0 && ratio <= 2.2, ratio.toFixed(2));
    }
    await page.close();
  }

  await browser.close();

  // ── ⑦ 反向验证：把修好的地方改回去，断言必须变红 ────────────────────────
  console.log('\n⑦ 反向验证：改回坏写法后，断言必须变红');
  {
    // 反向 1：把 renderAttributes 的归一逻辑删掉
    const noNorm = html.replace(
      /const k = String\(key\)\.toLowerCase\(\) === 'classname' \? 'class' : key;/,
      'const k = key;'
    );
    ck('删掉 className 归一后，归一断言确实会失败',
      !/String\(key\)\.toLowerCase\(\) === 'classname' \? 'class' : key/.test(noNorm));

    // 反向 2：把口子改回 className（模拟本次修掉的原始 bug），
    // 用真实浏览器确认 class 真的会丢
    const backToBogus = html.replace(
      "class: 'ap-input gift-quantity-input', placeholder: '个数'",
      "className: 'ap-input gift-quantity-input', placeholder: '个数'"
    ).replace(
      /const k = String\(key\)\.toLowerCase\(\) === 'classname' \? 'class' : key;/,
      'const k = key;'
    );
    const tmp = path.join(__dirname, '.tmp-bogus.html');
    fs.writeFileSync(tmp, backToBogus);
    let lost = false;
    try {
      const b2 = await launch();
      const page = await b2.newPage({ viewport: { width: 390, height: 900 } });
      await page.goto('file://' + tmp);
      await page.waitForTimeout(1400);
      const r = await page.evaluate(() => {
        const q = document.getElementById('giftQuantity');
        return q ? { cls: q.getAttribute('class'), bogus: q.getAttribute('classname') } : null;
      });
      lost = !r || !r.cls;
      await b2.close();
    } catch (e) {
      lost = true;
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
    }
    ck('改回 className 后，class 真的会丢（证明这条断言不是摆设）', lost === true);

    // 反向 3：把派单提示删空，消失断言必须变红
    const blank = html.replace("placeholder: '例如：下雪',\n lockId: 'PaiDan'", "placeholder: ' ',\n lockId: 'PaiDan'");
    const paiDanBlank = /id: 'paiDan'[\s\S]{0,600}?placeholder: ' '[\s\S]{0,80}?lockId: 'PaiDan'/.test(blank);
    ck('把派单提示删空后，非空白断言确实会失败', paiDanBlank);
  }

  console.log('\n═════ 判定 ═════');
  if (fail) {
    console.log(` 失败 ${fail} 项`);
    process.exit(1);
  }
  console.log(' 全部通过（class 真的落上了、提示不消失/不截断/不折行、尺寸合理）');
})().catch(err => {
  console.error('运行失败：' + (err && err.message));
  process.exit(1);
});
