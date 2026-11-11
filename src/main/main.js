// GoatDrey AI — main-процесс Electron.
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeTheme, dialog, shell, desktopCapturer, screen, nativeImage, systemPreferences, safeStorage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const ai = require('./ai');
const { PRESETS, ORDER, preset, detectProvider, baseOf } = require('./providers');
const local = require('./local');
const { Media, generateImages, generateVideoMinimax, extOf } = require('./media');
const ja = require('./jsonactions');
const search = require('./search');
const pc = require('./pc');
const updater = require('./updater');
const safety = require('./safety');
const net = require('./net');
const { redact } = require('./redact');
const untrusted = require('./untrusted');
const lockLib = require('./lock');

const ROOT = path.join(__dirname, '..', '..');
const IS_MAC = process.platform === 'darwin';
const ICON_PNG = path.join(ROOT, 'assets', 'icon', process.platform === 'win32' ? 'icon.ico' : IS_MAC ? 'icon-512.png' : 'icon-256.png');
const TRAY_PNG = path.join(ROOT, 'assets', 'icon', 'icon-32.png');

let win, tray, store, media;
const aborters = new Map();
let locked = false;
const lockLimiter = lockLib.createLimiter();
let micAllowedUntil = 0;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "worker-src 'none'",
  "upgrade-insecure-requests"
].join('; ');

function isAppFileUrl(url) {
  if (!url || !String(url).startsWith('file:')) return false;
  try {
    const u = new URL(url);
    let pth = decodeURIComponent(u.pathname);
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(pth)) pth = pth.slice(1);
    const n = path.normalize(pth);
    const root = path.normalize(ROOT);
    if (n.startsWith(root + path.sep) || n === root) return true;
    if (n.includes(`${path.sep}app.asar${path.sep}`) || n.includes(`${path.sep}app.asar`)) return true;
    return false;
  } catch { return false; }
}

function openExternalSafe(url) {
  const v = net.validateExternalUrl(url);
  if (!v.ok) return false;
  shell.openExternal(v.url);
  return true;
}

function trustedSender(event) {
  try {
    if (!event || !event.sender) return false;
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
    const frame = event.senderFrame;
    if (!frame) return isAppFileUrl(event.sender.getURL?.() || '');
    if (frame.isDestroyed?.()) return false;
    return isAppFileUrl(frame.url || '');
  } catch { return false; }
}

const LOCK_OK = new Set(['lock:status', 'lock:unlock', 'lock:enable', 'lock:disable', 'lock:change', 'theme:isDark']);
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedSender(event)) throw new Error('IPC: недоверенный источник');
    if (locked && !LOCK_OK.has(channel)) throw new Error('LOCKED');
    return fn(event, ...args);
  });
}

function createWindow() {
  const s = store.getSettings();
  nativeTheme.themeSource = s.theme;
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 720, minHeight: 520,
    title: 'GoatDrey AI',
    icon: ICON_PNG,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141210' : '#F4F1EA',
    autoHideMenuBar: true,
    show: false,
    // macOS: «светофор» поверх нашей шапки, как в Linear/Things.
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
      enableRemoteModule: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged || process.argv.includes('--dev')
    }
  });
  const page = locked ? path.join(ROOT, 'src', 'renderer', 'lock.html') : path.join(ROOT, 'src', 'renderer', 'index.html');
  win.loadFile(page);
  win.once('ready-to-show', () => win.show());
  // Для проверки без экрана: только в неупакованной сборке. GD_EVAL — тоже только непакетный режим.
  if (!app.isPackaged && process.env.GD_SNAPSHOT) win.webContents.once('did-finish-load', () => setTimeout(async () => {
    try { if (process.env.GD_EVAL) await win.webContents.executeJavaScript(process.env.GD_EVAL); } catch (e) { console.error('eval', e.message); }
    setTimeout(async () => { const img = await win.webContents.capturePage(); fs.writeFileSync(process.env.GD_SNAPSHOT, img.toPNG()); console.log('snapshot', process.env.GD_SNAPSHOT); app.quit(); }, +(process.env.GD_WAIT || 1500));
  }, 1200));
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((wc, perm, cb) => {
    if (wc !== win.webContents) return cb(false);
    if ((perm === 'media' || perm === 'microphone' || perm === 'audioCapture') && Date.now() < micAllowedUntil) return cb(true);
    return cb(false);
  });
  ses.setPermissionCheckHandler((wc, perm) => {
    if (wc && win && !win.isDestroyed() && wc !== win.webContents) return false;
    if ((perm === 'media' || perm === 'microphone' || perm === 'audioCapture') && Date.now() < micAllowedUntil) return true;
    return false;
  });
  ses.setDisplayMediaRequestHandler && ses.setDisplayMediaRequestHandler((req, cb) => cb({})); // renderer не снимает экран сам
  ses.webRequest.onHeadersReceived((details, cb) => {
    const headers = { ...(details.responseHeaders || {}), 'Content-Security-Policy': [CSP] };
    cb({ responseHeaders: headers });
  });
  if (process.argv.includes('--dev') && !app.isPackaged) win.webContents.openDevTools({ mode: 'detach' });
}

function loadMainPage() {
  if (!win || win.isDestroyed()) return;
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
}
function loadLockPage() {
  if (!win || win.isDestroyed()) return;
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'lock.html'));
}

