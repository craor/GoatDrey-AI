// Проверка, что в исходниках (или в собранной папке) нет ключей API. Падает с кодом 1, если что-то нашлось.
// node scripts/check-no-keys.js [папка]   — по умолчанию весь репозиторий без node_modules.
// .asar читаем как есть (строки внутри лежат открытым текстом). Нативные бинарники Electron (.exe, .dll, .pak, .so…)
// не сканируем: ключ туда попасть не может, а случайные байты дают ложные срабатывания.
const fs = require('fs'), path = require('path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const PATTERNS = [
  /gsk_[A-Za-z0-9]{20,}/, /sk-api-[A-Za-z0-9_-]{20,}/, /(?<![A-Za-z0-9_-])sk-(proj-|ant-api\d+-|or-v1-)?[A-Za-z0-9_-]{32,}/, /xai-[A-Za-z0-9]{30,}/,
  /AIza[0-9A-Za-z_-]{35}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{40,}/, /AKIA[0-9A-Z]{16}/, /"groqApiKey"\s*:\s*"[^"]{8,}"/
];
const SKIP = new Set(['node_modules', '.git', 'release', 'dist', 'out']);
let hits = 0, files = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name) || p === root) walk(p); continue; }
    if (!e.isFile()) continue;
    if (/\.(exe|dll|node|so|dylib|pak|bin|dat|icns|ico|png|jpg|jpeg|gif|webp|woff2?|ttf|otf|mp4|wasm)$/i.test(e.name) || /^(Electron Framework|GoatDrey AI|chrome_crashpad_handler|libEGL|libGLESv2|libffmpeg)/.test(e.name) && !/\.(asar|json|js|yml)$/i.test(e.name)) continue;
    const st = fs.statSync(p); if (st.size > 400 * 1024 * 1024) continue;
    files++;
    const txt = fs.readFileSync(p).toString('latin1');
    for (const re of PATTERNS) { const m = txt.match(re); if (m) { hits++; console.error(`Похоже на ключ: ${path.relative(root, p)} → ${m[0].slice(0, 6)}… (${re})`); } }
    if (/config\.local\.json$/.test(p)) { hits++; console.error('Найден config.local.json: ' + p); }
  }
}
walk(root);
if (hits) { console.error(`Найдено подозрительных мест: ${hits}`); process.exit(1); }
console.log(`Ключей нет. Проверено файлов: ${files} (${root})`);
