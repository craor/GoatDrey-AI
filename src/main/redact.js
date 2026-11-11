// Вычищает секреты из строк, которые могут попасть в журнал, ошибки или интерфейс.
function luhn(num) {
  let sum = 0, dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = +num[i];
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

const PATTERNS = [
  [/\bgsk_[A-Za-z0-9_-]{8,}\b/g, 'gsk_***'],
  [/\bsk-ant-[A-Za-z0-9_\-]{8,}\b/g, 'sk-ant-***'],
  [/\bsk-or-[A-Za-z0-9_\-]{8,}\b/g, 'sk-or-***'],
  [/\bsk-api-[A-Za-z0-9_\-]{8,}\b/g, 'sk-api-***'],
  [/\bxai-[A-Za-z0-9_\-]{8,}\b/g, 'xai-***'],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, 'github_pat_***'],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, 'gh*_***'],
  [/\bAIza[A-Za-z0-9_\-]{10,}\b/g, 'AIza***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\bsk-[A-Za-z0-9_\-]{8,}\b/g, 'sk-***'],
  [/\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, 'jwt_***'],
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer ***'],
  [/\b(api[_-]?key|secret|password|passwd|token)\s*[=:]\s*['"]?[^\s'"]{6,}/gi, '$1=***']
];

function redact(input) {
  if (input == null) return '';
  if (typeof input !== 'string') {
    try { input = JSON.stringify(input); } catch { input = String(input); }
  }
  let s = input;
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  s = s.replace(/\b(?:\d[ -]?){13,19}\b/g, m => {
    const d = m.replace(/[ -]/g, '');
    return luhn(d) ? '****' + d.slice(-4) : m;
  });
  return s;
}

function redactDeep(value, depth = 0) {
  if (depth > 8) return value;
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(v => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(apiKey|key|token|updateToken|password|pin|secret|authorization|hash|salt)$/i.test(k)) {
        out[k] = v ? '***' : v;
      } else out[k] = redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

module.exports = { redact, redactDeep, luhn };