/** macOS: русское меню приложения — без него не работают Cmd+C/V/Z/Q. */
function createMacMenu() {
  if (!IS_MAC) return;
  const send = cmd => () => { win?.show(); win?.webContents.send('app:command', cmd); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'GoatDrey AI', submenu: [
      { role: 'about', label: 'О GoatDrey AI' }, { type: 'separator' },
      { label: 'Настройки…', accelerator: 'Cmd+,', click: send('settings') }, { type: 'separator' },
      { role: 'hide', label: 'Скрыть GoatDrey AI' }, { role: 'hideOthers', label: 'Скрыть остальные' }, { role: 'unhide', label: 'Показать все' }, { type: 'separator' },
      { role: 'quit', label: 'Завершить GoatDrey AI' }] },
    { label: 'Файл', submenu: [{ label: 'Новый чат', accelerator: 'Cmd+N', click: send('new-chat') }, { type: 'separator' }, { role: 'close', label: 'Закрыть окно' }] },
    { label: 'Правка', submenu: [
      { role: 'undo', label: 'Отменить' }, { role: 'redo', label: 'Повторить' }, { type: 'separator' },
      { role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Скопировать' }, { role: 'paste', label: 'Вставить' }, { role: 'pasteAndMatchStyle', label: 'Вставить без форматирования' },
      { role: 'selectAll', label: 'Выбрать всё' }] },
    { label: 'Вид', submenu: [{ role: 'resetZoom', label: 'Обычный размер' }, { role: 'zoomIn', label: 'Крупнее' }, { role: 'zoomOut', label: 'Мельче' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Во весь экран' }] },
    { label: 'Окно', submenu: [{ role: 'minimize', label: 'Свернуть' }, { role: 'zoom', label: 'Изменить масштаб' }, { type: 'separator' }, { role: 'front', label: 'Все окна — вперёд' }] }
  ]));
}

/* ---------- Разрешения macOS ---------- */
const MAC_PREFS = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
};
function macPermissions() {
  if (!IS_MAC) return { platform: process.platform, accessibility: true, screen: 'granted', microphone: 'granted' };
  let accessibility = false, scr = 'unknown', mic = 'unknown';
  try { accessibility = systemPreferences.isTrustedAccessibilityClient(false); } catch {}
  try { scr = systemPreferences.getMediaAccessStatus('screen'); } catch {}
  try { mic = systemPreferences.getMediaAccessStatus('microphone'); } catch {}
  return { platform: 'darwin', accessibility, screen: scr, microphone: mic };
}
const NEEDS_ACCESSIBILITY = new Set(['mouse_move', 'mouse_click', 'scroll', 'type_text', 'key_press']);
const ACCESS_MSG = 'Нужно разрешение macOS «Универсальный доступ»: Системные настройки → Конфиденциальность и безопасность → Универсальный доступ → включите GoatDrey AI. Потом перезапустите GoatDrey.';
const SCREEN_MSG = 'Нужно разрешение macOS «Запись экрана»: Системные настройки → Конфиденциальность и безопасность → Запись экрана и системного аудио → включите GoatDrey AI и перезапустите программу.';

function createTray() {
  try {
    let img = nativeImage.createFromPath(TRAY_PNG);
    if (IS_MAC && !img.isEmpty()) img = img.resize({ width: 18, height: 18 });
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('GoatDrey AI');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть GoatDrey', click: () => { win.show(); win.focus(); } },
      { label: 'Новый чат', click: () => { win.show(); win.webContents.send('app:command', 'new-chat'); } },
      { type: 'separator' },
      { label: 'Выйти', click: () => app.quit() }
    ]));
    tray.on('click', () => { win.isVisible() ? win.focus() : win.show(); });
  } catch (e) { console.warn('tray:', e.message); }
}


/* ---------- Профили и возможности моделей ---------- */
const GROQ_VISION = /qwen|vision|llama-4|scout|maverick/i;
const VISION = /vision|[-_.:]vl\b|vl:|-vl-|llava|gemma3|llama-4|scout|maverick|gpt-4o|gpt-4\.1|gpt-5|\bo[34]\b|grok-4|grok-2-vision|gemini|claude|pixtral|mistral-(small|medium)|minicpm-v|moondream|qwen\/qwen3\.8/i;
const toolMode = new Map(); // `${profileId}|${model}` → 'native' | 'json'
let ollamaCache = { at: 0, st: null };

async function ollamaInfo(profile, fresh) {
  if (!fresh && ollamaCache.st && Date.now() - ollamaCache.at < 15000) return ollamaCache.st;
  const st = await local.ollamaStatus(baseOf(profile));
  ollamaCache = { at: Date.now(), st };
  return st;
}
const needsKey = p => !preset(p.provider).noKey && p.provider !== 'custom';
const usable = p => p && (!needsKey(p) || !!p.apiKey);

