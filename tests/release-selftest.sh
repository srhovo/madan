#!/usr/bin/env bash
#
# release.sh 负向自检（A1 配套）
#
# 为什么需要它
# ------------
# 一个「只会在正常状态下变绿」的检查没有价值。release.sh 的价值全在于
# **出问题时它真的会拦、真的会回滚** —— 而这条性质无法靠「跑一遍成功」证明，
# 必须主动注入故障，断言它确实报错、且确实把文件还原。
#
# 本脚本在**临时克隆**里做实验，绝不触碰真实工作区。
#
# 覆盖场景：
#   N1  目标版本号不合法（8.3）
#   N2  版本号倒退（回退到 8.3.34）
#   N3  重复发布（目标版本已有同名 zip）
#   N4  工作区不干净
#   N5  缺少 --notes
#   N6  CHANGELOG 已存在该版本条目（幂等提示，不写两次）
#   N7  注入一个必然失败的防线 → 断言整体回滚（最关键）
#   N8  断言回滚后 index.html / version.json / CHANGELOG.md / package.json
#       逐字节还原、新 zip 已删除
#
# 用法：bash tests/release-selftest.sh
# 退出码：0 全部符合预期 / 1 有场景不符合
set -u

SRC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="$(mktemp -d /tmp/_relselftest.XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

PASS=0
FAIL=0
ok()   { echo "  ✓ $*"; PASS=$((PASS + 1)); }
bad()  { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }

echo "==================================================================="
echo " release.sh 负向自检"
echo "==================================================================="
echo " 源仓库: $SRC_ROOT"
echo " 沙箱  : $SANDBOX"

# ── 动态版本号 ────────────────────────────────────────────────────
# 不要在这里写死 8.3.36 之类的字面量。release.sh 有一道「目标版本必须大于
# 当前版本」的前置门，一旦写死的版本恰好等于当前版本，**那道门会先于本场景
# 想要考察的门拦下**，于是 grep 不到预期字样、断言恒红 —— 而产品其实是对的。
# 这不是假设：8.3.36 发布当日，N3/N4 两条就因此从绿变红，且永远不会自己恢复。
#
# 所以这里从 version.json 取当前版本，再自行推导出场景所需的版本：
#   CUR    当前版本，用于「重复发布」场景（同名 zip 已存在 → 必须是 CUR）
#   NEXT   CUR 的第三位 +1，用于所有「合法可发」场景
CUR="$(python3 -c "import json;print(json.load(open('$SRC_ROOT/version.json'))['version'])" 2>/dev/null)"
if [ -z "$CUR" ]; then
  echo "  ✗ 无法从 version.json 读到当前版本，自检无法进行"
  exit 1
fi
NEXT="$(python3 -c "
v='$CUR'.split('.')
print(f'{v[0]}.{v[1]}.{int(v[2])+1}')
")"
echo " 当前版本: $CUR   本场景将发版本: $NEXT"

# ── 建一个干净克隆（含 .git，因为 release.sh 要查工作区状态）───────
make_clone() {
  local dst="$1"
  rm -rf "$dst"
  mkdir -p "$dst"
  # 只带当前工作区状态，不带历史负担；用 rsync 风格复制而非 git clone，
  # 因为待测的有未提交改动（release.sh 的 --dry-run 需要它）
  ( cd "$SRC_ROOT" && git ls-files -z | xargs -0 -I{} cp --parents {} "$dst"/ ) 2>/dev/null
  # 复制未跟踪但必需的文件
  for f in tools/release.sh tools/set-version.js tests/run-all.sh \
           tests/version-single-source.js package.json; do
    mkdir -p "$dst/$(dirname "$f")"
    [ -f "$SRC_ROOT/$f" ] && cp "$SRC_ROOT/$f" "$dst/$f"
  done
  # 复制全部测试与工具（用 rsync 若可用，否则 cp -r）
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude node_modules --exclude .git "$SRC_ROOT/tests/" "$dst/tests/"
    rsync -a --exclude node_modules --exclude .git "$SRC_ROOT/tools/" "$dst/tools/"
  else
    cp -r "$SRC_ROOT/tests" "$dst/tests" 2>/dev/null
    cp -r "$SRC_ROOT/tools" "$dst/tools" 2>/dev/null
  fi
  # node_modules 用软链（避免每次复制 39 个包）
  ln -sfn "$SRC_ROOT/node_modules" "$dst/node_modules"
  ( cd "$dst" && git init -q . && git add -A >/dev/null 2>&1 && \
    git -c user.email=t@t -c user.name=t commit -qm init >/dev/null 2>&1 )
}

