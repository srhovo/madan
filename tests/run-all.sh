#!/usr/bin/env bash
# 码单器 · 统一测试入口
#
# 一次跑完全部防线，最后给出汇总退出码，便于挂 CI。
#
# 用法:
#   bash tests/run-all.sh                  # 全量（含约 4 分钟的变异测试）
#   bash tests/run-all.sh --fast           # 跳过变异测试（日常提交用）
#   bash tests/run-all.sh --only=engine    # 只跑某一套
#   bash tests/run-all.sh --require-package # 当前版本没有对应 zip 即判失败（CI/发版用）
#
# 可用 --only 值: engine | chunk | arch | chain | dom | combo | fullchain | mutate | package | version
#
# 退出码: 0 全通过 / 1 有套件失败
set -u

cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
HTML="$ROOT/index.html"
VERSION="$(grep -oE "APP_VERSION[[:space:]]*=[[:space:]]*'[0-9.]+'" "$HTML" | head -1 | grep -oE "[0-9]+\.[0-9]+\.[0-9]+")"
OUT="$ROOT/.test-out"
mkdir -p "$OUT"

FAST=0
ONLY=""
REQUIRE_PACKAGE=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --only=*) ONLY="${arg#--only=}" ;;
    --require-package) REQUIRE_PACKAGE=1 ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

echo "==================================================================="
echo " 码单器测试总入口   版本: ${VERSION:-未知}   模式: $([ $FAST -eq 1 ] && echo '快速（跳过变异测试）' || echo '全量')"
echo "==================================================================="

PASS=0
FAIL=0
declare -a RESULTS

# 跳过标记：$1=套件名，命中则返回 0
should_skip() { [ -n "$ONLY" ] && [ "$ONLY" != "$1" ]; }

# 从 JSON 报告里数「通过/总数」——dom-full.js / combo.js 不打印计数，只能读文件
count_json() {
  python3 - "$1" <<'PY' 2>/dev/null
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
ch = d.get('checks', d)
items = list(ch.items()) if isinstance(ch, dict) else []
ok = sum(1 for _, v in items if (v if isinstance(v, bool) else v.get('ok')))
print(f'{ok}/{len(items)} ok' if items else '无断言')
PY
}

run_suite() {
  local key="$1" label="$2" rc="$3" detail="$4"
  if [ "$rc" -eq 0 ]; then
    RESULTS+=("通过  $label  $detail")
    PASS=$((PASS + 1))
  else
    RESULTS+=("失败  $label  $detail (exit $rc)")
    FAIL=$((FAIL + 1))
  fi
}

# ── 1. 引擎单元测试 ────────────────────────────────────────────────
if ! should_skip engine; then
  echo
  echo "── [1/11] 引擎单元测试 test-engine.js ─────────────────────────"
  if [ -z "$VERSION" ]; then
    echo "  ✗ 无法从 index.html 解析 APP_VERSION"
    run_suite engine "引擎单元测试" 1 "无法解析版本号"
  else
    out=$(node test-engine.js "$HTML" "$VERSION" 2>&1)
    rc=$?
    echo "$out" | tail -3
    line=$(echo "$out" | grep -oE "[0-9]+ passed, [0-9]+ failed" | tail -1)
    run_suite engine "引擎单元测试" $rc "${line:-无输出}"
  fi
fi

# ── 2. 内联 chunk 源码一致性（A4 新增）─────────────────────────────
# 背景：dataPortability / durationCalculator 两个 Feature 的源码被转义后存在
# index.html 的 __INLINE_CHUNKS_RAW__ 单行字符串里，编辑器无法索引，是全项目
# 最大的维护盲区。A4 起把源码落到 src/chunks/*.js，index.html 里的副本由
# tools/build-inline-chunks.js 生成。这道防线盯「有人改了 src 却忘了重新生成」。
if ! should_skip chunk; then
  echo
  echo "── [2/11] 内联 chunk 源码一致性 build-inline-chunks.js --check ──"
  out=$(node tools/build-inline-chunks.js --check 2>&1)
  rc=$?
  echo "$out" | tail -6
  line=$(echo "$out" | grep -oE "（[0-9]+ 个 chunk）" | tail -1)
  run_suite chunk "内联 chunk 源码一致性" $rc "${line:-无输出}"
  # 同时跑既有的内联完整性防线（update-checker/analytics 两份内联副本 + 原生壳冒烟）
  inline_out=$(node tests/inline-integrity.js 2>&1)
  inline_rc=$?
  inline_line=$(echo "$inline_out" | grep -oE "全部通过|失败 [0-9]+ 项" | tail -1)
  run_suite inline "内联完整性 inline-integrity.js" $inline_rc "${inline_line:-无输出}"
  # 根级脚本（update-checker/analytics）源文件与内联副本的一致性
  root_out=$(node tools/sync-root-scripts.js --check 2>&1)
  root_rc=$?
  run_suite rootsync "根级脚本内联同步" $root_rc "$(echo "$root_out" | grep -oE '一致|不一致 [0-9]+ 项' | tail -1)"
