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
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S | re.M)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return updated


def main() -> None:
    text = INDEX.read_text(encoding="utf-8")
    original = text

    mapping_methods = r'''

 // 昵称映射：允许多个识别名称指向同一个正确团名；同一识别名称只保留一个当前结果。
 normalizeMappingSource(source, original = '', corrected = '') {
 const value = String(source || '').trim();
 if (value === 'model_confirm' || value === 'manual_correction' || value === 'custom') return value;
 if (value === 'auto') return 'model_confirm';
 if (value === 'interactive') return this.compactExtractName(original).toLowerCase() === this.compactExtractName(corrected).toLowerCase()
 ? 'model_confirm'
 : 'manual_correction';
 return this.compactExtractName(original).toLowerCase() === this.compactExtractName(corrected).toLowerCase()
 ? 'model_confirm'
 : 'manual_correction';
 }

 normalizeNameMapping(raw, fallbackSource = 'manual_correction') {
 const original = this.cleanName(raw?.original ?? '');
 const corrected = this.cleanName(raw?.corrected ?? raw?.name ?? '');
 if (!original || !corrected || !this.isReasonableName(corrected)) return null;
 return {
 original,
 corrected,
 timestamp: Number(raw?.timestamp) || Date.now(),
 usageCount: Math.max(1, Number(raw?.usageCount) || 1),
 source: this.normalizeMappingSource(raw?.source || fallbackSource, original, corrected)
 };
 }

 normalizeNameMappings(list) {
 const map = new Map();
 (Array.isArray(list) ? list : []).forEach(raw => {
 const item = this.normalizeNameMapping(raw);
 if (!item) return;
 const key = this.compactExtractName(item.original).toLowerCase();
 const current = map.get(key);
 if (!current || item.timestamp >= current.timestamp) map.set(key, item);
 });
 return [...map.values()]
 .sort((a, b) => b.timestamp - a.timestamp)
 .slice(0, this.config.maxStoredCorrections);
 }

 getNameMappings() {
 this.data.corrections = this.normalizeNameMappings(this.data.corrections);
 return this.data.corrections;
 }

 getNameMappingByOriginal(original) {
 const key = this.compactExtractName(original).toLowerCase();
 if (!key) return null;
 return this.getNameMappings().find(item => this.compactExtractName(item.original).toLowerCase() === key) || null;
 }

 ensureConfirmedName(name, original = null, source = 'model_confirm') {
 const cleanName = this.cleanName(name);
 if (!cleanName) return false;
 if (!Array.isArray(this.data.confirmedNames)) this.data.confirmedNames = [];
 const key = cleanName.toLowerCase();
 const existing = this.data.confirmedNames.find(item => this.cleanName(item?.name).toLowerCase() === key);
 const normalizedSource = this.normalizeMappingSource(source, original || cleanName, cleanName);
 if (!existing) {
 this.data.confirmedNames.push({
 name: cleanName,
 original: this.cleanName(original || cleanName) || cleanName,
 timestamp: Date.now(),
 source: normalizedSource
 });
 } else {
 existing.timestamp = Date.now();
 existing.source = normalizedSource;
 if (!existing.original) existing.original = this.cleanName(original || cleanName) || cleanName;
 }
 this.data.confirmedNames = this.data.confirmedNames
 .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
 .slice(0, this.config.maxConfirmedNames);
 return true;
 }

 upsertNameMapping(original, corrected, source = 'custom') {
 const item = this.normalizeNameMapping({ original, corrected, source, timestamp: Date.now() }, source);
 if (!item) return false;
 const key = this.compactExtractName(item.original).toLowerCase();
 const mappings = this.getNameMappings();
 const index = mappings.findIndex(entry => this.compactExtractName(entry.original).toLowerCase() === key);
 if (index >= 0) {
 item.usageCount = Math.max(1, Number(mappings[index].usageCount) || 1) + 1;
 mappings[index] = item;
 } else {
 mappings.unshift(item);
 }
 this.data.corrections = this.normalizeNameMappings(mappings);
 this.ensureConfirmedName(item.corrected, item.original, item.source);
 if (!this.data.commonNames.includes(item.corrected)) this.data.commonNames.push(item.corrected);
 return this.saveData() ? item : false;
 }

 updateNameMapping(previousOriginal, original, corrected, source = 'custom') {
 const previousKey = this.compactExtractName(previousOriginal).toLowerCase();
 const nextKey = this.compactExtractName(original).toLowerCase();
 if (previousKey && previousKey !== nextKey) {
 this.data.corrections = this.getNameMappings().filter(item => this.compactExtractName(item.original).toLowerCase() !== previousKey);
 }
 return this.upsertNameMapping(original, corrected, source);
 }

 removeNameMapping(original) {
 const key = this.compactExtractName(original).toLowerCase();
 if (!key) return false;
 const before = this.getNameMappings().length;
 this.data.corrections = this.data.corrections.filter(item => this.compactExtractName(item.original).toLowerCase() !== key);
 if (this.data.corrections.length === before) return false;
 return this.saveData();
 }
'''

    text = replace_once(
        text,
        "\n // 加载数据（兼容旧版本）\n loadData() {",
        mapping_methods + "\n\n // 加载数据（兼容旧版本）\n loadData() {",
        "insert mapping methods",
    )

    text = replace_once(
        text,
        " this.data.corrections = saved.corrections || [];",
        " this.data.corrections = this.normalizeNameMappings(saved.corrections || []);",
        "normalize loaded mappings",
    )

    text = replace_once(
        text,
        " corrections: this.data.corrections.slice(0, this.config.maxStoredCorrections),",
        " corrections: this.normalizeNameMappings(this.data.corrections),",
        "normalize saved mappings",
    )

    text = replace_once(text, " version: '2.1'", " version: '2.2'", "bump extractor data version")

    text = replace_once(
        text,
        " this.data.confirmedNames = this.data.confirmedNames || [];\n return this.saveData();",
        " this.data.confirmedNames = this.data.confirmedNames || [];\n this.data.corrections = this.normalizeNameMappings(this.data.corrections || []);\n return this.saveData();",
        "normalize restored mappings",
    )

    confirm_method = r''' confirmName(name, original = null, source = 'interactive') {
 try {
 const cleanName = this.cleanName(name);
 if (!cleanName) return false;
 const existed = this.isNameConfirmed(cleanName);
 this.ensureConfirmedName(cleanName, original || cleanName, source);
 return this.saveData() ? !existed : false;
 } catch {
 return false;
 }
 }'''
    text = replace_regex(
        text,
        r"^ confirmName\(name, original = null, source = 'interactive'\) \{.*?^ \}\n\n // 获取需要确认的新名字",
        confirm_method + "\n\n // 获取需要确认的新名字",
        "replace confirmName",
    )

    text = replace_once(
        text,
        " return this.data.corrections.find(c => c.original === name && this.isSafeLearningCorrection(c));",
        " const key = this.compactExtractName(name).toLowerCase();\n return this.getNameMappings().find(c => this.compactExtractName(c.original).toLowerCase() === key && this.isSafeLearningCorrection(c));",
        "case-insensitive exact mapping lookup",
    )

    learn_method = r''' learnFromCorrection(original, corrected) {
 try {
 const saved = this.upsertNameMapping(original, corrected, 'manual_correction');
 if (saved) this.data.stats.userCorrections++;
 return Boolean(saved);
 } catch (error) {
 appLogSilent(error);
 return false;
 }
 }'''
    text = replace_regex(
        text,
        r"^ learnFromCorrection\(original, corrected\) \{.*?^ \}\n\n updateStats\(names\)",
        learn_method + "\n\n updateStats(names)",
        "replace learnFromCorrection",
    )

    exact_memory_method = r''' findExactMemoryMapping(raw) {
 const key = this.compactExtractName(raw).toLowerCase();
 const learned = this.getNameMappings().find(item => this.compactExtractName(item.original).toLowerCase() === key && this.isSafeLearningCorrection(item));
 if (learned) return { name: learned.corrected, reason: '昵称映射库精确命中' };
 const memory = this.getConfirmedMemoryIndex();
 const mapped = memory.originalMap.get(key);
 return mapped ? { name: mapped, reason: '原始名称→正确团名确认记录命中' } : null;
 }'''
    text = replace_regex(
        text,
        r"^ findExactMemoryMapping\(raw\) \{.*?^ \}\n\n addPlayableCandidate",
        exact_memory_method + "\n\n addPlayableCandidate",
        "replace exact memory lookup",
    )

    if text == original:
        raise RuntimeError("no changes were applied")

    INDEX.write_text(text, encoding="utf-8")
    print("stage 1 nickname mapping data upgrade applied")


if __name__ == "__main__":
    main()