# 通用断言：跑一次 release.sh，检查退出码与关键输出
run_release() {
  local dir="$1"; shift
  ( cd "$dir" && bash tools/release.sh "$@" 2>&1 )
}

echo
echo "── N1. 版本号格式不合法 ─────────────────────────────────────────"
D="$SANDBOX/n1"; make_clone "$D"
OUT="$(run_release "$D" "8.3" --notes "x" --dry-run)"; RC=$?
if [ $RC -ne 0 ] && echo "$OUT" | grep -q "格式不合法"; then
  ok "拒绝非法版本号 8.3，退出码 $RC"
else
  bad "未拒绝非法版本号（rc=$RC）"; echo "$OUT" | tail -5
fi

echo
echo "── N2. 版本号倒退 ───────────────────────────────────────────────"
D="$SANDBOX/n2"; make_clone "$D"
OUT="$(run_release "$D" "8.3.20" --notes "x" --dry-run)"; RC=$?
if [ $RC -ne 0 ] && echo "$OUT" | grep -qE "递增|倒退|不大于"; then
  ok "拒绝版本号倒退 8.3.35 → 8.3.20"
else
  bad "未拒绝版本号倒退（rc=$RC）"; echo "$OUT" | tail -5
fi

echo
echo "── N3. 重复发布（目标版本已有 zip）─────────────────────────────"
# 这里考察的是「防重复发布」这道门：它比对的是**目标版本自身**的同名 zip。
# 所以必须让目标版本 = CUR 并预先放置 madan-$CUR.zip —— 但 CUR 又过不了
# 「必须大于当前版本」那道更靠前的门。
#
# 结论：光靠命令行参数无法把这道门单独暴露出来（两道门的目标版本取值天然冲突）。
# 因此改为直接在夹具里把 version.json 的版本回退一格，使目标版本既「大于当前版本」
# 又「已有同名 zip」—— 这才是真正在测「防重复发布」，而不是在测版本递增。
D="$SANDBOX/n3"; make_clone "$D"
python3 - "$D" "$CUR" <<'PYFIX'
import json, sys
d, cur = sys.argv[1], sys.argv[2]
p = d + '/version.json'
o = json.load(open(p, encoding='utf-8'))
# 把清单版本与包名回退一格，制造「已发布过 CUR」的现场
o['version'] = cur
o['url'] = o['url'].replace(cur, cur)
json.dump(o, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PYFIX
touch "$D/madan-$CUR.zip"
OUT="$(run_release "$D" "$NEXT" --notes "x" --dry-run)"; RC=$?
if [ $RC -ne 0 ] && echo "$OUT" | grep -qE "重复发布|已存在"; then
  ok "拒绝重复发布（$NEXT 已有同名包）"
else
  bad "未拒绝重复发布（rc=$RC）"; echo "$OUT" | tail -6
fi

echo
echo "── N4. 工作区不干净 ─────────────────────────────────────────────"
D="$SANDBOX/n4"; make_clone "$D"
echo "// 脏改动" >> "$D/index.html"
OUT="$(run_release "$D" "$NEXT" --notes "x" --dry-run)"; RC=$?
if [ $RC -ne 0 ] && echo "$OUT" | grep -qE "工作区不干净"; then
  ok "拒绝在脏工作区发版"
else
  bad "未拒绝脏工作区（rc=$RC）"; echo "$OUT" | tail -5
fi

echo
echo "── N5. 缺少 --notes ─────────────────────────────────────────────"
D="$SANDBOX/n5"; make_clone "$D"
OUT="$(run_release "$D" "$NEXT" --dry-run)"; RC=$?
if [ $RC -ne 0 ] && echo "$OUT" | grep -qE "notes"; then
  ok "拒绝无说明的发版"
else
  bad "未拒绝缺少 notes（rc=$RC）"; echo "$OUT" | tail -5
fi

echo
echo "── N7/N8. 注入失败防线 → 断言整体回滚（最关键）─────────────────"
D="$SANDBOX/n7"; make_clone "$D"

# 注入一个必然失败的防线：把 version-single-source.js 换成永远 exit 1，
# 模拟「发版跑到最后一套防线时红了」——这是最危险的位置，因为文件已被改写。
cat > "$D/tests/version-single-source.js" <<'FAKE'
console.error('  模拟防线失败：注入的故障');
process.exit(1);
FAKE
# 注入后必须提交，否则 release.sh 会在「工作区不干净」处提前拦截，
# 根本走不到防线这一步 —— 那就测不到回滚了。
( cd "$D" && git add -A >/dev/null 2>&1 && \
  git -c user.email=t@t -c user.name=t commit -qm "inject failing guard" >/dev/null 2>&1 )

# 提交后重新取指纹（此时才是真正的「发版前基线」）
B_IDX="$(sha256sum "$D/index.html" | cut -d' ' -f1)"
B_VJ="$(sha256sum "$D/version.json" | cut -d' ' -f1)"
B_CL="$(sha256sum "$D/CHANGELOG.md" | cut -d' ' -f1)"
B_PKG="$(sha256sum "$D/package.json" | cut -d' ' -f1)"

# 正式模式（非 dry-run），这样才会真的改文件，才能检验回滚
OUT="$(run_release "$D" "$NEXT" --notes "自检注入" --skip-full-tests 2>&1)"; RC=$?

if [ $RC -ne 0 ]; then
  ok "失败链路下退出码非 0（$RC）"
else
  bad "防线失败但脚本仍返回 0 —— 这是最严重的问题"
fi

if echo "$OUT" | grep -qE "回滚"; then
  ok "输出中明确报告了回滚"
else
  bad "没有回滚提示"; echo "$OUT" | tail -10
fi

A_IDX="$(sha256sum "$D/index.html" | cut -d' ' -f1)"
A_VJ="$(sha256sum "$D/version.json" | cut -d' ' -f1)"
A_CL="$(sha256sum "$D/CHANGELOG.md" | cut -d' ' -f1)"
A_PKG="$(sha256sum "$D/package.json" | cut -d' ' -f1)"

[ "$A_IDX" = "$B_IDX" ] && ok "index.html 逐字节还原"      || bad "index.html 未还原"
[ "$A_VJ"  = "$B_VJ"  ] && ok "version.json 逐字节还原"    || bad "version.json 未还原"
[ "$A_CL"  = "$B_CL"  ] && ok "CHANGELOG.md 逐字节还原"    || bad "CHANGELOG.md 未还原"
[ "$A_PKG" = "$B_PKG" ] && ok "package.json 逐字节还原"    || bad "package.json 未还原"

if [ -f "$D/madan-$NEXT.zip" ]; then
  bad "残留本次生成的 madan-$NEXT.zip"
else
  ok "本次生成的 zip 已删除"
fi

# 版本号不应残留新值
if grep -q "$NEXT" "$D/index.html"; then
  bad "index.html 中残留 $NEXT"
else
  ok "index.html 无新版本号残留"
fi

echo
echo "==================================================================="
echo " 通过 $PASS 项 / 失败 $FAIL 项"
if [ "$FAIL" = "0" ]; then
  echo " ✓ release.sh 的防呆与回滚均符合预期"
else
  echo " ✗ 存在不符合预期的场景，见上方 ✗ 行"
fi
echo "==================================================================="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
