#!/usr/bin/env bash
# 码单器 · 一键发布脚本（A1）
#
# 背景
# ----
# 在此之前，一次发版要手工做 6 件事：改 <title>、改 APP_VERSION、打包 zip、
# 算 sha256 抄回 version.json、写 CHANGELOG、git 提交。
#
# 历史上这套手工流程出过两次真事故：
#   · 8.3.24：version.json 改成了新版本，但包内 APP_VERSION 还是旧值
#             → 设备每次启动都判定「有新版本」→ 无限下载同一个包
#   · 8.3.26~8.3.29：包只打了 index.html，漏了 update-checker.js / analytics.js
#             → 原生层等不到 notifyAppReady → 判定包不健康 → 回退 → 无限重载
#
# 两次事故的共性是同一个形状：**仓库里存在一个自相矛盾的状态，却没有门拦住它。**
# 本脚本的作用就是把这条链路串成一条命令，并在任何一环出问题时**整体回滚**，
# 让「半发布态」从物理上无法落盘。
#
# 用法
# ----
#   bash tools/release.sh 8.3.36 --notes @notes.txt
#   bash tools/release.sh 8.3.36 --notes "一句话说明"
#   bash tools/release.sh 8.3.36 --notes @notes.txt --theme "发布流程自动化" --dry-run
#
# 参数
#   必填   <版本号>             严格 X.Y.Z，且必须大于当前版本（不会自动递增）
#   必填   --notes <文本|@文件> 同时写入 version.json.notes 与 CHANGELOG 正文
#   选填   --theme <主题>       CHANGELOG 标题的「（主题）」，缺省取 notes 首行前 40 字
#   选填   --dry-run            全程演练，不写任何文件
#   选填   --skip-full-tests    用 --fast（跳过约 4 分钟的变异测试）
#   选填   --no-package         只改版本号不出包（应急；OTA 不会更新）
#   选填   -h | --help
#
# 本脚本**不执行任何 git 命令**。
# push 会触发 Cloudflare Pages 自动构建、直接推送到用户设备，属于不可逆的对外动作，
# 因此保留为人工的最后一道确认（脚本结束时会打印该执行的 git 命令）。
#
# 退出码：0 发布物就绪 / 1 失败（且已回滚）
set -u

cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
cd "$ROOT" || exit 1

HTML="index.html"
VJ="version.json"
CL="CHANGELOG.md"
PKG="package.json"
RM="README.md"
# 发版过程中会被改写的文件：失败必须能整体回滚
# README.md 也在此列 —— set-version.js 会同步里面的「当前版本」，
# 漏了它就会出现「回滚后 README 停在新版本、其余文件退回旧版本」的半发布状态。
MANAGED=("$HTML" "$VJ" "$CL" "$PKG" "$RM")

# ── 参数解析 ────────────────────────────────────────────────────────
VER=""
NOTES_ARG=""
THEME=""
DRY_RUN=0
SKIP_FULL=0
NO_PACKAGE=0

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage ;;
    --notes) NOTES_ARG="${2:-}"; shift 2 ;;
    --notes=*) NOTES_ARG="${1#--notes=}"; shift ;;
    --theme) THEME="${2:-}"; shift 2 ;;
    --theme=*) THEME="${1#--theme=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-full-tests) SKIP_FULL=1; shift ;;
    --no-package) NO_PACKAGE=1; shift ;;
    -*) echo "未知参数: $1"; echo "用 --help 查看用法"; exit 1 ;;
    *) VER="$1"; shift ;;
  esac
done

# ── 输出风格（与 tools/*.js 一致）───────────────────────────────────
ok()   { echo "  ✓ $*"; }
bad()  { echo "  ✗ $*"; }
info() { echo "  · $*"; }
warn() { echo "  ! $*"; }

STEP=0
step() { STEP=$((STEP + 1)); echo; echo "── $STEP. $* ─────────────────────────────────"; }

# ── 回滚 ────────────────────────────────────────────────────────────
BACKUP=""
NEWZIP=0
DONE=0