async function isVision(profile, model) {
  if (!model) return false;
  if (profile.provider === 'ollama') { const st = await ollamaInfo(profile); const m = st.models.find(x => x.name === model || x.name === model + ':latest'); return m ? m.caps.includes('vision') : VISION.test(model); }
  if (profile.provider === 'groq') return GROQ_VISION.test(model);
  if (model === profile.visionModel) return true;
  return VISION.test(model);
}
/** Кто посмотрит картинку: сначала активный профиль, потом любой другой с vision-моделью. */
async function visionTarget(prefer) {
  const s = store.getSettings();
  const first = s.profiles.find(p => p.id === prefer) || store.getProfile();
  for (const p of [first, ...s.profiles.filter(x => x.id !== first.id)]) {
    if (!usable(p)) continue;
    if (p.provider === 'ollama') {
      const st = await ollamaInfo(p); if (!st.running) continue;
      const v = st.models.find(m => m.name === p.visionModel && m.caps.includes('vision')) || st.models.find(m => m.name === p.model && m.caps.includes('vision')) || st.models.find(m => m.caps.includes('vision'));
      if (v) return { profile: p, model: v.name };
      continue;
    }
    if (await isVision(p, p.model)) return { profile: p, model: p.model };
    const vm = p.visionModel || preset(p.provider).visionModel;
    if (vm) return { profile: p, model: vm };
  }
  return null;
}
function stripImages(messages, note) {
  return messages.map(m => Array.isArray(m.content) ? { ...m, content: m.content.filter(c => c.type === 'text').map(c => c.text).join('\n') + note } : m);
}
const hasImages = messages => messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image_url'));

/** Для моделей без function calling: протокол JSON-действий в тексте. */
async function chatJsonActions(opts) {
  const names = new Set(pc.TOOLS.map(t => t.function.name));
  const r = await ai.chatStream({ ...opts, messages: ja.withProtocol(opts.messages, pc.TOOLS), tools: undefined });
  const toolCalls = ja.parseActions(r.content, names);
  return { ...r, toolCalls, content: toolCalls.length ? ja.stripActions(r.content) : r.content, toolMode: 'json' };
}

async function guessToolMode(profile, model) {
  const k = profile.id + '|' + model;
  if (toolMode.has(k)) return toolMode.get(k);
  const pre = preset(profile.provider);
  if (pre.tools === 'native') return 'native';
  if (profile.provider === 'ollama') {
    const st = await ollamaInfo(profile);
    const m = st.models.find(x => x.name === model || x.name === model + ':latest');
    if (m && m.caps.length) return m.caps.includes('tools') ? 'native' : 'json';
  }
  return 'native'; // LM Studio / свой адрес: пробуем, при отказе переключимся на JSON
}

function publicProfile(p) {
  const pre = preset(p.provider);
  const { apiKey, ...rest } = p;
  return { ...rest, hasKey: !!apiKey, keyMask: apiKey ? '•'.repeat(8) + apiKey.slice(-4) : '', presetName: pre.name, short: pre.short, local: !!pre.local, noKey: !!pre.noKey, baseUrl: p.baseUrl || '', effectiveBase: baseOf(p), defaultModel: pre.defaultModel || '', defaultVision: pre.visionModel || '', browserSearch: !!pre.browserSearch, image: pre.image || null, video: pre.video || null, usable: usable(p) };
}
function publicSettings() {
  const s = store.getSettings();
  const { apiKey, updateToken, ...rest } = s;
  return { ...rest, hasUpdateToken: !!updateToken, lockEnabled: !!(store.getLockRecord && store.getLockRecord()), stopHotkey: stopHotkeyLabel, safetyRules: safety.RULES_RU, profiles: s.profiles.map(publicProfile), platform: process.platform, version: app.getVersion(), dataDir: app.getPath('userData') };
}
function presetsPublic() {
  return ORDER.map(id => { const p = PRESETS[id]; return { id, name: p.name, short: p.short, base: p.base, keyUrl: p.keyUrl || '', local: !!p.local, noKey: !!p.noKey, defaultModel: p.defaultModel, note: p.note, image: !!p.image, video: !!p.video, stt: !!p.stt, browserSearch: !!p.browserSearch }; });
}

async function takeScreenshot() {
  if (IS_MAC && macPermissions().screen !== 'granted') {
    // Первый запрос сам добавит GoatDrey в список «Запись экрана»; без разрешения macOS отдаёт только обои.
    try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); } catch {}
    if (macPermissions().screen !== 'granted') throw new Error(SCREEN_MSG);
  }
  const d = screen.getPrimaryDisplay();
  const { width, height } = d.size;
  const scale = Math.min(1, 1600 / width);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) } });
  const src = sources[0];
  if (!src) throw new Error('Не удалось получить экран');
  const image = src.thumbnail.toDataURL();
  const tw = src.thumbnail.getSize().width;
  let text = `Снимок экрана ${width}×${height} (логические пиксели).`;
  // Vision-модель (активного провайдера, локальная qwen2.5vl или любая другая доступная) описывает экран.
  try {
    const vt = await visionTarget();
    if (!vt) throw new Error('нет модели, которая видит картинки (для локального режима: ollama pull qwen2.5vl:7b)');
    const desc = await ai.chatOnce({ target: ai.targetOf(vt.profile), model: vt.model, max_tokens: 900, messages: [{ role: 'user', content: [
      { type: 'text', text: `Это скриншот экрана ${width}×${height}. Картинка уменьшена в ${(width / tw).toFixed(2)} раз. Кратко по-русски опиши, какие окна открыты и ключевые кликабельные элементы с примерными координатами центра в ПИКСЕЛЯХ ИСХОДНОГО экрана (${width}×${height}). Формат: «элемент — (x, y)». До 15 пунктов.` },
      { type: 'image_url', image_url: { url: image } }] }] });
    if (desc) text += `\nОписание экрана (${vt.model}):\n` + desc.trim();
  } catch (e) { text += ' Описание экрана недоступно: ' + e.message; }
  return { ok: true, image, text };
}

