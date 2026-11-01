#!/usr/bin/env node
/**
 * 界面可用性与平板自适应 · 回归防线（8.4.0）
 *
 * 背景（为什么需要这一套）
 * ------------------------
 * 8.4.0 做了一批「只在界面上体现」的改动：
 *   · 输入框字号 15 → 16px（避开 iOS 聚焦自动缩放）
 *   · 8 个弹窗补 aria-labelledby（此前读屏只念「对话框」）
 *   · 10.5px 辅助提示的对比度从 2.71:1 提到 5.2:1
 *   · 锁定 / 联系方式按钮的可点范围扩到 44px（视觉尺寸不变）
 *   · 平板字段列数改成跟着「实际可用宽度」走（竖屏 2 列 / 横屏 1 列）
 *   · 精简布局下模式选择器不再留 118px 空洞
 *
 * 这些改动的共同点是：**坏了不会报错**。字号退回 15px、对比度退回 #999、
 * 伪元素被删掉、媒体查询被覆盖 —— 页面照常打开，只是又变得难用。
 * 所以必须有断言守着，而且断言要能在 CI（只有 jsdom、没有浏览器）里跑。
 *
 * 因此本套件以**静态源码断言**为主：直接检查 CSS 规则与 JS 调用点是否还在。
 * 有 playwright-core 时再补一层真实浏览器实测（本地与发版时跑）。
 *
 * 反向验证：把每条关键片段从 HTML 里删掉，对应断言必须变红 —— 否则
 * 本套件只是一堆「字符串里有没有这句话」的假绿。
 *
 * 用法: node tests/ui-adaptive.js [index.html]
 * 退出码: 0 通过 / 1 失败
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// 一律转绝对路径：file:// 后面必须是绝对路径，否则浏览器拿到 file://index.html/
// 会直接失败，静默跳过实测（这是曾经真实发生过的假绿）。
const HTML_PATH = path.resolve(process.argv[2] || path.join(ROOT, 'index.html'));
if (!fs.existsSync(HTML_PATH)) {
  console.error(`  ✗ 找不到要检查的 HTML：${HTML_PATH}`);
  process.exit(1);
}
const html = fs.readFileSync(HTML_PATH, 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, actual) {
  if (ok) { pass += 1; console.log(`    ✓ ${name}${actual !== undefined ? '  ' + actual : ''}`); }
  else { fail += 1; failures.push(name); console.log(`    ✗ ${name}  ${actual === undefined ? '' : actual}`); }
}
function section(t) { console.log(`\n  ${t}`); }

/** 取出某条 CSS 规则的声明体（选择器精确匹配，允许选择器列表里含它）。 */
function ruleBody(src, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{([^}]*)\\}`, 'm');
  const m = src.match(re);
  return m ? m[1] : null;
}
/** 取出某个 @media 条件块的内容（支持嵌套一层）。 */
function mediaBlock(src, condition) {
  // 必须精确到「条件 + 空格 + {」：只找条件前缀会命中
  // `... and (min-width: 768px) and (max-width: 1024px)` 那条旧规则，
  // 于是断言测的是旧规则、永远红着（这类「测错对象」比不测更糟）。
  // 同时要收集**所有**同名条件的块：同一条件下这个文件里有多个块叠加，
  // 只取第一个会漏掉后面那条真正生效的规则。
  const bodies = [];
  let from = 0;
  for (;;) {
    const idx = src.indexOf(condition + ' {', from);
    if (idx < 0) break;
    const open = src.indexOf('{', idx);
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    bodies.push(src.slice(open + 1, end));
    from = end + 1;
  }
  return bodies.length ? bodies.join('\n') : null;
}

// ── 静态断言表：每项 = 名称 + 检测函数 ──────────────────────────────────
const RULES = [
  {
    name: '输入框字号 16px（iOS 聚焦不缩放）',
    test: (src) => {
      const body = ruleBody(src, '.input-group input,\n .input-group textarea');
      return !!body && /font-size:\s*16px/.test(body);
    },
    break: (src) => src.replace(/(\.input-group input,\n \.input-group textarea \{[^}]*?)font-size:\s*16px/, '$1font-size: 15px')
  },
  {
    name: '辅助提示专用色 --color-text-hint 已定义且对比度达标（#5f6b76）',
    test: (src) => /--color-text-hint:\s*#5f6b76/i.test(src),
    break: (src) => src.replace('--color-text-hint: #5f6b76;', '--color-text-hint: #999;')
  },
  {
    name: '折数内联提示使用达标色（不是 #999）',
    test: (src) => {
      const body = ruleBody(src, '#primaryFieldsContainer .discount-inline-hint');
      return !!body && /color:\s*var\(--color-text-hint\)/.test(body);
    },
    break: (src) => src.replace(/(#primaryFieldsContainer \.discount-inline-hint \{[^}]*?)color:\s*var\(--color-text-hint\)/, '$1color: var(--color-text-lighter)')
  },
  {
    name: '「自定义 / 单价」标签使用达标色',
    test: (src) => {
      const body = ruleBody(src, '.ap-label');
      return !!body && /color:\s*var\(--color-text-hint\)/.test(body);
    },
    break: (src) => src.replace(/(\.ap-label \{[^}]*?)color:\s*var\(--color-text-hint\)/, '$1color: var(--color-text-light)')
  },
  {
    name: '锁定按钮的 44px 命中区（伪元素，不改视觉）',
    test: (src) => /\.lock-btn::after\s*\{[^}]*inset:\s*-9px/.test(src),
    break: (src) => src.replace(/\.lock-btn::after\s*\{[^}]*\}/, '.lock-btn::after {}')
  },
  {
    name: '联系方式按钮的 44px 命中区',
    test: (src) => /\.contact-trigger-btn::after\s*\{[^}]*inset:\s*-9px/.test(src),
    break: (src) => src.replace(/\.contact-trigger-btn::after\s*\{[^}]*\}/, '.contact-trigger-btn::after {}')
  },
  {
    name: 'DialogManager 有统一的名称补全方法',
    test: (src) => /ensureAccessibleName\(modal\)\s*\{/.test(src) && /aria-labelledby/.test(src),
    break: (src) => src.replace(/ensureAccessibleName\(modal\)\s*\{/, 'ensureAccessibleNameBroken(modal) {')
  },
  {
    name: 'prepare() 会调用名称补全（静态弹窗）',
    test: (src) => {
      const i = src.indexOf('prepare(modal) {');
      if (i < 0) return false;
      return src.slice(i, i + 600).includes('this.ensureAccessibleName(modal)');
    },
    break: (src) => {
      const i = src.indexOf('prepare(modal) {');
      return src.slice(0, i) + src.slice(i).replace('this.ensureAccessibleName(modal);', '');
    }
  },
  {
    name: 'set() 显示前会再补一次名称（动态弹窗）',
    test: (src) => {
      const i = src.indexOf('set(modal, visible) {');
      if (i < 0) return false;
      return src.slice(i, i + 500).includes('this.ensureAccessibleName(modal)');
    },
    break: (src) => {
      const i = src.indexOf('set(modal, visible) {');
      return src.slice(0, i) + src.slice(i).replace('this.ensureAccessibleName(modal);', '');
    }
  },
  {
    name: '精简布局会把 layout-simple 写到 <html> 上',
    test: (src) => /classList\.toggle\('layout-simple'/.test(src),
    break: (src) => src.replace(/document\.documentElement\.classList\.toggle\('layout-simple'[^;]*;/, '')
  },
  {
    name: '精简布局下模式选择器改成两列（不再留空洞）',
    test: (src) => /html\.layout-simple \.mode-selector\s*\{[^}]*repeat\(2,/.test(src),
    break: (src) => src.replace(/html\.layout-simple \.mode-selector\s*\{[^}]*\}/, 'html.layout-simple .mode-selector {}')
  },
  {
    name: '平板竖屏字段两列',
    test: (src) => {
      const b = mediaBlock(src, '@media (orientation: portrait) and (min-width: 768px)');
      return !!b && /#primaryFieldsContainer\s*\{[^}]*repeat\(2,/.test(b);
    },
    break: (src) => src.replace(/(@media \(orientation: portrait\) and \(min-width: 768px\) \{\s*#primaryFieldsContainer\s*\{[^}]*?)repeat\(2, minmax\(0, 1fr\)\)/, '$1minmax(0, 1fr)')
  },
  {
    name: '平板横屏字段单列（双栏时左栏不足两列）',
    test: (src) => {
      const b = mediaBlock(src, '@media (orientation: landscape) and (min-width: 768px)');
      return !!b && /#primaryFieldsContainer\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/.test(b);
    },
    break: (src) => src.replace(/(@media \(orientation: landscape\) and \(min-width: 768px\) \{\s*#primaryFieldsContainer\s*\{[^}]*?)grid-template-columns:\s*minmax\(0, 1fr\)/, '$1grid-template-columns: repeat(2, minmax(0, 1fr))')
  },
  {
    name: '横屏平板折数行改纵向（三个框不再挤成一行）',
    test: (src) => {
      const b = mediaBlock(src, '@media (orientation: landscape) and (min-width: 1024px)');
      return !!b && /\.discount-paidan-row\s*\{[^}]*flex-direction:\s*column/.test(b) && /align-items:\s*stretch/.test(b);
    },
    break: (src) => src.replace(/(@media \(orientation: landscape\) and \(min-width: 1024px\) \{[^}]*?)flex-direction:\s*column;\s*align-items:\s*stretch;/, '$1flex-direction: row;')
  },
  {
    name: '叠加折数 placeholder 在窄框里不截断（12px）',
    test: (src) => /\.discount-combo-overlay input::placeholder\s*\{[^}]*font-size:\s*12px/.test(src),
    break: (src) => src.replace(/\.discount-combo-overlay input::placeholder\s*\{[^}]*\}/, '.discount-combo-overlay input::placeholder {}')
  }
];

(async () => {
  console.log('  ── 界面可用性与平板自适应 ──');

  section('① 静态规则（CI 可跑，不依赖浏览器）');
  for (const rule of RULES) {
    check(rule.name, rule.test(html));
  }

  section('② 反向验证：逐条删掉关键片段，对应断言必须变红');
  let brokeCount = 0;
  for (const rule of RULES) {
    let broken = null;
    try { broken = rule.break(html); } catch (e) { broken = null; }
    const changed = typeof broken === 'string' && broken !== html;
    // 只有「确实改动了」才有资格谈反向验证；改不动说明 break 本身失效，同样算失败
    const caught = changed && !rule.test(broken);
    if (!caught) {
      check(`反向验证「${rule.name}」`, false, changed ? '删掉后断言仍然通过（假绿）' : '反向改写没有生效');
      brokeCount += 1;
    }
  }
  if (!brokeCount) check(`14 条规则的反向验证全部变红`, true, '14/14');

  // ── ③ 真实浏览器实测（有 playwright-core 时跑，没有则跳过）────────────
  // 注意：这里的「跳过」只在**确实没有浏览器可用**时才允许。
  // 曾经踩过坑：run-all.sh 传的是相对路径 index.html，拼成 file://index.html/
  // 后 goto 失败，异常被当成「跳过」吞掉，于是平板三视口断言根本没跑、汇总却全绿。
  // 所以下面把「缺浏览器」与「跑起来但出错」严格分开：后者一律判失败。
  section('③ 真实浏览器实测（可选）');
  let PW = null;
  for (const base of [ROOT, process.cwd()]) {
    try { PW = require(require.resolve('playwright-core', { paths: [base] })); break; } catch (e) { /* next */ }
  }
  if (!PW) { PW = (() => { try { return require('playwright-core'); } catch (e) { return null; } })(); }
  if (!PW || !PW.chromium) {
    console.log('    · 跳过：本机没有 playwright-core（CI 环境正常如此）');
  } else {
    const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (fs.existsSync('/usr/bin/chromium')) launchOpts.executablePath = '/usr/bin/chromium';
    let browser = null;
    try {
      browser = await PW.chromium.launch(launchOpts);
      const vps = [[390, 844, '手机'], [768, 1024, '平板竖'], [1024, 768, '平板横']];
      for (const [w, h, label] of vps) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h } });
        const page = await ctx.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(e.message));
        await page.goto('file://' + HTML_PATH, { waitUntil: 'load' });
        await page.waitForTimeout(900);
        const r = await page.evaluate(() => {
          const small = [];
          document.querySelectorAll('#primaryFieldsContainer input, #primaryFieldsContainer textarea').forEach(el => {
            if (el.offsetParent === null) return;
            const fs = parseFloat(getComputedStyle(el).fontSize);
            if (fs < 16) small.push((el.id || el.placeholder) + ':' + fs);
          });
          const cols = getComputedStyle(document.querySelector('#primaryFieldsContainer')).gridTemplateColumns.split(' ').length;
          const modalNames = [...document.querySelectorAll('.app-modal')].filter(m => m.querySelector('h1,h2,h3,h4,.dialog-title,.confirm-message')).map(m => {
            window.appDialogManager && window.appDialogManager.prepare(m);
            const id = m.getAttribute('aria-labelledby');
            return !!(id && document.getElementById(id));
          });
          return {
            small, cols,
            named: modalNames.filter(Boolean).length,
            totalModals: modalNames.length,
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            errs: 0
          };
        });
        check(`${label} ${w}×${h}：输入框都 ≥16px`, r.small.length === 0, r.small.join(',') || '全部达标');
        check(`${label} ${w}×${h}：没有横向溢出`, !r.overflow);
        check(`${label} ${w}×${h}：弹窗都有可访问名称`, r.named === r.totalModals, `${r.named}/${r.totalModals}`);
        const wantCols = w < 768 ? 1 : (h > w ? 2 : 1);
        check(`${label} ${w}×${h}：字段列数 ${wantCols}`, r.cols === wantCols, `实际 ${r.cols}`);
        check(`${label} ${w}×${h}：无页面错误`, errs.length === 0, errs.join(';') || '0');
        await ctx.close();
      }
    } catch (e) {
      const msg = String((e && e.message) || e);
      // 只有「本机确实没有浏览器二进制」才允许跳过；其余（URL 无效、页面崩溃、
      // 断言执行期异常）都必须变红，否则就是假绿。
      const noBinary = /Executable doesn'?t exist|is not found at|ENOENT.*(chrome|chromium)|Cannot find (chrome|chromium)/i.test(msg);
      if (noBinary) {
        console.log('    · 跳过：本机没有可用的 Chromium 可执行文件');
      } else {
        check('真实浏览器实测能跑起来（失败不允许静默跳过）', false, msg.split('\n')[0]);
      }
    } finally {
      if (browser) await browser.close();
    }
  }

  console.log(`\n  通过 ${pass} / 失败 ${fail}`);
  if (fail) {
    console.log('  失败项：');
    failures.forEach(f => console.log('   · ' + f));
    process.exit(1);
  }
  console.log('  全部通过（含逐条反向验证）');
})().catch(e => {
  console.error('  ✗ 套件异常：' + (e && e.message));
  process.exit(1);
});
