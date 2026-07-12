import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const extractClass = className => {
  const start = html.indexOf(`class ${className} {`);
  if (start < 0) throw new Error(`${className} not found`);
  const tail = html.slice(start + 1);
  const nextOffset = tail.search(/\n\s*class [A-Za-z_$][\w$]* \{/);
  if (nextOffset < 0) throw new Error(`${className} end not found`);
  return html.slice(start, start + 1 + nextOffset);
};

const stored = new Map();
const context = {
  console,
  Date,
  Set,
  Map,
  JSON,
  String,
  Number,
  Array,
  Object,
  RegExp,
  Math,
  encodeURIComponent,
  decodeURIComponent,
  BACKUP_SCHEMA_VERSION: 2,
  BACKUP_MODULE_VERSIONS: Object.freeze({ playableNames: 1, nameLearningData: 1 }),
  structuredClone: value => JSON.parse(JSON.stringify(value)),
  appLogSilent: () => {},
  appLogError: () => {},
  storage: {
    get(key) { return stored.get(key) ?? null; },
    set(key, value) { stored.set(key, JSON.parse(JSON.stringify(value))); return true; }
  }
};
vm.createContext(context);
vm.runInContext(`
${extractClass('EnhancedNameExtractor')}
${extractClass('DataPortabilityFeature')}
${extractClass('ExtractionFeature')}
this.EnhancedNameExtractor = EnhancedNameExtractor;
this.DataPortabilityFeature = DataPortabilityFeature;
this.ExtractionFeature = ExtractionFeature;
`, context);

const extractor = new context.EnhancedNameExtractor();
assert(extractor.upsertNameMapping('See.下雪', '下雪', 'custom'), 'punctuated original mapping should save');
assert(extractor.getNameMappingByOriginal('See.下雪')?.original === 'See.下雪', 'source punctuation must be preserved for display and exact lookup');
assert(extractor.findExactMemoryMapping('See.下雪')?.name === '下雪', 'punctuated original must resolve exactly');
assert(extractor.decidePlayableName('See.下雪', 'pat').name === '下雪', 'model must prioritize punctuated exact mapping');

const portability = new context.DataPortabilityFeature({ enhancedExtractor: extractor });
const importedLearning = portability.normalizeLearningData({
  corrections: [
    { original: '同一错名', corrected: '旧名', timestamp: 1, source: 'manual_correction' },
    { original: '同一错名', corrected: '新名', timestamp: 2, source: 'manual_correction' }
  ]
});
assert(importedLearning.corrections.length === 1, 'import must keep one current result per recognized original');
assert(importedLearning.corrections[0].corrected === '新名', 'newest imported mapping must win');

const feature = new context.ExtractionFeature({
  enhancedExtractor: extractor,
  _savedNamesSearchQuery: '',
  _editingNameMappingOriginal: ''
});
const viewItems = feature.getSavedNamesViewItems();
assert(viewItems.length === 1, 'canonical confirmed record must not duplicate an existing alias mapping');
assert(viewItems[0].original === 'See.下雪' && viewItems[0].corrected === '下雪', 'mapping view must show recognized original to canonical name');

assert(html.includes('>撤销上次修改</button>'), 'undo wording must cover add, edit and delete');
assert(html.includes('@media (max-width: 520px)'), 'narrow-phone mapping editor layout must exist');
assert(html.includes('.name-mapping-field { grid-column: 1 / -1; }'), 'mapping inputs must use full width on narrow phones');
assert(html.includes('<!-- 陪玩昵称映射库弹窗 -->'), 'mapping modal code comment must be updated');
assert(html.includes('aria-label="退出昵称映射库弹窗"'), 'mapping modal accessibility label must be updated');

console.log('nickname mapping release tests passed');
