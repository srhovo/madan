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
#   bash tests/run-all.sh --release-flow   # 发版流程中调用：允许「zip 刚生成尚未 git add」
#
# 可用 --only 值: engine | chunk | arch | chain | dom | combo | fullchain | mutate | giftcombo | package | version | alias | historyrefill | hints | giftqty | hintlayout | giftfill | giftfillui | multilibrary | metalayout | ruleid
#
# 退出码: 0 全通过 / 1 有套件失败
set -u

cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
HTML="$ROOT/index.html"
VERSION="$(grep -oE "APP_VERSION[[:space:]]*=[[:space:]]*'[0-9]+\.[0-9]+\.[0-9]+(-test\.[0-9]+)?'" "$HTML" | head -1 | grep -oE "[0-9]+\.[0-9]+\.[0-9]+(-test\.[0-9]+)?")"
OUT="$ROOT/.test-out"
mkdir -p "$OUT"

FAST=0
ONLY=""
REQUIRE_PACKAGE=0
RELEASE_FLOW=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --only=*) ONLY="${arg#--only=}" ;;
    --require-package) REQUIRE_PACKAGE=1 ;;
    --release-flow) RELEASE_FLOW=1 ;;
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
  echo "── [1/20] 引擎单元测试 test-engine.js ─────────────────────────"
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
  echo "── [2/20] 内联 chunk 源码一致性 build-inline-chunks.js --check ──"
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
  echo "── [3/20] 架构边界快照 arch-snapshot.js ─────────────────────"
  out=$(node tests/arch-snapshot.js 2>&1)
  rc=$?
  echo "$out" | tail -8
  run_suite arch "架构边界快照" $rc "$(echo "$out" | grep -oE 'app 方法 [0-9]+ · state 键 [0-9]+ · feature [0-9]+' | tail -1)"
fi

# ── 3. 喂入链路 ────────────────────────────────────────────────────
if ! should_skip chain; then
  echo
  echo "── [4/20] 喂入链路 project-chain.js ───────────────────────────"
  out=$(node tests/project-chain.js "$HTML" "$OUT/project-chain.json" 2>&1)
  rc=$?
  echo "$out" | tail -4
  line=$(echo "$out" | grep -oE "project-chain: [0-9]+/[0-9]+ passed" | tail -1)
  run_suite chain "喂入链路" $rc "${line:-无输出}"
fi

# ── 3. DOM 全链路 ──────────────────────────────────────────────────
if ! should_skip dom; then
  echo
  echo "── [5/20] DOM 全链路 dom-full.js ──────────────────────────────"
  out=$(node tests/dom-full.js "$HTML" "$OUT/domfull.json" 2>&1)
  rc=$?
  echo "$out" | tail -3
  run_suite dom "DOM 全链路" $rc "$(count_json "$OUT/domfull.json")"
fi

# ── 4. 组合联动 ────────────────────────────────────────────────────
if ! should_skip combo; then
  echo
  echo "── [6/20] 组合联动 combo.js ───────────────────────────────────"
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
  echo "── [7/20] 五段式全链路 $(basename "$FULLCHAIN") ──────────"
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
    echo "── [8/20] 变异测试 mutate-chain.py  （--fast 已跳过）────────────"
  else
    echo
    echo "── [9/20] 变异测试 mutate-chain.py  （约 4 分钟）──────────────"
    out=$(python3 tests/mutate-chain.py 2>&1)
    rc=$?
    echo "$out" | tail -25
    line=$(echo "$out" | grep -oE "变异捕捉率: [0-9]+/[0-9]+" | tail -1)
    run_suite mutate "变异测试" $rc "${line:-无输出}"
  fi
fi

