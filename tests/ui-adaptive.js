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

/** 去掉 CSS 注释：注释里常写着「原为 static」「改成 relative」这类说明，
    不剥离会把注释当成真实声明，让断言既可能假红也可能假绿。 */
function stripCssComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 找出「有 ::after 且带 inset（命中区扩展）」但被某条规则声明成 position: static 的类。
 *
 * 为什么这是一条根因断言
 * ----------------------
 * 命中区是用 `::after { position: absolute; inset: -9px -2px }` 扩出来的。
 * 伪元素的定位基准是**宿主**；宿主一旦是 static，就会退到最近的定位祖先上，
 * inset 于是变成「撑满祖先再外扩」的一块透明层。
 *
 * 8.4.0 就栽在这里：`.peipei-group` 是 relative、它内部的 `.lock-btn` 是 static，
 * 结果伪元素盖住了整个陪陪区，陪陪输入框点不了 —— 页面不报错、测试也不红。
 */
function staticHostsWithInsetAfter(src) {
  const clean = stripCssComments(src);
  const tails = new Set();
  const re = /([^{}]+)::after\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    if (!/inset\s*:/.test(m[2])) continue;
    const sel = m[1].trim().split('\n').pop().trim();
    const parts = sel.split(/[\s>+~]+/).filter(Boolean);
    const lastSel = parts[parts.length - 1] || '';
    const cls = (lastSel.match(/\.([\w-]+)/) || [])[1];
    if (cls) tails.add(cls);
  }
  const out = [];
  for (const cls of tails) {
    const rr = new RegExp(`[^{}]*\\.${cls}(?![\\w-])[^{}]*\\{[^}]*position:\\s*static`, 'g');
    if (rr.test(clean)) out.push(cls);
  }
  return out;
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
    // 8.4.0 的真实事故：陪陪输入框点不了。
    // .peipei-group 是 relative，其内部的 .lock-btn 被覆盖成 static，
    // 于是 .lock-btn::after 的 inset 以整个陪陪区为基准，盖住了上面的输入框。
    // 8.4.2 已把那套伪元素整体撤掉（实测它对别的字段根本没生效），但这条守卫保留：
    // 将来谁再加「用伪元素扩可点范围」，宿主一旦是 static 就会立刻红。
    name: '若有伪元素扩可点范围，其宿主必须有定位上下文（不得 static）',
    test: (src) => staticHostsWithInsetAfter(src).length === 0,
    // 人为造一个「宿主 static + 伪元素 inset」的组合，断言必须能抓住
    break: (src) => src.replace(
      '</style>',
      '.probe-static::after { content: ""; position: absolute; inset: -9px; }\n .probe-static { position: static; }\n</style>'
    )
  },
  {
    name: '陪陪区锁定按钮保留自身定位上下文（防止伪元素重现时再盖住输入框）',
    test: (src) => {
      const body = stripCssComments(ruleBody(src, '.input-group.peipei-group > .lock-btn') || '');
      return /position:\s*relative/.test(body);
    },
    break: (src) => src.replace(
      /(\.input-group\.peipei-group > \.lock-btn \{(?:\s*\/\*[\s\S]*?\*\/)*\s*)position: relative;/,
      '$1position: static;'
    )
  },
  {
    name: '点空白结束输入态：处理器已实现并挂上初始化',
    test: (src) => /initTapToDismiss\(\)\s*\{/.test(src)
      && /this\.initTapToDismiss\(\);/.test(src)
      && /document,\s*'pointerup'/.test(src),
    break: (src) => src.replace('this.initTapToDismiss();', '')
  },
  {
    // 8.4.2 的真实事故：点空白用的是 pointerdown，而候选的选中逻辑挂在 mousedown 上，
    // pointerdown 更早 → 先把输入框 blur 掉 → blur 处理器用 rAF 收起候选面板 →
    // 真机上 touchstart 与 touchend 之间跨帧，rAF 先跑，touchend 的 mousedown 落空。
    // 用户看到的就是「点候选没反应，直接跳过」。判定必须晚于 mousedown。
    name: '点空白的判定晚于候选的 mousedown（不得在 pointerdown 上直接 blur）',
    test: (src) => /'pointerdown',\s*onDown/.test(src) && /'pointerup',\s*onUp/.test(src),
    break: (src) => src.replace("'pointerup', onUp", "'pointerdown', onUp")
  },
  {
    name: '点空白结束输入态：可交互白名单覆盖所有候选面（漏一个就点不中）',
    test: (src) => {
      const list = (src.match(/const INTERACTIVE = \[([\s\S]*?)\]\.join\(', '\)/) || [])[1] || '';
      return ['.type-suggest-list', '.boss-suggest-list', '.ap-quick-chip', '.history-item', '.boss-memory-item']
        .every(cls => list.includes(`'${cls}'`));
    },
    break: (src) => src.replace(/'\s*\.type-suggest-list\s*'/, "'__removed_in_probe__'")
  },
  {
    name: '点空白结束输入态：焦点已变 / 起手落点可交互 / 滚动过，都不允许再补一刀',
    test: (src) => /document\.activeElement !== down\.active/.test(src)
      && /keepFocus\(target\)/.test(src)
      && /Math\.abs\(window\.scrollY - down\.sy\)/.test(src),
    break: (src) => src.replace('if (document.activeElement !== down.active || !isTextField(down.active)) return;', '')
  },
  {
    // touchend 事件自身没有 clientX（坐标在 changedTouches[0] 里）。
    // 直接读 event.clientX 会得到 undefined → 减法变 NaN → `NaN > 12` 恒 false，
    // 「手指滑走就不算点空白」这条判据在老 WebView 上会静默失效。
    name: '老 WebView 的 touchend 分支能从 changedTouches 取到坐标',
    // 判据不能只搜「changedTouches 有没有出现」——注释里也写了这个词，
    // 删掉代码行后照样能搜到，反向验证会假通过。必须盯代码本身。
    test: (src) => /const pointOf = event =>/.test(src)
      && /const touch = \(event\.changedTouches/.test(src)
      && !/Math\.hypot\(event\.clientX - down\.x/.test(src),
    break: (src) => src.replace(/\s*const touch = \(event\.changedTouches && event\.changedTouches\[0\]\)[\s\S]*?return touch \? \{ x: touch\.clientX, y: touch\.clientY \} : null;/, '\n return null;')
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
  if (!brokeCount) check(`${RULES.length} 条规则的反向验证全部变红`, true, `${RULES.length}/${RULES.length}`);

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

        // 真实点击：8.4.0 的陪陪输入框点不了，页面不报错、尺寸也正常，
        // 只有「点一下看看焦点落在哪」能发现。允许一次重试，避开联想列表的异步抖动。
        const fieldIds = await page.evaluate(() =>
          [...document.querySelectorAll('#primaryFieldsContainer input')]
            .filter(el => el.offsetParent !== null && el.getBoundingClientRect().width > 4)
            .map(el => el.id).filter(Boolean)
        );
        const unclickable = [];
        for (const fid of fieldIds) {
          let ok = false;
          for (let attempt = 0; attempt < 2 && !ok; attempt++) {
            const pt = await page.evaluate(async (id) => {
              const el = document.getElementById(id);
              el.scrollIntoView({ block: 'center' });
              await new Promise(r => setTimeout(r, 180));
              const b = el.getBoundingClientRect();
              return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
            }, fid);
            await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
            await page.mouse.click(pt.x, pt.y);
            const focused = await page.evaluate(() => (document.activeElement || {}).id || '');
            ok = focused === fid;
          }
          if (!ok) unclickable.push(fid);
        }
        check(`${label} ${w}×${h}：每个输入框都点得进去`, unclickable.length === 0, unclickable.join(',') || `${fieldIds.length} 个全通`);

        // 点空白结束输入态。桌面浏览器点 body 会「天然失焦」，掩盖这条能力的有无，
        // 所以这里派发合成 pointerdown + pointerup —— 合成事件不会触发浏览器原生失焦，
        // 焦点是否离开输入框完全取决于我们的处理逻辑。
        if (w <= 480) {
          const tap = await page.evaluate(async () => {
            const input = document.getElementById('totalPrice');
            const blank = document.querySelector('.input-section');
            if (!input || !blank) return { ok: false, reason: '缺少元素' };
            input.focus();
            await new Promise(r => setTimeout(r, 80));
            if (document.activeElement !== input) return { ok: false, reason: '聚焦失败' };
            const box = blank.getBoundingClientRect();
            const at = { bubbles: true, clientX: Math.round(box.x + 8), clientY: Math.round(box.y + 8) };
            blank.dispatchEvent(new PointerEvent('pointerdown', at));
            blank.dispatchEvent(new PointerEvent('pointerup', at));
            await new Promise(r => setTimeout(r, 120));
            return { ok: document.activeElement !== input, active: (document.activeElement || {}).id || 'body' };
          });
          check(`${label} ${w}×${h}：点空白能结束输入态`, tap.ok, tap.reason || `active=${tap.active}`);

          const keep = await page.evaluate(async () => {
            const input = document.getElementById('totalPrice');
            const btn = document.getElementById('lockPaiDanBtn');
            if (!input || !btn) return { ok: false, reason: '缺少元素' };
            input.focus();
            await new Promise(r => setTimeout(r, 80));
            const box = btn.getBoundingClientRect();
            const at = { bubbles: true, clientX: Math.round(box.x + box.width / 2), clientY: Math.round(box.y + box.height / 2) };
            btn.dispatchEvent(new PointerEvent('pointerdown', at));
            btn.dispatchEvent(new PointerEvent('pointerup', at));
            await new Promise(r => setTimeout(r, 120));
            // 点在按钮上不允许被强行 blur —— 否则会打断「点按钮先失焦再触发」的原生顺序
            return { ok: document.activeElement === input };
          });
          check(`${label} ${w}×${h}：点按钮不被误当作空白`, keep.ok, keep.reason || '');
        }

        // 候选面必须真的点得中。8.4.2 的事故：点空白的 pointerdown 抢在候选的 mousedown
        // 之前把输入框 blur 掉，blur 处理器用 rAF 收起候选面板；真机上 touchstart 与
        // touchend 之间必然跨帧，rAF 先跑，等 touchend 的 mousedown 派发时元素已不在。
        // 连续 tap（中间不插帧）测不出来 —— 这正是当初漏掉它的原因，所以这里必须分两步派发。
        if (w <= 480) {
          await page.evaluate(() => {
            try {
              const key = 'pw_ultimate_priceLibraries';
              const raw = localStorage.getItem(key);
              if (!raw) return;
              const data = JSON.parse(raw);
              const lib = (data.libraries || [])[0];
              if (!lib) return;
              lib.rules = [{ id: '__uiadapt_probe__', kind: 'exact', serviceName: '防线探针项目', aliases: ['防线探针'], prices: { hour: 30, round: 20 } }];
              localStorage.setItem(key, JSON.stringify(data));
            } catch (e) { /* 注入失败就让下面的断言变红，不静默跳过 */ }
          });
          await page.reload({ waitUntil: 'load' });
          await page.waitForTimeout(900);
          const cdp = await ctx.newCDPSession(page);
          const cand = await page.evaluate(async () => {
            const el = document.getElementById('type');
            if (!el) return { ok: false, reason: '缺少服务类型输入框' };
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            await new Promise(r => setTimeout(r, 150));
            el.focus();
            el.value = '防线探针';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 400));
            const item = document.querySelector('#typeSuggestList .type-suggest-item[data-suggestion-owner="service"]');
            if (!item) return { ok: false, reason: '候选没有出现（数据或渲染链路有问题）' };
            const b = item.getBoundingClientRect();
            return { ok: true, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), before: el.value };
          });
          if (!cand.ok) {
            check(`${label} ${w}×${h}：点服务类型候选能填入`, false, cand.reason);
          } else {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cand.x, y: cand.y, radiusX: 2, radiusY: 2, force: 1 }] });
            await page.waitForTimeout(120); // 留一帧：真机 touchend 与 mousedown 之间本就跨帧
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await page.waitForTimeout(450);
            const after = await page.evaluate(() => document.getElementById('type').value);
            check(`${label} ${w}×${h}：点服务类型候选能填入`, after !== cand.before && after.includes('防线探针'), `"${cand.before}"→"${after}"`);
          }
        }

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
