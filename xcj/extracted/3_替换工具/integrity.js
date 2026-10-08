/**
 * 重算备份完整性校验（与码单器 DataPortabilityFeature 逐条对齐）。
 *
 * 算法（从 madan/index.html 的 dataPortability chunk 还原）：
 *   canonicalStringify：对象键排序、数组保序、跳过 undefined；
 *   hashCanonical：对 canonical 文本按 UTF-16 code unit 做 FNV-1a 32；
 *   getIntegrityPayload：删掉顶层 integrity 字段后计算。
 *
 * 已用线上真实备份反向验证通过（见 verify-integrity.js）。
 */
const fs = require('fs');

function canonicalStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalStringify(item)).join(',')}]`;
  return `{${Object.keys(value).filter(k => value[k] !== undefined).sort()
    .map(k => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
}

function hashCanonical(value) {
  const text = canonicalStringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function getIntegrityPayload(backup) {
  const payload = { ...backup };
  delete payload.integrity;
  return payload;
}

function createIntegrity(backup) {
  return { algorithm: 'fnv1a32', value: hashCanonical(getIntegrityPayload(backup)) };
}

function verifyIntegrity(backup) {
  if (!backup || !backup.integrity) return { ok: true, note: '无 integrity 字段，跳过校验' };
  if (backup.integrity.algorithm !== 'fnv1a32') throw new Error('备份完整性算法不受支持');
  const expected = createIntegrity(backup).value;
  const actual = String(backup.integrity.value || '').toLowerCase();
  return { ok: actual === expected, expected, actual };
}

/** 就地写入正确的 integrity，返回备份对象 */
function seal(backup) {
  backup.integrity = createIntegrity(backup);
  return backup;
}

module.exports = { canonicalStringify, hashCanonical, createIntegrity, verifyIntegrity, seal };

if (require.main === module) {
  const mode = process.argv[2];
  const file = process.argv[3];
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (mode === 'verify') {
    const r = verifyIntegrity(backup);
    console.log(`${file}: ${r.ok ? '✓ 校验通过' : '✗ 校验失败'} (${r.actual || '-'} vs ${r.expected || '-'})`);
    process.exit(r.ok ? 0 : 1);
  } else if (mode === 'seal') {
    const before = backup.integrity ? backup.integrity.value : '(无)';
    seal(backup);
    fs.writeFileSync(file, JSON.stringify(backup, null, 2), 'utf8');
    console.log(`${file}: integrity ${before} -> ${backup.integrity.value}`);
  }
}