# ── 10. 礼物码单的组合语法与按模式隐藏 ───────────────────────────
# 背景：8.3.41 让礼物码单支持「5满天星+3同心结」这种多礼物写法，
#   并顺手把礼物码单下没意义的「服务时长」那一组藏掉。这两件事都直接
#   关系到钱和「点不点得到」，必须钉死：
#   ① 组合解析的数量在前/在后、没写数量按 1 个、名称里的数字不当作数量；
#   ② 查不到单价的礼物绝不给总价（宁可让用户看到 ⚠ 提示，也不能算半个数）；
#   ③ 「按模式隐藏」是规则不是偏好 —— 不能退化成写进 hiddenModules，
#      否则用户动过一次布局偏好就可能把时长框勾回来；
#   ④ 服务类型提示分两套文案，且单子码单那条长文案有字号兜底不被截断；
#   ⑤ 礼物码单里禁用了「软提示抢字」—— 否则用户打不出数字和加号。
if ! should_skip giftcombo; then
  echo
  echo "── [10/20] 礼物组合与按模式隐藏 gift-combo.js ─────────────────"
  out=$(node tests/gift-combo.js 2>&1)
  rc=$?
  echo "$out" | tail -6
  line=$(echo "$out" | grep -oE "失败 [0-9]+ 项" | tail -1)
  [ -z "$line" ] && line=$(echo "$out" | grep -oE "全部通过.*" | tail -1)
  run_suite giftcombo "礼物组合与按模式隐藏" $rc "${line:-无输出}"
fi

# ── 7. OTA 包自包含性（8.3.30 新增）────────────────────────────────
# 背景：8.3.26~8.3.29 的包只打了 index.html，而 index.html 仍引用
# update-checker.js / analytics.js，包内却没有 → 安卓端无限重载。
# 这道防线专门盯「包内 index.html 是否引用了包外不存在的资源」。
if ! should_skip package; then
  echo
  echo "── [11/20] OTA 包自包含性 check-package-selfcontained.py ──────"
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
  echo "── [12/20] 版本号单一真源 version-single-source.js ────────────"
  # --release-flow：发版脚本刚打完包、尚未 git add 时调用，
  # 此时「zip 未被跟踪」是预期中间态（git add 由人在收到提示后执行），
  # 不该据此判失败 —— 否则发版流程会自锁。
  # 常规提交与 CI 不带此参数，检查依旧强制。
  VER_ARGS=()
  [ $RELEASE_FLOW -eq 1 ] && VER_ARGS+=(--release-flow)
  out=$(node tests/version-single-source.js "${VER_ARGS[@]}" 2>&1)
  rc=$?
  echo "$out" | tail -8
  line=$(echo "$out" | grep -oE "参与代码的版本号出现位置：[0-9]+ 处" | tail -1)
  run_suite version "版本号单一真源" $rc "${line:-无输出}"
fi

# ── 11. 精确项目「其他名字」（多别名）────────────────────────────
# 背景：8.3.37 新增「一个精确项目可挂多个具体名称」——
# 如「其他手游」下可有 蛋仔派对 / 和平精英 / 手瓦，用户填任一个都能命中所属项目的价。
# 这是一项【新增能力】，上面 10 套防线全部写于它之前，对它零覆盖，
# 所以需要一套专项套件，并且必须自带反向验证（拆掉能力后要变红），
# 否则它只会是一堆恒真的假断言。
if ! should_skip alias; then
  echo
  echo "── [13/20] 精确项目多别名 price-alias.js ─────────────────────"
  out=$(node tests/price-alias.js 2>&1)
  rc=$?
  echo "$out" | tail -6
  line=$(echo "$out" | grep -oE "通过 [0-9]+ / 失败 [0-9]+" | tail -1)
  [ -z "$line" ] && line=$(echo "$out" | grep -oE "全部通过.*" | tail -1)
  run_suite alias "精确项目多别名" $rc "${line:-无输出}"
fi

