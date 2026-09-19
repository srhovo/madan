#!/usr/bin/env node
/**
 * 【8.3.46】规则 id 稳定性检查（本套防线）
 *
 * 本轮动了规则 id 的生成方式，必须证明两件事：
 *   ① 稳定：同一条规则反复归一化，id 不变；旁边增删规则也不影响它。
 *      —— id 一旦漂移，草稿 / 界面选中态 / 备份里的 ruleId 就全部失配。
 *   ② 不撞车：两个库存同名同价的规则时，id 不再算出同一个值。
 *
 * 为什么这套防线必须存在
 * ----------------------
 * 规则 id 是「草稿 / 界面选中态 / 备份里的 ruleId」共同引用的东西。
 * 它一旦漂移，用户看到的是「刚选好的区间规则又没了」这类莫名现象 ——
 * 界面上完全看不出是 id 变了。
 * 本轮实测就抓到过一次：给规则 id 加「所属库」这层盐时，
 * 现算输入里含的「第几条」跟着入参形式漂移，27 条规则里 16 条的 id 当场全变。
 * 所以这里钉死三条：
 *   ① 反复归一化，id 不变
 *   ② 旁边增删规则，其余 id 不受影响
 *   ③ 两库同名同价时，id 不撞车
 *
 * 用法：node tests/rule-id-stability.js [可选：一份真实备份 json]
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const wait = ms => new Promise(r => setTimeout(r, ms));

let fail = 0;
const ck = (n, c, e) => { console.log(`  ${c ? '✓' : '✗'} ${n}${e ? '  ' + e : ''}`); if (!c) fail++; };

(async () => {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => console.log('ERR', e.message));
  const dom = new JSDOM(html, {
    url: 'https://madan.test/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.alert = () => {}; w.confirm = () => true;
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.requestAnimationFrame = cb => w.setTimeout(() => cb(Date.now()), 0);
      w.requestIdleCallback = cb => w.setTimeout(() => cb({ timeRemaining: () => 50 }), 0);
      w.visualViewport = { height: 800, width: 400, addEventListener() {}, removeEventListener() {} };
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.Element.prototype.scrollIntoView = function () {};
      w.HTMLCanvasElement.prototype.getContext = function () { return { measureText() { return { width: 0 }; }, fillRect() {}, clearRect() {} }; };
      w.fetch = () => Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' });
    }
  });
  const w = dom.window;
  for (let i = 0; i < 200 && !w.orderCalculator; i++) await wait(25);
  const app = w.orderCalculator; await wait(200);
  const store = app.priceLibraryStore;

  const file = process.argv[2];
  let raw = null;
  if (file) {
    const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw = backup.priceLibraries || backup.modules?.priceLibraries || backup.data?.priceLibraries || backup;
  }
  if (!raw || !Array.isArray(raw.libraries) || !raw.libraries.length) {
    raw = store.normalizeData(JSON.parse(w.localStorage.getItem('pw_ultimate_priceLibraries') || 'null'));
  }
  /* 保证有内容可测：应用自带的初始库往往是个空壳（没有规则），
     那样第 ② 组会「0/0」通过 —— 看着是绿的，实际什么都没验。
     所以没规则时在这里补一批（精确项目 + 区间规则各来几条），
     让这套防线在任何环境下都有实质断言。 */
  raw = store.normalizeData(raw) || store.normalizeData({ libraries: [{ name: 'A' }] });
  if (!raw.libraries.some(l => (l.rules || []).length >= 6)) {
    raw.libraries[0].rules = [
      { kind: 'exact', serviceName: '鹅鸭杀', prices: { round: 30 }, createdAt: 1700000000000 },
      { kind: 'exact', serviceName: '一起看', prices: { round: 40 }, createdAt: 1700000000001 },
      { kind: 'exact', serviceName: '树洞', prices: { hour: 50 }, createdAt: 1700000000002 },
      { kind: 'rankRange', rangeLabel: '星耀', rankType: 'star', minStar: 1, maxStar: 20, prices: { carry: { round: 25 } }, createdAt: 1700000000003 },
      { kind: 'rankRange', rangeLabel: '低段', rankType: 'named', namedRanks: ['钻石', '铂金'], prices: { normal: { round: 15 } }, createdAt: 1700000000004 },
      { kind: 'rankRange', rangeLabel: '高段', rankType: 'named', namedRanks: ['王者'], prices: { starGuarantee: { round: 60 } }, createdAt: 1700000000005 },
    ];
    raw = store.normalizeData(raw);
  }
  console.log(`库数 = ${(raw.libraries || []).length}，规则共 ${(raw.libraries || []).reduce((n, l) => n + (l.rules || []).length, 0)} 条\n`);

  const sig = d => JSON.stringify(d.libraries.flatMap(l => (l.rules || []).map(r => r.id)));

  /* ① 反复归一化：id 必须稳定 */
  console.log('① 反复归一化 id 是否稳定');
  let cur = store.normalizeData(JSON.parse(JSON.stringify(raw)));
  const s0 = sig(cur);
  let same = true;
  for (let i = 0; i < 5; i++) { cur = store.normalizeData(cur); if (sig(cur) !== s0) same = false; }
  ck('连续归一化 5 次，规则 id 全部不变（反复保存/加载不漂移）', same);
  ck('id 都不是空值', !/""/.test(s0) && !/null/.test(s0));

  /* ② 旁边增删规则不影响其余 id —— 这是本轮真正修好的健壮性 */
  console.log('\n② 旁边增删规则时，其余规则 id 是否受影响');
  const d2 = store.normalizeData(cur);
  const before = d2.libraries[0].rules.map(r => r.id);
  d2.libraries[0].rules = d2.libraries[0].rules.filter((_, i) => i !== 3);
  const after = store.normalizeData(d2).libraries[0].rules.map(r => r.id);
  const survivors = before.filter((_, i) => i !== 3);
  let kept = 0;
  for (let i = 0; i < survivors.length; i++) if (survivors[i] === after[i]) kept++;
  ck('删掉第 4 条后，其余规则 id 全部原样保留（不再连带漂移）', kept === survivors.length && survivors.length > 0,
    `${kept}/${survivors.length}`);

  /* ③ 两个库同名同价：id 不能撞车 */
  console.log('\n③ 两库同名同价时规则 id 是否撞车');
  const two = {
    schemaVersion: 2,
    activeLibraryId: 'lib_a',
    mergedLibraryIds: ['lib_a', 'lib_b'],
    libraries: ['lib_a', 'lib_b'].map(id => ({
      id, name: id, createdAt: 1700000000000, updatedAt: 1700000000000,
      items: [],
      rules: [{ kind: 'exact', serviceName: '鹅鸭杀', prices: { round: 30 }, createdAt: 1700000000000 }],
    })),
  };
  const nt = store.normalizeData(two);
  const ids = nt.libraries.flatMap(l => (l.rules || []).map(r => r.id));
  ck('两个库各有一条同名同价规则', ids.length === 2, ids.join(' / '));
  ck('两条规则 id 互不相同（各库分开，不再撞车）', new Set(ids).size === ids.length, ids.join(' / '));

  /* ④ 反向验证：把「id 里去掉序号」这条改回去，第 ② 组必须变红。
     这正是本轮实测踩到的坑：算 id 的输入里含「第几条」，
     旁边增删一条就会连带改变后面所有规则的 id。 */
  console.log('\n④ 反向验证（确认第 ② 组不是假绿）');
  {
    const ANCHOR = ' const source = `${this.buildRuleKey(rule)}|${Number(rule?.createdAt) || 0}|${scope}`;';
    const MUTANT = ' const source = `${this.buildRuleKey(rule)}|${Number(rule?.createdAt) || 0}|${index}|${scope}`;';
    const mutated = html.includes(ANCHOR) ? html.replace(ANCHOR, MUTANT) : html;
    ck('变异已成功注入（锚点命中）', mutated !== html);
    if (mutated !== html) {
      let caught = false;
      try {
        /* 用同一套起沙箱的方式跑变异版本 —— 直接复用上面的思路：
           只关心「删掉一条后，其余 id 是否还稳定」。 */
        const d = store.normalizeData(raw);
        // 变异版本里 buildRuleId 用到了 index，这里通过重新写一份源码来验：
        // 简化做法：把变异源码写进临时文件、再起一个 JSDOM 跑（下面的 boot 复用）
        caught = await (async () => {
          const fs2 = require('fs');
          const os = require('os');
          const tmp = path.join(os.tmpdir(), `madan-mutant-${Date.now()}.html`);
          fs2.writeFileSync(tmp, mutated, 'utf8');
          const dom2 = new JSDOM(fs2.readFileSync(tmp, 'utf8'), {
            url: 'https://madan.test/', runScripts: 'dangerously', pretendToBeVisual: true,
            virtualConsole: new VirtualConsole(),
            beforeParse(w2) {
              w2.alert = () => {}; w2.confirm = () => true;
              w2.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
              w2.requestAnimationFrame = cb => w2.setTimeout(() => cb(Date.now()), 0);
              w2.requestIdleCallback = cb => w2.setTimeout(() => cb({ timeRemaining: () => 50 }), 0);
              w2.visualViewport = { height: 800, width: 400, addEventListener() {}, removeEventListener() {} };
              w2.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
              w2.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
              w2.Element.prototype.scrollIntoView = function () {};
              w2.HTMLCanvasElement.prototype.getContext = function () { return { measureText() { return { width: 0 }; }, fillRect() {}, clearRect() {} }; };
              w2.fetch = () => Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' });
            }
          });
          const w2 = dom2.window;
          for (let i = 0; i < 200 && !w2.orderCalculator; i++) await wait(25);
          const st2 = w2.orderCalculator.priceLibraryStore;
          await wait(200);
          let r2 = st2.normalizeData({
            schemaVersion: 2, activeLibraryId: 'L', mergedLibraryIds: ['L'],
            libraries: [{
              id: 'L', name: 'L', createdAt: 1700000000000, updatedAt: 1700000000000, items: [],
              rules: [
                { kind: 'exact', serviceName: 'A项', prices: { round: 10 }, createdAt: 1700000000000 },
                { kind: 'exact', serviceName: 'B项', prices: { round: 20 }, createdAt: 1700000000001 },
                { kind: 'exact', serviceName: 'C项', prices: { round: 30 }, createdAt: 1700000000002 },
                { kind: 'exact', serviceName: 'D项', prices: { round: 40 }, createdAt: 1700000000003 },
              ],
            }],
          });
          const before2 = r2.libraries[0].rules.map(r => r.id);
          // 删掉第一条（不是最后一条）
          r2.libraries[0].rules = r2.libraries[0].rules.filter((_, i) => i !== 0);
          const after2 = st2.normalizeData(r2).libraries[0].rules.map(r => r.id);
          const surv = before2.filter((_, i) => i !== 0);
          let kp = 0;
          for (let i = 0; i < surv.length; i++) if (surv[i] === after2[i]) kp++;
          dom2.window.close();
          try { fs2.unlinkSync(tmp); } catch (e) {}
          // 带序号时，删掉第一条会让原来第 2 条变成第 1 条 → 它的 id 也跟着变
          return kp < surv.length;
        })();
      } catch (e) {
        caught = true;
      }
      ck('把「序号」放回 id 里之后，删掉前一条会让后面 id 全变（断言确实能变红）', caught);
    }
  }

  dom.window.close();
  console.log('\n' + (fail ? `失败 ${fail} 项` : '全部通过：id 反复载入稳定、增删邻居不影响、跨库不撞车'));
  process.exit(fail ? 1 : 0);
})();
