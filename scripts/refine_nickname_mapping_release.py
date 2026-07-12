from __future__ import annotations

from pathlib import Path

INDEX = Path(__file__).resolve().parents[1] / "index.html"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def main() -> None:
    text = INDEX.read_text(encoding="utf-8")
    original = text

    text = replace_once(
        text,
        " const original = this.cleanName(raw?.original ?? '');\n const corrected = this.cleanName(raw?.corrected ?? raw?.name ?? '');\n if (!original || !corrected || !this.isReasonableName(corrected)) return null;",
        " const original = this.normalizeExtractText(raw?.original ?? '').trim().slice(0, 80);\n const corrected = this.cleanName(raw?.corrected ?? raw?.name ?? '');\n if (!this.compactExtractName(original) || !corrected || !this.isReasonableName(corrected)) return null;",
        "preserve mapping source punctuation",
    )

    text = replace_once(
        text,
        " const pairKeys = new Set(mappings.map(item => `${this.enhancedExtractor.compactExtractName(item.original).toLowerCase()}|${this.enhancedExtractor.compactExtractName(item.corrected).toLowerCase()}`));",
        " const correctedKeys = new Set(mappings.map(item => this.enhancedExtractor.compactExtractName(item.corrected).toLowerCase()));",
        "build corrected-name dedupe set",
    )
    text = replace_once(
        text,
        " }).filter(item => item.original && item.corrected && !pairKeys.has(`${this.enhancedExtractor.compactExtractName(item.original).toLowerCase()}|${this.enhancedExtractor.compactExtractName(item.corrected).toLowerCase()}`));",
        " }).filter(item => item.original && item.corrected && !correctedKeys.has(this.enhancedExtractor.compactExtractName(item.corrected).toLowerCase()));",
        "hide duplicate confirmed canonical entries",
    )

    old_learning = """ normalizeLearningData(data) {
 const safe = data && typeof data === 'object' ? data : {};
 const correctionMap = new Map();
 (Array.isArray(safe.corrections) ? safe.corrections : []).forEach(raw => {
 const original = String(raw?.original ?? '').trim();
 const corrected = String(raw?.corrected ?? '').trim();
 if (!original || !corrected) return;
 const key = `${original.toLowerCase()}|${corrected.toLowerCase()}`;
 correctionMap.set(key, { ...raw, original, corrected, timestamp: Number(raw?.timestamp) || Date.now() });
 });
 return {
 corrections: [...correctionMap.values()].slice(0, this.app.enhancedExtractor.config.maxStoredCorrections || 1000),
 patterns: Array.isArray(safe.patterns) ? safe.patterns.filter(Boolean).slice(0, 500) : [],
 stats: safe.stats && typeof safe.stats === 'object' ? safe.stats : { totalExtractions: 0, autoCorrections: 0, userCorrections: 0 },
 commonNames: Array.isArray(safe.commonNames) ? [...new Set(safe.commonNames.map(name => String(name ?? '').trim()).filter(Boolean))].slice(0, 500) : []
 };
 }"""
    new_learning = """ normalizeLearningData(data) {
 const safe = data && typeof data === 'object' ? data : {};
 return {
 corrections: this.app.enhancedExtractor.normalizeNameMappings(Array.isArray(safe.corrections) ? safe.corrections : []),
 patterns: Array.isArray(safe.patterns) ? safe.patterns.filter(Boolean).slice(0, 500) : [],
 stats: safe.stats && typeof safe.stats === 'object' ? safe.stats : { totalExtractions: 0, autoCorrections: 0, userCorrections: 0 },
 commonNames: Array.isArray(safe.commonNames) ? [...new Set(safe.commonNames.map(name => String(name ?? '').trim()).filter(Boolean))].slice(0, 500) : []
 };
 }"""
    text = replace_once(text, old_learning, new_learning, "normalize imported mappings by original name")

    text = replace_once(text, ">撤销上次删除</button>", ">撤销上次修改</button>", "rename mapping undo button")
    text = replace_once(text, "<!-- 已保存名字弹窗 -->", "<!-- 陪玩昵称映射库弹窗 -->", "rename mapping modal comment")
    text = replace_once(text, 'aria-label="退出已保存名字弹窗"', 'aria-label="退出昵称映射库弹窗"', "update mapping modal aria label")

    mobile_css = """

 @media (max-width: 520px) {
 .name-mapping-field { grid-column: 1 / -1; }
 }
"""
    marker = "\n /* 提取选项面板按钮样式 */"
    text = replace_once(text, marker, mobile_css + "\n /* 提取选项面板按钮样式 */", "add narrow-phone mapping layout")

    if text == original:
        raise RuntimeError("no release refinements applied")
    INDEX.write_text(text, encoding="utf-8")
    print("nickname mapping release refinements applied")


if __name__ == "__main__":
    main()
