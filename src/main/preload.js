// Мост между UI и main. Ключи API и сеть — только в main.
// Песочница + contextIsolation: здесь нет Node API, только безопасный белый список методов.
const { contextBridge, ipcRenderer } = require('electron');

function str(v, max = 20000) {
  if (v == null) return '';
  const s = String(v);
  if (s.length > max) throw new Error('Слишком длинный аргумент.');
  return s;
}
function obj(v) {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('Ожидался объект.');
  return v;
}
const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const listen = (ch, cb) => { const w = (e, d) => cb(d); ipcRenderer.on(ch, w); return () => ipcRenderer.removeListener(ch, w); };

const ai = {
  models: profileId => inv('ai:models', str(profileId, 80)),
  chat: req => inv('ai:chat', obj(req)),
  abort: id => inv('ai:abort', str(id, 80)),
  title: t => inv('ai:title', str(t, 4000)),
  stt: () => inv('ai:stt'),
  transcribe: (audio, mime) => inv('ai:transcribe', { audio, mime: str(mime, 80) }),
  onDelta: cb => listen('ai:delta', cb)
};
contextBridge.exposeInMainWorld('gd', {
  settings: { get: () => inv('settings:get'), set: p => inv('settings:set', obj(p)) },
  theme: { isDark: () => inv('theme:isDark'), onChange: cb => listen('theme:changed', cb) },
  chats: { get: () => inv('chats:get'), save: d => inv('chats:save', d) },
  templates: { get: () => inv('templates:get'), save: l => inv('templates:save', l) },
  providers: { presets: () => inv('providers:presets'), detect: key => inv('providers:detect', str(key, 200)) },
  profiles: {
    save: p => inv('profiles:save', obj(p)), remove: id => inv('profiles:delete', str(id, 80)),
    activate: (id, model) => inv('profiles:activate', { id: str(id, 80), model: model ? str(model, 200) : undefined }),
    test: draft => inv('profiles:test', obj(draft))
  },
  ai,
  groq: ai, // совместимость с 1.0
  local: {
    status: () => inv('local:status'), pull: m => inv('local:pull', str(m, 200)), abort: m => inv('local:pullAbort', str(m, 200)), remove: m => inv('local:delete', str(m, 200)),
    onProgress: cb => listen('local:progress', cb)
  },
  media: {
    providers: () => inv('media:providers'), list: () => inv('media:list'), image: req => inv('media:image', obj(req)), video: req => inv('media:video', obj(req)),
    read: id => inv('media:read', str(id, 80)), remove: id => inv('media:delete', str(id, 80)), reveal: id => inv('media:reveal', str(id, 80)),
    onProgress: cb => listen('media:progress', cb)
  },
  search: q => inv('search:query', str(q, 500)),
  pc: {
    classify: (action, args) => inv('pc:classify', { action: str(action, 40), args: args || {} }),
    exec: (action, args, confirmed, taskId) => inv('pc:exec', { action: str(action, 40), args: args || {}, confirmed: !!confirmed, taskId: str(taskId, 80) }),
    deny: (action, args) => inv('pc:deny', { action: str(action, 40), args: args || {} }),
    log: () => inv('actions:get'), clearLog: () => inv('actions:clear'),
    permissions: () => inv('pc:permissions'), openPrefs: kind => inv('pc:openPrefs', str(kind, 40))
  },
  agent: {
    start: userText => inv('agent:start', { userText: str(userText, 20000) }), end: id => inv('agent:end', str(id, 80)), stop: () => inv('agent:stop'), info: () => inv('agent:info'),
    onStopped: cb => listen('agent:stopped', cb)
  },
  lock: {
    status: () => inv('lock:status'),
    unlock: pin => inv('lock:unlock', str(pin, 128)),
    enable: (pin, confirm) => inv('lock:enable', { pin: str(pin, 128), confirm: str(confirm, 128) }),
    disable: pin => inv('lock:disable', str(pin, 128)),
    change: (oldPin, pin, confirm) => inv('lock:change', { oldPin: str(oldPin, 128), pin: str(pin, 128), confirm: str(confirm, 128) }),
    now: () => inv('lock:now')
  },
  voice: { allowMic: () => inv('voice:allowMic'), denyMic: () => inv('voice:denyMic') },
  relaunch: () => inv('app:relaunch'),
  file: { export: (name, content, ext) => inv('file:export', { name: str(name, 200), content: str(content, 2_000_000), ext: str(ext, 10) }) },
  open: url => inv('shell:open', str(url, 2000)),
  openDataDir: () => inv('shell:openData'),
  update: {
    check: () => inv('update:check'), state: () => inv('update:state'), install: () => inv('update:install'),
    setToken: t => inv('update:setToken', str(t, 200)), openRelease: () => inv('update:openRelease'), onStatus: cb => listen('update:status', cb)
  },
  onCommand: cb => listen('app:command', cb)
});