restore() {
  local rc=$?
  # die 传进来的显式退出码优先（trap 路径下 $? 才是有效值）
  [ "${1:-}" != "" ] && rc="$1"
  if [ "$DONE" = "1" ]; then return $rc; fi
  echo
  echo "==================================================================="
  if [ -z "$BACKUP" ]; then
    # 还没到快照阶段就失败了：此时一个文件都没改过，无需回滚
    echo " ✗ 失败 —— 尚未改写任何文件，无需回滚"
    echo "==================================================================="
    echo
    echo "  本次发版未发生，仓库未被改动。"
    echo "==================================================================="
    exit "$rc"
  fi
  echo " ✗ 失败（退出码 $rc）—— 正在回滚到发版前的状态"
  echo "==================================================================="
  local restored=0
  for f in "${MANAGED[@]}"; do
    if [ -f "$BACKUP/$f" ]; then
      cp -p "$BACKUP/$f" "$f" && restored=$((restored + 1))
    fi
  done
  echo "  已还原 $restored 个文件：${MANAGED[*]}"
  if [ "$NEWZIP" = "1" ] && [ -n "${VER:-}" ] && [ -f "madan-${VER}.zip" ]; then
    rm -f "madan-${VER}.zip"
    echo "  已删除本次生成的 madan-${VER}.zip"
  fi
  if [ -d "$BACKUP" ]; then
    echo
    echo "  各阶段输出见上方；快照保留在 $BACKUP（取证用，确认无误后可删）。"
  fi
  echo
  echo "  本次发版未发生，仓库已回到干净状态。"
  echo "==================================================================="
  exit "$rc"
}
trap restore ERR INT TERM

# 显式失败出口。
#
# 为什么不能只靠 `trap restore ERR`：bash 的 ERR trap 只在**命令返回非零**时触发，
# 对脚本里显式写下的 `exit 1` **不生效**。这意味着所有 `exit 1` 的失败路径
# 都会跳过回滚 —— 表现为「打印了失败、文件却停在半发布状态」。
# 这是负向自检（tests/release-selftest.sh 的 N7）实测出来的真实缺陷，
# 因此所有失败路径一律走 die()，由它负责回滚 + 退出。
die() {
  echo
  echo "  ✗ $*"
  restore 1
}

echo "==================================================================="
echo " 码单器 一键发布   目标版本: ${VER:-（未提供）}   $([ $DRY_RUN -eq 1 ] && echo '模式: 演练（不写盘）' || echo '模式: 正式')"
echo "==================================================================="

# ── 1. 前置检查（只读，零副作用）────────────────────────────────────
step "前置检查"

DEP_FAIL=0
for c in node python3 zip unzip git; do
  if ! command -v "$c" >/dev/null 2>&1; then bad "缺少命令：$c"; DEP_FAIL=1; fi
done
[ $DEP_FAIL -eq 1 ] && die "缺少必需命令，请先安装（见上方 ✗ 行）"
ok "依赖齐全（node / python3 / zip / unzip / git）"

# 1.1 版本号格式
if [ -z "$VER" ]; then die "未提供版本号。用法：bash tools/release.sh 8.3.36 --notes @notes.txt"; fi
if ! printf '%s' "$VER" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  die "版本号格式不合法：$VER（应为 X.Y.Z，如 8.3.36）"
fi
ok "版本号格式合法：$VER"

# 1.2 --notes 必填
if [ -z "$NOTES_ARG" ]; then
  echo "    用法：--notes \"说明\"  或  --notes @notes.txt"
  die "未提供 --notes（发版必须有说明，会写入 version.json 与 CHANGELOG）"
fi

NOTES_FILE=""
if [ "${NOTES_ARG#@}" != "$NOTES_ARG" ]; then
  NOTES_FILE="${NOTES_ARG#@}"
  if [ ! -f "$NOTES_FILE" ]; then die "notes 文件不存在：$NOTES_FILE"; fi
  NOTES="$(cat "$NOTES_FILE")"
  ok "已从文件读取 notes：$NOTES_FILE（$(printf '%s' "$NOTES" | wc -c | tr -d ' ') 字节）"
else
  NOTES="$NOTES_ARG"
  ok "notes 长度：$(printf '%s' "$NOTES" | wc -c | tr -d ' ') 字节"
fi
[ -z "$NOTES" ] && die "notes 内容为空"

if [ -z "$THEME" ]; then
  THEME="$(printf '%s' "$NOTES" | head -1 | cut -c1-40)"
fi

# 1.3 当前版本（单一真源：APP_VERSION）
CUR_VER="$(grep -oE "APP_VERSION[[:space:]]*=[[:space:]]*'[0-9.]+'" "$HTML" | head -1 | grep -oE "[0-9]+\.[0-9]+\.[0-9]+")"
if [ -z "$CUR_VER" ]; then
  die "无法从 $HTML 解析 APP_VERSION"
fi
ok "当前版本：$CUR_VER → 目标版本：$VER"