/* ---------- Автономный агент: лимиты, стоп-кнопка, индикатор ---------- */
const MAX_STEPS = 40, MAX_MINUTES = 15;
let task = null, taskSeq = 0, indicator = null, stopHotkeyLabel = '';
function agentStart(userText) {
  if (task) agentEnd(task.id);
  task = { id: 't' + (++taskSeq) + Date.now().toString(36), userText, started: Date.now(), steps: 0, stopped: null, screenHint: '' };
  task.timer = setTimeout(() => emergencyStop(`лимит ${MAX_MINUTES} минут`), MAX_MINUTES * 60000);
  store.logAction({ action: 'task_start', args: { text: userText.slice(0, 200) }, status: 'done', note: 'Задача начата' });
  return { id: task.id, maxSteps: MAX_STEPS, maxMinutes: MAX_MINUTES, hotkey: stopHotkeyLabel };
}
function agentEnd(id, why) {
  if (!task || (id && task.id !== id)) return;
  clearTimeout(task.timer);
  if (why) { task.stopped = why; win?.webContents.send('agent:stopped', { reason: why }); }
  store.logAction({ action: 'task_end', args: {}, status: why ? 'stopped' : 'done', note: why ? 'Остановлено: ' + why : `Задача завершена, шагов: ${task.steps}` });
  task = null; showIndicator(false);
}
/** Аварийный стоп: прибить запущенные команды, оборвать запрос к модели, сообщить интерфейсу. */
function emergencyStop(why) {
  pc.killAll();
  for (const c of aborters.values()) { try { c.abort(); } catch {} }
  if (task) { task.stopped = why; agentEnd(task.id, why); }
  else win?.webContents.send('agent:stopped', { reason: why });
  try { if (win && !win.isDestroyed()) { win.show(); win.focus(); } } catch {}
}
function registerStopHotkey() {
  const combos = IS_MAC ? [['Control+Option+Command+.', '⌃⌥⌘ .'], ['Control+Option+Command+Escape', '⌃⌥⌘ Esc']] : [['Control+Alt+Escape', 'Ctrl+Alt+Esc'], ['Control+Alt+Shift+S', 'Ctrl+Alt+Shift+S']];
  const ok = [];
  for (const [acc, label] of combos) { try { if (globalShortcut.register(acc, () => emergencyStop('горячие клавиши ' + label))) ok.push(label); } catch {} }
  stopHotkeyLabel = ok.join(' или ') || '';
}
function showIndicator(on) {
  try {
    if (!on) { if (indicator && !indicator.isDestroyed()) indicator.hide(); return; }
    if (!indicator || indicator.isDestroyed()) {
      const { workArea } = screen.getPrimaryDisplay();
      indicator = new BrowserWindow({ width: 380, height: 50, x: Math.round(workArea.x + workArea.width / 2 - 190), y: workArea.y + 8, frame: false, transparent: true, resizable: false, movable: true, skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false, hasShadow: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: true } });
      indicator.setAlwaysOnTop(true, 'screen-saver');
      indicator.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
      indicator.setContentProtection(true); // не попадает на скриншоты, которые смотрит модель
      indicator.webContents.on('did-navigate-in-page', (e, url) => { if (url.endsWith('#stop')) emergencyStop('кнопка «Стоп» на индикаторе'); });
      indicator.loadFile(path.join(ROOT, 'src', 'renderer', 'indicator.html'), { query: { hot: stopHotkeyLabel || '' } });
    }
    if (!indicator.isVisible()) indicator.showInactive();
  } catch (e) { console.warn('indicator:', e.message); }
}

