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

    text = replace_once(
        text,
        "默认勾选陪玩名单、老板记忆库、单价记忆库；可按需增加其他模块。",
        "默认勾选陪玩昵称映射库、老板记忆库、单价记忆库；可按需增加其他模块。",
        "update backup helper text",
    )
    text = replace_once(
        text,
        "{ id: 'playableNames', label: '陪玩名单', note: '已确认的陪陪名字', defaultSelected: true },",
        "{ id: 'playableNames', label: '陪玩昵称映射库', note: '正确团名与识别名称映射', defaultSelected: true },",
        "rename playable backup module",
    )
    text = replace_once(
        text,
        "{ id: 'nameLearningData', label: '名字修正学习', note: '修正记录与常用名字', defaultSelected: false },",
        "{ id: 'nameLearningData', label: '提取学习高级数据', note: '规则、统计与常用名字', defaultSelected: false },",
        "clarify advanced learning module",
    )

    portability_methods = r''' normalizePlayableAliases(list, correctedFallback = '') {
 const normalized = (Array.isArray(list) ? list : []).map(raw => ({
 original: raw?.original ?? '',
 corrected: raw?.corrected ?? correctedFallback,
 timestamp: raw?.timestamp,
 usageCount: raw?.usageCount,
 source: raw?.source || 'manual_correction'
 }));
 return this.app.enhancedExtractor.normalizeNameMappings(normalized);
 }

 normalizeConfirmedNames(list) {
 const max = this.app.enhancedExtractor.config.maxConfirmedNames || 200;
 const map = new Map();
 (Array.isArray(list) ? list : []).forEach(raw => {
 const name = this.app.enhancedExtractor.cleanName(raw?.name ?? raw);
 if (!name) return;
 const item = {
 name,
 original: String(raw?.original ?? name).trim() || name,
 timestamp: Number(raw?.timestamp) || Date.now(),
 source: String(raw?.source ?? 'import').trim() || 'import',
 aliases: this.normalizePlayableAliases(raw?.aliases, name)
 };
 const key = name.toLowerCase();
 const current = map.get(key);
 if (!current) {
 map.set(key, item);
 return;
 }
 const latest = item.timestamp >= current.timestamp ? item : current;
 map.set(key, {
 ...latest,
 aliases: this.app.enhancedExtractor.normalizeNameMappings([...(current.aliases || []), ...(item.aliases || [])])
 });
 });
 return [...map.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, max);
 }

 buildPlayableNamesBackup(extractorData = this.getCurrentExtractorData()) {
 const confirmed = this.normalizeConfirmedNames(extractorData.confirmedNames);
 const byName = new Map(confirmed.map(item => [item.name.toLowerCase(), { ...item, aliases: [...(item.aliases || [])] }]));
 this.app.enhancedExtractor.normalizeNameMappings(extractorData.corrections || []).forEach(mapping => {
 const name = this.app.enhancedExtractor.cleanName(mapping.corrected);
 if (!name) return;
 const key = name.toLowerCase();
 const current = byName.get(key) || {
 name,
 original: name,
 timestamp: Number(mapping.timestamp) || Date.now(),
 source: mapping.source || 'manual_correction',
 aliases: []
 };
 current.aliases = this.app.enhancedExtractor.normalizeNameMappings([...(current.aliases || []), mapping]);
 current.timestamp = Math.max(Number(current.timestamp) || 0, Number(mapping.timestamp) || 0);
 byName.set(key, current);
 });
 return this.normalizeConfirmedNames([...byName.values()]);
 }

 extractPlayableNameMappings(list) {
 return this.app.enhancedExtractor.normalizeNameMappings(
 this.normalizeConfirmedNames(list).flatMap(item => item.aliases || [])
 );
 }'''

    text = replace_regex(
        text,
        r"^\s*normalizeConfirmedNames\(list\) \{.*?^\s*\}\n\n\s*normalizeLearningData",
        portability_methods + "\n\n normalizeLearningData",
        "upgrade playable names normalization",
    )

    text = replace_once(
        text,
        "if (id === 'playableNames') modules.playableNames = this.normalizeConfirmedNames(extractorData.confirmedNames);",
        "if (id === 'playableNames') modules.playableNames = this.buildPlayableNamesBackup(extractorData);",
        "export nickname aliases by default",
    )

    apply_method = r''' applyPlayableNames(incoming, mode) {
 const currentData = this.app.enhancedExtractor.data;
 const incomingList = Array.isArray(incoming) ? incoming : [];
 const imported = this.normalizeConfirmedNames(incomingList);
 currentData.confirmedNames = mode === 'overwrite'
 ? imported
 : this.normalizeConfirmedNames([...(currentData.confirmedNames || []), ...imported]);

 const hasAliasPayload = incomingList.some(raw => Array.isArray(raw?.aliases));
 if (hasAliasPayload) {
 const importedMappings = this.extractPlayableNameMappings(incomingList);
 currentData.corrections = mode === 'overwrite'
 ? importedMappings
 : this.app.enhancedExtractor.normalizeNameMappings([...(currentData.corrections || []), ...importedMappings]);
 }
 }'''
    text = replace_regex(
        text,
        r"^\s*applyPlayableNames\(incoming, mode\) \{.*?^\s*\}\n\n\s*applyLearningData",
        apply_method + "\n\n applyLearningData",
        "restore nickname aliases from playable module",
    )

    if text == original:
        raise RuntimeError("no changes were applied")
    INDEX.write_text(text, encoding="utf-8")
    print("stage 3 nickname mapping backup upgrade applied")


if __name__ == "__main__":
    main()