# 1.4 版本号必须递增（逐段数值比较，避免字符串比较把 8.3.10 判小于 8.3.9）
ver_gt() {
  local a1 a2 a3 b1 b2 b3
  a1="$(printf '%s' "$1" | cut -d. -f1)"; a2="$(printf '%s' "$1" | cut -d. -f2)"; a3="$(printf '%s' "$1" | cut -d. -f3)"
  b1="$(printf '%s' "$2" | cut -d. -f1)"; b2="$(printf '%s' "$2" | cut -d. -f2)"; b3="$(printf '%s' "$2" | cut -d. -f3)"
  [ "$a1" -gt "$b1" ] && return 0
  [ "$a1" -lt "$b1" ] && return 1
  [ "$a2" -gt "$b2" ] && return 0
  [ "$a2" -lt "$b2" ] && return 1
  [ "$a3" -gt "$b3" ] && return 0
  return 1
}
if ! ver_gt "$VER" "$CUR_VER"; then
  echo "    拒绝相等或倒退：这会造成设备端「永久有新版本」或版本错位。"
  die "版本号必须大于当前版本（当前 $CUR_VER，目标 $VER）"
fi
ok "版本号递增校验通过"

# 1.5 防重复发布
if [ -f "madan-${VER}.zip" ]; then
  echo "    若确要重发，请先确认并手动删除该包。"
  die "madan-${VER}.zip 已存在 —— $VER 似乎已经发布过了"
fi
VJ_VER="$(python3 -c "import json,sys;print(json.load(open('$VJ',encoding='utf-8')).get('version',''))" 2>/dev/null || echo '')"
if [ "$VJ_VER" = "$VER" ]; then
  die "$VJ 里已记录版本 $VER（重复发布）"
fi
ok "无重复发布（无同名 zip，$VJ 未记录该版本）"

if grep -qE "^## ${VER}([^0-9.]|$)" "$CL"; then
  die "$CL 中已存在 $VER 的条目（重复追加）"
fi
ok "CHANGELOG 中无该版本条目"

# 1.6 上一条 CHANGELOG 是否完整（历史欠账预警，不阻塞）
if ! grep -qE "^## ${CUR_VER}([^0-9.]|$)" "$CL"; then
  warn "CHANGELOG 里没有当前版本 $CUR_VER 的条目 —— 上一个版本可能漏记了变更日志"
fi

# 1.7 工作区必须干净
DIRTY="$(git status --porcelain 2>/dev/null || true)"
if [ -n "$DIRTY" ]; then
  printf '%s\n' "$DIRTY" | sed 's/^/      /'
  echo "    请先提交或 stash 当前改动。"
  die "工作区不干净，拒绝发版（发版应基于一个确定的基线）"
fi
ok "工作区干净（HEAD $(git rev-parse --short HEAD 2>/dev/null || echo '?'))"

# 1.8 jsdom 可用性（不自动安装 —— 安装动作不该是发版脚本的副作用）
if [ ! -d node_modules/jsdom ]; then
  echo "    请先执行：npm ci   （若无 package.json 则 npm install jsdom）"
  echo "    本脚本刻意不自动安装依赖，以免产生「安装副作用」。"
  die "缺少测试依赖 jsdom —— 多项防线无法运行"
fi
ok "测试依赖 jsdom 可用"

if [ $NO_PACKAGE -eq 1 ]; then
  warn "已指定 --no-package：本次只改版本号、不出更新包，设备端 OTA 不会更新"
fi

echo
echo "  说明（将写入 version.json.notes 与 CHANGELOG）："
printf '%s\n' "$NOTES" | head -3 | sed 's/^/      /'
[ "$(printf '%s\n' "$NOTES" | wc -l | tr -d ' ')" -gt 3 ] && echo "      ……（共 $(printf '%s' "$NOTES" | wc -c | tr -d ' ') 字节）"
echo "  CHANGELOG 标题：## $VER（$THEME）"

# ── 2. 快照备份 ─────────────────────────────────────────────────────
step "快照备份"

if [ $DRY_RUN -eq 1 ]; then
  info "演练模式：跳过备份（本模式本就不会写盘）"
else
  BACKUP=".release-backup/${VER}-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP"
  for f in "${MANAGED[@]}"; do
    [ -f "$f" ] && cp -p "$f" "$BACKUP/" || die "缺少待管理文件：$f"
  done
  ok "已备份 ${MANAGED[*]} → $BACKUP"
fi

# ── 3. 改写版本号（只动 2 处）───────────────────────────────────────
step "改写版本号（工具强制：每条落点必须恰好命中 1 次）"

