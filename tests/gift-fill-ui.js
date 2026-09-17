#!/usr/bin/env node
/**
 * 第 19 套防线 · 补价那一排的宽度与按钮可见性（8.3.43）
 *
 * 守的是用户直接报上来的界面缺陷，以及修它时连带发现的两个更深的问题：
 *
 *   ① 「确定·换XX」按钮的文字被裁掉一截（用户附截图报的）
 *      根因：那一排装不下「标签 + 单价框 + × + 个数框 + 按钮」五样东西，
 *      而按钮是固定宽度（52px），文字要 59~79px，实测 360/390/430 三档屏宽
 *      下分别差 7~27 像素 —— 一律从右边裁掉。
 *      修法：补价期间数量框主动让位（数量永不超过两位数），宽度转给按钮。
 *
 *   ② 按钮只在「填了单价之后」才出现
 *      根因：礼物码单下服务类型框的 input 处理在礼物分支直接 return，
 *      不刷新那一排；按钮只被「单价框变化」那条链路点亮。
 *      用户感受：提示行已经在说「正在补第 1 个」，按钮却还是收起的，
 *      不知道该去哪儿按。
 *
 *   ③ 记忆库里已经有价的礼物，仍被要求再补一遍
 *      根因：补价判据只看「这一单的价格表」，而结算（resolve）看的是
 *      「记忆库 + 价格表」并集 —— 两者打架。实测「3满天星+2同心结」里
 *      同心结记忆库有 15，用户补完满天星后总价已经算出来了（提示行说
 *      「共 5 个礼物」），补价状态却还停在同心结，用户按确定会把一个
 *      没人要的价塞进记忆库，覆盖掉原来记的 15。
 *
 * 本套跑在**真实浏览器**里：宽度、可见性、文字是否被裁，都只有渲染出来才知道。
 * 纯字符串检查抓不住「元素在但被压成 0 宽」「文字在但溢出容器」这类问题。
 *
 * 运行: node tests/gift-fill-ui.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let passed = 0;
const failures = [];
const notes = [];

const ok = (name, cond, detail = '') => {
  if (cond) { passed += 1; return true; }
  failures.push(`${name}${detail ? ' → ' + detail : ''}`);
  return false;
};

/** 抓一个方法体的源码（从签名到配对的收尾大括号）
 *
 * ★ 坑：不能简单地找签名后的第一个 `{` —— 默认参数里可能就有花括号，
 * 例如 `updateManualControls(draft = null, { forceGiftPriority = false } = {})`。
 * 那样配对会从默认参数的花括号开始，取出一段残缺片段，断言全部变成假绿。
 * 正确做法：先扫过参数列表（圆括号配平），再往下找方法体的 `{`。
 * 这段逻辑与 tests/gift-fill.js 里的 extractMethod 一致，是踩过坑后定下来的写法。
 */
function extractMethod(signature) {
  const start = HTML.indexOf(signature);
  if (start < 0) return '';
  let i = HTML.indexOf('(', start);
  if (i < 0) return '';
  let paren = 0;
  for (; i < HTML.length; i += 1) {
    if (HTML[i] === '(') paren += 1;
    else if (HTML[i] === ')') { paren -= 1; if (paren === 0) { i += 1; break; } }
  }
  while (i < HTML.length && HTML[i] !== '{') {
    if (HTML[i] === ';') return '';
    i += 1;
  }
  const from = i;
  let depth = 0;
  for (; i < HTML.length; i += 1) {
    if (HTML[i] === '{') depth += 1;
    else if (HTML[i] === '}') { depth -= 1; if (depth === 0) return HTML.slice(start, i + 1); }
  }
  return HTML.slice(start, from + 1);
}

/** 抓 `this.bind('xxx', 'evt', () => { ... })` 这个回调的函数体
 *
 * ★ 坑：不能把它丢给 extractMethod。extractMethod 是从签名里的**第一个** `(`
 * 开始配平的，而 `this.bind(` 那个括号会把整段 `bind(...)` 调用整体吞掉，
 * 配平结束后落在调用末尾的 `;` 上，于是返回空串 —— 断言静默变成假失败。
 * 这里改成直接定位箭头函数体：从 `=> {` 之后开始配平。
 */
