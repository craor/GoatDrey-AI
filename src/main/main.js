// GoatDrey AI — main-процесс Electron.
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeTheme, dialog, shell, desktopCapturer, screen, nativeImage } = require('electron');
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

const ROOT = path.join(__dirname, '..', '..');
const ICON_PNG = path.join(ROOT, 'assets', 'icon', process.platform === 'win32' ? 'icon.ico' : 'icon-256.png');
const TRAY_PNG = path.join(ROOT, 'assets', 'icon', 'icon-32.png');

let win, tray, store, media;
const aborters = new Map();

function localConfigPath() {
  // В собранной версии config.local.json лежит в resources/, в dev — в корне проекта.
  const candidates = [path.join(process.resourcesPath || '', 'config.local.json'), path.join(ROOT, 'config.local.json'), path.join(path.dirname(process.execPath), 'config.local.json')];
  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: true }
  });
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // Для проверки без экрана: GD_SNAPSHOT=путь.png — снимок окна и выход.
  if (process.env.GD_SNAPSHOT) win.webContents.once('did-finish-load', () => setTimeout(async () => {
    try { if (process.env.GD_EVAL) await win.webContents.executeJavaScript(process.env.GD_EVAL); } catch (e) { console.error('eval', e.message); }
    setTimeout(async () => { const img = await win.webContents.capturePage(); fs.writeFileSync(process.env.GD_SNAPSHOT, img.toPNG()); console.log('snapshot', process.env.GD_SNAPSHOT); app.quit(); }, +(process.env.GD_WAIT || 1500));
  }, 1200));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  // Микрофон для голосового ввода
  win.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'microphone', 'clipboard-sanitized-write'].includes(perm)));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(TRAY_PNG);
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
  return { ...rest, hasKey: !!apiKey, keyMask: apiKey ? apiKey.slice(0, 6) + '•'.repeat(8) + apiKey.slice(-4) : '', presetName: pre.name, short: pre.short, local: !!pre.local, noKey: !!pre.noKey, baseUrl: p.baseUrl || '', effectiveBase: baseOf(p), defaultModel: pre.defaultModel || '', defaultVision: pre.visionModel || '', browserSearch: !!pre.browserSearch, image: pre.image || null, video: pre.video || null, usable: usable(p) };
}
function publicSettings() {
  const s = store.getSettings();
  const { apiKey, updateToken, ...rest } = s;
  return { ...rest, hasLegacyKey: !!apiKey, hasUpdateToken: !!updateToken, profiles: s.profiles.map(publicProfile), platform: process.platform, version: app.getVersion(), dataDir: app.getPath('userData') };
}
function presetsPublic() {
  return ORDER.map(id => { const p = PRESETS[id]; return { id, name: p.name, short: p.short, base: p.base, keyUrl: p.keyUrl || '', local: !!p.local, noKey: !!p.noKey, defaultModel: p.defaultModel, note: p.note, image: !!p.image, video: !!p.video, stt: !!p.stt, browserSearch: !!p.browserSearch }; });
}

