from __future__ import annotations

import runpy
from pathlib import Path

SCRIPT = Path(__file__).with_name("upgrade_nickname_mapping_stage2.py")
namespace = runpy.run_path(str(SCRIPT), run_name="nickname_mapping_stage2_module")
strict_replace_once = namespace["replace_once"]


def safe_replace_once(text: str, old: str, new: str, label: str) -> str:
    if label == "update initial empty title":
        old = "<div>暂无已确认的名字</div>"
        new = "<div>暂无昵称映射</div>"
    return strict_replace_once(text, old, new, label)


namespace["replace_once"] = safe_replace_once
namespace["main"]()
