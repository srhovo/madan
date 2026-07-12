from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def replace_regex(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, lambda _match: replacement, text, count=1, flags=re.S | re.M)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return updated


def main() -> None:
    text = INDEX.read_text(encoding="utf-8")
    required_markers = [
        "normalizeMappingOriginal(value)",
        "isReasonableMappedName(name)",
        "const normalizedOriginal = this.normalizeMappingOriginal(original || cleanName) || cleanName;",
        "const original = this.normalizeMappingOriginal(correction.original);",
        "this.isReasonableMappedName(correction.corrected)",
    ]
    if all(marker in text for marker in required_markers):
        print("nickname mapping hardening already applied")
        return

    original_text = text
    mapping_methods = r''' normalizeMappingOriginal(value) {
 const original = this.normalizeExtractText(value)
 .replace(/[\r\n]+/g, ' ')
 .replace(/\s+/g, ' ')
 .trim();
 return original.slice(0, 80);
 }

 isReasonableMappedName(name) {
 const clean = this.cleanName(name);
 const compact = this.compactExtractName(clean);
 return Boolean(clean && compact.length >= 1 && compact.length <= 20 && this.isValidName(clean, true));
 }

 normalizeNameMapping(raw, fallbackSource = 'manual_correction') {
 const original = this.normalizeMappingOriginal(raw?.original ?? '');
 const corrected = this.cleanName(raw?.corrected ?? raw?.name ?? '');
 if (!original || !corrected || !this.isReasonableMappedName(corrected)) return null;
 return {
 original,
 corrected,
 timestamp: Number(raw?.timestamp) || Date.now(),
 usageCount: Math.max(1, Number(raw?.usageCount) || 1),
 source: this.normalizeMappingSource(raw?.source || fallbackSource, original, corrected)
 };
 }'''
    text = replace_regex(
        text,
        r"^\s*normalizeNameMapping\(raw, fallbackSource = 'manual_correction'\) \{.*?^\s*\}\n\n\s*normalizeNameMappings",
        mapping_methods + "\n\n normalizeNameMappings",
        "preserve original mapping name",
    )

    confirmed_block = r''' const normalizedOriginal = this.normalizeMappingOriginal(original || cleanName) || cleanName;
 const normalizedSource = this.normalizeMappingSource(source, normalizedOriginal, cleanName);
 if (!existing) {
 this.data.confirmedNames.push({
 name: cleanName,
 original: normalizedOriginal,
 timestamp: Date.now(),
 source: normalizedSource
 });
 } else {
 existing.timestamp = Date.now();
 existing.source = normalizedSource;
 if (!existing.original) existing.original = normalizedOriginal;
 }'''
    text = replace_regex(
        text,
        r"^\s*const normalizedSource = this\.normalizeMappingSource\(source, original \|\| cleanName, cleanName\);.*?^\s*\}\n\s*this\.data\.confirmedNames =",
        confirmed_block + "\n this.data.confirmedNames =",
        "preserve confirmed original",
    )

    safe_method = r''' isSafeLearningCorrection(correction, name = '', prefixMode = false) {
 if (!correction || !correction.original || !correction.corrected) return false;
 const original = this.normalizeMappingOriginal(correction.original);
 const corrected = this.cleanName(correction.corrected);
 if (!original || !corrected || !this.isReasonableMappedName(corrected)) return false;
 if (!prefixMode) return true;
 const candidate = this.normalizeMappingOriginal(name);
 return this.compactExtractName(original).length >= 3 && candidate.startsWith(original) && original !== corrected;
 }'''
    text = replace_regex(
        text,
        r"^\s*isSafeLearningCorrection\(correction, name = '', prefixMode = false\) \{.*?^\s*\}\n\n\s*learnFromCorrection",
        safe_method + "\n\n learnFromCorrection",
        "harden learning correction validation",
    )

    text = replace_once(
        text,
        "if (correction.corrected && this.isReasonableName(correction.corrected)) {",
        "if (correction.corrected && this.isReasonableMappedName(correction.corrected)) {",
        "migrate longer mapped names",
    )

    if text == original_text:
        raise RuntimeError("no changes were applied")
    INDEX.write_text(text, encoding="utf-8")
    print("nickname mapping hardening applied")


if __name__ == "__main__":
    main()