function extractArrowBody(prefix) {
  const at = HTML.indexOf(prefix);
  if (at < 0) return '';
  const arrow = HTML.indexOf('=>', at);
  if (arrow < 0) return '';
  const open = HTML.indexOf('{', arrow);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < HTML.length; i += 1) {
    if (HTML[i] === '{') depth += 1;
    else if (HTML[i] === '}') { depth -= 1; if (depth === 0) return HTML.slice(open, i + 1); }
  }
  return '';
}

/* ============================================================
   A. 样式表规则：补价期间的宽度重分配必须存在且形状正确
   （这一段不依赖浏览器 —— 规则没了就直接报红，不用等渲染）
   ============================================================ */
console.log('\nA. 补价期间的宽度重分配规则');

const cssBlocks = (selectors) => {
  // 从样式表里抓某个选择器的声明块（index.html 里是单行缩进风格，按大括号配对取）
  const out = [];
  selectors.forEach(sel => {
    let from = 0;
    while (true) {
      const at = HTML.indexOf(sel, from);
      if (at < 0) break;
      const open = HTML.indexOf('{', at);
      if (open < 0) break;
      // 确认这个 { 前面没有别的选择器（即 at 到 open 之间只有这个选择器与空白）
      const between = HTML.slice(at + sel.length, open).trim();
      if (between === '' || /^[,\s]/.test(between) === false && between === '') {
        const close = HTML.indexOf('}', open);
        if (close > 0) out.push(HTML.slice(at, close + 1));
      }
      from = at + sel.length;
    }
  });
  return out.join('\n');
};

const fillingQty = cssBlocks(['.gift-mode-panel.gift-combo-filling .gift-quantity-input']);
const fillingUnit = cssBlocks(['.gift-mode-panel.gift-combo-filling #autoUnitPrice']);
const fillingBtn = cssBlocks(['.gift-mode-panel.gift-combo-filling #addPriceProject']);

ok('存在「补价期间个数框让位」规则', fillingQty.length > 0, '找不到 .gift-mode-panel.gift-combo-filling .gift-quantity-input');
ok('个数框在补价期间改为固定宽度（不再参与拉伸）', /flex:\s*0\s+0\s+auto/.test(fillingQty), fillingQty);
ok('个数框宽度收到两位数够用的量级（≤64px）', (() => {
  const m = fillingQty.match(/width:\s*(\d+)px/);
  return m && Number(m[1]) <= 64;
})(), fillingQty.match(/width:\s*\d+px/)?.[0] || '没有 width');

ok('存在「补价期间单价框吃掉剩余」规则', fillingUnit.length > 0);
ok('单价框在补价期间可伸缩（flex-grow 不为 0）', /flex:\s*[1-9]/.test(fillingUnit), fillingUnit);

ok('存在「补价期间按钮按内容撑开」规则', fillingBtn.length > 0);
ok('按钮不再是固定宽度（flex-shrink 允许收缩、basis 为 auto）', /flex:\s*0\s+1\s+auto/.test(fillingBtn), fillingBtn);
ok('按钮宽度来自内容而非写死', /width:\s*auto/.test(fillingBtn), fillingBtn);
ok('按钮有内边距余量（避免宽度恰好等于文字宽度时贴边）', /padding:\s*0\s+[1-9]\d*px/.test(fillingBtn), fillingBtn);

/* 反向验证：这一整组规则必须只在「补价期间」生效。
   少了 .gift-combo-filling 这个限定，全部补完价之后那一排也会被改窄，
   用户就看不到「共 9 个礼物」那个正常的宽个数框了。 */
['.gift-quantity-input', '#autoUnitPrice', '#addPriceProject'].forEach(sel => {
  const bare = new RegExp(`\\.gift-mode-panel\\s+${sel.replace(/[.#]/g, m => '\\' + m)}\\s*\\{[^}]*flex:\\s*0\\s+1\\s+auto`, 'm');
  ok(`不存在「无条件的按钮伸缩」规则（必须是补价限定）`, !bare.test(HTML), sel);
});

/* ============================================================
   B. 补价判据必须认「两个价源」，而不是只看价格表
   ============================================================ */
console.log('\nB. 补价判据认记忆库');

const hasPriceFn = extractMethod('giftComboItemHasPrice(name) {');

