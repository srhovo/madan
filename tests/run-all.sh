#!/usr/bin/env bash
# 码单器 · 统一测试入口
#
# 一次跑完全部防线，最后给出汇总退出码，便于挂 CI。
#
# 用法:
#   bash tests/run-all.sh                  # 全量（含约 4 分钟的变异测试）
#   bash tests/run-all.sh --fast           # 跳过变异测试（日常提交用）
#   bash tests/run-all.sh --only=engine    # 只跑某一套
#
# 可用 --only 值: engine | chain | dom | combo | fullchain | mutate
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
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --only=*) ONLY="${arg#--only=}" ;;
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
  echo "── [1/6] 引擎单元测试 test-engine.js ─────────────────────────"
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

# ── 2. 喂入链路 ────────────────────────────────────────────────────
if ! should_skip chain; then
  echo
  echo "── [2/6] 喂入链路 project-chain.js ───────────────────────────"
  out=$(node tests/project-chain.js "$HTML" "$OUT/project-chain.json" 2>&1)
  rc=$?
  echo "$out" | tail -4
  line=$(echo "$out" | grep -oE "project-chain: [0-9]+/[0-9]+ passed" | tail -1)
  run_suite chain "喂入链路" $rc "${line:-无输出}"
fi

# ── 3. DOM 全链路 ──────────────────────────────────────────────────
if ! should_skip dom; then
  echo
  echo "── [3/6] DOM 全链路 dom-full.js ──────────────────────────────"
  out=$(node tests/dom-full.js "$HTML" "$OUT/domfull.json" 2>&1)
  rc=$?
  echo "$out" | tail -3
  run_suite dom "DOM 全链路" $rc "$(count_json "$OUT/domfull.json")"
fi

# ── 4. 组合联动 ────────────────────────────────────────────────────
if ! should_skip combo; then
  echo
  echo "── [4/6] 组合联动 combo.js ───────────────────────────────────"
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
  echo "── [5/6] 五段式全链路 $(basename "$FULLCHAIN") ──────────"
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
    echo "── [6/6] 变异测试 mutate-chain.py  （--fast 已跳过）────────────"
  else
    echo
    echo "── [6/6] 变异测试 mutate-chain.py  （约 4 分钟）──────────────"
    out=$(python3 tests/mutate-chain.py 2>&1)
    rc=$?
    echo "$out" | tail -25
    line=$(echo "$out" | grep -oE "变异捕捉率: [0-9]+/[0-9]+" | tail -1)
    run_suite mutate "变异测试" $rc "${line:-无输出}"
  fi
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
