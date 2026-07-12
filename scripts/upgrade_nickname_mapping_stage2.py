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

    css = r'''

 .name-mapping-editor {
 display: grid;
 grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto auto;
 gap: var(--spacing-sm);
 align-items: end;
 margin-bottom: var(--spacing-sm);
 padding: var(--spacing-md);
 border: 1px solid var(--color-border-light);
 border-radius: var(--border-radius-lg);
 background: var(--color-bg-light);
 }

 .name-mapping-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
 .name-mapping-label { font-size: var(--font-size-xs); color: var(--color-text-light); font-weight: var(--font-weight-semibold); }
 .name-mapping-input {
 width: 100%; min-width: 0; padding: 9px 10px; border: 1px solid var(--color-border);
 border-radius: var(--border-radius-md); background: var(--color-white); font: inherit;
 }
 .name-mapping-input:focus { outline: none; border-color: var(--color-primary); box-shadow: var(--shadow-primary); }
 .name-mapping-tip { margin: 0 var(--spacing-xs) var(--spacing-md); }
 .name-mapping-cancel { display: none; }
 .saved-name-info { min-width: 0; flex: 1; }
 .saved-name-route { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-weight: var(--font-weight-semibold); }
 .saved-name-original-value, .saved-name-corrected-value { overflow-wrap: anywhere; }
 .saved-name-arrow { color: var(--color-text-light); }
 .saved-name-source-badge {
 display: inline-flex; align-items: center; width: fit-content; margin-top: 5px; padding: 2px 7px;
 border-radius: var(--border-radius-pill); background: var(--color-bg-info); color: var(--color-info);
 font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold);
 }

 @media (max-width: 720px) {
 .name-mapping-editor { grid-template-columns: 1fr 1fr; }
 .name-mapping-editor .app-btn { width: 100%; }
 .saved-name-item { align-items: flex-start; gap: var(--spacing-sm); }
 }
'''
    text = replace_once(
        text,
        "\n /* 提取选项面板按钮样式 */",
        css + "\n\n /* 提取选项面板按钮样式 */",
        "insert mapping library styles",
    )

    text = replace_once(
        text,
        '<i class="fas fa-save"></i> 已保存名字',
        '<i class="fas fa-random"></i> 昵称映射库',
        "rename extract mapping button",
    )
    text = replace_once(
        text,
        '<h3 class="dialog-title"><i class="fas fa-database"></i> 已确认的陪陪名字</h3>',
        '<h3 class="dialog-title"><i class="fas fa-random"></i> 陪玩昵称映射库</h3>',
        "rename mapping modal title",
    )

    editor_markup = r'''

 <div class="name-mapping-editor" id="nameMappingEditor">
 <label class="name-mapping-field">
 <span class="name-mapping-label">识别名称（原始）</span>
 <input type="text" id="nameMappingOriginalInput" class="name-mapping-input" placeholder="例如：x下雪" autocomplete="off">
 </label>
 <label class="name-mapping-field">
 <span class="name-mapping-label">正确团名</span>
 <input type="text" id="nameMappingCorrectedInput" class="name-mapping-input" placeholder="例如：下雪" autocomplete="off">
 </label>
 <button class="app-btn app-btn--primary app-btn--sm" id="nameMappingSaveBtn" type="button">新增映射</button>
 <button class="app-btn app-btn--secondary app-btn--sm name-mapping-cancel" id="nameMappingCancelBtn" type="button">取消编辑</button>
 </div>
 <div class="app-list-note name-mapping-tip">同一个正确团名可以保存多个识别名称；精确映射会优先于通用模型。</div>
'''
    text = replace_once(
        text,
        "\n <div class=\"saved-names-search\">",
        editor_markup + "\n <div class=\"saved-names-search\">",
        "insert mapping editor",
    )
    text = replace_once(
        text,
        'placeholder="搜索原始名字或确认后的名字"',
        'placeholder="搜索识别名称、正确团名或来源"',
        "update mapping search placeholder",
    )
    text = replace_once(text, "共 0 个已保存名字", "共 0 条昵称映射", "update mapping meta text")
    text = replace_once(text, "暂无已确认的名字", "暂无昵称映射", "update initial empty title")
    text = replace_once(text, "提取名字并确认后，会记录在这里", "可手动新增，或在提取修正后自动记录", "update initial empty note")

    text = replace_once(
        text,
        " this._savedNamesSearchQuery = ''; // 已保存名字弹窗的搜索关键词（瞬态UI状态，不纳入业务state）\n this._softTypeSuggestion",
        " this._savedNamesSearchQuery = ''; // 昵称映射库搜索关键词（瞬态UI状态，不纳入业务state）\n this._editingNameMappingOriginal = ''; // 当前正在编辑的原始识别名称\n this._softTypeSuggestion",
        "add mapping editor transient state",
    )

    text = replace_once(
        text,
        " get _savedNamesSearchQuery() { return this.app._savedNamesSearchQuery; }\n set _savedNamesSearchQuery(value) { this.app._savedNamesSearchQuery = value; }",
        " get _savedNamesSearchQuery() { return this.app._savedNamesSearchQuery; }\n set _savedNamesSearchQuery(value) { this.app._savedNamesSearchQuery = value; }\n get _editingNameMappingOriginal() { return this.app._editingNameMappingOriginal; }\n set _editingNameMappingOriginal(value) { this.app._editingNameMappingOriginal = value; }",
        "expose mapping editor state",
    )

    text = replace_once(
        text,
        " [() => this.switchExtractMode('chain'), 'chainModeBtn']\n ]);",
        " [() => this.switchExtractMode('chain'), 'chainModeBtn'],\n [() => this.saveNameMappingFromEditor(), 'nameMappingSaveBtn'],\n [() => this.resetNameMappingEditor(), 'nameMappingCancelBtn']\n ]);",
        "bind mapping editor buttons",
    )
    text = replace_once(
        text,
        " this.on(this.el.savedNamesSearchInput, 'input', this.debounce(() => this.handleSavedNamesSearchInput(), 80));\n }",
        " this.on(this.el.savedNamesSearchInput, 'input', this.debounce(() => this.handleSavedNamesSearchInput(), 80));\n [this.el.nameMappingOriginalInput, this.el.nameMappingCorrectedInput].forEach(input => this.on(input, 'keydown', event => {\n if (event.key === 'Enter') { event.preventDefault(); this.saveNameMappingFromEditor(); }\n if (event.key === 'Escape') { event.preventDefault(); this.resetNameMappingEditor(); }\n }));\n }",
        "bind mapping editor keyboard actions",
    )

    text = replace_once(
        text,
        " this.resetSavedNamesSearch();\n this.updateSavedNamesList();\n this.openModal(this.el.savedNamesModal);",
        " this.resetSavedNamesSearch();\n this.resetNameMappingEditor();\n this.updateSavedNamesList();\n this.openModal(this.el.savedNamesModal);",
        "reset mapping editor on open",
    )
    text = replace_once(
        text,
        " closeSavedNamesModal() {\n this.closeModal(this.el.savedNamesModal);\n }",
        " closeSavedNamesModal() {\n this.resetNameMappingEditor();\n this.closeModal(this.el.savedNamesModal);\n }",
        "reset mapping editor on close",
    )

    view_methods = r''' getNameMappingSourceLabel(source) {
 return ({ model_confirm: '模型确认', manual_correction: '手动修正', custom: '自定义添加' })[source] || '手动修正';
 }

 getSavedNamesViewItems() {
 const mappings = this.enhancedExtractor.getNameMappings().map(item => ({ ...item, kind: 'mapping' }));
 const pairKeys = new Set(mappings.map(item => `${this.enhancedExtractor.compactExtractName(item.original).toLowerCase()}|${this.enhancedExtractor.compactExtractName(item.corrected).toLowerCase()}`));
 const confirmed = (this.enhancedExtractor.data.confirmedNames || []).map(item => {
 const original = String(item.original || item.name || '').trim();
 const corrected = String(item.name || '').trim();
 return {
 original,
 corrected,
 timestamp: Number(item.timestamp) || Date.now(),
 source: this.enhancedExtractor.normalizeMappingSource(item.source, original, corrected),
 kind: 'confirmed'
 };
 }).filter(item => item.original && item.corrected && !pairKeys.has(`${this.enhancedExtractor.compactExtractName(item.original).toLowerCase()}|${this.enhancedExtractor.compactExtractName(item.corrected).toLowerCase()}`));
 const all = [...mappings, ...confirmed].sort((a, b) => b.timestamp - a.timestamp);
 const query = this._savedNamesSearchQuery;
 if (!query) return all;
 return all.filter(item => [item.original, item.corrected, this.getNameMappingSourceLabel(item.source)]
 .some(value => String(value || '').toLowerCase().includes(query)));
 }'''
    text = replace_regex(
        text,
        r"^ getSavedNamesViewItems\(\) \{.*?^ \}\n\n updateSavedNamesMeta",
        view_methods + "\n\n updateSavedNamesMeta",
        "replace mapping view model",
    )

    text = replace_once(
        text,
        " const total = this.enhancedExtractor.data.confirmedNames?.length || 0;\n const visible = this.getSavedNamesViewItems().length;\n const query = this._savedNamesSearchQuery;\n const text = query ? `共 ${total} 个已保存名字，当前筛选 ${visible} 个` : `共 ${total} 个已保存名字`;",
        " const total = this.getSavedNamesViewItemsForCount();\n const visible = this.getSavedNamesViewItems().length;\n const query = this._savedNamesSearchQuery;\n const text = query ? `共 ${total} 条昵称映射，当前筛选 ${visible} 条` : `共 ${total} 条昵称映射`;",
        "update mapping metadata",
    )
    text = replace_once(
        text,
        " updateSavedNamesMeta() {",
        " getSavedNamesViewItemsForCount() {\n const query = this._savedNamesSearchQuery;\n this._savedNamesSearchQuery = '';\n const count = this.getSavedNamesViewItems().length;\n this._savedNamesSearchQuery = query;\n return count;\n }\n\n updateSavedNamesMeta() {",
        "add unfiltered mapping count",
    )

    editor_methods = r'''

 resetNameMappingEditor() {
 this._editingNameMappingOriginal = '';
 if (this.el.nameMappingOriginalInput) this.el.nameMappingOriginalInput.value = '';
 if (this.el.nameMappingCorrectedInput) this.el.nameMappingCorrectedInput.value = '';
 if (this.el.nameMappingSaveBtn) this.el.nameMappingSaveBtn.textContent = '新增映射';
 if (this.el.nameMappingCancelBtn) this.el.nameMappingCancelBtn.style.display = 'none';
 }

 startEditNameMapping(payload) {
 const original = String(payload?.original || '').trim();
 const corrected = String(payload?.corrected || '').trim();
 if (!original || !corrected) return false;
 this._editingNameMappingOriginal = original;
 this.el.nameMappingOriginalInput.value = original;
 this.el.nameMappingCorrectedInput.value = corrected;
 this.el.nameMappingSaveBtn.textContent = '保存修改';
 this.el.nameMappingCancelBtn.style.display = 'inline-flex';
 this.el.nameMappingOriginalInput.focus();
 return true;
 }

 saveNameMappingFromEditor() {
 const original = String(this.el.nameMappingOriginalInput?.value || '').trim();
 const corrected = String(this.el.nameMappingCorrectedInput?.value || '').trim();
 if (!original || !corrected) return this.showError('请同时填写识别名称和正确团名');
 const existing = this.enhancedExtractor.getNameMappingByOriginal(this._editingNameMappingOriginal || original);
 const source = existing?.source || 'custom';
 this.captureLearningSnapshot();
 const saved = this._editingNameMappingOriginal
 ? this.enhancedExtractor.updateNameMapping(this._editingNameMappingOriginal, original, corrected, source)
 : this.enhancedExtractor.upsertNameMapping(original, corrected, 'custom');
 if (!saved) return this.showError('保存昵称映射失败，请检查名称是否有效');
 const edited = Boolean(this._editingNameMappingOriginal);
 this.resetNameMappingEditor();
 this.updateSavedNamesList();
 this.showSuccess(edited ? `已更新映射：${original} → ${corrected}` : `已新增映射：${original} → ${corrected}`);
 return true;
 }
'''
    text = replace_once(
        text,
        "\n resetSavedNamesSearch() {",
        editor_methods + "\n\n resetSavedNamesSearch() {",
        "insert mapping editor methods",
    )

    apply_delete_methods = r''' applySavedNameToPeipei(payload) {
 const corrected = String(payload?.corrected ?? payload ?? '').trim();
 if (!corrected) return false;
 try {
 this.submitNamesToPeiPei(corrected, {
 message: `已应用正确团名“${corrected}”`,
 afterCommit: () => this.closeSavedNamesModal()
 });
 return true;
 } catch (error) {
 appLogSilent(error);
 return false;
 }
 }

 async deleteSavedName(payload) {
 try {
 const original = String(payload?.original ?? payload ?? '').trim();
 const corrected = String(payload?.corrected ?? payload ?? '').trim();
 const kind = payload?.kind || 'mapping';
 if (!original || !corrected) return;
 const label = original === corrected ? corrected : `${original} → ${corrected}`;
 const confirmed = await this.showConfirm(`确定要删除“${label}”吗？本次页面内可撤销一次。`);
 if (!confirmed) return;
 this.captureLearningSnapshot();
 const removed = kind === 'confirmed'
 ? this.enhancedExtractor.removeConfirmedName(corrected)
 : this.enhancedExtractor.removeNameMapping(original);
 if (!removed) return this.showError('删除昵称映射失败');
 if (this._editingNameMappingOriginal === original) this.resetNameMappingEditor();
 this.updateSavedNamesList();
 this.showSuccess(`已删除“${label}”`);
 } catch (error) {
 appLogSilent(error);
 }
 }'''
    text = replace_regex(
        text,
        r"^ applySavedNameToPeipei\(name\) \{.*?^ \}\n\n async deleteSavedName\(name\) \{.*?^ \}\n\n switchExtractMode",
        apply_delete_methods + "\n\n switchExtractMode",
        "replace mapping apply and delete methods",
    )

    text = replace_once(
        text,
        " this.service.enhancedExtractor.batchConfirmNames(correctedNames, 'interactive');\n this.close(correctedNames);",
        " this.close(correctedNames);",
        "remove duplicate confirmation source overwrite",
    )

    text = replace_once(
        text,
        " { container: this.app.el.savedNamesList, itemSelector: '.saved-name-item', getPayload: item => item.dataset.name, actions: [\n { selector: '.saved-name-delete', handler: name => this.app.deleteSavedName(name) }\n ], onItem: name => this.app.applySavedNameToPeipei(name) },",
        " { container: this.app.el.savedNamesList, itemSelector: '.saved-name-item', getPayload: item => ({ original: decodeURIComponent(item.dataset.original || ''), corrected: decodeURIComponent(item.dataset.corrected || ''), kind: item.dataset.kind || 'mapping' }), actions: [\n { selector: '.saved-name-edit', handler: payload => this.app.extractionFeature.startEditNameMapping(payload) },\n { selector: '.saved-name-delete', handler: payload => this.app.deleteSavedName(payload) }\n ], onItem: payload => this.app.applySavedNameToPeipei(payload) },",
        "update mapping list delegated actions",
    )

    text = replace_once(
        text,
        " 'savedNamesSearchInput', 'savedNamesSearchClearBtn',",
        " 'savedNamesSearchInput', 'savedNamesSearchClearBtn', 'nameMappingOriginalInput', 'nameMappingCorrectedInput',\n 'nameMappingSaveBtn', 'nameMappingCancelBtn',",
        "cache mapping editor elements",
    )

    text = replace_once(
        text,
        " savedNames: { className: 'saved-names-empty app-empty-state--panel', text: '暂无已确认的名字', note: '提取名字并确认后，会记录在这里' },\n savedNamesSearch: { className: 'saved-names-empty app-empty-state--panel', text: '没有找到匹配的名字', note: '换个关键词试试，或清空搜索查看全部' },",
        " savedNames: { className: 'saved-names-empty app-empty-state--panel', text: '暂无昵称映射', note: '可手动新增，或在提取修正后自动记录' },\n savedNamesSearch: { className: 'saved-names-empty app-empty-state--panel', text: '没有找到匹配的映射', note: '换个关键词试试，或清空搜索查看全部' },",
        "update mapping empty presets",
    )

    render_block = r''' savedNames: {
 container: () => this.el.savedNamesList,
 items: () => this.getSavedNamesViewItems(),
 getKey: item => `${item.kind}:${this.enhancedExtractor.compactExtractName(item.original).toLowerCase()}:${this.enhancedExtractor.compactExtractName(item.corrected).toLowerCase()}`,
 empty: () => this._savedNamesSearchQuery
 ? this.renderNamedEmptyState('savedNamesSearch')
 : this.renderNamedEmptyState('savedNames'),
 renderItem: item => {
 const date = new Date(item.timestamp).toLocaleString();
 const sourceText = this.extractionFeature.getNameMappingSourceLabel(item.source);
 const encodedOriginal = encodeURIComponent(item.original);
 const encodedCorrected = encodeURIComponent(item.corrected);
 return `<div class="saved-name-item app-list-item" data-original="${this.escapeHtml(encodedOriginal)}" data-corrected="${this.escapeHtml(encodedCorrected)}" data-kind="${this.escapeHtml(item.kind)}"><div class="saved-name-info" title="点击应用正确团名到陪陪输入框"><div class="saved-name-route"><span class="saved-name-original-value">${this.escapeHtml(item.original)}</span><span class="saved-name-arrow">→</span><span class="saved-name-corrected-value">${this.escapeHtml(item.corrected)}</span></div><div class="saved-name-source-badge">${this.escapeHtml(sourceText)}</div><div class="saved-name-original app-list-note">保存时间: ${this.escapeHtml(date)}</div></div>${this.renderIconActions([{ className: 'saved-name-apply', sizeClass: 'danger-icon-btn--lg', title: '应用正确团名到陪陪输入框', labelHtml: '<span class="icon-emoji" aria-hidden="true">➕</span>' }, { className: 'saved-name-edit', sizeClass: 'danger-icon-btn--lg', title: '编辑昵称映射', label: '✏️' }, { className: 'saved-name-delete', sizeClass: 'danger-icon-btn--lg', title: '删除昵称映射', labelHtml: '<i class="fas fa-trash"></i>' }], 'app-list-actions')}</div>`;
 }
 },'''
    text = replace_regex(
        text,
        r"^ savedNames: \{\n container: \(\) => this\.el\.savedNamesList,.*?^ \},\n recentBosses:",
        render_block + "\n recentBosses:",
        "replace mapping collection renderer",
    )

    if text == original:
        raise RuntimeError("no changes were applied")
    INDEX.write_text(text, encoding="utf-8")
    print("stage 2 nickname mapping library UI upgrade applied")


if __name__ == "__main__":
    main()