# ── 12. 历史记录「编辑回填」详情同步 ──────────────────────────────
# 背景：8.3.37 修复「从历史点编辑回填后，右侧结果区仍停在上一条，
# 必须再点一下输入框才会显示」的长期缺陷。
# 这一套同样自带反向验证 —— 把 recalculate 改回 false 必须变红，
# 否则它只是一堆恒真的假断言（项目历史上踩过这个坑，见 tests/README.md）。
if ! should_skip historyrefill; then
  echo
  echo "── [14/20] 历史编辑回填详情同步 history-refill.js ────────────"
  out=$(node tests/history-refill.js 2>&1)
  rc=$?
  echo "$out" | tail -6
  line=$(echo "$out" | grep -oE "通过 [0-9]+ / 失败 [0-9]+" | tail -1)
  [ -z "$line" ] && line=$(echo "$out" | grep -oE "全部通过.*" | tail -1)
  run_suite historyrefill "历史编辑回填详情同步" $rc "${line:-无输出}"
fi

# ── 13. 辅助提示随实际情况变化 ────────────────────────────────────
# 背景：8.3.38 把礼物码单折数提示从静态说明改为跟着状态走的动态文案
# （折数未填 / 已填无总价 / 已填有总价 三种说法，金额还要跟着总价走）。
# 这套的重点不在「文案对不对」，而在**刷新链路还在不在**：
#   handleMainInput → app.updateGiftDiscountNote → ModeFlowFeature
# 任何一环掉链子，表现都是「文案永远停在默认那句」—— 而默认那句本身合法，
# 只断言文案值的测试根本发现不了。因此本套额外断言链路各环存在，
# 并带反向验证（拆文案 / 删转发 / 误用 this.currentMode 三种改坏方式都必须变红）。
if ! should_skip hints; then
  echo
  echo "── [15/20] 辅助提示动态化 hint-dynamic.js ────────────────────"
  out=$(node tests/hint-dynamic.js 2>&1)
  rc=$?
  echo "$out" | tail -6
  line=$(echo "$out" | grep -oE "失败 [0-9]+ 项" | tail -1)
  [ -z "$line" ] && line=$(echo "$out" | grep -oE "全部通过.*" | tail -1)
  run_suite hints "辅助提示动态化" $rc "${line:-无输出}"
fi

# ── 15. 礼物码单「单价 × 个数 = 总价」 ────────────────────────────
# 背景：8.3.39 让礼物码单下「自定义单价」那一排真的参与算钱。
# 这条链路上有三个隐性坑，本套逐一钉住：
#   ① 个数框是动态注入的，抓元素时还不存在 → 绑不上事件。
#      症状是「先填单价再填个数不出结果，反过来却出」——看顺序的 bug，极难复现。
#   ② 清空个数后总价残留。
#   ③ 切回单子码单时礼物残留串过去；但用户手填的总价绝不能被当礼物结果清掉。
# 另有显隐控制：这两个控件曾被样式表里十几条同名字号/尺寸规则轮流盖回来，
# 单子模式下个数框照样显示；现在唯一真源是 hidden 属性，本套断言样式表里
# 不再有 display 切换规则，并附 5 种反向改坏方式必须变红。
if ! should_skip giftqty; then
  echo
  echo "── [16/20] 礼物单价×个数 gift-quantity.js ────────────────────"
  out=$(node tests/gift-quantity.js 2>&1)
  rc=$?
  echo "$out" | tail -6
  line=$(echo "$out" | grep -oE "失败 [0-9]+ 项" | tail -1)
  [ -z "$line" ] && line=$(echo "$out" | grep -oE "全部通过.*" | tail -1)
  run_suite giftqty "礼物单价×个数" $rc "${line:-无输出}"
fi

# ── 16. 输入框提示文案 + 动态控件类名 ─────────────────────────────
# 背景：8.3.40 修了两类**不报错、只在界面上静默表现**的毛病：
#   ① 动态注入控件时属性名写成 className，渲染出 classname="..." ——
#      浏览器不认识，元素上没有 class，所有靠 class 的选择器整批失效。
#      礼物个数框的尺寸规则就是这样全死的，表现为「改了 CSS 毫无反应」。
#   ② 提示文案三种劣化：消失（派单/陪陪被删成空白）、截断（服务类型/备注）、
#      挤压（加价框两行被折成三行）。
# 这套跑在**真实浏览器**里 —— 这两类问题的本质是「渲染出来才知道」，
# 纯字符串检查抓不住。含反向验证（改回 classname 后真的会丢 class）。
if ! should_skip hintlayout; then
  echo
  echo "── [17/22] 提示文案与控件类名 hint-layout.js ─────────────────"
  out=$(node tests/hint-layout.js 2>&1)
  rc=$?
  echo "$out" | tail -6
  line=$(echo "$out" | grep -oE "失败 [0-9]+ 项" | tail -1)
  [ -z "$line" ] && line=$(echo "$out" | grep -oE "全部通过.*" | tail -1)
  run_suite hintlayout "提示文案与控件类名" $rc "${line:-无输出}"
