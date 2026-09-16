// ============================================
// 数据可携带 Feature（DataPortabilityFeature）· 内联 chunk
// 职责：备份的导出/导入、完整性校验（fnv1a32）、撤销快照，以及与 memex 仓库的 club 记忆库同步。
// 说明：本文件为「内联 chunk」——源码被 JSON 转义后存于 index.html 的 __INLINE_CHUNKS_RAW__ 单行字符串中，
//       由 InlineChunkLoader 延迟加载执行。修改本 chunk 必须同步更新该字符串（见 tests/inline-integrity.js）。
//       因处于单行字符串内，编辑器无法索引，故本文件是主要维护风险点。
// ============================================
window.DataPortabilityFeature = class {
 constructor(app) {
 this.app = app;
 this.lastImport = null;
 this.undoSnapshot = null;
 this.backupType = 'pw-order-tool-backup';
 this.schemaVersion = BACKUP_SCHEMA_VERSION;
 this.moduleVersions = BACKUP_MODULE_VERSIONS;
 this.undoStateKeys = ['bossMemory', 'priceLibraries', 'priceMemory', 'recentBosses', 'modeRatios', 'history', 'lockedPeiPei', 'lockedPaiDan', 'lockedBoss', 'hiddenModules', 'layoutTemplates'];
 this.importPriceLibraryIds = new Set();
 this._lastRenderedImport = null;
 this._eventScope = new FeatureEventScope();
 this._fileReadSeq = 0;
 this._activeFileReader = null;
 this._applyImportPending = false;
 this._importInputDebounceTimer = null;
 this._clubLoading = false;
 this.MEMEX_REPO = { owner: 'srhovo', repo: 'memex', branch: 'main', rawBase: 'https://madan.pages.dev/memex' };
 }

 init() {
 this.updateShareButtonState();
 window.appDialogManager.register([
 { el: this.app.el.clubSelectModal, close: () => this.closeClubSelect() }
 ]);
 }

 getModuleConfigs() {
 return [
 { id: 'playableNames', label: '陪玩名单', note: '已确认的陪陪名字', defaultSelected: true },
 { id: 'bossMemory', label: '老板记忆库', note: '老板、派单、折数', defaultSelected: true },
 { id: 'recentBosses', label: '最近老板记录', note: '单击老板昵称时的候选历史', defaultSelected: false },
 { id: 'priceLibraries', label: '价格库', note: '可选择导出一个或多个价格库', defaultSelected: true },
  { id: 'modeRatios', label: '自定义比例', note: '单子/礼物自定义比例', defaultSelected: false },
 { id: 'history', label: '历史记录', note: '最多保留 10 条', defaultSelected: false },
 { id: 'lockedFields', label: '锁定字段', note: '陪陪、派单、老板锁定值', defaultSelected: false },
 { id: 'nameLearningData', label: '名字修正学习', note: '修正记录与常用名字', defaultSelected: false },
 ];
 }

 getCurrentPriceLibrariesData() {
 const current = this.app.priceLibraryStore.normalizeData(this.app.priceLibraries);
 if (current) return current;
 return this.app.priceLibraryStore.createFromLegacy(this.app.priceMemory || []);
 }

 renderExportModules() {
 const app = this.app;
 const priceData = this.getCurrentPriceLibrariesData();
 const libraryOptions = (priceData?.libraries || []).map(library => `
 <label class="dp-price-library-option" title="${app.escapeHtml(library.name)}">
 <input type="checkbox" class="dp-price-library-export" value="${app.escapeHtml(library.id)}" checked>
 <span>${app.escapeHtml(library.name)}（${library.items.length}条）</span>
 </label>`).join('') || '<div class="dp-price-library-empty">暂无可导出的价格库</div>';
 app.setRenderedHtml(app.el.dpExportModules, this.getModuleConfigs().map(config => {
 const main = `<label class="dp-module-item">
 <input type="checkbox" class="dp-module-toggle" value="${app.escapeHtml(config.id)}" ${config.defaultSelected ? 'checked' : ''}>
 <span>
 <span class="dp-module-title">${app.escapeHtml(config.label)}</span>
 <span class="dp-module-note">${app.escapeHtml(config.note)}</span>
 </span>
 </label>`;
 if (config.id !== 'priceLibraries') return `<div class="dp-module-block">${main}</div>`;
 return `<div class="dp-module-block dp-module-block--price">${main}<div class="dp-price-library-options">${libraryOptions}</div></div>`;
 }).join(''));
 this.syncExportPriceLibraryAvailability();
 }

 bindEvents() {
 if (!this._eventScope.begin()) return false;
 const el = this.app.el;
 try {
 [
 [el.dpExportBtn, 'copyDownload'],
 [el.dpCopyBtn, 'copy'],
 [el.dpDownloadBtn, 'download'],
 [el.dpShareBtn, 'share']
 ].forEach(([button, type]) => this._eventScope.on(button, 'click', () => this.exportAction(type)));
 this._eventScope.on(el.dpApplyImportBtn, 'click', () => this.applyImport());
 this._eventScope.on(el.dpUndoImportBtn, 'click', () => this.undoImport());
 this._eventScope.on(el.dpSelectFileBtn, 'click', () => { if (el.dpFileInput) { el.dpFileInput.value = ''; el.dpFileInput.click(); } });
 this._eventScope.on(el.dpFileInput, 'change', event => this.readSelectedFile(event.currentTarget));
 this._eventScope.on(el.dpSelectClubBtn, 'click', () => this.openClubSelect());
 this._eventScope.on(el.clubSelectList, 'click', event => this.handleClubListClick(event));
 this._eventScope.on(el.dpImportText, 'input', () => this.handleImportInput());
 this._eventScope.on(el.dpTabs, 'click', event => {
 const btn = event.target.closest('.pm-tab');
 if (!btn || !el.dpTabs?.contains(btn)) return;
 this.switchDpTab(btn.dataset.tab);
 });
 [el.dpImportMerge, el.dpImportOverwrite].forEach(input => this._eventScope.on(input, 'change', () => {
 if (this.lastImport) this.renderPreview(this.lastImport);
 }));
 this._eventScope.on(el.dpExportModules, 'change', event => this.handleExportSelectionChange(event));
 this._eventScope.on(el.dpPreview, 'change', event => this.handleImportPriceSelectionChange(event));
 return true;
 } catch (error) {
 this._eventScope.clear();
 throw error;
 }
 }

 unbindEvents() {
 this._eventScope.clear();
 this.close();
 return true;
 }

 handleExportSelectionChange(event) {
 const target = event.target;
 if (target?.classList.contains('dp-module-toggle') && target.value === 'priceLibraries') this.syncExportPriceLibraryAvailability();
 if (!target?.classList.contains('dp-price-library-export')) return;
 const parent = this.app.el.dpExportModules?.querySelector('.dp-module-toggle[value="priceLibraries"]');
 const anyChecked = Boolean(this.app.el.dpExportModules?.querySelector('.dp-price-library-export:checked'));
 if (parent) parent.checked = anyChecked;
 this.syncExportPriceLibraryAvailability();
 }

 handleImportPriceSelectionChange(event) {
 const target = event.target;
 if (!target?.classList.contains('dp-import-price-library')) return;
 if (target.checked) this.importPriceLibraryIds.add(target.value);
 else this.importPriceLibraryIds.delete(target.value);
 this.updateImportApplyState(this.lastImport);
 }

 syncExportPriceLibraryAvailability() {
 const root = this.app.el.dpExportModules;
 const parent = root?.querySelector('.dp-module-toggle[value="priceLibraries"]');
 const enabled = Boolean(parent?.checked);
 root?.querySelectorAll('.dp-price-library-export').forEach(input => { input.disabled = !enabled; });
 }

 updateShareButtonState() {
 if (this.app.el.dpShareBtn) this.app.el.dpShareBtn.style.display = navigator.share ? '' : 'none';
 }

 open() {
 this.cancelFileRead();
 this.renderExportModules();
 this.updateShareButtonState();
 this.resetPreview();
 if (this.app.el.dpFileInput) this.app.el.dpFileInput.value = '';
 }

 close() {
 this.cancelFileRead();
 this.resetPreview();
 if (this.app.el.dpFileInput) this.app.el.dpFileInput.value = '';
 }

 switchDpTab(tab) {
 const el = this.app.el;
 if (el.dpTabs) {
 el.dpTabs.querySelectorAll('.pm-tab').forEach(btn => {
 const active = btn.dataset.tab === tab;
 btn.classList.toggle('active', active);
 btn.setAttribute('aria-selected', String(active));
 });
 }
 if (el.dpPanelImport) el.dpPanelImport.classList.toggle('active', tab === 'import');
 if (el.dpPanelExport) el.dpPanelExport.classList.toggle('active', tab === 'export');
 return true;
 }

 cancelFileRead() {
 this._fileReadSeq += 1;
 const reader = this._activeFileReader;
 this._activeFileReader = null;
 if (reader && typeof FileReader === 'function' && reader.readyState === FileReader.LOADING) {
 try { reader.abort(); } catch (error) { appLogSilent(error); }
 }
 }

 getSelectedExportModuleIds() {
 const checked = this.app.el.dpExportModules?.querySelectorAll('.dp-module-toggle:checked') || [];
 return Array.from(checked).map(item => item.value);
 }

 getSelectedExportPriceLibraryIds() {
 const selected = this.app.el.dpExportModules?.querySelectorAll('.dp-price-library-export:checked') || [];
 return Array.from(selected).map(item => item.value);
 }

 clone(value) {
 if (typeof structuredClone === 'function') return structuredClone(value);
 return JSON.parse(JSON.stringify(value ?? null));
 }

 normalizeSchemaVersion(value, fallback = 1) {
 const version = Number(value);
 return Number.isInteger(version) && version >= 1 ? version : fallback;
 }

 canonicalStringify(value) {
 if (value === undefined) return 'null';
 if (value === null || typeof value !== 'object') return JSON.stringify(value);
 if (Array.isArray(value)) return `[${value.map(item => this.canonicalStringify(item)).join(',')}]`;
 return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${this.canonicalStringify(value[key])}`).join(',')}}`;
 }

 hashCanonical(value) {
 const text = this.canonicalStringify(value);
 let hash = 0x811c9dc5;
 for (let index = 0; index < text.length; index++) {
 hash ^= text.charCodeAt(index);
 hash = Math.imul(hash, 0x01000193) >>> 0;
 }
 return hash.toString(16).padStart(8, '0');
 }

 getIntegrityPayload(backup) {
 const payload = { ...backup };
 delete payload.integrity;
 return payload;
 }

 createIntegrity(backup) { return { algorithm: 'fnv1a32', value: this.hashCanonical(this.getIntegrityPayload(backup)) }; }

 verifyIntegrity(backup) {
 if (!backup?.integrity) return true;
 if (backup.integrity.algorithm !== 'fnv1a32') throw new Error('备份完整性算法不受支持');
 const expected = this.createIntegrity(backup).value;
 if (String(backup.integrity.value || '').toLowerCase() !== expected) throw new Error('备份完整性校验失败，内容可能不完整或已被修改');
 return true;
 }

 buildModuleVersions(modules) {
 return Object.fromEntries(Object.keys(modules || {}).map(id => [id, this.moduleVersions[id] || 1]));
 }

 validateModuleVersions(backup) {
 const versions = backup.moduleVersions && typeof backup.moduleVersions === 'object' && !Array.isArray(backup.moduleVersions) ? backup.moduleVersions : {};
 Object.keys(backup.modules || {}).forEach(id => {
 const incoming = this.normalizeSchemaVersion(versions[id], 1);
 const supported = this.moduleVersions[id];
 if (supported && incoming > supported) throw new Error(`${this.getModuleLabel(id)}的数据版本较新，请使用更新版码单器导入`);
 });
 return true;
 }

 makeUniqueImportedName(baseName, usedNameKeys) {
 const store = this.app.priceLibraryStore;
 const base = store.normalizeLibraryName(baseName, '导入价格表');
 let name = base;
 let suffix = 1;
 while (usedNameKeys.has(store.getLibraryNameKey(name))) {
 const marker = `（${suffix++}）`;
 name = `${base.slice(0, Math.max(1, 18 - marker.length))}${marker}`;
 }
 usedNameKeys.add(store.getLibraryNameKey(name));
 return name;
 }

 normalizeIncomingPriceLibraries(value) {
 const store = this.app.priceLibraryStore;
 if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.libraries) || !value.libraries.length) throw new Error('价格库备份格式不正确');
 const incomingVersion = this.normalizeSchemaVersion(value.schemaVersion, 1);
 if (incomingVersion > store.schemaVersion) throw new Error('价格库数据版本较新，请使用更新版码单器导入');
 const libraries = [];
 const usedIds = new Set();
 const usedNames = new Set();
 let duplicateCount = 0;
 value.libraries.forEach((raw, index) => {
 const normalized = store.normalizeLibrary(raw, index);
 if (!normalized?.library) return;
 let library = normalized.library;
 duplicateCount += Number(normalized.duplicateCount) || 0;
 if (usedIds.has(library.id)) library = { ...library, id: `price_import_${store.hashText(`${library.id}|${index}`)}` };
 library = { ...library, name: this.makeUniqueImportedName(library.name, usedNames) };
 usedIds.add(library.id);
 libraries.push(library);
 });
 if (!libraries.length) throw new Error('价格库备份中没有有效记录');
 const activeLibraryId = libraries.some(library => library.id === value.activeLibraryId) ? value.activeLibraryId : libraries[0].id;
 const candidateData = {
 schemaVersion: store.schemaVersion,
 activeLibraryId,
 libraries,
 createdAt: Number(value.createdAt) || Math.min(...libraries.map(library => library.createdAt)),
 updatedAt: Number(value.updatedAt) || Math.max(...libraries.map(library => library.updatedAt)),
 duplicateCount
 };
 const conflictCheck = this.app.priceRuleEditorFeature.validateImportedData(candidateData);
 if (!conflictCheck.ok) throw new Error(`价格规则冲突：${conflictCheck.message}`);
 return candidateData;
 }

 buildLegacyPriceLibraries(priceMemory, backup = {}) {
 const store = this.app.priceLibraryStore;
 const data = store.createFromLegacy(priceMemory);
 const library = data.libraries[0];
 library.name = '导入价格表';
 library.id = `price_import_legacy_${store.hashText(`${backup.exportedAt || ''}|${library.items.length}`)}`;
 data.activeLibraryId = library.id;
 data.migratedFrom = 'backup.priceMemory';
 return data;
 }

 migrateBackup(backup) {
 const sourceVersion = this.normalizeSchemaVersion(backup.schemaVersion, 1);
 if (sourceVersion > this.schemaVersion) throw new Error('备份版本较新，请使用更新版码单器导入');
 this.verifyIntegrity(backup);
 this.validateModuleVersions(backup);
 const migrated = this.clone(backup);
 if (migrated.modules?.priceLibraries) {
 migrated.modules.priceLibraries = this.normalizeIncomingPriceLibraries(migrated.modules.priceLibraries);
 delete migrated.modules.priceMemory;
 } else if (migrated.modules?.priceMemory) {
 migrated.modules.priceLibraries = this.normalizeIncomingPriceLibraries(this.buildLegacyPriceLibraries(migrated.modules.priceMemory, migrated));
 delete migrated.modules.priceMemory;
 }
 if (migrated.modules?.history) migrated.modules.history = this.normalizeHistory(migrated.modules.history);
 migrated.schemaVersion = this.schemaVersion;
 migrated.moduleVersions = this.buildModuleVersions(migrated.modules);
 delete migrated.moduleVersions.priceMemory;
 delete migrated.integrity;
 migrated.integrity = this.createIntegrity(migrated);
 return migrated;
 }

 normalizeConfirmedNames(list) {
 return this.app.enhancedExtractor.normalizeConfirmedCollection(list);
 }

 normalizeLearningData(data) {
 const safe = data && typeof data === 'object' ? data : {};
 return {
 corrections: this.app.enhancedExtractor.normalizeCorrectionCollection(safe.corrections),
 patterns: Array.isArray(safe.patterns) ? safe.patterns.filter(Boolean).slice(0, 500) : [],
 stats: safe.stats && typeof safe.stats === 'object' ? safe.stats : { totalExtractions: 0, autoCorrections: 0, userCorrections: 0 },
 commonNames: this.app.enhancedExtractor.normalizeCommonNames(safe.commonNames),
 ignoredNames: this.app.enhancedExtractor.normalizeIgnoredCollection(safe.ignoredNames)
 };
 }

 normalizeModeRatios(modeRatios) {
 const current = this.clone(this.app.modeRatios);
 const source = modeRatios && typeof modeRatios === 'object' ? modeRatios : {};
 ['mode1', 'mode2'].forEach(modeKey => {
 const src = source[modeKey] || {};
 const customRatios = Array.isArray(src.customRatios) ? src.customRatios : [];
 const normalized = [];
 const seen = new Set();
 customRatios.forEach(raw => {
 const group = Number(raw?.group);
 const platform = Number(raw?.platform);
 const earning = Number(raw?.earning);
 if (![group, platform, earning].every(Number.isFinite)) return;
 if (Math.round((group + platform + earning) * 1000) / 1000 !== 100) return;
 const key = `${group}|${platform}|${earning}`;
 if (seen.has(key)) return;
 seen.add(key);
 normalized.push({
 id: String(raw?.id || `custom_${Date.now()}_${normalized.length}`),
 name: String(raw?.name || '导入比例').trim() || '导入比例',
 group,
 platform,
 earning,
 timestamp: raw?.timestamp || new Date().toLocaleString()
 });
 });
 current[modeKey].customRatios = normalized;
 if (src.currentRatioId && (src.currentRatioId === 'default' || normalized.some(item => item.id === src.currentRatioId))) current[modeKey].currentRatioId = src.currentRatioId;
 });
 return current;
 }

 mergeModeRatios(incoming) {
 const next = this.clone(this.app.modeRatios);
 const normalized = this.normalizeModeRatios(incoming);
 ['mode1', 'mode2'].forEach(modeKey => {
 const list = Array.isArray(next[modeKey].customRatios) ? next[modeKey].customRatios : [];
 const seen = new Set(list.map(ratio => `${ratio.group}|${ratio.platform}|${ratio.earning}`));
 normalized[modeKey].customRatios.forEach(ratio => {
 const key = `${ratio.group}|${ratio.platform}|${ratio.earning}`;
 if (seen.has(key)) return;
 seen.add(key);
 list.push({ ...ratio, id: `custom_${Date.now()}_${list.length}` });
 });
 next[modeKey].customRatios = list;
 });
 return next;
 }

 normalizeHistory(list) {
 const normalized = this.app.historyStore.normalize(list);
 const seen = new Set();
 const result = [];
 normalized.forEach(order => {
 const key = JSON.stringify([order.timestamp || '', order.orderText || order.peiPei || '', order.boss || '', order.totalPrice || '']);
 if (seen.has(key)) return;
 seen.add(key);
 result.push(order);
 });
 return result.slice(0, this.app.historyStore.limit || 10);
 }

 mergeHistory(incoming) { return this.normalizeHistory([...this.normalizeHistory(incoming), ...this.normalizeHistory(this.app.history)]); }

 mergeRecentBosses(incoming) {
 const map = new Map();
 [...(Array.isArray(this.app.recentBosses) ? this.app.recentBosses : []), ...(Array.isArray(incoming) ? incoming : [])]
 .map(item => this.app.bossDirectory.normalizeRecentBossEntry(item))
 .filter(Boolean)
 .forEach(item => {
 const key = this.app.bossDirectory.buildRecentBossKey(item);
 const current = map.get(key);
 if (!current) {
 map.set(key, item);
 return;
 }
 map.set(key, {
 ...current,
 ...item,
 usageCount: Math.max(Number(current.usageCount) || 1, Number(item.usageCount) || 1),
 timestamp: Math.max(Number(current.timestamp) || 0, Number(item.timestamp) || 0)
 });
 });
 return [...map.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, this.app.bossDirectory.recentLimit);
 }

 getCurrentExtractorData() { return this.app.enhancedExtractor.data || {}; }

 buildPriceLibrariesExport(selectedIds) {
 const data = this.getCurrentPriceLibrariesData();
 const selectedSet = new Set(selectedIds || []);
 const libraries = data.libraries.filter(library => selectedSet.has(library.id)).map(library => this.clone(library));
 if (!libraries.length) throw new Error('请至少选择一个价格库导出');
 return {
 schemaVersion: this.app.priceLibraryStore.schemaVersion,
 activeLibraryId: libraries.some(library => library.id === data.activeLibraryId) ? data.activeLibraryId : libraries[0].id,
 libraries,
 createdAt: data.createdAt,
 updatedAt: data.updatedAt
 };
 }

 buildBackup(moduleIds = this.getSelectedExportModuleIds()) {
 if (!moduleIds.length) throw new Error('请至少选择一个导出模块');
 const modules = {};
 const extractorData = this.getCurrentExtractorData();
 moduleIds.forEach(id => {
 if (id === 'playableNames') modules.playableNames = this.normalizeConfirmedNames(extractorData.confirmedNames);
 if (id === 'bossMemory') modules.bossMemory = this.app.bossDirectory.normalizeMemory(this.app.bossMemory);
 if (id === 'recentBosses') modules.recentBosses = this.app.bossDirectory.normalizeRecentBosses(this.app.recentBosses);
 if (id === 'priceLibraries') {
 modules.priceLibraries = this.buildPriceLibrariesExport(this.getSelectedExportPriceLibraryIds());
 const compatibilityLibrary = modules.priceLibraries.libraries.find(library => library.id === modules.priceLibraries.activeLibraryId) || modules.priceLibraries.libraries[0];
 modules.priceMemory = this.app.priceLibraryStore.toLegacyItems(compatibilityLibrary?.items || []);
 }
  if (id === 'modeRatios') modules.modeRatios = this.app.getStateValueForStorage('modeRatios');
 if (id === 'history') modules.history = this.normalizeHistory(this.app.history);
 if (id === 'lockedFields') modules.lockedFields = { lockedPeiPei: this.app.lockedPeiPei, lockedPaiDan: this.app.lockedPaiDan, lockedBoss: this.app.lockedBoss };
 if (id === 'nameLearningData') modules.nameLearningData = this.normalizeLearningData(extractorData);
 });
 const backup = {
 backupType: this.backupType,
 schemaVersion: this.schemaVersion,
 appVersion: APP_VERSION,
 exportedAt: new Date().toISOString(),
 moduleVersions: this.buildModuleVersions(modules),
 modules
 };
 return { ...backup, integrity: this.createIntegrity(backup) };
 }

 getBackupText() { return JSON.stringify(this.buildBackup(), null, 2); }

 setExportText(text) {
 const output = this.app.el.dpExportText;
 if (!output) return false;
 output.value = String(text ?? '');
 output.hidden = !output.value.trim();
 if (!output.hidden) this.app.uiRender.revealContainingDetails(output);
 return !output.hidden;
 }

 createFileName() {
 const pad = n => String(n).padStart(2, '0');
 const d = new Date();
 return `码单器备份_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.json`;
 }

 async copyText(text) {
 const ok = await this.app.orderFlow.copyToClipboard(text);
 if (!ok) throw new Error('复制失败');
 return true;
 }

 downloadText(text, filename = this.createFileName()) {
 const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
 const safeName = String(filename || this.createFileName());
 const revoke = (url, delay = 5000) => { setTimeout(() => { try { URL.revokeObjectURL(url); } catch (error) { appLogSilent(error); } }, delay); };
 const tryWebShare = async () => {
 if (typeof navigator === 'undefined' || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
 try {
 if (typeof File === 'function') {
 const file = new File([text], safeName, { type: 'application/json' });
 if (navigator.canShare({ files: [file] })) {
 await navigator.share({ title: '码单器备份', text: '码单器备份文件', files: [file] });
 return true;
 }
 }
 await navigator.share({ title: '码单器备份', text });
 return true;
 } catch (error) {
 if (error && (error.name === 'AbortError' || /abort|cancel/i.test(String(error && error.message || '')))) return 'cancelled';
 return false;
 }
 };
 return (async () => {
 const shareResult = await tryWebShare();
 if (shareResult === true) return true;
 if (shareResult === 'cancelled') return false;
 try {
 const url = URL.createObjectURL(blob);
 const opened = window.open(url, '_blank', 'noopener');
 if (opened) { revoke(url, 30000); return true; }
 revoke(url, 1500);
 } catch (error) { appLogSilent(error); }
 try {
 const url = URL.createObjectURL(blob);
 const link = document.createElement('a');
 link.href = url;
 link.download = safeName;
 link.rel = 'noopener';
 link.style.display = 'none';
 document.body.appendChild(link);
 link.click();
 link.remove();
 revoke(url, 5000);
 return true;
 } catch (error) { appLogSilent(error); return false; }
 })();
 }

 async shareText(text) {
 if (!navigator.share) throw new Error('当前浏览器不支持系统分享');
 const filename = this.createFileName();
 const file = typeof File === 'function' ? new File([text], filename, { type: 'application/json' }) : null;
 if (file && navigator.canShare?.({ files: [file] })) {
 await navigator.share({ title: '码单器备份', text: '码单器备份文件', files: [file] });
 return;
 }
 await navigator.share({ title: '码单器备份', text });
 }

 async exportAction(type = 'copyDownload') {
 try {
 const text = this.getBackupText();
 this.setExportText(text);
 if (type === 'copy' || type === 'copyDownload') await this.copyText(text);
 let downloadOk = true;
 if (type === 'download' || type === 'copyDownload') downloadOk = await this.downloadText(text);
 if (type === 'share') await this.shareText(text);
 const messageMap = { copy: '备份内容已复制', download: '备份文件已生成', share: '已打开系统分享', copyDownload: '备份已复制并生成下载文件' };
 if ((type === 'download' || type === 'copyDownload') && !downloadOk) {
 this.setExportText(text);
 this.app.showError('当前环境无法直接下载，已显示备份内容，请长按全选复制，或使用上方"复制文本"/"系统分享"按钮');
 return;
 }
 this.app.showSuccess(messageMap[type] || '导出完成');
 } catch (error) {
 this.app.logError('dataExport', error);
 this.app.showInfo('自动处理受限，已把备份内容显示在文本框，可长按手动复制');
 try { this.setExportText(this.getBackupText()); } catch (innerError) { this.app.showError(innerError.message || '导出失败'); }
 }
 }

 getImportMode() { return this.app.el.dpImportOverwrite?.checked ? 'overwrite' : 'merge'; }
 readImportText() { return String(this.app.el.dpImportText?.value ?? '').trim(); }

 extractJsonText(text) {
 const raw = String(text ?? '').trim();
 if (!raw) throw new Error('请先粘贴备份内容或选择备份文件');
 const start = raw.indexOf('{');
 const end = raw.lastIndexOf('}');
 if (start < 0 || end <= start) throw new Error('未识别到 JSON 备份内容');
 return raw.slice(start, end + 1);
 }

 parseBackupText(text) {
 const data = JSON.parse(this.extractJsonText(text));
 const modules = data?.modules && typeof data.modules === 'object' && !Array.isArray(data.modules) ? data.modules : null;
 if (!modules) throw new Error('备份格式不正确：缺少 modules');
 if (data.backupType && data.backupType !== this.backupType) throw new Error('备份类型不匹配');
 return this.migrateBackup({ ...data, modules });
 }

 countModule(id, value) {
 if (id === 'lockedFields') return Object.values(value || {}).filter(v => v !== null && v !== undefined && String(v).trim() !== '').length;
 if (id === 'modeRatios') return ['mode1', 'mode2'].reduce((sum, key) => sum + (Array.isArray(value?.[key]?.customRatios) ? value[key].customRatios.length : 0), 0);
 if (id === 'nameLearningData') return (Array.isArray(value?.corrections) ? value.corrections.length : 0) + (Array.isArray(value?.commonNames) ? value.commonNames.length : 0) + (Array.isArray(value?.ignoredNames) ? value.ignoredNames.length : 0);
 if (id === 'priceLibraries') return Array.isArray(value?.libraries) ? value.libraries.length : 0;
 return Array.isArray(value) ? value.length : 0;
 }

 getModuleLabel(id) {
 if (id === 'priceMemory') return '旧版单价记忆库';
 return this.getModuleConfigs().find(config => config.id === id)?.label || id;
 }

 getCurrentModuleCount(id) {
 const app = this.app;
 if (id === 'playableNames') return this.countModule(id, app.enhancedExtractor.data.confirmedNames);
 if (id === 'bossMemory') return this.countModule(id, app.bossMemory);
 if (id === 'recentBosses') return this.countModule(id, app.recentBosses);
 if (id === 'priceLibraries') return this.countModule(id, this.getCurrentPriceLibrariesData());
  if (id === 'modeRatios') return this.countModule(id, app.modeRatios);
 if (id === 'history') return this.countModule(id, app.history);
 if (id === 'lockedFields') return this.countModule(id, { lockedPeiPei: app.lockedPeiPei, lockedPaiDan: app.lockedPaiDan, lockedBoss: app.lockedBoss });
 if (id === 'nameLearningData') return this.countModule(id, app.enhancedExtractor.data);
 return 0;
 }

 getIncomingPriceLibraries(backup) {
 return backup?.modules?.priceLibraries ? this.normalizeIncomingPriceLibraries(backup.modules.priceLibraries) : null;
 }

 initializeImportPriceSelection(backup) {
 const incoming = this.getIncomingPriceLibraries(backup);
 this.importPriceLibraryIds = new Set((incoming?.libraries || []).map(library => library.id));
 }

 syncImportPriceSelectionFromDom() {
 const inputs = this.app.el.dpPreview?.querySelectorAll('.dp-import-price-library');
 if (!inputs?.length) return;
 this.importPriceLibraryIds = new Set(Array.from(inputs).filter(input => input.checked).map(input => input.value));
 }

 getSelectedIncomingPriceLibraries(backup) {
 const incoming = this.getIncomingPriceLibraries(backup);
 if (!incoming) return [];
 return incoming.libraries.filter(library => this.importPriceLibraryIds.has(library.id));
 }

 getImportCapacityStatus(backup, mode = this.getImportMode()) {
 const incoming = this.getIncomingPriceLibraries(backup);
 const otherModuleCount = Object.keys(backup?.modules || {}).filter(id => id !== 'priceLibraries').length;
 const store = this.app.priceLibraryStore;
 const currentLibraries = this.getCurrentPriceLibrariesData().libraries;
 const current = currentLibraries.length;
 const max = store.maxLibraries;
 if (!incoming) return { ok: otherModuleCount > 0, selected: 0, current, max, text: '' };
 const selectedLibraries = this.getSelectedIncomingPriceLibraries(backup);
 const selected = selectedLibraries.length;
 if (!selected) return { ok: otherModuleCount > 0, selected, current, max, text: otherModuleCount > 0 ? '未选择价格库，本次将跳过价格库导入。' : '请至少选择一个价格库。' };
 if (selected > max) return { ok: false, selected, current, max, text: `已选择${selected}个价格库，单次最多导入${max}个。` };
 if (mode === 'merge') {
 const newCount = selectedLibraries.filter(incomingLib => !currentLibraries.some(currentLib => store.getLibraryNameKey(currentLib.name) === store.getLibraryNameKey(incomingLib.name))).length;
 if (current + newCount > max) return { ok: false, selected, current, max, text: `当前已有${current}个库，本次将新增${newCount}个，超过最多${max}个；请减少选择或改用覆盖导入。` };
 return {
 ok: true,
 selected,
 current,
 max,
 text: newCount === 0
 ? `已选${selected}个价格库，全部与当前库名相同，将直接合并到现有库。`
 : `本次将新增${newCount}个价格库、合并${selected - newCount}个同名库，导入后共${current + newCount}/${max}个；同名库直接合并，不会添加（1）（2）。`
 };
 }
 return {
 ok: true,
 selected,
 current,
 max,
 text: mode === 'overwrite'
 ? `将用选中的${selected}个价格库替换当前全部价格库。`
 : `将新增${selected}个价格库，导入后共${current + selected}/${max}个。`
 };
 }

 renderPreview(backup, mode = this.getImportMode()) {
 if (this._lastRenderedImport === backup) this.syncImportPriceSelectionFromDom();
 else this._lastRenderedImport = backup;
 const modules = backup.modules || {};
 const rows = Object.keys(modules).map(id => {
 if (id === 'priceLibraries') {
 const incoming = this.getIncomingPriceLibraries(backup);
 const options = incoming.libraries.map(library => `
 <label class="dp-import-price-option" title="${this.app.escapeHtml(library.name)}">
 <input type="checkbox" class="dp-import-price-library" value="${this.app.escapeHtml(library.id)}" ${this.importPriceLibraryIds.has(library.id) ? 'checked' : ''}>
 <span>${this.app.escapeHtml(library.name)}（${library.items.length}条）</span>
 </label>`).join('');
 return `<li>价格库：备份 ${incoming.libraries.length} 库 / 当前 ${this.getCurrentModuleCount(id)} 库
 <div class="dp-import-price-block"><div class="dp-import-price-title">选择要导入的价格库</div><div class="dp-import-price-options">${options}</div></div></li>`;
 }
 const incoming = this.countModule(id, modules[id]);
 const current = this.getCurrentModuleCount(id);
 const action = mode === 'overwrite' ? '覆盖' : '合并';
 return `<li>${this.app.escapeHtml(this.getModuleLabel(id))}：备份 ${incoming} 条 / 当前 ${current} 条 / ${action}</li>`;
 }).join('');
 const exportedAt = backup.exportedAt ? new Date(backup.exportedAt).toLocaleString() : '未知';
 const warning = mode === 'overwrite' ? '<div class="dp-warning">覆盖导入会替换备份中包含模块的当前数据；价格库只使用上方勾选的库。</div>' : '';
 const capacity = this.getImportCapacityStatus(backup, mode);
 const capacityHtml = capacity.text ? `<div class="dp-capacity-note${capacity.ok ? '' : ' error'}">${this.app.escapeHtml(capacity.text)}</div>` : '';
 this.app.setRenderedHtml(this.app.el.dpPreview, `识别到备份：${this.app.escapeHtml(exportedAt)}<ul>${rows}</ul>${capacityHtml}${warning}`);
 this.updateImportApplyState(backup, mode);
 }

 updateImportApplyState(backup = this.lastImport, mode = this.getImportMode()) {
 if (!this.app.el.dpApplyImportBtn) return false;
 if (!backup) {
 this.app.el.dpApplyImportBtn.disabled = true;
 return false;
 }
 const capacity = this.getImportCapacityStatus(backup, mode);
 this.app.el.dpApplyImportBtn.disabled = !capacity.ok;
 const note = this.app.el.dpPreview?.querySelector('.dp-capacity-note');
 if (note && capacity.text) {
 note.textContent = capacity.text;
 note.classList.toggle('error', !capacity.ok);
 }
 return capacity.ok;
 }

 resetPreview() {
 this.lastImport = null;
 this.importPriceLibraryIds.clear();
 this._lastRenderedImport = null;
 if (this.app.el.dpApplyImportBtn) this.app.el.dpApplyImportBtn.disabled = true;
 if (this.app.el.dpPreview) this.app.el.dpPreview.textContent = '请选择文件、粘贴备份内容或选择 Club 后查看解析预览。';
 }

 handleImportInput() {
 this.resetPreview();
 if (this._importInputDebounceTimer) clearTimeout(this._importInputDebounceTimer);
 this._importInputDebounceTimer = setTimeout(() => {
 const text = this.readImportText();
 if (text) this.parseImport();
 }, 500);
 }

 getMemexRepoUrl(file) {
 return `${this.MEMEX_REPO.rawBase}/${encodeURIComponent(file)}?t=${Date.now()}`;
 }

 async fetchJson(url, errorMessage) {
 const controller = new AbortController();
 const timeoutId = setTimeout(() => controller.abort(), 8000);
 try {
 const response = await fetch(url, { method: 'GET', cache: 'no-store', signal: controller.signal });
 if (!response.ok) {
 const error = new Error(errorMessage || `请求失败: ${response.status}`);
 error.status = response.status;
 throw error;
 }
 return await response.json();
 } finally {
 clearTimeout(timeoutId);
 }
 }

 async fetchClubList() {
 const data = await this.fetchJson(this.getMemexRepoUrl('index.json'), '记忆库仓库未配置 Club 清单');
 if (!data || typeof data !== 'object') throw new Error('Club 清单格式错误');
 const clubs = Array.isArray(data.clubs) ? data.clubs : [];
 if (!clubs.length) throw new Error('暂无可用 Club');
 return clubs;
 }

 renderClubList(clubs) {
 const container = this.app.el.clubSelectList;
 if (!container) return;
 const html = clubs.map(club => {
 const label = this.app.escapeHtml(club.label || club.id || '未命名 Club');
 const desc = this.app.escapeHtml(club.description || `记忆库文件: ${club.file || '-'}`);
 return `<button class="club-select-item" type="button" data-club-file="${this.app.escapeHtml(club.file || '')}" data-club-label="${label}">
 <span class="club-select-item__label">${label}</span>
 <span class="club-select-item__desc">${desc}</span>
 </button>`;
 }).join('');
 container.innerHTML = html || '<div class="club-select-empty">暂无可用 Club</div>';
 }

 setClubLoading(loading) {
 this._clubLoading = loading;
 const btn = this.app.el.dpSelectClubBtn;
 if (btn) {
 btn.disabled = loading;
 btn.textContent = loading ? '加载中...' : '选择 Club';
 }
 const list = this.app.el.clubSelectList;
 if (list && loading) list.innerHTML = '<div class="club-select-loading">正在拉取 Club 清单...</div>';
 }

 async openClubSelect() {
 if (this._clubLoading) return;
 this.setClubLoading(true);
 try {
 const clubs = await this.fetchClubList();
 this.renderClubList(clubs);
 this.app.openModal(this.app.el.clubSelectModal);
 } catch (error) {
 this.handleClubError(error);
 } finally {
 this.setClubLoading(false);
 }
 }

 closeClubSelect() {
 this.app.closeModal(this.app.el.clubSelectModal);
 }

 handleClubError(error) {
 const message = error?.message || '无法连接记忆库仓库';
 const status = error?.status;
 let toast = message;
 if (error?.name === 'AbortError') toast = '请求超时，请检查网络后重试';
 else if (status === 404) toast = '记忆库仓库未配置 Club 清单';
 else if (status === 0 || !navigator.onLine) toast = '无法连接记忆库仓库，请检查网络';
 this.app.showError(toast);
 }

 handleClubListClick(event) {
 const item = event.target.closest('.club-select-item');
 if (!item) return;
 const file = item.dataset.clubFile;
 const label = item.dataset.clubLabel || file;
 if (!file) return;
 this.loadClubFile(file, label);
 }

 async loadClubFile(file, label) {
 const list = this.app.el.clubSelectList;
 if (list) list.innerHTML = `<div class="club-select-loading">正在加载 ${this.app.escapeHtml(label)}...</div>`;
 try {
 const data = await this.fetchJson(this.getMemexRepoUrl(file), '该 Club 记忆库文件不存在');
 if (!data || typeof data !== 'object' || !data.modules) throw new Error('Club 记忆库数据格式错误');
 const text = JSON.stringify(data, null, 2);
 if (this.app.el.dpImportText) this.app.el.dpImportText.value = text;
 this.closeClubSelect();
 this.parseImport();
 } catch (error) {
 this.handleClubError(error);
 }
 }

 parseImport() {
 try {
 const backup = this.parseBackupText(this.readImportText());
 this.lastImport = backup;
 this.initializeImportPriceSelection(backup);
 this.renderPreview(backup);
 if (this.updateImportApplyState(backup)) this.app.showSuccess('备份解析成功');
 else this.app.showInfo('备份已解析，请调整价格库选择后再导入');
 } catch (error) {
 this.lastImport = null;
 this.importPriceLibraryIds.clear();
 this._lastRenderedImport = null;
 if (this.app.el.dpApplyImportBtn) this.app.el.dpApplyImportBtn.disabled = true;
 this.app.showError(error.message || '备份解析失败');
 }
 }

 readFileText(file, requestId) {
 if (requestId !== this._fileReadSeq) {
 const error = new Error('文件读取已取消');
 error.name = 'AbortError';
 return Promise.reject(error);
 }
 if (typeof FileReader !== 'function') return file.text();
 return new Promise((resolve, reject) => {
 const reader = new FileReader();
 this._activeFileReader = reader;
 const finish = callback => value => {
 if (this._activeFileReader === reader) this._activeFileReader = null;
 callback(value);
 };
 reader.onload = finish(() => resolve(String(reader.result ?? '')));
 reader.onerror = finish(() => reject(reader.error || new Error('读取备份文件失败')));
 reader.onabort = finish(() => {
 const error = new Error('文件读取已取消');
 error.name = 'AbortError';
 reject(error);
 });
 reader.readAsText(file, 'utf-8');
 });
 }

 async readSelectedFile(input = this.app.el.dpFileInput) {
 const file = input?.files?.[0];
 if (!file) return;
 this.cancelFileRead();
 const requestId = this._fileReadSeq;
 this.resetPreview();
 try {
 const text = await this.readFileText(file, requestId);
 if (requestId !== this._fileReadSeq) return;
 if (this.app.el.dpImportText) this.app.el.dpImportText.value = text;
 this.parseImport();
 } catch (error) {
 if (requestId !== this._fileReadSeq || error?.name === 'AbortError') return;
 this.app.showError('读取备份文件失败');
 } finally {
 if (input) input.value = '';
 }
 }

 captureUndoSnapshot() {
 this.undoSnapshot = { enhancedNameExtractorData: this.app.enhancedExtractor.snapshotData() };
 this.undoStateKeys.forEach(key => { this.undoSnapshot[key] = this.clone(this.app[key]); });
 if (this.app.el.dpUndoImportBtn) this.app.el.dpUndoImportBtn.disabled = false;
 }

 restoreImportSnapshot(snapshot, { keepUndo = false } = {}) {
 if (!snapshot) return false;
 this.app.enhancedExtractor.data = this.clone(snapshot.enhancedNameExtractorData);
 this.app.enhancedExtractor.markLearningCollectionsDirty();
 this.undoStateKeys.forEach(key => { this.app[key] = this.clone(snapshot[key]); });
 const restored = this.refreshAfterImport();
 if (!keepUndo) {
 this.undoSnapshot = null;
 if (this.app.el.dpUndoImportBtn) this.app.el.dpUndoImportBtn.disabled = true;
 }
 return restored;
 }

 refreshAfterImport() {
 this.app.enhancedExtractor.markLearningCollectionsDirty();
 const results = [this.app.enhancedExtractor.saveData(), this.app.bossMemoryFeature.save(), this.app.savePriceMemory(), this.app.saveRecentBosses(), this.app.saveModeRatios(), this.app.saveLockedData(), this.app.historyFeature.save(), this.app.saveLayoutPrefs(), this.app.saveLayoutTemplates()];
 this.app.historyFeature.updateUI();
 this.app.bossMemoryFeature.refresh();
 this.app.extractionFeature?.resetSavedNamesRenderLimit?.();
 [() => this.app.inputFlowFeature?.applyLockedDataToUI?.(), () => this.app.layoutFeature?.applyLayoutVisibility?.(), () => this.app.extractionFeature?.updateSavedNamesList?.(), () => this.app.priceRuleEditorFeature?.updatePriceMemoryUI?.(), () => this.app.ratioFeature?.updateRatioCards?.(), () => this.app.ratioFeature?.updateModeButtonText?.(), () => this.app.updateModeIndicator?.(), () => this.app.inputFlowFeature?.updatePeiPeiCount?.(), () => this.app.bossMemoryFeature?.hideBossSuggestions?.()]
 .forEach(run => run());
 this.app.priceMemoryFeature?.resetPriceMemoryEditor?.({ clear: true });
 this.app.priceMemoryFeature?.refreshServicePriceMatchAfterLibraryChange?.();
 return results.every(result => result !== false);
 }

 applyPlayableNames(incoming, mode) {
 const currentData = this.app.enhancedExtractor.data;
 const imported = this.normalizeConfirmedNames(incoming);
 currentData.confirmedNames = mode === 'overwrite' ? imported : this.normalizeConfirmedNames([...(currentData.confirmedNames || []), ...imported]);
 this.app.enhancedExtractor.markLearningCollectionsDirty();
 }

 applyLearningData(incoming, mode) {
 const currentData = this.app.enhancedExtractor.data;
 const imported = this.normalizeLearningData(incoming);
 if (mode === 'overwrite') {
 currentData.corrections = imported.corrections;
 currentData.patterns = imported.patterns;
 currentData.stats = imported.stats;
 currentData.commonNames = imported.commonNames;
 currentData.ignoredNames = imported.ignoredNames;
 this.app.enhancedExtractor.markLearningCollectionsDirty();
 return;
 }
 const merged = this.normalizeLearningData({
 corrections: [...(currentData.corrections || []), ...imported.corrections],
 patterns: [...(currentData.patterns || []), ...imported.patterns],
 stats: currentData.stats,
 commonNames: [...(currentData.commonNames || []), ...imported.commonNames],
 ignoredNames: [...(currentData.ignoredNames || []), ...imported.ignoredNames]
 });
 currentData.corrections = merged.corrections;
 currentData.patterns = merged.patterns;
 currentData.commonNames = merged.commonNames;
 currentData.ignoredNames = merged.ignoredNames;
 this.app.enhancedExtractor.markLearningCollectionsDirty();
 }

 buildMergedPriceLibraries(incoming, selectedLibraries) {
 const store = this.app.priceLibraryStore;
 const current = store.normalizeData(this.app.priceLibraries) || store.createFromLegacy(this.app.priceMemory || []);
 const selectedIds = new Set(selectedLibraries.map(library => library.id));
 const newLibraryCount = selectedLibraries.filter(sourceLibrary => !current.libraries.some(library => store.getLibraryNameKey(library.name) === store.getLibraryNameKey(sourceLibrary.name))).length;
 if (current.libraries.length + newLibraryCount > store.maxLibraries) throw new Error('导入后价格库数量超过上限');
 const next = this.clone(current);
 const now = Date.now();
 const idMap = new Map();
 selectedLibraries.forEach((sourceLibrary, index) => {
 const incomingNameKey = store.getLibraryNameKey(sourceLibrary.name);
 const existingIndex = next.libraries.findIndex(library => store.getLibraryNameKey(library.name) === incomingNameKey);
 if (existingIndex >= 0) {
 const existing = next.libraries[existingIndex];
 const mergedRaw = {
 ...existing,
 id: existing.id,
 name: existing.name,
 createdAt: existing.createdAt,
 updatedAt: now,
 items: [...existing.items, ...(sourceLibrary.items || [])],
 rules: [...(existing.rules || []), ...(sourceLibrary.rules || [])],
 surcharges: [...(existing.surcharges || []), ...(sourceLibrary.surcharges || [])],
 giftMemories: [...(existing.giftMemories || []), ...(sourceLibrary.giftMemories || [])]
 };
 const normalized = store.normalizeLibrary(mergedRaw, existingIndex);
 next.libraries[existingIndex] = normalized.library;
 idMap.set(sourceLibrary.id, existing.id);
 } else {
 const name = store.makeUniqueLibraryName(next, sourceLibrary.name);
 const id = store.generateLibraryId(next, `${name}|${sourceLibrary.id}|${index}`);
 const items = store.normalizeItems(sourceLibrary.items).items.map((item, itemIndex) => ({
 ...item,
 id: store.buildItemId(item.serviceKey || store.buildServiceKey(item.serviceType), now + index + itemIndex)
 }));
 next.libraries.push({
 ...this.clone(sourceLibrary),
 id,
 name,
 items
 });
 idMap.set(sourceLibrary.id, id);
 }
 });
 if (selectedIds.has(incoming.activeLibraryId)) {
 next.activeLibraryId = idMap.get(incoming.activeLibraryId) || incoming.activeLibraryId;
 }
 next.updatedAt = now;
 const normalized = store.normalizeData(next);
 if (!normalized || normalized.libraries.length !== current.libraries.length + newLibraryCount) throw new Error('价格库合并失败');
 return normalized;
 }

 buildOverwrittenPriceLibraries(incoming, selectedLibraries) {
 const store = this.app.priceLibraryStore;
 if (!selectedLibraries.length) return null;
 if (selectedLibraries.length > store.maxLibraries) throw new Error('选择的价格库超过上限');
 const selectedIds = new Set(selectedLibraries.map(library => library.id));
 const data = {
 schemaVersion: store.schemaVersion,
 activeLibraryId: selectedIds.has(incoming.activeLibraryId) ? incoming.activeLibraryId : selectedLibraries[0].id,
 libraries: selectedLibraries.map(library => this.clone(library)),
 createdAt: Number(incoming.createdAt) || Date.now(),
 updatedAt: Date.now()
 };
 const normalized = store.normalizeData(data);
 if (!normalized || normalized.libraries.length !== selectedLibraries.length) throw new Error('价格库覆盖数据无效');
 return normalized;
 }

 applyPriceLibraries(incomingValue, mode) {
 const incoming = this.normalizeIncomingPriceLibraries(incomingValue);
 const selected = incoming.libraries.filter(library => this.importPriceLibraryIds.has(library.id));
 if (!selected.length) return false;
 const next = mode === 'overwrite'
 ? this.buildOverwrittenPriceLibraries(incoming, selected)
 : this.buildMergedPriceLibraries(incoming, selected);
 if (!next) return false;
 const active = this.app.priceLibraryStore.getActiveLibrary(next);
 this.app.priceLibraries = next;
 this.app.priceMemory = this.app.priceLibraryStore.toLegacyItems(active?.items || []);
 return true;
 }

 applyBackup(backup, mode = 'merge') {
 const modules = backup.modules || {};
 if (modules.playableNames) this.applyPlayableNames(modules.playableNames, mode);
 if (modules.nameLearningData) this.applyLearningData(modules.nameLearningData, mode);
 if (modules.bossMemory) {
 this.app.bossMemory = mode === 'overwrite'
 ? this.app.bossDirectory.normalizeMemory(modules.bossMemory)
 : modules.bossMemory.reduce((list, record) => this.app.bossDirectory.upsertMemoryRecord(list, record).memory, this.app.bossMemory);
 }
 if (modules.priceLibraries) this.applyPriceLibraries(modules.priceLibraries, mode);
 if (modules.recentBosses) this.app.recentBosses = mode === 'overwrite' ? this.app.bossDirectory.normalizeRecentBosses(modules.recentBosses) : this.mergeRecentBosses(modules.recentBosses);
 if (modules.modeRatios) this.app.modeRatios = mode === 'overwrite' ? this.normalizeModeRatios(modules.modeRatios) : this.mergeModeRatios(modules.modeRatios);
 if (modules.history) this.app.history = mode === 'overwrite' ? this.normalizeHistory(modules.history) : this.mergeHistory(modules.history);
 if (modules.lockedFields) {
 ['lockedPeiPei', 'lockedPaiDan', 'lockedBoss'].forEach(key => {
 if (mode === 'overwrite' || modules.lockedFields[key] !== null && modules.lockedFields[key] !== undefined) this.app[key] = modules.lockedFields[key] ?? null;
 });
 }
 if (!this.refreshAfterImport()) throw new Error('导入数据保存失败');
 }

 async applyImport() {
 if (this._applyImportPending) return;
 this._applyImportPending = true;
 try {
 if (!this.lastImport) {
 this.lastImport = this.parseBackupText(this.readImportText());
 this.initializeImportPriceSelection(this.lastImport);
 }
 this.syncImportPriceSelectionFromDom();
 const mode = this.getImportMode();
 const capacity = this.getImportCapacityStatus(this.lastImport, mode);
 if (!capacity.ok) throw new Error(capacity.text || '价格库选择不符合导入条件');
 if (mode === 'overwrite') {
 const confirmed = await this.app.showConfirm('覆盖导入会先替换备份中包含模块的当前数据。本次页面内可撤销一次，是否继续？');
 if (!confirmed) return;
 }
 this.captureUndoSnapshot();
 try {
 this.applyBackup(this.lastImport, mode);
 } catch (error) {
 const snapshot = this.undoSnapshot;
 this.restoreImportSnapshot(snapshot);
 throw new Error(`${error.message || '导入失败'}，已自动恢复导入前数据`);
 }
 this.renderPreview(this.lastImport, mode);
 this.app.showSuccess(mode === 'overwrite' ? '覆盖导入完成' : '合并导入完成');
 } catch (error) {
 this.app.handleError('dataImport', error, error.message || '导入失败，请检查备份内容');
 } finally {
 this._applyImportPending = false;
 }
 }

 undoImport() {
 if (!this.undoSnapshot) return this.app.showInfo('暂无可撤销的导入操作');
 const snapshot = this.undoSnapshot;
 if (this.restoreImportSnapshot(snapshot)) this.app.showSuccess('已撤销本次导入');
 else this.app.showError('撤销导入失败，请使用备份文件恢复');
 }
 }
