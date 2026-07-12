import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

[
  '陪玩昵称映射库',
  'id="nameMappingOriginalInput"',
  'id="nameMappingCorrectedInput"',
  'id="nameMappingSaveBtn"',
  'id="nameMappingCancelBtn"',
  '识别名称（原始）',
  '正确团名',
  '模型确认',
  '手动修正',
  '自定义添加',
  'saved-name-edit'
].forEach(token => assert(html.includes(token), `missing UI token: ${token}`));

assert(!html.includes("this.service.enhancedExtractor.batchConfirmNames(correctedNames, 'interactive');"), 'duplicate confirmation source overwrite must be removed');
assert(html.includes("getKey: item => `${item.kind}:"), 'mapping list must have stable keyed rendering');
assert(html.includes("getPayload: item => ({ original: decodeURIComponent"), 'delegated list actions must carry original and corrected names');

const start = html.indexOf('class ExtractionFeature {');
const tail = html.slice(start + 1);
const nextClassOffset = tail.search(/\n class [A-Za-z_$][\w$]* \{/);
assert(start >= 0 && nextClassOffset > 0, 'ExtractionFeature class boundary not found');
const classSource = html.slice(start, start + 1 + nextClassOffset);

const context = { console, Date, String, Number, Array, Object, Set, Map, JSON, encodeURIComponent, decodeURIComponent, appLogSilent: () => {}, appLogError: () => {} };
vm.createContext(context);
vm.runInContext(`${classSource}\nthis.ExtractionFeature = ExtractionFeature;`, context);

const calls = [];
const mappings = [];
const enhancedExtractor = {
  compactExtractName: value => String(value ?? '').replace(/\s+/g, ''),
  normalizeMappingSource: (source, original, corrected) => source === 'interactive' ? (original === corrected ? 'model_confirm' : 'manual_correction') : source,
  getNameMappings: () => mappings,
  getNameMappingByOriginal: original => mappings.find(item => item.original === original) || null,
  upsertNameMapping(original, corrected, source) {
    const current = mappings.find(item => item.original === original);
    if (current) Object.assign(current, { corrected, source, timestamp: Date.now() });
    else mappings.push({ original, corrected, source, timestamp: Date.now() });
    calls.push(['upsert', original, corrected, source]);
    return true;
  },
  updateNameMapping(previous, original, corrected, source) {
    const index = mappings.findIndex(item => item.original === previous);
    if (index >= 0) mappings.splice(index, 1);
    mappings.push({ original, corrected, source, timestamp: Date.now() });
    calls.push(['update', previous, original, corrected, source]);
    return true;
  },
  removeNameMapping(original) { calls.push(['removeMapping', original]); return true; },
  removeConfirmedName(name) { calls.push(['removeConfirmed', name]); return true; },
  data: { confirmedNames: [] }
};

const el = {
  nameMappingOriginalInput: { value: '', focus() { calls.push(['focus']); } },
  nameMappingCorrectedInput: { value: '' },
  nameMappingSaveBtn: { textContent: '' },
  nameMappingCancelBtn: { style: { display: '' } },
  savedNamesMeta: { textContent: '' },
  savedNamesSearchInput: { value: '', focus() {} },
  savedNamesSearchClearBtn: { style: {} }
};
const app = {
  el,
  enhancedExtractor,
  extractorService: {},
  correctionModal: null,
  extractionConfig: {},
  lockedPeiPei: null,
  currentExtractMode: 'pat',
  extractRequestSeq: 0,
  _savedNamesSearchQuery: '',
  _editingNameMappingOriginal: '',
  uiRender: {
    updateNamedCollectionView() { return true; },
    openModal() { return true; },
    closeModal() { return true; },
    setActiveState() {},
    clearRenderedHtml() {},
    getElement(value) { return value; }
  },
  inputFlowFeature: { focusFirstBlankAfterLastFilled() {}, syncInputValueState() {} },
  bindActionClicks() {}, on() {}, debounce(fn) { return fn; }, scheduleUiTask(_key, fn) { fn(); },
  captureLearningSnapshot() { calls.push(['snapshot']); }, updateLearningUndoButton() {},
  showSuccess(message) { calls.push(['success', message]); }, showError(message) { calls.push(['error', message]); return false; },
  showInfo() {}, showConfirm: async () => true, handleError() {}
};
const feature = new context.ExtractionFeature(app);
feature.submitNamesToPeiPei = value => { calls.push(['apply', value]); return true; };

el.nameMappingOriginalInput.value = 'x下雪';
el.nameMappingCorrectedInput.value = '下雪';
assert(feature.saveNameMappingFromEditor() === true, 'new mapping should save');
assert(calls.some(call => call[0] === 'upsert' && call[1] === 'x下雪' && call[2] === '下雪' && call[3] === 'custom'), 'new mapping must use custom source');

feature.startEditNameMapping({ original: 'x下雪', corrected: '下雪' });
el.nameMappingOriginalInput.value = '下雪z';
el.nameMappingCorrectedInput.value = '下雪';
assert(feature.saveNameMappingFromEditor() === true, 'mapping edit should save');
assert(calls.some(call => call[0] === 'update' && call[1] === 'x下雪' && call[2] === '下雪z'), 'edit must replace the selected original');

feature.applySavedNameToPeipei({ original: '下雪z', corrected: '下雪' });
assert(calls.some(call => call[0] === 'apply' && call[1] === '下雪'), 'list click must apply corrected name');

await feature.deleteSavedName({ original: '下雪z', corrected: '下雪', kind: 'mapping' });
assert(calls.some(call => call[0] === 'removeMapping' && call[1] === '下雪z'), 'mapping delete must remove only the selected original mapping');

console.log('nickname mapping stage 2 tests passed');
