// Автообновление через GitHub Releases (публичный репозиторий craor/GoatDrey-AI). Токен не нужен;
// если пользователь сам указал GitHub-токен (Настройки → Обновления), он используется — например, чтобы не упираться в лимит запросов.
// macOS: приложение без подписи Apple, а Squirrel.Mac ставит только подписанные обновления. Поэтому на Mac
// проверяем последний релиз через GitHub API сами, по кнопке качаем .dmg в «Загрузки» и открываем его.
const { app, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const IS_MAC = process.platform === 'darwin';
const RELEASES = 'https://github.com/craor/GoatDrey-AI/releases';

const REPO = { provider: 'github', owner: 'craor', repo: 'GoatDrey-AI' };
let au = null, getWin = () => null, getToken = () => '', state = { status: 'idle' }, busy = false, notifiedVersion = null;

function send(patch) {
  state = { ...state, ...patch, at: Date.now() };
  const w = getWin();
  if (w && !w.isDestroyed()) w.webContents.send('update:status', state);
}

function supported() {
  if (!app.isPackaged) return { ok: false, why: 'Обновления работают только в установленной версии.' };
  if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR) return { ok: false, why: 'Портативная версия не обновляется сама. Поставьте GoatDrey через Setup.' };
  return { ok: true };
}

function lazy() {
  if (au) return au;
  ({ autoUpdater: au } = require('electron-updater'));
  au.autoDownload = true;
  au.autoInstallOnAppQuit = true;
  au.allowPrerelease = false;
  au.on('checking-for-update', () => send({ status: 'checking', error: null }));
  au.on('update-not-available', i => send({ status: 'latest', version: i?.version }));
  au.on('update-available', i => send({ status: 'downloading', version: i?.version, percent: 0 }));
  au.on('download-progress', p => send({ status: 'downloading', percent: Math.round(p?.percent || 0) }));
  au.on('update-downloaded', async i => {
    send({ status: 'ready', version: i?.version });
    if (notifiedVersion === i?.version) return;
    notifiedVersion = i?.version;
    const w = getWin();
    const r = await dialog.showMessageBox(w && !w.isDestroyed() ? w : undefined, {
      type: 'info', buttons: ['Перезапустить сейчас', 'Позже'], defaultId: 0, cancelId: 1,
      title: 'GoatDrey AI', message: `Скачал GoatDrey ${i?.version}.`,
      detail: 'Перезапустить и обновиться сейчас? Если «Позже» — обновлюсь сам, когда закроете программу.'
    });
    if (r.response === 0) setImmediate(() => au.quitAndInstall(false, true));
  });
  au.on('error', e => send({ status: 'error', error: humanize(e) }));
  return au;
}

function humanize(e) {
  const m = String(e?.message || e || '');
  if (/401|Bad credentials/i.test(m)) return 'GitHub не принял токен. Уберите его в Настройки → Обновления — для обновлений он не нужен.';
  if (/403|rate limit/i.test(m)) return 'GitHub временно ограничил запросы. Попробую позже сам.';
  if (/404|Not Found/i.test(m)) return 'Не вижу релизов на GitHub (craor/GoatDrey-AI). Попробую позже.';
  if (/latest\.yml/i.test(m)) return 'В последнем релизе нет latest.yml — его надо приложить к релизу.';
  if (/ENOTFOUND|ETIMEDOUT|ECONNRE|net::/i.test(m)) return 'Нет связи с GitHub. Проверьте интернет.';
  return m.split('\n')[0].slice(0, 200);
}

/* ---------- macOS ---------- */
const gh = (url, token, accept = 'application/vnd.github+json', ms = 20000) => fetch(url, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: accept, 'User-Agent': 'GoatDrey-AI', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(ms) });
const cmpVer = (a, b) => { const x = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0), y = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
let macRelease = null, macFile = null;

function pickDmg(assets) {
  const dmgs = (assets || []).filter(a => /\.dmg$/i.test(a.name));
  return dmgs.find(a => /universal/i.test(a.name)) || dmgs.find(a => a.name.includes(process.arch)) || dmgs[0] || null;
}

