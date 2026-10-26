#!/usr/bin/env node
/**
 * 源码锚点表（第 27 套防线的前置体检）
 *
 * 为什么要有这张表
 * ----------------
 * 一批测试靠「在源码里找到某段代码、把它改坏、看断言是否变红」来证明自己不是假的绿。
 * 这类测试有一个共同的脆弱点：**锚点本身**。锚点一旦因为格式化、改名、重构而漂移，
 * 测试会以两种难查的方式坏掉：
 *   · 找不到 → replace 静默不生效 → 变异没发生 → 「拆掉修复仍然全绿」→ 假的绿；
 *   · 找到多处 → replace 只替换第一处 → 变异可能作用在别的地方 → 断言测的不是想测的东西。
 * 两种都不会报错，只会让防线悄悄失效。8.3.53 那三套恒红就是前一种。
 *
 * 这张表把「锚点」从散落在各测试文件里的裸字符串，收成一份可体检的清单：
 *   每条锚点登记 content（原文）+ expect（应命中几次）+ note（它是谁的锚点）。
 * 体检通过才跑后续测试；不通过就明确报「锚点失效：<名字>」，而不是让后续测试莫名其妙地红。
 *
 * 用法：
 *   node tests/_anchors.js [index.html]       # 体检；0 全命中 / 1 有问题
 */
const fs = require('fs');
const path = require('path');

const ANCHORS = {
  // ── regression-854（8.3.54 回归 · 反向验证）──────────────────────
  manualPriceNameGuard: {
    text: 'if (registered && current && registered !== current) return null;',
    expect: 1,
    note: '手输单价按项目名校验（拆掉后单价会串项）'
  },
  clearStaleProjects: {
    text: 'if (nextNames && nextNames !== currentNames) {',
    expect: 1,
    note: '换项目时作废旧项目与草稿（拆掉后旧总价残留）'
  },
  editingIndexShift: {
    text: 'else if (this.editingIndex > index) this.editingIndex -= 1;',
    expect: 1,
    note: '老板记忆删除后校正编辑下标（拆掉后会写错人）'
  },
  stripTrailingTimeToken: {
    text: ' stripTrailingTimeToken(value) {\n const text = String(value ?? \'\');',
    expect: 1,
    note: '剥掉名字末尾的时间/局数（拆掉后「阿豪 8点」变「阿豪8点」）'
  },
  ctrlCPassInput: {
    text: 'if ((event.ctrlKey || event.metaKey) && !editableTarget',
    expect: 1,
    note: '输入框内放行 Ctrl+C（拆掉后复制小段文字会粘出整张单）'
  },

  // ── amount-property（金额属性）──────────────────────────────────
  aggregateReduce: {
    text: 'const totalPrice = this.roundThree(list.reduce((sum, project) => sum + (Number(project.subtotal) || 0), 0));',
    expect: 1,
    note: '聚合求和（拆掉后守恒性质会红）'
  },
  peiPeiMultiply: {
    text: 'if (context.peiPeiCount > 1) discountedPrice *= context.peiPeiCount;',
    expect: 1,
    note: '折后总价乘人数（拆掉后人数线性会红）'
  },

  // ── 8.3.56（新建价格库 / 撤销导入）────────────────────────────────
  createLibraryAutoName: {
    text: 'const createName = (!nameKey || nameTaken)',
    expect: 1,
    note: '新建价格库时，框里的名字空或已存在就自动命名（改回直接取 typedName 会重新报同名）'
  },
  undoImportTTL: {
    text: 'static get UNDO_TTL_MS() { return 30 * 60 * 1000; }',
    expect: 1,
    note: '撤销导入的 30 分钟时限（改成 0 会让「刚导入完按钮可用」变红）'
  },

  // ── gift-quantity / hint-dynamic（礼物链路）──────────────────────
  bindLateInputsCall: {
    text: 'this.inputFlowFeature.bindLateInjectedInputs?.();',
    expect: 1,
    note: '迟注入输入的补绑调用'
  },
  giftTotalKeyGate: {
    text: "if (key === 'totalPrice' || key === 'autoUnitPrice' || key === 'giftQuantity') {",
    expect: 1,
    note: '礼物总价同步的输入触发条件'
  },
  giftNoteFacade: {
    text: 'updateGiftDiscountNote(...args) { return this.modeFlowFeature.updateGiftDiscountNote(...args); }',
    expect: 1,
    note: '礼物折数提示的 app 门面转发'
  },
  discountKeyGate: {
    text: "if (key === 'totalPrice' || key === 'discount' || key === 'discountOverlay') {\n this.app.updateGiftDiscountNote?.();",
    expect: 1,
    note: '主输入流里的礼物折数提示刷新点'
  },
  clearFieldRefresh: {
    text: " if (targetId === 'discount' || targetId === 'discountOverlay' || targetId === 'totalPrice') this.app.updateGiftDiscountNote?.();\n",
    expect: 1,
    note: '单字段清除时的礼物折数提示刷新'
  },
  clearAllRefresh: {
    text: ' this.app.updateGiftDiscountNote?.();\n this.bossMemoryFeature.hideBossSuggestions();',
    expect: 1,
    note: '「全部清除」里的顺序：先刷提示、再收候选'
  }
};

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * 体检：每条锚点必须恰好命中 expect 次。
 * @returns {{ ok: boolean, total: number, problems: Array<{key:string, expect:number, actual:number, note:string}> }}
 */
function verify(html) {
  const problems = [];
  Object.keys(ANCHORS).forEach(key => {
    const anchor = ANCHORS[key];
    const actual = countOccurrences(String(html ?? ''), anchor.text);
    if (actual !== (anchor.expect || 1)) {
      problems.push({ key, expect: anchor.expect || 1, actual, note: anchor.note });
    }
  });
  return { ok: problems.length === 0, total: Object.keys(ANCHORS).length, problems };
}

module.exports = { ANCHORS, verify, countOccurrences };

if (require.main === module) {
  const htmlPath = process.argv[2] || path.join(__dirname, '..', 'index.html');
  let html = '';
  try {
    html = fs.readFileSync(htmlPath, 'utf8');
  } catch (error) {
    console.log(`  ✗ 读不到 ${htmlPath}：${error.message}`);
    process.exit(1);
  }
  const result = verify(html);
  console.log(`  ── 源码锚点体检（${result.total} 条）──`);
  if (result.ok) {
    console.log(`  ✓ ${result.total} 条锚点全部恰好命中 1 处（变异测试的定位是可靠的）`);
    process.exit(0);
  }
  result.problems.forEach(problem => {
    const reason = problem.actual === 0
      ? '源码里找不到 —— 代码改过但锚点没同步，依赖它的反向验证会静默失效（假绿）'
      : `命中 ${problem.actual} 处（应为 ${problem.expect} 处）—— 替换只会作用在第一个位置，断言可能测错对象`;
    console.log(`  ✗ 锚点失效：${problem.key}`);
    console.log(`      ${reason}`);
    console.log(`      用途：${problem.note}`);
  });
  console.log(`\n  修法：改 tests/_anchors.js 里对应条目的 text，让它与当前源码一致；不要删条目。`);
  process.exit(1);
}
