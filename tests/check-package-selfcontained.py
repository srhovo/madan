#!/usr/bin/env python3
"""
OTA 包自包含性检查（8.3.30 新增的发布防线）

背景：8.3.26~8.3.29 的 OTA 包只打包了 index.html，但 index.html 里以
<script src> 引用 update-checker.js / analytics.js，包内却没有这两个文件。
缺了 update-checker.js → notifyAppReady() 不执行 → 原生层判定包不健康
→ 自动回退 → 版本号不变 → 再次判定有新版本 → 无限重载。

本脚本在打包后立即检查：包内 index.html 是否还引用包外文件。
若有任何 src/href 指向包内不存在的资源，直接失败，阻止问题包发出去。

用法：python3 tests/check-package-selfcontained.py madan-<版本>.zip
      （包名由 tests/run-all.sh 自动传当前版本；单独运行时可传任意包）
"""
import re
import sys
import zipfile
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        print('用法: python3 tests/check-package-selfcontained.py <包.zip>')
        return 1

    zpath = Path(sys.argv[1])
    if not zpath.exists():
        print(f'✗ 找不到文件: {zpath}')
        return 1

    zf = zipfile.ZipFile(zpath)
    names = set(zf.namelist())
    print(f'检查 {zpath.name}（{len(names)} 个文件）')
    for n in sorted(names):
        print(f'  · {n}')

    if 'index.html' not in names:
        print('✗ 包内没有 index.html')
        return 1

    html = zf.read('index.html').decode('utf-8')

    # 找出所有 <script src=...> 与 <link href=...> 引用的本地资源
    # （http/https/data: 开头的是外链，不属于「包内应自包含」范畴）
    refs = []
    for m in re.finditer(r'<script\b[^>]*\bsrc\s*=\s*["\']([^"\']+)["\']', html, re.I):
        refs.append(('script', m.group(1)))
    for m in re.finditer(r'<link\b[^>]*\bhref\s*=\s*["\']([^"\']+)["\']', html, re.I):
        refs.append(('link', m.group(1)))

    problems = []
    for kind, ref in refs:
        if re.match(r'^(https?:)?//|^(data|blob):|^#', ref, re.I):
            continue
        clean = ref.split('?')[0].split('#')[0].lstrip('./')
        if clean and clean not in names:
            problems.append((kind, ref))

    print()
    print(f'包内 index.html 引用的本地资源: {len(refs)} 个')
    if problems:
        print('✗ 发现引用包内不存在的资源（这正是无限重载的根因）:')
        for kind, ref in problems:
            print(f'   <{kind}> → {ref}')
        print()
        print('  修法：把该文件一并打进包，或将其内容内联进 index.html。')
        return 1

    ver = re.search(r"const APP_VERSION\s*=\s*'([^']+)'", html)
    print(f'✓ 自包含检查通过（版本 {ver.group(1) if ver else "未知"}）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
