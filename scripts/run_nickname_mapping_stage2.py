from __future__ import annotations

import re
import runpy
from pathlib import Path

SCRIPT = Path(__file__).with_name("upgrade_nickname_mapping_stage2.py")
namespace = runpy.run_path(str(SCRIPT), run_name="nickname_mapping_stage2_module")
main = namespace["main"]
module_globals = main.__globals__
strict_replace_once = module_globals["replace_once"]


def safe_replace_once(text: str, old: str, new: str, label: str) -> str:
    if label == "update initial empty title":
        old = "<div>暂无已确认的名字</div>"
        new = "<div>暂无昵称映射</div>"
    elif label == "update initial empty note":
        old = '<div class="app-empty-state__note">提取名字并确认后，会记录在这里</div>'
        new = '<div class="app-empty-state__note">可手动新增，或在提取修正后自动记录</div>'
    elif text.count(old) == 0 and old.startswith(" ") and text.count(old[1:]) == 1:
        old = old[1:]
        if new.startswith(" "):
            new = new[1:]
    return strict_replace_once(text, old, new, label)


def safe_replace_regex(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S | re.M)
    if count == 1:
        return updated
    fallback = pattern.replace("^ ", r"^\s*").replace(r"\n\n ", r"\n\n\s*")
    updated, count = re.subn(fallback, replacement, text, count=1, flags=re.S | re.M)
    if count == 1:
        return updated
    raise RuntimeError(f"{label}: expected exactly one match, found 0 in strict and whitespace fallback")


module_globals["replace_once"] = safe_replace_once
module_globals["replace_regex"] = safe_replace_regex
main()
