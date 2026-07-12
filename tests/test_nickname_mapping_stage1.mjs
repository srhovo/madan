import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('class EnhancedNameExtractor {');
const end = html.indexOf('// ============================================\n // 提取服务', start);
if (start < 0 || end < 0) throw new Error('EnhancedNameExtractor class boundary not found');

const classSource = html.slice(start, end);
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
  appLogSilent: () => {},
  storage: {
    get(key) { return stored.get(key) ?? null; },
    set(key, value) { stored.set(key, JSON.parse(JSON.stringify(value))); return true; }
  }
};
vm.createContext(context);
vm.runInContext(`${classSource}\nthis.EnhancedNameExtractor = EnhancedNameExtractor;`, context);

const extractor = new context.EnhancedNameExtractor();
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

assert(extractor.upsertNameMapping('x下雪', '下雪', 'custom'), 'custom mapping x下雪 should save');
assert(extractor.upsertNameMapping('下雪z', '下雪', 'custom'), 'custom mapping 下雪z should save');
assert(extractor.data.corrections.length === 2, 'two originals must remain as two mappings');
assert(extractor.data.confirmedNames.filter(item => item.name === '下雪').length === 1, 'canonical name must be deduplicated');
assert(extractor.findExactMemoryMapping('x下雪')?.name === '下雪', 'exact mapping must resolve x下雪');
assert(extractor.findExactMemoryMapping('下雪z')?.name === '下雪', 'exact mapping must resolve 下雪z');
assert(extractor.decidePlayableName('x下雪', 'pat').name === '下雪', 'model decision must prioritize exact mapping');

assert(extractor.updateNameMapping('下雪z', '雪下雪', '下雪', 'custom'), 'mapping edit should succeed');
assert(!extractor.getNameMappingByOriginal('下雪z'), 'old original must be removed after edit');
assert(extractor.getNameMappingByOriginal('雪下雪')?.corrected === '下雪', 'edited original must resolve');

assert(extractor.removeNameMapping('x下雪'), 'mapping delete should succeed');
assert(!extractor.getNameMappingByOriginal('x下雪'), 'deleted mapping must be absent');
assert(extractor.getNameMappingByOriginal('雪下雪')?.corrected === '下雪', 'other aliases must be preserved');

const legacy = extractor.normalizeNameMapping({ original: '旧下雪', corrected: '下雪', source: 'interactive' });
assert(legacy?.source === 'manual_correction', 'legacy interactive correction must migrate to manual_correction');

const selfConfirmed = extractor.normalizeNameMapping({ original: '下雪', corrected: '下雪', source: 'interactive' });
assert(selfConfirmed?.source === 'model_confirm', 'unchanged interactive confirmation must migrate to model_confirm');

console.log('nickname mapping stage 1 tests passed');
