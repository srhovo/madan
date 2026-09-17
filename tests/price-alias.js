#!/usr/bin/env node
/**
 * 精确项目「其他名字」（多别名）专项验证
 *
 * 为什么需要它
 * ------------
 * 多别名是**新增能力**，既有的 11 套防线全部写于它之前，对它零覆盖。
 * 一个只会在新功能下变绿的测试没有价值 —— 本脚本同时验证两件事：
 *   ① 正向：别名真的能命中、多别名真的都生效、老数据真的还能读
 *   ② 反向：把别名支持「拆掉」后，断言必须变红（否则就是假的绿）
 *
 * 反向验证用与 tests/mutate-chain.py 相同的方法：临时改写源码副本，
 * 断言其失败。这保证本套件测的是「能力是否还在」，而不是「代码是否长得像」。
 *
 * 用法：node tests/price-alias.js
 * 退出码：0 全部通过 / 1 有断言失败
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');

// 从 index.html 主脚本中抠出 PriceRuleEngine 与 PriceRuleConflictEngine
// （与 test-engine.js 同一套做法：抠类定义，在 vm 里跑，不碰 DOM）
function extractEngine(src) {
  const start = src.indexOf('class PriceRuleEngine {');
  if (start < 0) throw new Error('找不到 PriceRuleEngine');
  // 取到 PriceRuleConflictEngine 类结束
  // collectCandidates / matchRankTarget 在 PriceRuleMatcher 里，必须一起抠出来
  const matcherStart = src.indexOf('class PriceRuleMatcher {', start);
  if (matcherStart < 0) throw new Error('找不到 PriceRuleMatcher');
  const confStart = src.indexOf('class PriceRuleConflictEngine {', start);
  if (confStart < 0) throw new Error('找不到 PriceRuleConflictEngine');
  // 从 PriceRuleConflictEngine 往后找到下一个顶层 class
  const after = src.indexOf('\nclass ', confStart + 10);
  const end = after < 0 ? src.length : after;
  return src.slice(start, end);
}

let fail = 0;
const ck = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

function buildSandbox(htmlText) {
  const engineSrc = extractEngine(htmlText);
  const sandbox = {
    console,
    Math,
    Number,
    String,
    Object,
    Array,
    Set,
    Map,
    JSON,
    Date,
    // 引擎依赖的文本工具（与 index.html 里的定义保持一致的最小实现）
    AppTextUtils: {
      normalizeText: (v) => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim(),
      escapeHtml: (v) => String(v ?? ''),
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(engineSrc + '\n;globalThis.__PE = PriceRuleEngine; globalThis.__PC = PriceRuleConflictEngine; globalThis.__PM = PriceRuleMatcher;', sandbox);
  return sandbox;
}

const html = fs.readFileSync(HTML, 'utf8');
const sb = buildSandbox(html);
const PE = sb.__PE;
const PC = sb.__PC;
const PM = sb.__PM;

console.log('--- 精确项目「其他名字」（多别名）验证 ---\n');

console.log('【1】老数据兼容：单个别名（改动前的形状）仍能读、仍能命中');
{
  const rule = PE.normalizeExactRule({ serviceName: '其他手游', alias: '蛋仔派对', prices: { round: 30 } });
  ck('老数据 alias 被读进 aliases', Array.isArray(rule.aliases) && rule.aliases.includes('蛋仔派对'), JSON.stringify(rule.aliases));
  ck('老数据 alias 字段仍保留（外部读取不破）', rule.alias === '蛋仔派对', rule.alias);
}

console.log('\n【2】新能力：多个别名同时生效');
{
  const rule = PE.normalizeExactRule({ serviceName: '其他手游', aliases: '蛋仔派对、和平精英、手瓦', prices: { round: 30 } });
  ck('三个别名都被解析', rule.aliases.length === 3, JSON.stringify(rule.aliases));
  const parsed = (name) => PE.parseService ? PE.parseService({ raw: name, display: name, compact: name }) : null;
  // 用 collectCandidates 验证匹配（这是结算真正走的那条路）
  const parsedBase = { ok: true, serviceDisplay: '和平精英', base: '和平精英', compact: '和平精英', variantKey: '', variantLabel: '' };
  const cand = PM.collectCandidates([rule], parsedBase);
  ck('别名「和平精英」命中该规则', cand.exact.length === 1, `命中 ${cand.exact.length} 条`);
  ck('命中来源标记为 alias', cand.exact[0]?.matchedBy === 'alias', cand.exact[0]?.matchedBy);
  const cand2 = PM.collectCandidates([rule], { ...parsedBase, serviceDisplay: '手瓦', base: '手瓦', compact: '手瓦' });
  ck('别名「手瓦」同样命中', cand2.exact.length === 1);
  const cand3 = PM.collectCandidates([rule], { ...parsedBase, serviceDisplay: '其他手游', base: '其他手游', compact: '其他手游' });
  ck('项目本名「其他手游」仍命中', cand3.exact.length === 1 && cand3.exact[0].matchedBy === 'serviceName');
}

console.log('\n【3】多种分隔符都能拆（与项目既有习惯一致）');
{
  const cases = [
    ['蛋仔派对、和平精英', 2, '顿号'],
    ['蛋仔派对,和平精英', 2, '半角逗号'],
    ['蛋仔派对，和平精英', 2, '全角逗号'],
    ['蛋仔派对/和平精英', 2, '斜杠'],
    ['蛋仔派对|和平精英', 2, '竖线'],
    ['蛋仔派对;和平精英', 2, '分号'],
    // 空格【刻意不是】分隔符：游戏名本身就含空格（如「永劫 端游」「CS GO」），
    // 若按空格拆会把一个名字劈成两个。见下方「空格被完整保留」用例。
  ];
  cases.forEach(([input, want, label]) => {
    const r = PE.normalizeAliases({ aliases: input });
    ck(`${label} 分隔`, r.length === want, `得到 ${JSON.stringify(r)}`);
  });
  const spaced = PE.normalizeAliases({ aliases: '永劫 端游' });
  ck('空格被完整保留（不误拆含空格的名字）', spaced.length === 1 && spaced[0] === '永劫 端游', JSON.stringify(spaced));
}

console.log('\n【4】去重与上限');
{
  const dup = PE.normalizeAliases({ aliases: '蛋仔派对、蛋仔派对、蛋仔派对' });
  ck('重复别名合并为一个', dup.length === 1, JSON.stringify(dup));
  const many = PE.normalizeAliases({ aliases: Array.from({ length: 30 }, (_, i) => `别名${i}`).join('、') });
  ck('别名数量上限 12', many.length === 12, `得到 ${many.length}`);
}

console.log('\n【5】不在别名里的名字不应被误命中（防「别名变通配」）');
{
  const rule = PE.normalizeExactRule({ serviceName: '其他手游', aliases: '蛋仔派对、和平精英', prices: { round: 30 } });
  const miss = PM.collectCandidates([rule], { ok: true, serviceDisplay: '王者荣耀', base: '王者荣耀', compact: '王者荣耀', variantKey: '', variantLabel: '' });
  ck('无关名字不命中', miss.exact.length === 0, `命中 ${miss.exact.length} 条`);
}

console.log('\n【6】冲突检测：别名占用也被算作冲突（否则两个项目可用同一名字）');
{
  const a = PE.normalizeExactRule({ serviceName: '其他手游', aliases: '蛋仔派对', prices: { round: 30 } });
  const b = PE.normalizeExactRule({ serviceName: '蛋仔派对', prices: { round: 50 } });
  const names = PC.exactNames(a);
  ck('exactNames 含项目名与全部别名', names.includes('其他手游') && names.includes('蛋仔派对'), JSON.stringify(names));
  const conflicts = PC.findConflicts([a, b]);
  ck('「A 的别名」与「B 的项目名」撞车能被发现', conflicts.length > 0, `发现 ${conflicts.length} 组`);
}

console.log('\n【7】合并（两处导入同一条）时别名不丢');
{
  const cur = PE.normalizeExactRule({ serviceName: '其他手游', aliases: '蛋仔派对', prices: { round: 30 }, updatedAt: 1 });
  const inc = PE.normalizeExactRule({ serviceName: '其他手游', aliases: '和平精英', prices: { round: 30 }, updatedAt: 2 });
  const merged = PE.mergeRule(cur, inc);
  ck('合并后别名是并集', merged.aliases.length === 2 && merged.aliases.includes('蛋仔派对') && merged.aliases.includes('和平精英'), JSON.stringify(merged.aliases));
}

console.log('\n【8】导出/导入往返：别名经 JSON 一圈后不丢');
{
  const rule = PE.normalizeExactRule({ serviceName: '其他手游', aliases: '蛋仔派对、和平精英', prices: { round: 30 } });
  const round = PE.normalizeExactRule(JSON.parse(JSON.stringify(rule)));
  ck('往返后别名完整', JSON.stringify(round.aliases) === JSON.stringify(rule.aliases), JSON.stringify(round.aliases));
}

// ── 反向验证：把别名支持拆掉，前面的断言必须变红 ───────────────────
console.log('\n【9】反向验证：拆掉多别名支持后，本套件必须变红（防「假的绿」）');
{
  // 变异：让 ruleAliasKeys 只认第一个别名（即退化回改动前的行为）
  // 注意：index.html 主脚本用 **1 空格** 缩进（不是 2/4 空格），锚点必须按实际文本写。
  const ANCHOR = "const list = Array.isArray(rule?.aliases) && rule.aliases.length ? rule.aliases : (rule?.alias ? [rule.alias] : []);\n return [...new Set(list.map(name => PriceRuleEngine.buildServiceKey(name)).filter(Boolean))];";
  const MUTANT = "const list = Array.isArray(rule?.aliases) && rule.aliases.length ? [rule.aliases[0]] : (rule?.alias ? [rule.alias] : []);\n return [...new Set(list.map(name => PriceRuleEngine.buildServiceKey(name)).filter(Boolean))];";
  const mutated = html.includes(ANCHOR) ? html.replace(ANCHOR, MUTANT) : html;
  ck('变异已成功注入（锚点命中）', mutated !== html);
  if (mutated !== html) {
    let caught = false;
    try {
      const msb = buildSandbox(mutated);
      const rule = msb.__PE.normalizeExactRule({ serviceName: '其他手游', aliases: '蛋仔派对、和平精英', prices: { round: 30 } });
      const cand = msb.__PM.collectCandidates([rule], { ok: true, serviceDisplay: '和平精英', base: '和平精英', compact: '和平精英', variantKey: '', variantLabel: '' });
      caught = cand.exact.length === 0; // 第二个别名失效 → 应当抓不住
    } catch (e) {
      caught = true;
    }
    ck('「第二个别名失效」被本套件抓住', caught);
  }
}

console.log('\n' + (fail === 0 ? '=== 全部通过（多别名能力成立，且断言不是假的绿）===' : `=== 失败 ${fail} 项 ===`));
process.exit(fail === 0 ? 0 : 1);