fi

# ── 3. 架构边界快照（A3 遗留防线）─────────────────────────────────
# 8.3.33 修的两类问题（bindToApp 隐式动态挂载、字符串数组动态派发）都是
# 「静默失效」：不报错、不崩溃，只是某个功能悄悄不工作了。静态扫描抓不住
# （本项目已验证会给出假绿灯），只有运行时原型链内省可靠。本套件把
# app 方法集合 / state 键集合 / featureOrder 冻结成基线，任何变化都必须
# 显式更新基线，从而迫使改动者回答「这个增删是有意的吗」。
if ! should_skip arch; then
  echo
  echo "── [3/11] 架构边界快照 arch-snapshot.js ─────────────────────"
  out=$(node tests/arch-snapshot.js 2>&1)
  rc=$?
  echo "$out" | tail -8
  run_suite arch "架构边界快照" $rc "$(echo "$out" | grep -oE 'app 方法 [0-9]+ · state 键 [0-9]+ · feature [0-9]+' | tail -1)"
fi

# ── 3. 喂入链路 ────────────────────────────────────────────────────
if ! should_skip chain; then
  echo
  echo "── [4/11] 喂入链路 project-chain.js ───────────────────────────"
  out=$(node tests/project-chain.js "$HTML" "$OUT/project-chain.json" 2>&1)
  rc=$?
  echo "$out" | tail -4
  line=$(echo "$out" | grep -oE "project-chain: [0-9]+/[0-9]+ passed" | tail -1)
  run_suite chain "喂入链路" $rc "${line:-无输出}"
fi

# ── 3. DOM 全链路 ──────────────────────────────────────────────────
if ! should_skip dom; then
  echo
  echo "── [5/11] DOM 全链路 dom-full.js ──────────────────────────────"
  out=$(node tests/dom-full.js "$HTML" "$OUT/domfull.json" 2>&1)
  rc=$?
  echo "$out" | tail -3
  run_suite dom "DOM 全链路" $rc "$(count_json "$OUT/domfull.json")"
fi

# ── 4. 组合联动 ────────────────────────────────────────────────────
if ! should_skip combo; then
  echo
  echo "── [6/11] 组合联动 combo.js ───────────────────────────────────"
  out=$(node tests/combo.js "$HTML" "$OUT/combo.json" 2>&1)
  rc=$?
  echo "$out" | tail -3
  run_suite combo "组合联动" $rc "$(count_json "$OUT/combo.json")"
fi

# ── 5. 五段式全链路 ────────────────────────────────────────────────
# 注意：该脚本在仓库中的文件名是中文长名，不是 fullchain.py。
# 这里用变量集中定义一次，避免改名时散落多处漏改。
FULLCHAIN="tests/码单器8.3_AI可运行全链路测试脚本_8.3架构版.py"
if ! should_skip fullchain; then
  echo
  echo "── [7/11] 五段式全链路 $(basename "$FULLCHAIN") ──────────"
  if [ ! -f "$FULLCHAIN" ]; then
    run_suite fullchain "五段式全链路" 1 "脚本不存在: $FULLCHAIN"
  else
    out=$(python3 "$FULLCHAIN" --html "$HTML" --report-dir "$ROOT/report" 2>&1)
    rc=$?
    echo "$out" | grep -E "通过|失败" | head -8
    run_suite fullchain "五段式全链路" $rc "见 report/"
  fi
fi