async function checkMac(token) {
  send({ status: 'checking', error: null });
  const res = await gh(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/releases/latest`, token);
  if (!res.ok) throw new Error(`${res.status} ${res.status === 404 ? 'Not Found' : res.statusText}`);
  const rel = await res.json();
  const version = String(rel.tag_name || '').replace(/^v/, '');
  if (!version || cmpVer(version, app.getVersion()) <= 0) { send({ status: 'latest', version: app.getVersion() }); return; }
  macRelease = { version, url: rel.html_url || `${RELEASES}/tag/v${version}`, dmg: pickDmg(rel.assets) };
  send({ status: 'available', version, url: macRelease.url });
  if (notifiedVersion === version) return;
  notifiedVersion = version;
  const w = getWin();
  const r = await dialog.showMessageBox(w && !w.isDestroyed() ? w : undefined, {
    type: 'info', buttons: ['Скачать', 'Открыть страницу релиза', 'Позже'], defaultId: 0, cancelId: 2,
    title: 'GoatDrey AI', message: `Вышел GoatDrey ${version}.`,
    detail: 'На Mac обновление ставится вручную: скачаю .dmg в «Загрузки» и открою — перетащите GoatDrey AI в «Программы» с заменой.'
  });
  if (r.response === 0) downloadMac().catch(e => { send({ status: 'error', error: humanize(e) }); shell.openExternal(macRelease.url); });
  if (r.response === 1) shell.openExternal(macRelease.url);
}

async function downloadMac() {
  const token = (getToken() || '').trim();
  if (!macRelease?.dmg) { shell.openExternal(macRelease?.url || RELEASES); return; }
  const { dmg, version } = macRelease;
  send({ status: 'downloading', version, percent: 0 });
  const res = token ? await gh(dmg.url, token, 'application/octet-stream', 30 * 60000) : await fetch(dmg.browser_download_url, { headers: { 'User-Agent': 'GoatDrey-AI' }, signal: AbortSignal.timeout(30 * 60000) });
  if (!res.ok || !res.body) throw new Error(`Скачивание: HTTP ${res.status}`);
  const total = +res.headers.get('content-length') || dmg.size || 0;
  const file = path.join(app.getPath('downloads'), dmg.name);
  const tmp = file + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0, lastPct = -1;
  for await (const chunk of res.body) {
    if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
    got += chunk.length;
    const pct = total ? Math.floor(got / total * 100) : 0;
    if (pct !== lastPct) { lastPct = pct; send({ status: 'downloading', version, percent: pct }); }
  }
  await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
  fs.renameSync(tmp, file);
  macFile = file;
  send({ status: 'mac-ready', version, file });
  await shell.openPath(file);
  const w = getWin();
  const r = await dialog.showMessageBox(w && !w.isDestroyed() ? w : undefined, {
    type: 'info', buttons: ['Закрыть GoatDrey', 'Позже'], defaultId: 0, cancelId: 1, title: 'GoatDrey AI',
    message: `GoatDrey ${version} скачан и открыт.`,
    detail: 'Закройте GoatDrey, в открывшемся окне перетащите GoatDrey AI в «Программы» и нажмите «Заменить». Если macOS скажет, что приложение повреждено или от неизвестного разработчика, — правый клик по нему → «Открыть».'
  });
  if (r.response === 0) setImmediate(() => app.quit());
}

async function check({ manual = false } = {}) {
  const sp = supported();
  if (!sp.ok) { send({ status: 'unsupported', error: sp.why }); return state; }
  const token = (getToken() || '').trim(); // необязателен
  if (busy) return state;
  busy = true;
  try {
    if (IS_MAC) { await checkMac(token); return state; }
    const u = lazy();
    u.setFeedURL(token ? { ...REPO, token, private: true } : REPO);
    await u.checkForUpdates();
  } catch (e) { send({ status: 'error', error: humanize(e) }); }
  finally { busy = false; }
  return state;
}

function init(opts) {
  getWin = opts.getWin; getToken = opts.getToken;
  // Тихая проверка через 8 секунд после старта и потом раз в 6 часов.
  setTimeout(() => check().catch(() => {}), 8000);
  setInterval(() => check().catch(() => {}), 6 * 60 * 60 * 1000).unref?.();
}

function install() {
  if (IS_MAC) {
    if (macFile && fs.existsSync(macFile)) { shell.openPath(macFile); return true; }
    if (macRelease) { downloadMac().catch(e => { send({ status: 'error', error: humanize(e) }); shell.openExternal(macRelease.url); }); return true; }
    return false;
  }
  if (state.status === 'ready' && au) { setImmediate(() => au.quitAndInstall(false, true)); return true; }
  return false;
}
function openRelease() { shell.openExternal(macRelease?.url || state.url || RELEASES); return true; }

module.exports = { init, check, install, openRelease, getState: () => state };