fi

# ── 18. 逐项补价 + 纯数字候选 + 版本号机制 ────────────────────────
# 背景：8.3.42 修了两个用户直接报上来的缺陷 ——
#   ① 礼物码单写「5满天星+3同心结」时，那一排只装得下第一个礼物，
#      第二个礼物没地方补单价，总价永远算不出来。现在改成
#      「填一个价 → 按确定 → 自动换下一个」，补完自动出总价。
#   ② 服务类型框里只输一个数字（如刚敲下「5」）时候选会消失。
#      根因是「5」被当成礼物名去查库，一个都不中就把候选收起来了。
# 另含版本号机制的常驻校验：未推送的改动一律走 -test.N 测试号，
# 正式发行时对照仓库已发行版顺位，不占正式版本序列。
if ! should_skip giftfill; then
  echo
  echo "── [18/22] 逐项补价与纯数字候选 gift-fill.js ─────────────────"
  out=$(node tests/gift-fill.js 2>&1)
  rc=$?
  echo "$out" | tail -6
  line=$(echo "$out" | grep -oE "失败 [0-9]+ 项" | tail -1)
  [ -z "$line" ] && line=$(echo "$out" | grep -oE "全部通过.*" | tail -1)
  run_suite giftfill "逐项补价与纯数字候选" $rc "${line:-无输出}"
fi

# ── 19. 补价那一排的宽度与按钮可见性 ──────────────────────────────
# 背景：8.3.43 修了用户附截图报上来的界面缺陷，以及修它时连带发现的两个更深的问题 ——
#   ① 「确定·换XX」按钮的文字被裁掉一截：那一排装不下五样东西，而按钮是固定宽度
#      （52px），文字要 59~79px。现在改成补价期间数量框主动让位、宽度转给按钮。
#   ② 按钮只在「填了单价之后」才出现：礼物码单下服务类型框的输入处理直接 return，
#      不刷新那一排。提示行已经在说「正在补第 1 个」，按钮却还是收起的。
#   ③ 记忆库已有价的礼物仍被要求再补一遍：补价判据只看价格表，而结算看的是
#      「记忆库 + 价格表」并集 —— 两者打架，总价都算出来了还要求继续补。
# 本套跑在**真实浏览器**里：宽度、可见性、文字是否被裁，只有渲染出来才知道。
# 三处修复各配一条反向验证（改回错误写法必须变红），实测分别报红 21/4/13 项。
if ! should_skip giftfillui; then
  echo
  echo "── [19/22] 补价那一排的宽度与按钮可见性 gift-fill-ui.js ──────"
  out=$(node tests/gift-fill-ui.js 2>&1)
  rc=$?
  echo "$out" | tail -6
  line=$(echo "$out" | grep -oE "失败 [0-9]+ 项" | tail -1)
  [ -z "$line" ] && line=$(echo "$out" | grep -oE "全部通过.*" | tail -1)
  run_suite giftfillui "补价排宽度与按钮可见性" $rc "${line:-无输出}"
fi

