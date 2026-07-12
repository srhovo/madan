import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('class EnhancedNameExtractor {');
const end = html.indexOf('// ============================================\n // 提取服务', start);
if (start < 0 || end < 0) throw new Error('EnhancedNameExtractor class boundary not found');

const stored = new Map();
const context = {
  console, Date, Set, Map, JSON, String, Number, Array, Object, RegExp, Math,
  appLogSilent: () => {},
  storage: {
    get(key) { return stored.get(key) ?? null; },
    set(key, value) { stored.set(key, JSON.parse(JSON.stringify(value))); return true; }
  }
};
vm.createContext(context);
vm.runInContext(`${html.slice(start, end)}\nthis.EnhancedNameExtractor = EnhancedNameExtractor;`, context);

const extractor = new context.EnhancedNameExtractor();
const assert = (condition, message) => { if (!condition) throw new Error(message); };

assert(extractor.upsertNameMapping('See.下雪', '下雪', 'custom'), 'punctuated original should save');
const punctuated = extractor.getNameMappingByOriginal('See.下雪');
assert(punctuated?.original === 'See.下雪', 'punctuated original must be preserved exactly after normalization');
assert(extractor.findExactMemoryMapping('See.下雪')?.name === '下雪', 'punctuated original must exact-match later');
assert(extractor.decidePlayableName('See.下雪', 'at').name === '下雪', 'model must prioritize punctuated exact mapping');

assert(extractor.upsertNameMapping('识别-yudrops', 'yudrops', 'custom'), 'longer English corrected name should save');
assert(extractor.getNameMappingByOriginal('识别-yudrops')?.corrected === 'yudrops', 'longer English corrected name must persist');
assert(extractor.findExactMemoryMapping('识别-yudrops')?.name === 'yudrops', 'longer English corrected name must exact-match');

assert(extractor.upsertNameMapping('x 下雪', '下雪', 'custom'), 'spaced original should save');
assert(extractor.getNameMappingByOriginal('x下雪')?.corrected === '下雪', 'lookup must ignore insignificant spaces consistently');

console.log('nickname mapping edge-case tests passed');
