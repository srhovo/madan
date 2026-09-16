#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""变异测试：向 index.html 注入「喂入链路」级别的缺陷，验证 tests/project-chain.js 能抓住。

与 /tmp/mutate.py（面向 test-engine.js，改的是引擎内部算法）不同，
本脚本改的是**界面事件 → 状态 → 结算 → 渲染**这条链路，
每条变异都对应 CHANGELOG 里记录过的真实历史 bug。若抓不住，说明该防线是「假的绿」。

注意：index.html 主脚本内部使用 1 空格缩进（非 2/4 空格），锚点必须按实际文本匹配。
"""
import io, os, re, subprocess, sys, tempfile

# 路径相对脚本自身定位，保证仓库克隆到任意目录都能跑。
# （早先版本写死了一个绝对路径，只在开发机上有效，属可移植性缺陷。）
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'index.html')
TEST = os.path.join(ROOT, 'tests', 'project-chain.js')

MUTATIONS = [
    # ── 加价落位链路 ──────────────────────────────────────────────
    (
        'C1 数字加价忽略 targetIndex（回归 8.3.21 修复）',
        "let manualIndexes = sourceProjects.map((_, index) => index);\n if (sourceProjects.length > 1 && !targetAll && targetIndex >= 0 && targetIndex < sourceProjects.length) {\n manualIndexes = [targetIndex];\n }",
        "let manualIndexes = sourceProjects.map((_, index) => index);",
    ),
    (
        'C2 备注重新参与加价（回归 8.3.19 决策）',
        "const combinedNote = surchargeText;",
        "const combinedNote = (String(note ?? '') + ' ' + surchargeText).trim();",
    ),
    # C3 原拟「把带加价的项目写回 orderProjects」。
    # 实测该变异**不改变任何行为**：resolveProjects 返回的 projects 在
    # render:false 且无 targetIndex 时与入参同构，且下游渲染读的是
    # pricedAggregate 而非 orderProjects，因此写不写回观察不到差异。
    # 结论：orderProjects 与结算结果本就是两条数据流，不存在「污染」路径。
    # 改用真正会破坏「基础价独立性」的变异：让 createProject 把加价并进基础单价
    # （即历史上最典型的「加价被固化进单价」缺陷）。
    (
        'C3 加价并入基础单价（加价被固化，破坏基础价独立性）',
        "unitPrice: baseUnitPrice,\n baseUnitPrice,\n surchargeUnitPrice,",
        "unitPrice: effectiveUnitPrice,\n baseUnitPrice: effectiveUnitPrice,\n surchargeUnitPrice: 0,",
    ),
    # ── 单位换算链路 ─────────────────────────────────────────────
    (
        'C4 1h 不再按 3 局换算（局数模式）',
        "static parseQuantity(raw, mode = 'round') {",
        "static parseQuantity(raw, mode = 'round') { if (String(raw).trim() === '1h' && mode === 'round') return { ok: true, raw: String(raw).trim(), unit: 'hour', amount: 1, quantityMode: 'round', billingQuantity: 1, calculationQuantity: 1, durationMinutes: 60 };",
    ),
    # ── 渲染链路 ────────────────────────────────────────────────
    (
        'C5 小计改用基础项目渲染（丢掉加价）',
        "pricedPriceBreakdown: feature.formatProjectPriceBreakdown(pricedAggregate.projects, pricedAggregate),",
        "pricedPriceBreakdown: feature.formatProjectPriceBreakdown(baseAggregate.projects, baseAggregate),",
    ),
    (
        'C6 金额截断为整数（丢掉小数）',
        "static roundThree(value) {",
        "static roundThree(value) { return Math.round(Number(value) || 0);",
    ),
    # ── 刷新链路（8.3.26 / 8.3.27 病灶）──────────────────────────
    (
        'C7 加价框输入不再触发重算（刷新断链）',
        "refreshOrderPreview() {\n if (!this.autoPriceFeature?.syncUI) return false;",
        "refreshOrderPreview() {\n if (true) return false;\n if (!this.autoPriceFeature?.syncUI) return false;",
    ),
    (
        'C8 切单位后表达式不再重算（回归 8.3.26 修复）',
        "if (changed && this._expressionActive) {",
        "if (false && changed && this._expressionActive) {",
    ),
    # C9 原拟「服务类型框清空后不再清理项目」。
    # 实测该变异**不改变任何行为**（见下方 diagnosed_as 说明）。
    # 改用同族但会真正断链的变异：让结算快照不再按「加价框内容」失效，
    # 于是改了加价框但缓存命中旧结果 —— 这就是 8.3.26「按钮点了不重算」的同款病灶。
    (
        'C9 结算快照不再随加价框失效（缓存命中旧结果）',
        "surcharge: String(feature.getElement('surcharge')?.value || ''),",
        "surcharge: '',",
    ),
]


def run(html, out):
    p = subprocess.run(['node', TEST, html, out], cwd=ROOT, capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


COMBO = os.path.join(ROOT, 'tests', 'combo.js')


def run_combo(html, out):
    """跑 combo.js，返回 (是否抓住, 失败断言名列表)。"""
    p = subprocess.run(['node', COMBO, html, out], cwd=ROOT, capture_output=True, text=True)
    try:
        d = json.load(io.open(out, encoding='utf-8'))
        ch = d.get('checks', d)
        bad = [k for k, v in ch.items() if not (v if isinstance(v, bool) else v.get('ok'))]
    except Exception:
        bad = []
    return (p.returncode != 0 or bool(bad)), bad


# 双套件交叉验证。
#
# 背景：combo.js 曾在「备注重新参与加价（8.3.19）」上是**真盲区**——
# 它的 combo2 场景只断言 okCalc === true，注入该变异后仍 exit 0。
# 该盲区已于 2026-09-14 加固（补齐数值/状态断言），现存 **C2** 为回归看护对象。
#
# 其余变异（C1/C7/C9）**故意不纳入**：
#   它们是「单条加价链路的力学」，而 combo.js 的职责是**跨模块协同**
#   （见其文件头：价格库→码单→历史→老板记忆 等组合场景）。
#   把单路径力学塞进组合测试会让两个套件职责重叠、维护成本翻倍。
#   这几条由 project-chain.js 专属覆盖，无需 combo.js 重复。
CROSSCHECK = [1]   # 仅 C2（8.3.19 备注不参与加价）—— 曾经的盲区，长期看护


def main():
    base = io.open(SRC, encoding='utf-8').read()
    rc0, out0 = run(SRC, '/tmp/_pc_base.json')
    m = re.search(r'project-chain: (\d+)/(\d+) passed', out0)
    print(f'基线: {m.group(0) if m else out0.strip()[:200]} (exit {rc0})\n')
    if rc0 != 0:
        print('基线不干净，终止'); return 1
    okc, badc = run_combo(SRC, '/tmp/_combo_base.json')
    print(f'combo.js 基线: {"干净" if not okc else "不干净 " + str(badc)}\n')
    if okc:
        print('combo.js 基线不干净，终止'); return 1

    caught, missed, unanchored = [], [], []
    for name, old, new in MUTATIONS:
        if old not in base:
            print(f'[锚点未命中] {name}')
            unanchored.append(name)
            continue
        tmp = tempfile.NamedTemporaryFile('w', suffix='.html', delete=False, encoding='utf-8')
        tmp.write(base.replace(old, new, 1))
        tmp.close()
        rc, out = run(tmp.name, '/tmp/_pc_mut.json')
        fails = [l.strip()[6:] for l in out.split('\n') if l.startswith('FAIL:')]
        mm = re.search(r'project-chain: (\d+)/(\d+) passed', out)
        if rc != 0:
            print(f'[抓住] {name}')
            print(f'       {mm.group(0) if mm else ""}  例: {fails[:2]}')
            caught.append(name)
        else:
            print(f'[漏掉] {name}  -> {mm.group(0) if mm else out.strip()[:150]} (exit {rc})')
            missed.append(name)
        os.unlink(tmp.name)

    # ── 交叉验证：这些变异 combo.js 是否也能抓住？────────────────
    # 曾经的事实：注入 C2（备注重新参与加价）后 combo.js **仍 exit 0**，
    # 因为 combo2 场景只断言 okCalc === true。现已加固，这里做回归看护。
    print('\n交叉验证（combo.js 是否也会报警 · 仅看护曾经的盲区）:')
    cross_fail = []
    for idx in CROSSCHECK:
        name, old, new = MUTATIONS[idx]
        if old not in base:
            print(f'  [跳过] {name}（锚点未命中）')
            continue
        tmp = tempfile.NamedTemporaryFile('w', suffix='.html', delete=False, encoding='utf-8')
        tmp.write(base.replace(old, new, 1))
        tmp.close()
        got, bad = run_combo(tmp.name, '/tmp/_combo_mut.json')
        flag = '也抓住' if got else '★ 未抓住（盲区）'
        print(f'  [{flag}] {name}')
        if bad:
            print(f'           {bad[:3]}')
        if not got:
            cross_fail.append(name)
        os.unlink(tmp.name)

    total = len(MUTATIONS)
    print(f'\n变异捕捉率: {len(caught)}/{total}（project-chain.js）')
    print(f'交叉覆盖: {len(CROSSCHECK) - len(cross_fail)}/{len(CROSSCHECK)}（combo.js）')
    if unanchored:
        print('锚点未命中（需按实际缩进重写）:')
        for x in unanchored:
            print('  -', x)
    if missed:
        print('未被捕捉（防线是假的绿）:')
        for x in missed:
            print('  -', x)
    if cross_fail:
        print('combo.js 未覆盖（仍是盲区）:')
        for x in cross_fail:
            print('  -', x)
    return 0 if not (missed or unanchored) else 2


if __name__ == '__main__':
    sys.exit(main())