# ── [20/20] 同时使用多个价格库 ─────────────────────────────────────
# 8.3.46 新增「多库同用」：勾选多个库一起参与查价，不用来回切库。
# 这套防线的重点是**两种语义不能混**：
#   · activeLibraryId  = 编辑目标（新增/修改/删除写进哪个库），永远只有一个
#   · mergedLibraryIds = 查询范围（查价去哪些库找），可以多个
# 混了就会出现「改了 A 库、B 库跟着变」这类界面上看不出来的静默污染，
# 所以钉住四件事：编辑只动当前库 / 查价用并集 / 当前库优先 / 最后一个库不能取消。
# 另加两条升级安全：老数据无该字段要回落成「只查当前库」（行为与改动前一致），
# 新建库要自动纳入查价范围（否则「新建了却查不到」像坏了）。
# 五条反向验证覆盖上面每一条，确保断言不是假绿。
if ! should_skip multilibrary; then
  echo
  echo "── [20/22] 同时使用多个价格库 multi-library.js ────────────────"
  out=$(node tests/multi-library.js 2>&1)
  rc=$?
  echo "$out" | tail -6
  line=$(echo "$out" | grep -oE "失败 [0-9]+ 项" | tail -1)
  [ -z "$line" ] && line=$(echo "$out" | grep -oE "全部通过.*" | tail -1)
  run_suite multilibrary "同时使用多个价格库" $rc "${line:-无输出}"
fi

# ── [21/21] 候选说明行的排版 ───────────────────────────────────────
# 8.3.46 用户报的「提示库名的前括号位置不对，没对齐在同一行」就落在这里：
# 根因是库名原本排在整条说明的**末尾**，前面那段（匹配方式 + 价钱）把行占满后
# 〔库名〕被挤到第二行，看着就像括号掉了。本轮把库名提到行首。
# 另外多库同用后说明变长（多了「〔XX价〕 · 别名：XX」这截），
# 两行装不下会被截成半截 —— 加了 has-more 按需放宽到三行。
# 这两件事都只能看**渲染结果**：JSDOM 没有布局引擎（高度恒为 0），
# 所以本套必须跑在真实浏览器里（与 gift-fill-ui.js 同一套做法）。
# 守三件事：① 有库名时〔 一定在第一行 ② 两行装不下的放宽后要显示完整
#          ③ 不管多长都稳在 3 行内、且两行够用时不多占一行。
if ! should_skip metalayout; then
  echo
  echo "── [21/22] 候选说明行排版 suggest-meta-layout.js ──────────────"
  out=$(node tests/suggest-meta-layout.js 2>&1)
  rc=$?
  echo "$out" | tail -6
  line=$(echo "$out" | grep -oE "失败 [0-9]+ 项" | tail -1)
  [ -z "$line" ] && line=$(echo "$out" | grep -oE "全部通过.*" | tail -1)
  run_suite metalayout "候选说明行排版" $rc "${line:-无输出}"
fi

# ── [22/22] 规则 id 稳定性 ─────────────────────────────────────────
# 8.3.46 为了修「副库项目点候选填不上价」，规则的 id 生成方式动了两处：
#   · 加了「所属库」这层盐（否则两库同名同价会算出同一个 id，候选被误判成重复）
#   · 去掉了「第几条」这个输入（否则旁边增删一条，后面所有规则的 id 全变）
# id 是草稿 / 界面选中态 / 备份里 ruleId 共同引用的东西，漂移了界面上看不出来，
# 只会表现为「刚选好的规则又没了」。这套防线钉住三条：
#   ① 反复归一化 id 不变 ② 增删邻居不影响其余 id ③ 跨库同名同价不撞车
# 另配一条反向验证（把「第几条」放回去必须变红）。
# 本地若有真实备份，可用 `node tests/rule-id-stability.js <备份.json>` 再验一遍。
if ! should_skip ruleid; then
  echo
  echo "── [22/22] 规则 id 稳定性 rule-id-stability.js ────────────────"
  out=$(node tests/rule-id-stability.js 2>&1)
  rc=$?
  echo "$out" | tail -6
  line=$(echo "$out" | grep -oE "失败 [0-9]+ 项" | tail -1)
  [ -z "$line" ] && line=$(echo "$out" | grep -oE "全部通过.*" | tail -1)
  run_suite ruleid "规则 id 稳定性" $rc "${line:-无输出}"
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
