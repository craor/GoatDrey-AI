// Веб-поиск без платных ключей: DuckDuckGo HTML → Bing HTML → Wikipedia.
// Если поисковик показал капчу/блок — честно возвращаем ошибку провайдера и пробуем следующий.
const untrusted = require('./untrusted');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };
function decode(s = '') {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}
const strip = s => decode((s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

async function get(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 12000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8', ...(opts.headers || {}) }, method: opts.method || 'GET', body: opts.body, signal: ctrl.signal });
    return { status: res.status, text: await res.text() };
  } finally { clearTimeout(t); }
}

async function duckduckgo(q, n) {
  const r = await get('https://html.duckduckgo.com/html/', { method: 'POST', body: new URLSearchParams({ q, kl: 'ru-ru' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (/anomaly|challenge-form/i.test(r.text) && !/result__a/.test(r.text)) throw new Error('DuckDuckGo попросил капчу');
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(r.text)) && out.length < n) {
    let url = decode(m[1]);
    const u = url.match(/uddg=([^&]+)/); if (u) url = decodeURIComponent(u[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    out.push({ title: strip(m[2]), url, snippet: strip(m[3]) });
  }
  if (!out.length) throw new Error('DuckDuckGo: пусто');
  return out;
}

function bingUrl(href) {
  const h = decode(href);
  const m = h.match(/[?&]u=a1([^&]+)/);
  if (m) { try { return Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch {} }
  return h;
}

async function bing(q, n) {
  const r = await get('https://www.bing.com/search?setlang=ru&cc=ru&q=' + encodeURIComponent(q));
  const blocks = r.text.split('<li class="b_algo"').slice(1);
  const out = [];
  for (const b of blocks) {
    const a = b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: strip(a[2]), url: bingUrl(a[1]), snippet: strip(p && p[1]) });
    if (out.length >= n) break;
  }
  if (!out.length) throw new Error('Bing: пусто или блок');
  return out;
}

async function wikipedia(q, n) {
  const r = await get(`https://ru.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=${n}`);
  const j = JSON.parse(r.text);
  const out = (j.query?.search || []).map(s => ({ title: s.title, url: 'https://ru.wikipedia.org/wiki/' + encodeURIComponent(s.title.replace(/ /g, '_')), snippet: strip(s.snippet) }));
  if (!out.length) throw new Error('Wikipedia: пусто');
  return out;
}

const PROVIDERS = { duckduckgo, bing, wikipedia };

// Некоторые поисковики при подозрении на бота отдают случайную выдачу — отсеиваем нерелевантное.
function relevant(q, results) {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4).map(w => w.slice(0, Math.max(4, w.length - 2)));
  if (!words.length) return results;
  return results.filter(r => { const t = (r.title + ' ' + r.snippet + ' ' + r.url).toLowerCase(); return words.some(w => t.includes(w)); });
}

async function search(q, { provider = 'auto', n = 6 } = {}) {
  if (provider === 'groq') provider = 'auto';
  const order = provider === 'auto' ? ['duckduckgo', 'bing', 'wikipedia'] : [provider, ...['duckduckgo', 'bing', 'wikipedia'].filter(p => p !== provider)];
  const errors = [];
  for (const p of order) {
    try {
      const raw = relevant(q, await PROVIDERS[p](q, n));
      const res = raw.filter(r => { try { return new URL(r.url).protocol === 'https:'; } catch { return false; } });
      if (res.length < 2) throw new Error('выдача не по теме (похоже на антибот)');
      return { provider: p, results: res, errors };
    }
    catch (e) { errors.push(`${p}: ${e.message}`); }
  }
  return { provider: null, results: [], errors };
}

function toContext(q, res) {
  if (!res.results.length) return untrusted.wrap('web-search', `Веб-поиск по запросу «${q}» не дал результатов (${res.errors.join('; ')}). Скажи пользователю честно, что поиск сейчас недоступен, и ответь по своим знаниям с оговоркой.`);
  const lines = res.results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`);
  return untrusted.wrap('web-search', `Результаты веб-поиска (${res.provider}) по запросу «${q}», ${new Date().toLocaleDateString('ru-RU')}:\n\n${lines.join('\n\n')}\n\nОпирайся на них, ставь ссылки вида [1], [2]. Если данных не хватает — так и скажи.`);
}

module.exports = { search, toContext, _bingUrl: bingUrl };