# ── 6. 变异测试（测试自身的质量门禁）────────────────────────────────
if ! should_skip mutate; then
  if [ $FAST -eq 1 ]; then
    echo
    echo "── [8/11] 变异测试 mutate-chain.py  （--fast 已跳过）────────────"
  else
    echo
    echo "── [8/11] 变异测试 mutate-chain.py  （约 4 分钟）──────────────"
    out=$(python3 tests/mutate-chain.py 2>&1)
    rc=$?
    echo "$out" | tail -25
    line=$(echo "$out" | grep -oE "变异捕捉率: [0-9]+/[0-9]+" | tail -1)
    run_suite mutate "变异测试" $rc "${line:-无输出}"
  fi
fi

# ── 7. OTA 包自包含性（8.3.30 新增）────────────────────────────────
# 背景：8.3.26~8.3.29 的包只打了 index.html，而 index.html 仍引用
# update-checker.js / analytics.js，包内却没有 → 安卓端无限重载。
# 这道防线专门盯「包内 index.html 是否引用了包外不存在的资源」。
if ! should_skip package; then
  echo
  echo "── [9/11] OTA 包自包含性 check-package-selfcontained.py ──────"
  # 找当前版本对应的 zip；找不到就跳过（例如只改代码、尚未打包）
  ZIP=""
  for f in "$ROOT"/madan-*.zip; do
    [ -e "$f" ] || continue
    case "$(basename "$f")" in
      "madan-${VERSION}.zip") ZIP="$f" ;;
    esac
  done
  if [ -z "$ZIP" ]; then
    # 这里曾经是「静默跳过」，是个危险的洞：发版时若改了版本号却忘了打包，
    # 本套件会显示「通过 0 套 / 失败 0 套」并 exit 0 —— 全绿放行。
    # 而这正是 8.3.24 事故（version.json 版本 ≠ 包内版本 → 无限更新循环）的形状。
    # --require-package 把「跳过」改判为「失败」，供 CI 与发版流程使用；
    # 本地日常改代码（确实还没打包）仍保持宽松。
    if [ $REQUIRE_PACKAGE -eq 1 ]; then
      echo "  ✗ 未找到 madan-${VERSION}.zip，但本次以 --require-package 运行"
      echo "    版本号已改为 ${VERSION} 却没有对应的更新包 —— 这正是无限更新循环的成因。"
      run_suite package "OTA 包自包含性" 1 "缺少 madan-${VERSION}.zip"
    else
      echo "  （未找到 madan-${VERSION}.zip，跳过——仅改代码未打包时属正常）"
      echo "    提示：发版与 CI 场景请加 --require-package，把此处改为强制失败。"
    fi
  else
    out=$(python3 tests/check-package-selfcontained.py "$ZIP" 2>&1)
    rc=$?
    echo "$out" | tail -6
    run_suite package "OTA 包自包含性" $rc "$(basename "$ZIP")"
  fi
fi

# ── 11. 版本号单一真源（B2 新增）───────────────────────────────────
# 背景：index.html 里 8.3.x 字样共 165 处，但其中 163 处是注释（变更考古，应保留），
# 真正参与代码的只有 <title> 与 APP_VERSION 两处。风险是将来有人写出一处
# 「参与运行时判断的硬编码版本号」（如 compareVersions('8.3.20', ...)），
# 形成静默的第二真源 —— 发版时忘改它，功能会悄悄走错分支。
# 本套件剥离注释、排除标签属性（SVG path 坐标天然含 x.y.z 形状）后，
# 只允许版本号出现在白名单的 2 个位置，并交叉校验 title↔APP_VERSION↔version.json↔zip。
if ! should_skip version; then
  echo
  echo "── [10/11] 版本号单一真源 version-single-source.js ────────────"
  out=$(node tests/version-single-source.js 2>&1)
  rc=$?
  echo "$out" | tail -8
  line=$(echo "$out" | grep -oE "参与代码的版本号出现位置：[0-9]+ 处" | tail -1)
  run_suite version "版本号单一真源" $rc "${line:-无输出}"
fi

# ── 汇总 ───────────────────────────────────────────────────────────
echo
echo "==================================================================="
echo " 汇总"
echo "==================================================================="
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "-------------------------------------------------------------------"
echo " 通过 $PASS 套 / 失败 $FAIL 套"
if [ $FAIL -eq 0 ]; then
  echo " ✓ 全部通过"
else
  echo " ✗ 存在失败，详见上方各套件输出"
fi
echo "==================================================================="

[ $FAIL -eq 0 ] || exit 1
exit 0
