// Локальное хранилище: settings.json, chats.json, actions.log.json в userData.
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  theme: 'system',            // light | dark | system
  language: 'ru',
  apiKey: '',
  model: 'openai/gpt-oss-120b',
  fallbackModels: ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  visionModel: 'qwen/qwen3.8-27b',
  temperature: 0.6,
  searchEnabled: true,
  searchProvider: 'auto',     // auto (Groq browser_search → DDG → Bing → Wikipedia) | groq | duckduckgo | bing
  pcControlEnabled: false,
  pcControlUserOff: false,   // пользователь сам выключил — не включаем автоматически
  confirmRisky: true,         // всегда true для опасных действий, флаг только для «всех» действий
  confirmAll: false,
  voiceEnabled: true,
  ttsAutoplay: false,
  launchAtStartup: false,
  onboarded: false,
  systemPrompt: '',
  // v1.1: несколько провайдеров/ключей. apiKey/model выше — наследие v1.0 (мигрируются в профиль Groq).
  profiles: [],               // [{id, provider, name, apiKey, baseUrl, model, visionModel, imageModel}]
  activeProfile: null,
  brain: null,                // 'local' | 'api' — ответ на «Где думать?»
  updateToken: ''             // GitHub PAT для автообновления из приватного репозитория
};
const uidp = () => 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.files = {
      settings: path.join(dir, 'settings.json'),
      chats: path.join(dir, 'chats.json'),
      actions: path.join(dir, 'actions.log.json'),
      templates: path.join(dir, 'templates.json')
    };
  }
  _read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }
  _write(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }
  getSettings() {
    const s = { ...DEFAULT_SETTINGS, ...this._read(this.files.settings, {}) };
    if (!this._migrated) { this._migrated = true; if (this._migrate(s)) this._write(this.files.settings, s); }
    return s;
  }
  /** v1.0 → v1.1: ключ Groq становится профилем; профиль «Локально (Ollama)» есть всегда. */
  _migrate(s) {
    let changed = false;
    s.profiles = Array.isArray(s.profiles) ? s.profiles : [];
    if (s.apiKey && !s.profiles.some(p => p.provider === 'groq' && p.apiKey === s.apiKey)) {
      s.profiles.unshift({ id: 'groq', provider: 'groq', name: 'Groq', apiKey: s.apiKey, model: s.model || 'openai/gpt-oss-120b', visionModel: s.visionModel || '' });
      changed = true;
    }
    if (!s.profiles.some(p => p.provider === 'ollama')) { s.profiles.push({ id: 'local-ollama', provider: 'ollama', name: 'Локально (Ollama)', apiKey: '', model: '', visionModel: '' }); changed = true; }
    if (!s.activeProfile || !s.profiles.some(p => p.id === s.activeProfile)) { s.activeProfile = (s.profiles.find(p => p.apiKey) || s.profiles[0]).id; changed = true; }
    return changed;
  }
  getProfile(id) { const s = this.getSettings(); return s.profiles.find(p => p.id === (id || s.activeProfile)) || s.profiles[0]; }
  saveProfile(p) {
    const s = this.getSettings();
    const i = s.profiles.findIndex(x => x.id === p.id);
    if (i >= 0) { const prev = s.profiles[i]; s.profiles[i] = { ...prev, ...p, apiKey: p.apiKey === undefined || p.apiKey === null ? prev.apiKey : p.apiKey }; }
    else s.profiles.push({ id: p.id || uidp(), apiKey: '', model: '', visionModel: '', ...p });
    const saved = s.profiles[i >= 0 ? i : s.profiles.length - 1];
    this._syncLegacy(s); this._write(this.files.settings, s);
    return saved;
  }
  deleteProfile(id) {
    const s = this.getSettings();
    s.profiles = s.profiles.filter(p => p.id !== id);
    this._syncLegacy(s); this._migrate(s); this._write(this.files.settings, s);
    return true;
  }
  activate(id, model) {
    const s = this.getSettings();
    const p = s.profiles.find(x => x.id === id); if (!p) throw new Error('Нет такого профиля');
    s.activeProfile = id; if (model) p.model = model;
    this._syncLegacy(s); this._write(this.files.settings, s);
    return s;
  }
  // Поля v1.0 (apiKey/model) повторяют активный Groq-профиль — на случай отката на 1.0.x.
  _syncLegacy(s) { const g = s.profiles.find(p => p.provider === 'groq' && p.apiKey); s.apiKey = g ? g.apiKey : ''; if (g?.model) s.model = g.model; }
  setSettings(patch) {
    const next = { ...this.getSettings(), ...patch };
    next.confirmRisky = true; // опасные действия подтверждаются всегда — не отключается
    this._write(this.files.settings, next);
    return next;
  }
  seedFromLocalConfig(configPath) {
    const cfg = this._read(configPath, null);
    if (!cfg) return false;
    const s = this.getSettings();
    let seeded = false;
    // Ключ Groq из config.local.json — как в 1.0: подхватывается, только если своего ключа ещё нет.
    if (cfg.groqApiKey && !s.profiles.some(p => p.provider === 'groq' && p.apiKey)) {
      const p = this.saveProfile({ id: 'groq', provider: 'groq', name: 'Groq', apiKey: cfg.groqApiKey, model: cfg.model || 'openai/gpt-oss-120b', visionModel: s.visionModel || '' });
      const cur = this.getSettings();
      if (!cur.profiles.find(x => x.id === cur.activeProfile)?.apiKey && !cur.brain) this.activate(p.id);
      seeded = true;
    }
    // Необязательно: заранее прописанные профили { provider, apiKey, model, baseUrl, name }.
    for (const pr of Array.isArray(cfg.profiles) ? cfg.profiles : []) {
      if (!pr.provider || this.getSettings().profiles.some(p => p.provider === pr.provider && (p.apiKey || '') === (pr.apiKey || '') && (p.baseUrl || '') === (pr.baseUrl || ''))) continue;
      this.saveProfile({ ...pr, id: undefined }); seeded = true;
    }
    return seeded;
  }
  getChats() { return this._read(this.files.chats, { chats: [], folders: ['Работа', 'Личное'] }); }
  saveChats(data) { this._write(this.files.chats, data); return true; }
  getActions() { return this._read(this.files.actions, []); }
  logAction(entry) {
    const list = this.getActions();
    list.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), ...entry });
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
}

module.exports = { Store, DEFAULT_SETTINGS };