function registerIpc() {
  handle('settings:get', () => publicSettings());
  handle('settings:set', (e, patch = {}) => {
    const { profiles, activeProfile, apiKey, updateToken, ...safe } = patch; // профили и ключи — только через profiles:*
    const next = store.setSettings(safe);
    if ('theme' in safe) nativeTheme.themeSource = next.theme;
    if ('launchAtStartup' in safe && (process.platform === 'win32' || process.platform === 'darwin')) app.setLoginItemSettings({ openAtLogin: !!next.launchAtStartup });
    return publicSettings();
  });
  handle('theme:isDark', () => nativeTheme.shouldUseDarkColors);
  nativeTheme.on('updated', () => win?.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors));

  handle('chats:get', () => store.getChats());
  handle('chats:save', (e, data) => store.saveChats(data));
  handle('templates:get', () => store.getTemplates());
  handle('templates:save', (e, list) => store.saveTemplates(list));

  /* --- Провайдеры и профили --- */
  handle('providers:presets', () => presetsPublic());
  handle('providers:detect', (e, key) => detectProvider(key));
  handle('profiles:save', (e, p) => {
    const patch = { ...p };
    if (typeof patch.apiKey === 'string') { patch.apiKey = patch.apiKey.trim(); if (!patch.apiKey || patch.apiKey.includes('•')) delete patch.apiKey; }
    if (!patch.name) patch.name = preset(patch.provider).name;
    if (patch.baseUrl) {
      patch.baseUrl = String(patch.baseUrl).trim().replace(/\/+$/, '');
      const pre = preset(patch.provider);
      const v = net.validateBaseUrl(patch.baseUrl, { allowLocalHttp: !!pre.local || patch.provider === 'custom' });
      if (!v.ok) throw new Error(v.reason);
      patch.baseUrl = v.url;
    }
    const saved = store.saveProfile(patch);
    toolMode.clear();
    return publicProfile(saved);
  });
  handle('profiles:delete', (e, id) => { store.deleteProfile(id); return publicSettings(); });
  handle('profiles:activate', (e, { id, model }) => { store.activate(id, model); return publicSettings(); });
  /** Проверка ключа до/после сохранения: draft может содержать новый ключ, иначе берём сохранённый. */
  handle('profiles:test', async (e, draft) => {
    const saved = draft.id ? store.getSettings().profiles.find(p => p.id === draft.id) : null;
    const p = { ...(saved || {}), ...draft };
    if (!p.apiKey || String(p.apiKey).includes('•')) p.apiKey = saved?.apiKey || '';
    if (needsKey(p) && !p.apiKey) throw new Error('NO_KEY');
    net.assertKeyDestination(p);
    const models = await ai.listModels(ai.targetOf(p));
    return models;
  });
  handle('ai:models', async (e, profileId) => {
    const p = store.getProfile(profileId);
    if (!usable(p)) throw new Error('NO_KEY');
    net.assertKeyDestination(p);
    if (p.provider === 'ollama') { const st = await ollamaInfo(p, true); if (!st.running) throw new Error('OLLAMA_DOWN'); return st.models.map(m => m.name); }
    return ai.listModels(ai.targetOf(p));
  });

  /* --- Чат --- */
  handle('ai:chat', async (e, { id, messages, profileId, model, mode, useTools, webSearch }) => {
    const s = store.getSettings();
    const prof = store.getProfile(profileId);
    const pre = preset(prof.provider);
    if (!usable(prof)) throw new Error('NO_KEY');
    net.assertKeyDestination(prof);
    if (!model && prof.provider === 'ollama') { const st = await ollamaInfo(prof); if (!st.running) throw new Error('OLLAMA_DOWN'); model = prof.model || st.models.find(m => !/embed/.test(m.name))?.name; }
    model = model || prof.model || pre.defaultModel;
    if (!model) throw new Error('NO_MODEL');
    const computer = mode === 'desktop' || useTools;
    if (computer && !s.pcControlEnabled) throw new Error('PC_OFF');
    const onDelta = d => e.sender.send('ai:delta', { id, ...d });
    let target = ai.targetOf(prof);
    let profForTools = prof;

    // Картинки во вложениях: нужна модель, которая видит.
    if (hasImages(messages) && !(await isVision(prof, model))) {
      const vt = await visionTarget(prof.id);
      if (vt) { model = vt.model; target = ai.targetOf(vt.profile); profForTools = vt.profile; if (vt.profile.id !== prof.id) onDelta({ status: `Картинку смотрит ${vt.model}` }); }
      else messages = stripImages(messages, '\n[Прикреплено изображение — ни одна подключённая модель не умеет смотреть картинки. Для локального режима скачайте qwen2.5vl:7b.]');
    }

    const ctrl = new AbortController(); aborters.set(id, ctrl);
    let tools, json = false;
    if (computer) { json = (await guessToolMode(profForTools, model)) === 'json'; if (!json) tools = pc.TOOLS; }
    else if (webSearch && profForTools.provider === 'groq') { tools = [{ type: 'browser_search' }]; if (!/gpt-oss/.test(model || '')) model = 'openai/gpt-oss-120b'; }
    const fallbacks = profForTools.provider === 'groq' ? (s.fallbackModels || []).filter(m => m !== model) : [];
    const models = [model, ...fallbacks];
    const names = new Set(pc.TOOLS.map(t => t.function.name));
    // Недоверенные данные (инструменты, поиск, файлы) помечаются здесь, в main — интерфейс это не обойдёт.
    messages = untrusted.ensurePreamble(untrusted.wrapMessages(messages || [])).map(m => {
      if (m.role === 'system' && typeof m.content === 'string' && /Результаты веб-поиска|Веб-поиск по запросу/.test(m.content) && !untrusted.isWrapped(m.content)) {
        return { ...m, content: untrusted.wrap('web-search', m.content) };
      }
      if (m.role === 'user' && typeof m.content === 'string' && /Файл «/.test(m.content) && !untrusted.isWrapped(m.content)) {
        return { ...m, content: untrusted.wrap('attachment', m.content) };
      }
      if (m.role === 'user' && Array.isArray(m.content)) {
        return { ...m, content: m.content.map(part => (part && part.type === 'text' && part.text && /Файл «/.test(part.text) && !untrusted.isWrapped(part.text)) ? { ...part, text: untrusted.wrap('attachment', part.text) } : part) };
      }
      return m;
    });
    const base = { target, messages, temperature: s.temperature, signal: ctrl.signal, onDelta };
    let lastErr;
    try {
      for (const m of models) {
        const key = profForTools.id + '|' + m;
        try {
          if (json) return await chatJsonActions({ ...base, model: m });
          const r = await ai.chatWithToolGuard({ ...base, model: m, tools });
          // Локальный сервер мог проигнорировать tools, а модель написала действие текстом — понимаем и так.
          if (computer && !r.toolCalls.length) { const tc = ja.parseActions(r.content, names); if (tc.length) return { ...r, toolCalls: tc, content: ja.stripActions(r.content) }; }
          if (computer) toolMode.set(key, 'native');
          return r;
        } catch (err) {
          lastErr = err;
          if (ctrl.signal.aborted) throw err;
          if (computer && tools && ai.TOOLS_UNSUPPORTED.test(err.message || '')) { toolMode.set(key, 'json'); onDelta({ status: 'Модель без функций — перехожу на текстовые команды' }); return await chatJsonActions({ ...base, model: m }); }
          const modelGone = err.status === 404 || err.status === 400 && /model/i.test(err.message) && !/tool/i.test(err.message) || /does not exist|decommissioned|not found/i.test(err.message);
          const toolsUnsupported = tools && ai.TOOLS_UNSUPPORTED.test(err.message || '');
          if (!fallbacks.length || !(modelGone || toolsUnsupported || err.toolMismatch)) throw err;
        }
      }
      throw lastErr;
    } finally { aborters.delete(id); }
  });
  handle('ai:abort', (e, id) => { aborters.get(id)?.abort(); return true; });
  handle('ai:title', async (e, text) => {
    const prof = store.getProfile();
    if (!usable(prof)) return null;
    let model = prof.provider === 'groq' ? (prof.visionModel || 'openai/gpt-oss-20b') : (prof.model || preset(prof.provider).defaultModel);
    if (prof.provider === 'ollama' && !prof.model) model = (await ollamaInfo(prof)).models[0]?.name;
    if (!model) return null;
    try {
      const t = await ai.chatOnce({ target: ai.targetOf(prof), model, max_tokens: 60, messages: [{ role: 'system', content: 'Придумай короткий заголовок (2–5 слов) для диалога по первому сообщению. Без кавычек и точки. Только заголовок.' }, { role: 'user', content: text.slice(0, 800) }] });
      return t.replace(/<think>[\s\S]*?<\/think>/g, '').trim().split('\n')[0].replace(/^["«*]+|["»*.]+$/g, '').slice(0, 60) || null;
    } catch { return null; }
  });
  /* --- Голос: Whisper на Groq → Whisper OpenAI → (в UI) Web Speech API --- */
  const sttTarget = () => {
    const s = store.getSettings();
    const g = s.profiles.find(p => p.provider === 'groq' && p.apiKey); if (g) return { target: ai.targetOf(g), model: 'whisper-large-v3-turbo', name: 'Whisper · Groq' };
    const o = s.profiles.find(p => p.provider === 'openai' && p.apiKey); if (o) return { target: ai.targetOf(o), model: 'whisper-1', name: 'Whisper · OpenAI' };
    return null;
  };
  handle('ai:stt', () => sttTarget()?.name || null);
  handle('ai:transcribe', async (e, { audio, mime }) => {
    const t = sttTarget(); if (!t) throw new Error('NO_STT');
    return ai.transcribe({ ...t, audio: Buffer.from(audio), mime, language: store.getSettings().language || 'ru' });
  });

  handle('search:query', async (e, q) => {
    const s = store.getSettings();
    const res = await search.search(q, { provider: s.searchProvider });
    return { ...res, context: search.toContext(q, res) };
  });

  /* --- Локальные модели --- */
  let sysCache = null;
  handle('local:status', async () => {
    const s = store.getSettings();
    const op = s.profiles.find(p => p.provider === 'ollama') || { provider: 'ollama' };
    const lp = s.profiles.find(p => p.provider === 'lmstudio') || { provider: 'lmstudio' };
    sysCache = sysCache || await local.sysInfo();
    const [ollama, lmstudio] = await Promise.all([ollamaInfo(op, true), local.lmstudioStatus(baseOf(lp))]);
    return { ollama, lmstudio, sys: sysCache, rec: local.recommend(sysCache), suggested: local.SUGGESTED };
  });
  const pulls = new Map();
  handle('local:pull', async (e, model) => {
    const op = store.getSettings().profiles.find(p => p.provider === 'ollama') || { provider: 'ollama' };
    const ctrl = new AbortController(); pulls.set(model, ctrl);
    try { await local.ollamaPull(model, { base: baseOf(op), signal: ctrl.signal, onProgress: p => e.sender.send('local:progress', { model, ...p }) }); ollamaCache.at = 0; return true; }
    finally { pulls.delete(model); }
  });
  handle('local:pullAbort', (e, model) => { pulls.get(model)?.abort(); return true; });
  handle('local:delete', async (e, model) => { const op = store.getSettings().profiles.find(p => p.provider === 'ollama') || { provider: 'ollama' }; await local.ollamaDelete(model, baseOf(op)); ollamaCache.at = 0; return true; });

  /* --- Фото и видео --- */
  const mediaProviders = () => store.getSettings().profiles.filter(usable).flatMap(p => {
    const pre = preset(p.provider); const out = [];
    if (pre.image) out.push({ kind: 'image', profileId: p.id, name: p.name || pre.name, provider: p.provider, adapter: pre.image.kind, models: pre.image.models });
    if (pre.video) out.push({ kind: 'video', profileId: p.id, name: p.name || pre.name, provider: p.provider, adapter: pre.video.kind, models: pre.video.models });
    return out;
  });
  const withData = en => ({ ...en, file: undefined, path: en.file, data: en.kind === 'image' ? `data:image/${en.file.endsWith('jpg') ? 'jpeg' : en.file.split('.').pop()};base64,` + (media.read(en.id) || Buffer.alloc(0)).toString('base64') : null });
  handle('media:providers', () => mediaProviders());
  handle('media:list', () => media.list().filter(x => fs.existsSync(x.file)).map(withData));
  handle('media:image', async (e, { profileId, model, prompt, n = 1, size = '1024x1024' }) => {
    const mp = mediaProviders().find(x => x.kind === 'image' && (!profileId || x.profileId === profileId));
    if (!mp) throw new Error('NO_IMAGE_PROVIDER');
    const prof = store.getProfile(mp.profileId);
    model = model && mp.models.includes(model) ? model : mp.models[0];
    const bufs = await generateImages({ target: ai.targetOf(prof), kind: mp.adapter, model, prompt, n, size });
    if (!bufs.length) throw new Error('Провайдер ничего не вернул');
    return bufs.map(b => withData(media.add({ kind: 'image', prompt, provider: prof.provider, profileId: prof.id, model, size }, b, extOf(b))));
  });
  handle('media:video', async (e, { profileId, model, prompt, jobId }) => {
    const mp = mediaProviders().find(x => x.kind === 'video' && (!profileId || x.profileId === profileId));
    if (!mp) throw new Error('NO_VIDEO_PROVIDER');
    const prof = store.getProfile(mp.profileId);
    model = model && mp.models.includes(model) ? model : mp.models[0];
    const buf = await generateVideoMinimax({ target: ai.targetOf(prof), model, prompt, onProgress: text => e.sender.send('media:progress', { jobId, text }) });
    return withData(media.add({ kind: 'video', prompt, provider: prof.provider, profileId: prof.id, model }, buf, 'mp4'));
  });
  handle('media:read', (e, id) => { const b = media.read(id); return b ? new Uint8Array(b) : null; });
  handle('media:delete', (e, id) => media.remove(id));
  handle('media:reveal', (e, id) => { const en = media.list().find(x => x.id === id); if (en) shell.showItemInFolder(en.file); else shell.openPath(media.dir); return true; });

  /* --- Управление ПК --- */
  handle('pc:classify', (e, { action, args }) => pc.classify(action, args));
  handle('pc:permissions', () => macPermissions());
  handle('pc:openPrefs', (e, kind) => {
    if (!IS_MAC) return false;
    if (kind === 'accessibility') { try { systemPreferences.isTrustedAccessibilityClient(true); } catch {} } // macOS сам добавит программу в список
    if (kind === 'screen') desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
    shell.openExternal(MAC_PREFS[kind] || MAC_PREFS.accessibility);
    return true;
  });
  handle('app:relaunch', () => { app.relaunch(); app.exit(0); });
  /* --- Агент: задача, лимиты, правила, стоп --- */
  handle('agent:start', (e, { userText } = {}) => agentStart(String(userText || '')));
  handle('agent:end', (e, id) => { agentEnd(id); return true; });
  handle('agent:stop', () => { emergencyStop('кнопка «Стоп»'); return true; });
  handle('agent:info', () => ({ hotkey: stopHotkeyLabel, rules: safety.RULES_RU, maxSteps: MAX_STEPS, maxMinutes: MAX_MINUTES }));
  handle('pc:exec', async (e, { action, args = {}, confirmed, taskId }) => {
    const s = store.getSettings();
    if (!s.pcControlEnabled) { store.logAction({ action, args, status: 'blocked', note: 'Управление ПК выключено' }); throw new Error('Управление ПК выключено в настройках'); }
    const t = task && task.id === taskId ? task : null;
    if (!t) return { ok: false, stopped: true, text: 'Задача остановлена.' };
    if (t.stopped) return { ok: false, stopped: true, text: 'Остановлено: ' + t.stopped };
    if (++t.steps > MAX_STEPS) { agentEnd(t.id, `лимит ${MAX_STEPS} шагов`); return { ok: false, stopped: true, text: `Достигнут лимит ${MAX_STEPS} шагов на задачу — остановился.` }; }
    if (Date.now() - t.started > MAX_MINUTES * 60000) { agentEnd(t.id, `лимит ${MAX_MINUTES} минут`); return { ok: false, stopped: true, text: `Задача идёт дольше ${MAX_MINUTES} минут — остановился.` }; }
    // Жёсткие правила — всегда, в любом режиме. Нарушение не спрашиваем: пропускаем и объясняем.
    const verdict = safety.check(action, args, { userText: t.userText, screenHint: t.screenHint });
    const logArgs = action === 'type_text' && !verdict.ok ? { text: '•••' } : action === 'write_file' ? { path: args.path, chars: String(args.content || '').length } : args;
    if (!verdict.ok) { store.logAction({ action, args: logArgs, status: 'blocked', note: verdict.reason }); return { ok: false, blocked: true, text: verdict.reason }; }
    const risk = pc.classify(action, args);
    if (!s.autonomous && (risk.level === 'risky' || s.confirmAll) && !confirmed) { store.logAction({ action, args: logArgs, status: 'blocked', note: 'Нет подтверждения' }); throw new Error('Нужно подтверждение'); }
    if (IS_MAC && NEEDS_ACCESSIBILITY.has(action) && !macPermissions().accessibility) {
      try { systemPreferences.isTrustedAccessibilityClient(true); } catch {} // покажет системное окно с кнопкой «Открыть настройки»
      store.logAction({ action, args: logArgs, status: 'error', risk: risk.level, note: 'Нет разрешения «Универсальный доступ»' });
      throw new Error(ACCESS_MSG);
    }
    showIndicator(true);
    try {
      const r = await pc.execute(action, args, { screenshotFn: takeScreenshot, safePath: verdict.path });
      if (t.stopped) return { ok: false, stopped: true, text: 'Остановлено: ' + t.stopped };
      if (action === 'screenshot') t.screenHint = String(r.text || '').slice(0, 3000);
      store.logAction({ action, args: logArgs, status: r.simulated ? 'simulated' : 'done', risk: risk.level, note: r.text });
      return r;
    } catch (err) {
      store.logAction({ action, args: logArgs, status: t.stopped ? 'stopped' : 'error', risk: risk.level, note: err.message });
      if (t.stopped) return { ok: false, stopped: true, text: 'Остановлено: ' + t.stopped };
      throw err;
    }
  });
  handle('pc:deny', (e, { action, args }) => store.logAction({ action, args, status: 'denied', note: 'Отклонено пользователем' }));
  handle('actions:get', () => store.getActions());
  handle('actions:clear', () => store.clearActions());

  handle('file:export', async (e, { name, content, ext }) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: name.replace(/[\\/:*?"<>|]/g, '_') + '.' + ext, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, content, 'utf8');
    return r.filePath;
  });
  handle('shell:open', (e, url) => { const v = net.validateExternalUrl(url); if (!v.ok) return { ok: false, error: v.reason }; shell.openExternal(v.url); return { ok: true }; });
  handle('shell:openData', () => shell.openPath(app.getPath('userData')));
  // Обновления
  handle('update:check', () => updater.check({ manual: true }));
  handle('update:state', () => updater.getState());
  handle('update:install', () => updater.install());
  handle('update:openRelease', () => updater.openRelease());
  handle('update:setToken', (e, token) => {
    const tkn = String(token || '').trim();
    if (tkn && !/^(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}$/.test(tkn)) return { ok: false, error: 'Это не похоже на GitHub-токен.' };
    store.setSettings({ updateToken: tkn });
    return { ok: true, settings: publicSettings() };
  });

  handle('voice:allowMic', () => { micAllowedUntil = Date.now() + 120000; return true; });
  handle('voice:denyMic', () => { micAllowedUntil = 0; return true; });

  handle('lock:status', () => {
    const rec = store.getLockRecord();
    const lim = lockLimiter.status();
    return { enabled: !!rec, locked, waitMs: lim.waitMs, blocked: lim.blocked, maxTries: lim.maxTries };
  });
  handle('lock:unlock', (e, pin) => {
    const rec = store.getLockRecord();
    if (!rec) { locked = false; return { ok: true, settings: publicSettings() }; }
    lockLimiter.check();
    if (!lockLib.verifyPin(String(pin || ''), rec)) {
      const st = lockLimiter.fail();
      const e2 = new Error(st.blocked ? `Слишком много попыток. Подождите ${Math.ceil(st.waitMs / 1000)} с.` : 'Неверный пароль.');
      e2.code = st.blocked ? 'COOLDOWN' : 'BAD_PIN';
      throw e2;
    }
    lockLimiter.reset();
    locked = false;
    loadMainPage();
    return { ok: true, settings: publicSettings() };
  });
  handle('lock:enable', (e, { pin, confirm } = {}) => {
    if (String(pin || '') !== String(confirm || '')) throw new Error('Пароли не совпадают.');
    const rec = store.getLockRecord();
    if (rec) throw new Error('Блокировка уже включена. Сначала смените или отключите пароль.');
    store.setLockRecord(lockLib.hashPin(String(pin || '')));
    return { ok: true, settings: publicSettings() };
  });
  handle('lock:disable', (e, pin) => {
    const rec = store.getLockRecord();
    if (!rec) return { ok: true, settings: publicSettings() };
    if (!lockLib.verifyPin(String(pin || ''), rec)) throw new Error('Неверный пароль.');
    store.setLockRecord(null);
    locked = false;
    return { ok: true, settings: publicSettings() };
  });
  handle('lock:change', (e, { oldPin, pin, confirm } = {}) => {
    const rec = store.getLockRecord();
    if (!rec) throw new Error('Блокировка выключена.');
    if (!lockLib.verifyPin(String(oldPin || ''), rec)) throw new Error('Неверный текущий пароль.');
    if (String(pin || '') !== String(confirm || '')) throw new Error('Новые пароли не совпадают.');
    store.setLockRecord(lockLib.hashPin(String(pin || '')));
    return { ok: true, settings: publicSettings() };
  });
  handle('lock:now', () => {
    if (!store.getLockRecord()) throw new Error('Сначала задайте пароль в настройках.');
    locked = true;
    loadLockPage();
    return { ok: true };
  });
}

