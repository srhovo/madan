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
  BACKUP_SCHEMA_VERSION: 2,
  BACKUP_MODULE_VERSIONS: Object.freeze({ playableNames: 1, nameLearningData: 1 }),
  structuredClone: value => JSON.parse(JSON.stringify(value)),
  appLogSilent: () => {},
  storage: {
    get(key) { return stored.get(key) ?? null; },
    set(key, value) { stored.set(key, JSON.parse(JSON.stringify(value))); return true; }
  }
};
vm.createContext(context);
vm.runInContext(`${extractClass('EnhancedNameExtractor')}\n${extractClass('DataPortabilityFeature')}\nthis.EnhancedNameExtractor = EnhancedNameExtractor; this.DataPortabilityFeature = DataPortabilityFeature;`, context);

const sourceExtractor = new context.EnhancedNameExtractor();
sourceExtractor.upsertNameMapping('x下雪', '下雪', 'custom');
sourceExtractor.upsertNameMapping('下雪z', '下雪', 'manual_correction');

const sourceFeature = new context.DataPortabilityFeature({ enhancedExtractor: sourceExtractor });
const exported = sourceFeature.buildPlayableNamesBackup(sourceExtractor.data);
const snow = exported.find(item => item.name === '下雪');
assert(snow, 'canonical 下雪 entry must be exported');
assert(Array.isArray(snow.aliases) && snow.aliases.length === 2, 'both aliases must be embedded in default playableNames backup');
assert(snow.aliases.some(item => item.original === 'x下雪' && item.corrected === '下雪'), 'x下雪 alias must be exported');
assert(snow.aliases.some(item => item.original === '下雪z' && item.corrected === '下雪'), '下雪z alias must be exported');

const targetExtractor = new context.EnhancedNameExtractor();
const targetFeature = new context.DataPortabilityFeature({ enhancedExtractor: targetExtractor });
targetFeature.applyPlayableNames(exported, 'overwrite');
assert(targetExtractor.getNameMappingByOriginal('x下雪')?.corrected === '下雪', 'x下雪 alias must restore');
assert(targetExtractor.getNameMappingByOriginal('下雪z')?.corrected === '下雪', '下雪z alias must restore');
assert(targetExtractor.data.confirmedNames.filter(item => item.name === '下雪').length === 1, 'canonical name remains deduplicated after restore');

const legacyExtractor = new context.EnhancedNameExtractor();
legacyExtractor.upsertNameMapping('保留别名', '下雪', 'custom');
const legacyFeature = new context.DataPortabilityFeature({ enhancedExtractor: legacyExtractor });
legacyFeature.applyPlayableNames([{ name: '下雪', original: '下雪', timestamp: Date.now(), source: 'auto' }], 'overwrite');
assert(legacyExtractor.getNameMappingByOriginal('保留别名')?.corrected === '下雪', 'legacy backup without aliases must not erase existing mappings');

assert(html.includes("label: '陪玩昵称映射库'"), 'backup UI must use nickname mapping library label');
assert(html.includes('buildPlayableNamesBackup(extractorData)'), 'default playableNames export must include alias builder');
console.log('nickname mapping stage 3 tests passed');