ok('存在统一的「这个礼物有价吗」判据', hasPriceFn.length > 0);
ok('判据认「这一单当场补的价」（_giftComboPrices）', /_giftComboPrices\?\.has\(/.test(hasPriceFn), hasPriceFn.slice(0, 200));
ok('判据也认「礼物单价记忆库」', /findMemory\s*\(/.test(hasPriceFn), hasPriceFn.slice(0, 300));

/* 反向验证：这是本版修的核心 —— 判据若退回「只看价格表」，
   记忆库有价的礼物会被重复要求补价。 */
const fillStateFn = extractMethod('getGiftComboFillState() {');

ok('「现在补第几个」用的是统一判据', /giftComboItemHasPrice\s*\(/.test(fillStateFn), fillStateFn.slice(0, 120));
ok('「现在补第几个」不再直接查价格表', !/_giftComboPrices\.has\(/.test(fillStateFn), '仍在直接查 _giftComboPrices');

const completeFn = extractMethod('isGiftComboPriceComplete() {');

ok('「补完了吗」也走统一判据', /giftComboItemHasPrice\s*\(/.test(completeFn), completeFn.slice(0, 120));

/* 判据必须仍然不看「结算结果」—— 这是 8.3.42 踩过的坑：
   用户按下确定的那一刻 resolve 已经能算出总价，拿它当判据会立刻判定
   「补完了」，按钮当场收起、第二项永远补不上。 */
ok('判据没有退回「看结算结果」的写法', !/resolveGiftCombo\s*\(/.test(fillStateFn) && !/resolveGiftCombo\s*\(/.test(completeFn));

/* ============================================================
   C. 按钮可见性：进入补价流程就该出现
   ============================================================ */
console.log('\nC. 按钮在补价流程起点就出现');

const typeInputBinding = extractArrowBody("this.bind('type', 'input', () => {");

ok('找得到服务类型框的输入处理', typeInputBinding.length > 0);
/* 反向验证：这里原先只有一句 `return;`（礼物模式直接退出），
   按钮就只会在「填完单价」那一刻才亮起来。 */
ok('礼物模式分支里会刷新那一排（不再直接退出）',
  /Number\(this\.app\.currentMode\)\s*===\s*2[\s\S]*?updateManualControls\(null,\s*\{\s*forceGiftPriority:\s*true\s*\}\)/.test(typeInputBinding),
  '礼物分支里没有 updateManualControls 调用');

const umcFn = extractMethod('updateManualControls(draft = null, { forceGiftPriority = false } = {}) {');

ok('找得到按钮刷新方法', umcFn.length > 0);
ok('按钮刷新时会同步挂/摘补价期间这个类', /classList\.toggle\('gift-combo-filling'/.test(umcFn), umcFn.slice(0, 200));
ok('挂/摘的依据是「还有礼物没补价」（giftCanCommit）',
  /classList\.toggle\('gift-combo-filling',\s*giftCanCommit\)/.test(umcFn));

/* 反向验证：这个类不能只挂不摘 —— 否则全部补完价之后那一排的个数框
   还是窄的，用户就看不到总数量了。 */
ok('补完价时会把类摘掉（toggle 第二参数为 false 的分支存在）',
  /giftCanCommit/.test(umcFn) && /if\s*\(panel\)/.test(umcFn));

/* ============================================================
   D. 真机渲染验证（宽度 / 可见性 / 是否裁字）
   ============================================================ */
console.log('\nD. 真实浏览器渲染');

let chromium = null;
try {
  ({ chromium } = require('playwright-core'));
} catch (error) {
  notes.push('未安装 playwright-core，跳过渲染验证（余下断言不执行）');
}

const BROWSERS = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];

(async () => {
  if (chromium) {
    let browser = null;
    let launchErr = '';
    for (const exe of BROWSERS) {
      if (!fs.existsSync(exe)) continue;
      try {
        browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
        break;
      } catch (error) { launchErr = error.message; }
    }

    if (!browser) {
      notes.push(`无法启动浏览器，跳过渲染验证：${launchErr || '未找到 chromium'}`);
    } else {
      try {
        // 三档窄屏都测：用户手上设备不一，必须逐档确认按钮都放得下
        for (const W of [360, 390, 430]) {
          const page = await browser.newPage({ viewport: { width: W, height: 844 } });
          const pageErrors = [];
          page.on('pageerror', e => pageErrors.push(e.message));
          await page.goto('file://' + path.join(ROOT, 'index.html'));
          await page.waitForTimeout(2400);
          ok(`${W}px：页面无脚本错误`, pageErrors.length === 0, pageErrors.join(' | '));

          await page.evaluate(() => window.orderCalculator.switchMode(2));
          await page.waitForTimeout(300);

          // ---- 场景 1：三个礼物都缺价，按钮要在「打完组合」时就出现 ----
          await page.evaluate(() => {
            const el = document.getElementById('type');
            el.value = '3满天星+2同心结+4未知A';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          });
          await page.waitForTimeout(500);

          const s1 = await page.evaluate(() => {
            const btn = document.getElementById('addPriceProject');
            const r = btn.getBoundingClientRect();
            return {
              hidden: btn.hidden,
              text: btn.textContent,
              w: r.width,
              need: btn.scrollWidth,
              panelCls: document.getElementById('autoPricePanel').className,
              note: document.getElementById('giftComboNote').textContent,
            };
          });
          ok(`${W}px：打完组合按钮就出现（不必先填单价）`, !s1.hidden, JSON.stringify(s1));
          ok(`${W}px：按钮文字是「确定」形态`, /^确定/.test(s1.text), s1.text);
          ok(`${W}px：已挂上补价期间样式`, /gift-combo-filling/.test(s1.panelCls), s1.panelCls);
          ok(`${W}px：按钮有实际宽度（未被压成 0）`, s1.w > 0, String(s1.w));
          ok(`${W}px：按钮文字完整不裁切`, s1.need <= s1.w + 1, `需要 ${s1.need}，实得 ${s1.w}`);
          ok(`${W}px：提示行说清「正在补第 1 个」`, /正在补第 1 个/.test(s1.note), s1.note);

          // 整排不许溢出（溢出会让按钮或单价框被推出可视区）
          const rowFit = await page.evaluate(() => {
            const row = document.querySelector('.auto-price-row');
            return { scroll: row.scrollWidth, client: row.clientWidth };
          });
          ok(`${W}px：那一排没有横向溢出`, rowFit.scroll <= rowFit.client + 1, JSON.stringify(rowFit));

          // ---- 场景 2：逐个补价，按钮要一路能装下「确定·换下一位」 ----
          const widths = [];
          for (const price of ['10', '15', '20']) {
            await page.locator('#autoUnitPrice').fill(price);
            await page.waitForTimeout(250);
            const st = await page.evaluate(() => {
              const btn = document.getElementById('addPriceProject');
              const r = btn.getBoundingClientRect();
              return { hidden: btn.hidden, text: btn.textContent, w: r.width, need: btn.scrollWidth };
            });
            widths.push(st);
            if (!st.hidden) {
              ok(`${W}px：按钮「${st.text}」文字完整`, st.need <= st.w + 1, `需要 ${st.need}，实得 ${st.w}`);
            }
            await page.locator('#addPriceProject').click();
            await page.waitForTimeout(600);
          }

          const after = await page.evaluate(() => ({
            total: document.getElementById('totalPrice').value,
            note: document.getElementById('giftComboNote').textContent,
            btnHidden: document.getElementById('addPriceProject').hidden,
            panelCls: document.getElementById('autoPricePanel').className,
            hasFilling: document.getElementById('autoPricePanel').classList.contains('gift-combo-filling'),
            memories: window.orderCalculator.priceQuickPickFeature.getGiftMemories().map(m => `${m.serviceType}=${m.unitPrice}`).sort(),
          }));

          ok(`${W}px：三项补完总价正确（3×10+2×15+4×20=140）`, after.total === '140', after.total);
          ok(`${W}px：补完后按钮收起`, after.btnHidden === true);
          ok(`${W}px：补完后摘掉补价样式（个数框回到宽形态）`, after.hasFilling === false, after.panelCls);
          ok(`${W}px：三个价都进了记忆库`, JSON.stringify(after.memories) === JSON.stringify(['未知A=20', '同心结=15', '满天星=10'].sort()), JSON.stringify(after.memories));
          ok(`${W}px：提示行显示明细`, /共 9 个礼物/.test(after.note), after.note);

          // ---- 场景 3：记忆库已有价的礼物不该被要求重复补 ----
          // 用前面刚补过价的「满天星=10」和「未知A=20」——
          // 此时它们已在记忆库里，再写一遍组合应当直接出总价、不进补价流程。
          // 反向验证：判据若退回「只看这一单的价格表」，这里会要求重新补价。
          await page.evaluate(() => {
            const el = document.getElementById('type');
            el.value = '2未知A+1满天星';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          });
          await page.waitForTimeout(600);
          const s3 = await page.evaluate(() => ({
            btnHidden: document.getElementById('addPriceProject').hidden,
            total: document.getElementById('totalPrice').value,
            note: document.getElementById('giftComboNote').textContent,
            hasFilling: document.getElementById('autoPricePanel').classList.contains('gift-combo-filling'),
          }));
          ok(`${W}px：记忆库已有价时不进补价流程（按钮收起）`, s3.btnHidden === true, JSON.stringify(s3));
          ok(`${W}px：记忆库已有价时直接算出总价（2×20+1×10=50）`, s3.total === '50', s3.total);
          ok(`${W}px：记忆库已有价时不挂补价样式`, s3.hasFilling === false, JSON.stringify(s3));
          ok(`${W}px：提示行显示明细而非「还没单价」`, /共 3 个礼物/.test(s3.note) && !/还没有单价/.test(s3.note), s3.note);

          await page.close();
        }

        /* ---- 场景 4：全新会话，价只在记忆库里（价格表是空的）----
           这才是「判据认记忆库」的真正判别点。
           场景 3 是在同一页里补完价之后接着测的，那时 _giftComboPrices 里
           已经有那两个礼物的 key，即使判据退回「只看价格表」也能通过 ——
           这样的断言没有判别力（反向验证时确实漏掉了）。
           这里开一个干净页面，只往记忆库里塞价、绝不经过补价流程，
           于是价格表必然为空，能不能过就完全取决于判据认不认记忆库。 */
        {
          const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
          const pageErrors = [];
          page.on('pageerror', e => pageErrors.push(e.message));
          await page.goto('file://' + path.join(ROOT, 'index.html'));
          await page.waitForTimeout(2400);
          await page.evaluate(() => {
            window.orderCalculator.switchMode(2);
            const g = window.orderCalculator.giftMemoryFeature;
            g.upsert({ serviceType: '满天星', mode: 'fixed', unitPrice: 10 });
            g.upsert({ serviceType: '同心结', mode: 'fixed', unitPrice: 25 });
          });
          await page.waitForTimeout(400);

          const before = await page.evaluate(() => ({
            priceTableSize: window.orderCalculator.priceQuickPickFeature._giftComboPrices?.size ?? -1,
          }));
          ok('场景 4 前置：价格表确实为空（价只在记忆库）', before.priceTableSize === 0, String(before.priceTableSize));

          await page.evaluate(() => {
            const el = document.getElementById('type');
            el.value = '3满天星+2同心结';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          });
          await page.waitForTimeout(600);

          const s4 = await page.evaluate(() => ({
            btnHidden: document.getElementById('addPriceProject').hidden,
            total: document.getElementById('totalPrice').value,
            note: document.getElementById('giftComboNote').textContent,
            hasFilling: document.getElementById('autoPricePanel').classList.contains('gift-combo-filling'),
          }));
          /* 反向验证：判据若退回「只看这一单的价格表」，这两条必然报红 ——
             实测退回后按钮会亮起来、总价算不出来。 */
          ok('场景 4：记忆库有价即不进补价流程（按钮收起）', s4.btnHidden === true, JSON.stringify(s4));
          ok('场景 4：记忆库有价直接出总价（3×10+2×25=80）', s4.total === '80', s4.total);
          ok('场景 4：不挂补价样式', s4.hasFilling === false, JSON.stringify(s4));
          ok('场景 4：提示行是明细，不是「还没有单价」', /共 5 个礼物/.test(s4.note) && !/还没有单价/.test(s4.note), s4.note);
          ok('场景 4：无脚本错误', pageErrors.length === 0, pageErrors.join(' | '));
          await page.close();
        }
      } finally {
        await browser.close();
      }
    }
  }

  /* ============ 输出 ============ */
  console.log('');
  if (notes.length) notes.forEach(n => console.log(`  ⚠ ${n}`));
  if (failures.length) {
    console.log(`失败 ${failures.length} 项：`);
    failures.forEach(f => console.log(`  ✗ ${f}`));
    console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
    process.exit(1);
  }
  console.log(`全部通过（${passed} 项断言）`);
  process.exit(0);
})();
