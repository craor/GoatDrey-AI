// Мост между UI и main. Ключи API и сеть — только в main.
const { contextBridge, ipcRenderer } = require('electron');
const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const ai = {
  models: profileId => inv('ai:models', profileId),
  chat: req => inv('ai:chat', req),
  abort: id => inv('ai:abort', id),
  title: t => inv('ai:title', t),
  stt: () => inv('ai:stt'),
  transcribe: (audio, mime) => inv('ai:transcribe', { audio, mime }),
  onDelta: cb => ipcRenderer.on('ai:delta', (e, d) => cb(d))
};
contextBridge.exposeInMainWorld('gd', {
  settings: { get: () => inv('settings:get'), set: p => inv('settings:set', p) },
  theme: { isDark: () => inv('theme:isDark'), onChange: cb => ipcRenderer.on('theme:changed', (e, v) => cb(v)) },
  chats: { get: () => inv('chats:get'), save: d => inv('chats:save', d) },
  templates: { get: () => inv('templates:get'), save: l => inv('templates:save', l) },
  providers: { presets: () => inv('providers:presets'), detect: key => inv('providers:detect', key) },
  profiles: {
    save: p => inv('profiles:save', p), remove: id => inv('profiles:delete', id),
    activate: (id, model) => inv('profiles:activate', { id, model }), test: draft => inv('profiles:test', draft)
  },
  ai,
  groq: ai, // совместимость с 1.0
  local: {
    status: () => inv('local:status'), pull: m => inv('local:pull', m), abort: m => inv('local:pullAbort', m), remove: m => inv('local:delete', m),
    onProgress: cb => ipcRenderer.on('local:progress', (e, d) => cb(d))
  },
  media: {
    providers: () => inv('media:providers'), list: () => inv('media:list'), image: req => inv('media:image', req), video: req => inv('media:video', req),
    read: id => inv('media:read', id), remove: id => inv('media:delete', id), reveal: id => inv('media:reveal', id),
    onProgress: cb => ipcRenderer.on('media:progress', (e, d) => cb(d))
  },
  search: q => inv('search:query', q),
  pc: {
    classify: (action, args) => inv('pc:classify', { action, args }),
    exec: (action, args, confirmed, taskId) => inv('pc:exec', { action, args, confirmed, taskId }),
    deny: (action, args) => inv('pc:deny', { action, args }),
    log: () => inv('actions:get'), clearLog: () => inv('actions:clear'),
    permissions: () => inv('pc:permissions'), openPrefs: kind => inv('pc:openPrefs', kind)
  },
  agent: {
    start: userText => inv('agent:start', { userText }), end: id => inv('agent:end', id), stop: () => inv('agent:stop'), info: () => inv('agent:info'),
    onStopped: cb => ipcRenderer.on('agent:stopped', (e, d) => cb(d))
  },
  relaunch: () => inv('app:relaunch'),
  file: { export: (name, content, ext) => inv('file:export', { name, content, ext }) },
  open: url => inv('shell:open', url),
  openDataDir: () => inv('shell:openData'),
  update: {
    check: () => inv('update:check'), state: () => inv('update:state'), install: () => inv('update:install'),
    setToken: t => inv('update:setToken', t), openRelease: () => inv('update:openRelease'), onStatus: cb => ipcRenderer.on('update:status', (e, d) => cb(d))
  },
  onCommand: cb => ipcRenderer.on('app:command', (e, c) => cb(c))
});