if (process.env.GD_USERDATA) app.setPath('userData', process.env.GD_USERDATA);

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', ev => ev.preventDefault());
  contents.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: 'deny' }; });
  contents.on('will-navigate', (ev, url) => {
    if (isAppFileUrl(url)) return;
    ev.preventDefault();
    openExternalSafe(url);
  });
  contents.on('will-redirect', (ev, url) => {
    if (!isAppFileUrl(url) && !String(url).startsWith('file:')) ev.preventDefault();
  });
});

const gotInstance = app.requestSingleInstanceLock();
if (!gotInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    // Ключи провайдеров храним зашифрованными средствами ОС. В сборках никаких ключей нет — их вводит сам пользователь.
    const crypto = { available: () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } }, encrypt: v => safeStorage.encryptString(v).toString('base64'), decrypt: v => safeStorage.decryptString(Buffer.from(v, 'base64')) };
    store = new Store(app.getPath('userData'), crypto);
    media = new Media(app.getPath('userData'));
    locked = !!store.getLockRecord();
    registerIpc();
    registerStopHotkey();
    createMacMenu();
    if (IS_MAC && !app.isPackaged) { try { app.dock.setIcon(ICON_PNG); } catch {} }
    createWindow();
    createTray();
    updater.init({ getWin: () => win, getToken: () => store.getSettings().updateToken });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
