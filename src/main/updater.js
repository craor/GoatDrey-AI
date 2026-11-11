// Автообновление через GitHub Releases (приватный репозиторий craor/GoatDrey-AI).
// Для приватного репозитория нужен GitHub-токен (PAT) с доступом на чтение: Настройки → Обновления.
const { app, dialog } = require('electron');

const REPO = { provider: 'github', owner: 'craor', repo: 'GoatDrey-AI', private: true };
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
  if (/401|Bad credentials/i.test(m)) return 'GitHub не принял токен. Проверьте его в Настройки → Обновления.';
  if (/404|Not Found/i.test(m)) return 'Не вижу релизов: репозиторий приватный — нужен токен с доступом к craor/GoatDrey-AI (или релизов ещё нет).';
  if (/latest\.yml/i.test(m)) return 'В последнем релизе нет latest.yml — его надо приложить к релизу.';
  if (/ENOTFOUND|ETIMEDOUT|ECONNRE|net::/i.test(m)) return 'Нет связи с GitHub. Проверьте интернет.';
  return m.split('\n')[0].slice(0, 200);
}

async function check({ manual = false } = {}) {
  const sp = supported();
  if (!sp.ok) { send({ status: 'unsupported', error: sp.why }); return state; }
  const token = (getToken() || '').trim();
  if (!token) { send({ status: 'no-token', error: 'Нужен GitHub-токен: репозиторий приватный.' }); return state; }
  if (busy) return state;
  busy = true;
  try {
    const u = lazy();
    u.setFeedURL({ ...REPO, token });
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

function install() { if (state.status === 'ready' && au) { setImmediate(() => au.quitAndInstall(false, true)); return true; } return false; }

module.exports = { init, check, install, getState: () => state };