async function takeScreenshot() {
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

function registerIpc() {
  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('settings:set', (e, patch = {}) => {
    const { profiles, activeProfile, apiKey, updateToken, ...safe } = patch; // профили и ключи — только через profiles:*
    const next = store.setSettings(safe);
    if ('theme' in safe) nativeTheme.themeSource = next.theme;
    if ('launchAtStartup' in safe && (process.platform === 'win32' || process.platform === 'darwin')) app.setLoginItemSettings({ openAtLogin: !!next.launchAtStartup });
    return publicSettings();
  });
  ipcMain.handle('theme:isDark', () => nativeTheme.shouldUseDarkColors);
  nativeTheme.on('updated', () => win?.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors));

  ipcMain.handle('chats:get', () => store.getChats());
  ipcMain.handle('chats:save', (e, data) => store.saveChats(data));
  ipcMain.handle('templates:get', () => store.getTemplates());
  ipcMain.handle('templates:save', (e, list) => store.saveTemplates(list));

  /* --- Провайдеры и профили --- */
  ipcMain.handle('providers:presets', () => presetsPublic());
  ipcMain.handle('providers:detect', (e, key) => detectProvider(key));
  ipcMain.handle('profiles:save', (e, p) => {
    const patch = { ...p };
    if (typeof patch.apiKey === 'string') { patch.apiKey = patch.apiKey.trim(); if (!patch.apiKey || patch.apiKey.includes('•')) delete patch.apiKey; }
    if (!patch.name) patch.name = preset(patch.provider).name;
    if (patch.baseUrl) patch.baseUrl = String(patch.baseUrl).trim().replace(/\/+$/, '');
    const saved = store.saveProfile(patch);
    toolMode.clear();
    return publicProfile(saved);
  });
  ipcMain.handle('profiles:delete', (e, id) => { store.deleteProfile(id); return publicSettings(); });
  ipcMain.handle('profiles:activate', (e, { id, model }) => { store.activate(id, model); return publicSettings(); });
  /** Проверка ключа до/после сохранения: draft может содержать новый ключ, иначе берём сохранённый. */
  ipcMain.handle('profiles:test', async (e, draft) => {
    const saved = draft.id ? store.getSettings().profiles.find(p => p.id === draft.id) : null;
    const p = { ...(saved || {}), ...draft };
    if (!p.apiKey || String(p.apiKey).includes('•')) p.apiKey = saved?.apiKey || '';
    if (needsKey(p) && !p.apiKey) throw new Error('NO_KEY');
    const models = await ai.listModels(ai.targetOf(p));
    return models;
  });
  ipcMain.handle('ai:models', async (e, profileId) => {
    const p = store.getProfile(profileId);
    if (!usable(p)) throw new Error('NO_KEY');
    if (p.provider === 'ollama') { const st = await ollamaInfo(p, true); if (!st.running) throw new Error('OLLAMA_DOWN'); return st.models.map(m => m.name); }
    return ai.listModels(ai.targetOf(p));
  });

  /* --- Чат --- */
  ipcMain.handle('ai:chat', async (e, { id, messages, profileId, model, mode, useTools, webSearch }) => {
    const s = store.getSettings();
    const prof = store.getProfile(profileId);
    const pre = preset(prof.provider);
    if (!usable(prof)) throw new Error('NO_KEY');
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
  ipcMain.handle('ai:abort', (e, id) => { aborters.get(id)?.abort(); return true; });
  ipcMain.handle('ai:title', async (e, text) => {
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
  ipcMain.handle('ai:stt', () => sttTarget()?.name || null);
  ipcMain.handle('ai:transcribe', async (e, { audio, mime }) => {
    const t = sttTarget(); if (!t) throw new Error('NO_STT');
    return ai.transcribe({ ...t, audio: Buffer.from(audio), mime, language: store.getSettings().language || 'ru' });
  });

  ipcMain.handle('search:query', async (e, q) => {
    const s = store.getSettings();
    const res = await search.search(q, { provider: s.searchProvider });
    return { ...res, context: search.toContext(q, res) };
  });

  /* --- Локальные модели --- */
  let sysCache = null;
  ipcMain.handle('local:status', async () => {
    const s = store.getSettings();
    const op = s.profiles.find(p => p.provider === 'ollama') || { provider: 'ollama' };
    const lp = s.profiles.find(p => p.provider === 'lmstudio') || { provider: 'lmstudio' };
    sysCache = sysCache || await local.sysInfo();
    const [ollama, lmstudio] = await Promise.all([ollamaInfo(op, true), local.lmstudioStatus(baseOf(lp))]);
    return { ollama, lmstudio, sys: sysCache, rec: local.recommend(sysCache), suggested: local.SUGGESTED };
  });
  const pulls = new Map();
  ipcMain.handle('local:pull', async (e, model) => {
    const op = store.getSettings().profiles.find(p => p.provider === 'ollama') || { provider: 'ollama' };
    const ctrl = new AbortController(); pulls.set(model, ctrl);
    try { await local.ollamaPull(model, { base: baseOf(op), signal: ctrl.signal, onProgress: p => e.sender.send('local:progress', { model, ...p }) }); ollamaCache.at = 0; return true; }
    finally { pulls.delete(model); }
  });
  ipcMain.handle('local:pullAbort', (e, model) => { pulls.get(model)?.abort(); return true; });
  ipcMain.handle('local:delete', async (e, model) => { const op = store.getSettings().profiles.find(p => p.provider === 'ollama') || { provider: 'ollama' }; await local.ollamaDelete(model, baseOf(op)); ollamaCache.at = 0; return true; });

  /* --- Фото и видео --- */
  const mediaProviders = () => store.getSettings().profiles.filter(usable).flatMap(p => {
    const pre = preset(p.provider); const out = [];
    if (pre.image) out.push({ kind: 'image', profileId: p.id, name: p.name || pre.name, provider: p.provider, adapter: pre.image.kind, models: pre.image.models });
    if (pre.video) out.push({ kind: 'video', profileId: p.id, name: p.name || pre.name, provider: p.provider, adapter: pre.video.kind, models: pre.video.models });
    return out;
  });
  const withData = en => ({ ...en, file: undefined, path: en.file, data: en.kind === 'image' ? `data:image/${en.file.endsWith('jpg') ? 'jpeg' : en.file.split('.').pop()};base64,` + (media.read(en.id) || Buffer.alloc(0)).toString('base64') : null });
  ipcMain.handle('media:providers', () => mediaProviders());
  ipcMain.handle('media:list', () => media.list().filter(x => fs.existsSync(x.file)).map(withData));
  ipcMain.handle('media:image', async (e, { profileId, model, prompt, n = 1, size = '1024x1024' }) => {
    const mp = mediaProviders().find(x => x.kind === 'image' && (!profileId || x.profileId === profileId));
    if (!mp) throw new Error('NO_IMAGE_PROVIDER');
    const prof = store.getProfile(mp.profileId);
    model = model && mp.models.includes(model) ? model : mp.models[0];
    const bufs = await generateImages({ target: ai.targetOf(prof), kind: mp.adapter, model, prompt, n, size });
    if (!bufs.length) throw new Error('Провайдер ничего не вернул');
    return bufs.map(b => withData(media.add({ kind: 'image', prompt, provider: prof.provider, profileId: prof.id, model, size }, b, extOf(b))));
  });
  ipcMain.handle('media:video', async (e, { profileId, model, prompt, jobId }) => {
    const mp = mediaProviders().find(x => x.kind === 'video' && (!profileId || x.profileId === profileId));
    if (!mp) throw new Error('NO_VIDEO_PROVIDER');
    const prof = store.getProfile(mp.profileId);
    model = model && mp.models.includes(model) ? model : mp.models[0];
    const buf = await generateVideoMinimax({ target: ai.targetOf(prof), model, prompt, onProgress: text => e.sender.send('media:progress', { jobId, text }) });
    return withData(media.add({ kind: 'video', prompt, provider: prof.provider, profileId: prof.id, model }, buf, 'mp4'));
  });
  ipcMain.handle('media:read', (e, id) => { const b = media.read(id); return b ? new Uint8Array(b) : null; });
  ipcMain.handle('media:delete', (e, id) => media.remove(id));
  ipcMain.handle('media:reveal', (e, id) => { const en = media.list().find(x => x.id === id); if (en) shell.showItemInFolder(en.file); else shell.openPath(media.dir); return true; });

  /* --- Управление ПК --- */
  ipcMain.handle('pc:classify', (e, { action, args }) => pc.classify(action, args));
  ipcMain.handle('pc:exec', async (e, { action, args, confirmed }) => {
    const s = store.getSettings();
    if (!s.pcControlEnabled) { store.logAction({ action, args, status: 'blocked', note: 'Управление ПК выключено' }); throw new Error('Управление ПК выключено в настройках'); }
    const risk = pc.classify(action, args);
    if ((risk.level === 'risky' || s.confirmAll) && !confirmed) { store.logAction({ action, args, status: 'blocked', note: 'Нет подтверждения' }); throw new Error('Нужно подтверждение'); }
    try {
      const r = await pc.execute(action, args, { screenshotFn: takeScreenshot });
      store.logAction({ action, args: action === 'type_text' && risk.level === 'risky' ? { text: '•••' } : args, status: r.simulated ? 'simulated' : 'done', risk: risk.level, note: r.text });
      return r;
    } catch (err) {
      store.logAction({ action, args, status: 'error', risk: risk.level, note: err.message });
      throw err;
    }
  });
  ipcMain.handle('pc:deny', (e, { action, args }) => store.logAction({ action, args, status: 'denied', note: 'Отклонено пользователем' }));
  ipcMain.handle('actions:get', () => store.getActions());
  ipcMain.handle('actions:clear', () => store.clearActions());

  ipcMain.handle('file:export', async (e, { name, content, ext }) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: name.replace(/[\\/:*?"<>|]/g, '_') + '.' + ext, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, content, 'utf8');
    return r.filePath;
  });
  ipcMain.handle('shell:open', (e, url) => /^https?:/i.test(url) && shell.openExternal(url));
  ipcMain.handle('shell:openData', () => shell.openPath(app.getPath('userData')));
  // Обновления
  ipcMain.handle('update:check', () => updater.check({ manual: true }));
  ipcMain.handle('update:state', () => updater.getState());
  ipcMain.handle('update:install', () => updater.install());
  ipcMain.handle('update:setToken', (e, token) => {
    const t = String(token || '').trim();
    if (t && !/^(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}$/.test(t)) return { ok: false, error: 'Это не похоже на GitHub-токен (ghp_… или github_pat_…).' };
    store.setSettings({ updateToken: t });
    return { ok: true, settings: publicSettings() };
  });
}

if (process.env.GD_USERDATA) app.setPath('userData', process.env.GD_USERDATA);
app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  media = new Media(app.getPath('userData'));
  const cfg = localConfigPath();
  if (cfg) store.seedFromLocalConfig(cfg);
  registerIpc();
  createWindow();
  createTray();
  updater.init({ getWin: () => win, getToken: () => store.getSettings().updateToken });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
