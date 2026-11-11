// Локальное хранилище: settings.json, chats.json, actions.log.json в userData.
const fs = require('fs');
const path = require('path');
const { redact, redactDeep } = require('./redact');

const DEFAULT_SETTINGS = {
  theme: 'system',            // light | dark | system
  language: 'ru',
  apiKey: '',                 // наследие v1.0, больше не используется (ключи — только в профилях, зашифрованы)
  model: 'openai/gpt-oss-120b',
  fallbackModels: ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  visionModel: 'qwen/qwen3.8-27b',
  temperature: 0.6,
  searchEnabled: true,
  searchProvider: 'auto',     // auto (Groq browser_search → DDG → Bing → Wikipedia) | groq | duckduckgo | bing
  pcControlEnabled: false,
  pcControlUserOff: false,   // пользователь сам выключил — не включаем автоматически
  autonomous: true,           // «Автономный режим»: без подтверждений, защищают жёсткие правила safety.js
  confirmAll: false,          // только при выключенном автономном режиме: спрашивать перед каждым действием
  voiceEnabled: true,
  ttsAutoplay: false,
  launchAtStartup: false,
  onboarded: false,
  systemPrompt: '',
  // v1.1: несколько провайдеров/ключей. apiKey/model выше — наследие v1.0 (мигрируются в профиль Groq).
  profiles: [],               // [{id, provider, name, apiKey, baseUrl, model, visionModel, imageModel}]
  activeProfile: null,
  brain: null,                // 'local' | 'api' — ответ на «Где думать?»
  updateToken: '',            // необязательный GitHub-токен (репозиторий публичный, токен не нужен)
  keysPurged13: false         // 1.3.0: одноразовая чистка профиля 'groq', который старые сборки создавали сами
};
const uidp = () => 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Ключи на диске шифруются средствами ОС (Electron safeStorage: DPAPI в Windows, Связка ключей в macOS).
const ENC = 'enc:v1:';
class Store {
  constructor(dir, crypto = null) {
    this.dir = dir;
    this.crypto = crypto && crypto.available() ? crypto : null;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
    this.files = {
      settings: path.join(dir, 'settings.json'),
      chats: path.join(dir, 'chats.json'),
      actions: path.join(dir, 'actions.log.json'),
      templates: path.join(dir, 'templates.json'),
      lock: path.join(dir, 'lock.json')
    };
  }
  _read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }
  _dec(v) { if (typeof v !== 'string' || !v.startsWith(ENC)) return v || ''; try { return this.crypto ? this.crypto.decrypt(v.slice(ENC.length)) : ''; } catch { return ''; } }
  _enc(v) {
    if (!v) return '';
    if (String(v).startsWith(ENC)) return v;
    if (!this.crypto) {
      const e = new Error('Шифрование ключей недоступно (safeStorage). Ключ не сохранён открытым текстом.');
      e.code = 'NO_CRYPTO';
      throw e;
    }
    try { return ENC + this.crypto.encrypt(String(v)); }
    catch {
      const e = new Error('Не удалось зашифровать ключ — он не записан на диск.');
      e.code = 'ENC_FAIL';
      throw e;
    }
  }
  _readSettings() {
    const raw = this._read(this.files.settings, {});
    if (Array.isArray(raw.profiles)) raw.profiles = raw.profiles.map(p => ({ ...p, apiKey: this._dec(p.apiKey) }));
    if (raw.updateToken) raw.updateToken = this._dec(raw.updateToken);
    if (raw.apiKey) raw.apiKey = this._dec(raw.apiKey);
    return raw;
  }
  _writeSettings(s) {
    const out = { ...s, apiKey: '', updateToken: this._enc(s.updateToken), profiles: (s.profiles || []).map(p => ({ ...p, apiKey: this._enc(p.apiKey) })) };
    this._write(this.files.settings, out);
  }
  _write(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  }
  getSettings() {
    const s = { ...DEFAULT_SETTINGS, ...this._readSettings() };
    if (!this._migrated) { this._migrated = true; this._migrate(s); this._writeSettings(s); } // заодно шифрует ключи, лежавшие открытым текстом
    return s;
  }
  /** v1.0 → v1.1: ключ Groq становится профилем; профиль «Локально (Ollama)» есть всегда.
   *  v1.3: профиль с id 'groq' старые сборки создавали сами, без пользователя — удаляем его; ключи вводит только пользователь. */
  _migrate(s) {
    let changed = false;
    s.profiles = Array.isArray(s.profiles) ? s.profiles : [];
    if (!s.keysPurged13) {
      const had = s.profiles.some(p => p.id === 'groq');
      s.profiles = s.profiles.filter(p => p.id !== 'groq');
      s.apiKey = ''; s.keysPurged13 = true; changed = true;
      if (had) { s.activeProfile = null; s.onboarded = false; s.brain = null; }
    }
    if (s.apiKey) s.apiKey = '';
    if (!s.profiles.some(p => p.provider === 'ollama')) { s.profiles.push({ id: 'local-ollama', provider: 'ollama', name: 'Локально (Ollama)', apiKey: '', model: '', visionModel: '' }); changed = true; }
    if (!s.activeProfile || !s.profiles.some(p => p.id === s.activeProfile)) { s.activeProfile = (s.profiles.find(p => p.provider === 'ollama') || s.profiles[0]).id; changed = true; }
    return changed;
  }
  getProfile(id) { const s = this.getSettings(); return s.profiles.find(p => p.id === (id || s.activeProfile)) || s.profiles[0]; }
  saveProfile(p) {
    const s = this.getSettings();
    const i = s.profiles.findIndex(x => x.id === p.id);
    if (i >= 0) { const prev = s.profiles[i]; s.profiles[i] = { ...prev, ...p, apiKey: p.apiKey === undefined || p.apiKey === null ? prev.apiKey : p.apiKey }; }
    else s.profiles.push({ id: p.id || uidp(), apiKey: '', model: '', visionModel: '', ...p });
    const saved = s.profiles[i >= 0 ? i : s.profiles.length - 1];
    this._writeSettings(s);
    return saved;
  }
  deleteProfile(id) {
    const s = this.getSettings();
    s.profiles = s.profiles.filter(p => p.id !== id);
    this._migrate(s); this._writeSettings(s);
    return true;
  }
  activate(id, model) {
    const s = this.getSettings();
    const p = s.profiles.find(x => x.id === id); if (!p) throw new Error('Нет такого профиля');
    s.activeProfile = id; if (model) p.model = model;
    this._writeSettings(s);
    return s;
  }
  setSettings(patch) {
    const next = { ...this.getSettings(), ...patch };
    this._writeSettings(next);
    return next;
  }
  getChats() { return this._read(this.files.chats, { chats: [], folders: ['Работа', 'Личное'] }); }
  saveChats(data) { this._write(this.files.chats, data); return true; }
  getActions() { return redactDeep(this._read(this.files.actions, [])); }
  logAction(entry) {
    // Текстовый журнал рядом с JSON: agent.log (одна строка на действие), открывается любым блокнотом.
    // Секреты (ключи, токены, карты) вычищаются и в JSON, и в тексте.
    const safe = redactDeep({
      ...entry,
      args: entry.action === 'type_text' ? { text: `(текст, ${String((entry.args && entry.args.text) || '').length} символов)` } : redactDeep(entry.args || {}),
      note: redact(String(entry.note || ''))
    });
    try {
      const line = `${new Date().toISOString()}\t${safe.status || ''}\t${safe.action || ''}\t${JSON.stringify(safe.args || {})}\t${String(safe.note || '').split('\n')[0].slice(0, 300)}\n`;
      const lf = path.join(this.dir, 'agent.log');
      try { if (fs.statSync(lf).size > 5 * 1024 * 1024) { fs.renameSync(lf, lf + '.1'); try { fs.chmodSync(lf + '.1', 0o600); } catch {} } } catch {}
      fs.appendFileSync(lf, line, { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(lf, 0o600); } catch {}
    } catch {}
    const list = this.getActions();
    list.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), ...safe });
    this._write(this.files.actions, list.slice(0, 1000));
    return list[0];
  }
  clearActions() { this._write(this.files.actions, []); return true; }
  getTemplates() {
    return this._read(this.files.templates, [
      { id: 't1', title: 'Объясни попроще', text: 'Объясни так, будто я умный, но не в теме: ' },
      { id: 't2', title: 'Сократи', text: 'Сократи текст в два раза, смысл не теряй:\n\n' },
      { id: 't3', title: 'Письмо', text: 'Напиши короткое вежливое письмо. Суть: ' },
      { id: 't4', title: 'Разбор кода', text: 'Найди ошибки и предложи исправления:\n\n```\n\n```' },
      { id: 't5', title: 'План на день', text: 'Помоги разложить по часам задачи на сегодня: ' }
    ]);
  }
  saveTemplates(list) { this._write(this.files.templates, list); return true; }
  getLockRecord() {
    const raw = this._read(this.files.lock, null);
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  }
  setLockRecord(rec) {
    if (!rec) {
      try { fs.unlinkSync(this.files.lock); } catch {}
      return null;
    }
    this._write(this.files.lock, rec);
    return rec;
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