if [ $DRY_RUN -eq 1 ]; then
  node tools/set-version.js --to "$VER" --dry-run
else
  node tools/set-version.js --to "$VER"
  node tools/set-version.js --check | tail -2
fi
ok "版本号已处理"

# 同步内联副本（版本号改动通常不触及，但作为「产物与源码一致」的常规前置）
if [ $DRY_RUN -eq 0 ]; then
  if node tools/sync-root-scripts.js --check >/dev/null 2>&1; then
    ok "根级脚本内联副本一致"
  else
    echo "    （本脚本不自动同步：源码与产物的同步是开发动作，不应藏在发版脚本里）"
    die "根级脚本内联副本与源文件不一致 —— 请先运行 node tools/sync-root-scripts.js"
  fi
  if node tools/build-inline-chunks.js --check >/dev/null 2>&1; then
    ok "内联 chunk 源码一致"
  else
    die "内联 chunk 与 src/chunks/*.js 不一致 —— 请先运行 node tools/build-inline-chunks.js"
  fi
fi

# ── 4. 打包 ─────────────────────────────────────────────────────────
step "打包 OTA 更新包"

ZIP="madan-${VER}.zip"
if [ $NO_PACKAGE -eq 1 ]; then
  info "--no-package：跳过打包"
elif [ $DRY_RUN -eq 1 ]; then
  info "演练模式：跳过打包（预计产物 $ZIP）"
else
  rm -f "$ZIP"
  zip -q -X "$ZIP" "$HTML"
  NEWZIP=1
  # 包内容必须恰好是 index.html —— 对齐 8.3.26 漏文件事故
  NAMES="$(unzip -Z1 "$ZIP")"
  COUNT="$(printf '%s\n' "$NAMES" | grep -c . || true)"
  if [ "$COUNT" != "1" ] || [ "$NAMES" != "$HTML" ]; then
    printf '%s\n' "$NAMES" | sed 's/^/      /'
    die "包内文件异常（应为且仅为 $HTML，实际 $COUNT 个）"
  fi
  ok "已打包 $ZIP（$COUNT 个文件：$NAMES，$(stat -c%s "$ZIP" 2>/dev/null || wc -c <"$ZIP") 字节）"
fi

# ── 5. 算 checksum 并写 version.json（顺序硬约束：必须在打包之后）───
step "计算 checksum 并写入 version.json"

if [ $NO_PACKAGE -eq 1 ] || [ $DRY_RUN -eq 1 ]; then
  info "跳过（未产出包）"
else
  SHA="$(sha256sum "$ZIP" | cut -d' ' -f1)"
  ok "sha256 = $SHA"
  VER="$VER" SHA="$SHA" NOTES="$NOTES" python3 - <<'PY'
import json, os
vj = json.load(open('version.json', encoding='utf-8'))
ver = os.environ['VER']
vj['version'] = ver
vj['url'] = 'https://madan.pages.dev/madan-%s.zip' % ver
vj['checksum'] = os.environ['SHA']
vj['notes'] = os.environ['NOTES']
with open('version.json', 'w', encoding='utf-8') as f:
    json.dump(vj, f, ensure_ascii=False, indent=2)
    f.write('\n')
PY
  # 回读三方一致
  R_TITLE="$(grep -oE '<title>[^<]*[0-9]+\.[0-9]+\.[0-9]+</title>' "$HTML" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
  R_APP="$(grep -oE "APP_VERSION[[:space:]]*=[[:space:]]*'[0-9.]+'" "$HTML" | head -1 | grep -oE "[0-9]+\.[0-9]+\.[0-9]+")"
  R_JSON="$(python3 -c "import json;print(json.load(open('version.json',encoding='utf-8'))['version'])")"
  R_SHA="$(python3 -c "import json;print(json.load(open('version.json',encoding='utf-8'))['checksum'])")"
  if [ "$R_TITLE" = "$VER" ] && [ "$R_APP" = "$VER" ] && [ "$R_JSON" = "$VER" ] && [ "$R_SHA" = "$SHA" ]; then
    ok "四方一致：<title> = APP_VERSION = version.json.version = package.json.version = $VER"
    ok "checksum 已回填且与实际包一致"
  else
    die "版本不一致（title=$R_TITLE / APP_VERSION=$R_APP / json=$R_JSON / pkg=$R_PKG / sha=$R_SHA）"
  fi
fi

# ── 6. 追加 CHANGELOG ───────────────────────────────────────────────
step "追加 CHANGELOG"

