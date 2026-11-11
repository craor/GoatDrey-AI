// Локальные модели: Ollama (http://localhost:11434) и LM Studio (http://localhost:1234/v1).
const os = require('os');
const { execFile } = require('child_process');

const OLLAMA = 'http://localhost:11434';
const rootOf = base => String(base || OLLAMA + '/v1').replace(/\/v1\/?$/, '').replace(/\/+$/, '');

// Рекомендуемые модели. size — примерный объём скачивания, ram — сколько нужно памяти (ОЗУ или видеопамяти).
const SUGGESTED = [
  { id: 'qwen2.5:0.5b', size: '0.4 ГБ', ram: 2, tags: ['tools'], note: 'Крошечная, для слабых ПК и проверки. Глуповата.' },
  { id: 'llama3.2:3b', size: '2 ГБ', ram: 6, tags: ['tools'], note: 'Лёгкая. 8 ГБ ОЗУ, без видеокарты.' },
  { id: 'qwen2.5:7b', size: '4.7 ГБ', ram: 10, tags: ['tools'], note: 'Лучший старт: хорошо говорит по-русски, умеет управлять ПК. 16 ГБ ОЗУ или видеокарта 8 ГБ.' },
  { id: 'llama3.1:8b', size: '4.9 ГБ', ram: 10, tags: ['tools'], note: 'Надёжная универсальная. 16 ГБ ОЗУ или видеокарта 8 ГБ.' },
  { id: 'qwen2.5vl:7b', size: '6 ГБ', ram: 12, tags: ['vision'], note: 'Видит картинки и скриншоты. Видеокарта 8–12 ГБ.' },
  { id: 'gpt-oss:20b', size: '14 ГБ', ram: 16, tags: ['tools', 'thinking'], note: 'Самая умная из списка. Видеокарта 16 ГБ+ или 32 ГБ ОЗУ.' }
];

async function j(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: opts.signal || AbortSignal.timeout(opts.timeout || 4000) });
  if (!res.ok) { let t = ''; try { t = (await res.json()).error || ''; } catch {} throw Object.assign(new Error(t || `HTTP ${res.status}`), { status: res.status }); }
  return res.json();
}

/** Статус Ollama: running, version, models [{name,size,caps,family,params}] */
async function ollamaStatus(base) {
  const root = rootOf(base);
  try {
    const v = await j(`${root}/api/version`);
    const tags = await j(`${root}/api/tags`);
    const models = await Promise.all((tags.models || []).map(async m => {
      let caps = m.capabilities;
      if (!caps) { try { caps = (await j(`${root}/api/show`, { method: 'POST', body: JSON.stringify({ model: m.name }), timeout: 6000 })).capabilities; } catch {} }
      return { name: m.name, size: m.size, family: m.details?.family, params: m.details?.parameter_size, quant: m.details?.quantization_level, caps: caps || [] };
    }));
    return { running: true, version: v.version, models, root };
  } catch (e) { return { running: false, error: e.message, models: [], root }; }
}

async function lmstudioStatus(base = 'http://localhost:1234/v1') {
  try { const r = await j(`${String(base).replace(/\/+$/, '')}/models`); return { running: true, models: (r.data || []).map(m => ({ name: m.id, caps: [] })) }; }
  catch (e) { return { running: false, error: e.message, models: [] }; }
}

/** Скачать модель через POST /api/pull (стрим NDJSON). onProgress({status, completed, total, pct}). */
async function ollamaPull(model, { base, onProgress, signal } = {}) {
  const res = await fetch(`${rootOf(base)}/api/pull`, { method: 'POST', body: JSON.stringify({ model, stream: true }), signal });
  if (!res.ok) { let t = ''; try { t = (await res.json()).error; } catch {} throw new Error(t || `HTTP ${res.status}`); }
  const dec = new TextDecoder(); let buf = '', last = {};
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let p; try { p = JSON.parse(line); } catch { continue; }
      if (p.error) throw new Error(p.error);
      last = { status: p.status, completed: p.completed || 0, total: p.total || 0, pct: p.total ? Math.round((p.completed || 0) / p.total * 100) : null };
      onProgress?.(last);
    }
  }
  if (last.status !== 'success') throw new Error('Скачивание оборвалось: ' + (last.status || 'нет ответа'));
  return true;
}

async function ollamaDelete(model, base) {
  const res = await fetch(`${rootOf(base)}/api/delete`, { method: 'DELETE', body: JSON.stringify({ model }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return true;
}

/** Железо: ОЗУ, ядра, видеокарты (на Windows — через Win32_VideoController). */
function sysInfo() {
  return new Promise(resolve => {
    const base = { ramGB: Math.round(os.totalmem() / 2 ** 30), cpus: os.cpus().length, cpu: os.cpus()[0]?.model?.trim() || '', gpus: [] };
    if (process.platform !== 'win32') return resolve(base);
    // AdapterRAM — 32-битное поле и врёт для карт >4 ГБ; берём qwMemorySize из реестра, если есть.
    const ps = `$ErrorActionPreference='SilentlyContinue'; $r=@(); Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | ForEach-Object { if ($_.DriverDesc) { $r += [pscustomobject]@{ name=$_.DriverDesc; vram=[int64]$_.'HardwareInformation.qwMemorySize' } } }; if (-not $r.Count) { Get-CimInstance Win32_VideoController | ForEach-Object { $r += [pscustomobject]@{ name=$_.Name; vram=[int64]$_.AdapterRAM } } }; $r | ConvertTo-Json -Compress`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000, windowsHide: true }, (err, out) => {
      try { const list = [].concat(JSON.parse(String(out).trim() || '[]')); base.gpus = list.map(g => ({ name: g.name, vramGB: g.vram ? Math.round(g.vram / 2 ** 30 * 10) / 10 : null })); } catch {}
      resolve(base);
    });
  });
}

/** Подобрать модель под железо. */
function recommend(info) {
  const vram = Math.max(0, ...(info.gpus || []).filter(g => !/intel|microsoft basic/i.test(g.name || '')).map(g => g.vramGB || 0));
  const budget = Math.max(vram, (info.ramGB || 8) * 0.6);
  const fits = SUGGESTED.filter(s => s.ram <= budget + 0.5 && s.id !== 'qwen2.5:0.5b');
  const best = vram >= 16 ? 'gpt-oss:20b' : fits.some(s => s.id === 'qwen2.5:7b') ? 'qwen2.5:7b' : fits.length ? fits[fits.length - 1].id : 'qwen2.5:0.5b';
  const text = vram >= 16 ? `Видеокарта на ${vram} ГБ — потянет даже gpt-oss:20b.`
    : vram >= 8 ? `Видеокарта на ${vram} ГБ — 7–8B модели полетят. gpt-oss:20b будет медленно.`
    : (info.ramGB || 0) >= 16 ? `Мощной видеокарты не видно, но ОЗУ ${info.ramGB} ГБ — 7B модели пойдут на процессоре, неспешно.`
    : `ОЗУ ${info.ramGB} ГБ — берите лёгкие модели (3B). Большие будут тормозить.`;
  return { best, vram, text };
}

module.exports = { SUGGESTED, ollamaStatus, lmstudioStatus, ollamaPull, ollamaDelete, sysInfo, recommend, rootOf, OLLAMA };