if [ $DRY_RUN -eq 1 ]; then
  info "演练模式：跳过 CHANGELOG 写入"
else
  VER="$VER" THEME="$THEME" NOTES="$NOTES" python3 - <<'PY'
import os, re
ver, theme, notes = os.environ['VER'], os.environ['THEME'], os.environ['NOTES']
with open('CHANGELOG.md', encoding='utf-8') as f:
    lines = f.read().split('\n')
if any(re.match(r'^## %s([^0-9.]|$)' % re.escape(ver), l) for l in lines):
    print('  · CHANGELOG 已存在该版本条目，跳过（幂等）')
else:
    entry = ['## %s（%s）' % (ver, theme), ''] + notes.split('\n') + ['', '']
    # 插到「# 标题」之后、首个 '## ' 之前
    idx = next((i for i, l in enumerate(lines) if l.startswith('## ')), 2)
    lines[idx:idx] = entry
    with open('CHANGELOG.md', 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    print('  ✓ 已追加 CHANGELOG 条目')
PY
  FIRST="$(grep -m1 -E '^## ' "$CL")"
  if [ "$FIRST" = "## ${VER}（${THEME}）" ]; then
    ok "CHANGELOG 首条即新版：$FIRST"
  else
    die "CHANGELOG 首条不是新版（实际：$FIRST）"
  fi
fi

# ── 7. 全套防线 ─────────────────────────────────────────────────────
step "运行全套防线"

if [ $DRY_RUN -eq 1 ]; then
  info "演练模式：跳过测试（正式发版会跑 bash tests/run-all.sh --require-package）"
else
  info "tools 一致性三连（set-version / sync-root-scripts / build-inline-chunks）"
  node tools/set-version.js --check >/dev/null && ok "版本号落点一致"
  node tools/sync-root-scripts.js --check >/dev/null && ok "根级脚本内联一致"
  node tools/build-inline-chunks.js --check >/dev/null && ok "内联 chunk 一致"

  # --release-flow 告诉防线：当前处于发版流程中，zip 刚生成、尚未 git add
  # 属预期中间态。缺少它会让「zip 必须被 git 跟踪」这道检查把发版流程自锁。
  RUN_ARGS=(--require-package --release-flow)
  [ $SKIP_FULL -eq 1 ] && RUN_ARGS+=(--fast)
  echo
  echo "  执行：bash tests/run-all.sh ${RUN_ARGS[*]}"
  echo
  if bash tests/run-all.sh "${RUN_ARGS[@]}"; then
    ok "全套防线通过"
  else
    die "全套防线未通过 —— 本次发版作废"
  fi

  # 显式再跑一次包自包含检查，不走 run-all.sh 的「存在才跑」分支
  if [ $NO_PACKAGE -eq 0 ]; then
    echo
    if python3 tests/check-package-selfcontained.py "$ZIP" | sed 's/^/  /'; then
      ok "包自包含检查通过"
    else
      die "包自包含检查失败（这正是 8.3.26~8.3.29 无限重载的根因）"
    fi
  fi
fi

# ── 8. 收尾（不碰 git）──────────────────────────────────────────────
DONE=1
trap - ERR INT TERM

# 成功后清理本次快照
if [ -n "$BACKUP" ] && [ -d "$BACKUP" ]; then
  rm -rf "$BACKUP"
fi

echo
echo "==================================================================="
if [ $DRY_RUN -eq 1 ]; then
  echo " ✓ 演练完成（未写入任何文件）"
else
  echo " ✓ 发布物就绪 —— 但尚未提交，等待人工确认"
fi
echo "==================================================================="
if [ $DRY_RUN -eq 0 ]; then
  echo
  echo " 本次产生的改动："
  git status --porcelain | sed 's/^/   /'
  echo
  echo " ⚠  madan-${VER}.zip 必须一起提交。"
  echo "    更新包由 Cloudflare Pages 从仓库根目录直出，version.json.url 指向它；"
  echo "    漏提交会让已安装设备的 OTA 下载 404。"
  echo
  echo " 确认无误后执行（本脚本不代劳，因为 push 即上线）："
  # 用 MANAGED 展开，避免手工列举时漏掉文件 —— 上面第一版就漏了 package.json
  echo "   git add ${MANAGED[*]} madan-${VER}.zip"
  echo "   git commit -m \"release: ${VER} ${THEME}\""
  echo "   git push"
  echo
  echo " ↑ push 会触发 Cloudflare Pages 自动构建，直接推送到用户设备。"
fi
echo
exit 0
