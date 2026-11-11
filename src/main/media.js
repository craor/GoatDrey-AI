// Генерация картинок и видео. Картинки: OpenAI-совместимый /images/generations (OpenAI, xAI, Together)
// и MiniMax /image_generation. Видео: MiniMax (асинхронная задача + опрос статуса). Файлы — в userData/media.
const fs = require('fs');
const path = require('path');
const { headers, readError } = require('./ai');
const net = require('./net');

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Media {
  constructor(dir) { this.dir = path.join(dir, 'media'); fs.mkdirSync(this.dir, { recursive: true }); this.index = path.join(this.dir, 'media.json'); }
  list() { try { return JSON.parse(fs.readFileSync(this.index, 'utf8')); } catch { return []; } }
  _save(list) { fs.writeFileSync(this.index, JSON.stringify(list, null, 2)); }
  add(entry, buf, ext) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const file = path.join(this.dir, `${id}.${ext}`);
    fs.writeFileSync(file, buf);
    const e = { id, file, at: new Date().toISOString(), ...entry };
    const list = this.list(); list.unshift(e); this._save(list);
    return e;
  }
  remove(id) { const list = this.list(); const e = list.find(x => x.id === id); if (e) { try { fs.unlinkSync(e.file); } catch {} } this._save(list.filter(x => x.id !== id)); return true; }
  read(id) { const e = this.list().find(x => x.id === id); return e && fs.existsSync(e.file) ? fs.readFileSync(e.file) : null; }
}

async function download(url) {
  const u = new URL(String(url || ''));
  const ok = u.protocol === 'https:' || (u.protocol === 'http:' && net.isLoopback(u.hostname));
  if (!ok) throw new Error('Результат можно скачать только по https (или http на localhost).');
  const res = await fetch(u.toString(), { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Не скачал результат: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Картинки. kind: 'openai' | 'minimax'. Возвращает массив Buffer (png/jpeg). */
async function generateImages({ target, kind, model, prompt, n = 1, size = '1024x1024' }) {
  net.assertKeyDestination({ provider: target.provider, baseUrl: target.base, apiKey: target.key || '' });
  if (kind === 'minimax') {
    const ar = { '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3', '1792x1024': '16:9', '1024x1792': '9:16' }[size] || '1:1';
    const res = await fetch(`${target.base}/image_generation`, { method: 'POST', headers: headers(target), body: JSON.stringify({ model, prompt, aspect_ratio: ar, response_format: 'base64', n }) });
    if (!res.ok) throw await readError(res);
    const j = await res.json();
    if (j.base_resp && j.base_resp.status_code !== 0) throw new Error(j.base_resp.status_msg || 'MiniMax: ошибка генерации');
    const b64 = j.data?.image_base64 || [];
    if (b64.length) return b64.map(b => Buffer.from(b, 'base64'));
    return Promise.all((j.data?.image_urls || []).map(download));
  }
  const body = { model, prompt, n };
  if (target.provider === 'openai') { body.size = size; if (/dall-e/.test(model)) { body.response_format = 'b64_json'; if (/dall-e-3/.test(model)) body.n = 1; } }
  if (target.provider === 'together') { const [w, h] = size.split('x').map(Number); body.width = w; body.height = h; body.response_format = 'base64'; if (/schnell/.test(model)) body.steps = 4; }
  if (target.provider === 'xai') body.response_format = 'b64_json';
  const res = await fetch(`${target.base}/images/generations`, { method: 'POST', headers: headers(target), body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw await readError(res);
  const j = await res.json();
  return Promise.all((j.data || []).map(d => d.b64_json ? Buffer.from(d.b64_json, 'base64') : d.url ? download(d.url) : null).filter(Boolean));
}

/** Видео MiniMax: создать задачу → опрашивать → скачать mp4. onProgress(text). */
async function generateVideoMinimax({ target, model = 'MiniMax-Hailuo-02', prompt, onProgress, pollMs = 10000, timeoutMs = 15 * 60000, signal }) {
  net.assertKeyDestination({ provider: target.provider, baseUrl: target.base, apiKey: target.key || '' });
  const body = { model, prompt, duration: 6 };
  if (/hailuo-02/i.test(model)) body.resolution = '768P';
  const res = await fetch(`${target.base}/video_generation`, { method: 'POST', headers: headers(target), body: JSON.stringify(body) });
  if (!res.ok) throw await readError(res);
  const j = await res.json();
  if (j.base_resp && j.base_resp.status_code !== 0) throw new Error(j.base_resp.status_msg || 'MiniMax не принял задачу');
  const task = j.task_id; if (!task) throw new Error('MiniMax не вернул task_id');
  onProgress?.('Задача принята, снимаю…');
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (signal?.aborted) throw new Error('aborted');
    await sleep(pollMs);
    const q = await fetch(`${target.base}/query/video_generation?task_id=${encodeURIComponent(task)}`, { headers: headers(target, false) });
    if (!q.ok) throw await readError(q);
    const s = await q.json();
    const st = String(s.status || '');
    onProgress?.(({ Preparing: 'Готовлю плёнку', Queueing: 'В очереди', Processing: 'Снимаю' })[st] ? `${({ Preparing: 'Готовлю плёнку', Queueing: 'В очереди', Processing: 'Снимаю' })[st]} · ${Math.round((Date.now() - t0) / 1000)} с` : st);
    if (/fail/i.test(st)) throw new Error('MiniMax: генерация не удалась' + (s.base_resp?.status_msg ? ' — ' + s.base_resp.status_msg : ''));
    if (/success/i.test(st) && s.file_id) {
      const f = await fetch(`${target.base}/files/retrieve?file_id=${encodeURIComponent(s.file_id)}`, { headers: headers(target, false) });
      if (!f.ok) throw await readError(f);
      const url = (await f.json()).file?.download_url;
      if (!url) throw new Error('MiniMax не дал ссылку на файл');
      onProgress?.('Скачиваю видео');
      return download(url);
    }
  }
  throw new Error('Видео не успело за 15 минут — попробуйте позже');
}

const extOf = buf => buf[0] === 0x89 ? 'png' : buf[0] === 0xff ? 'jpg' : buf.slice(0, 4).toString() === 'RIFF' ? 'webp' : 'png';

module.exports = { Media, generateImages, generateVideoMinimax, extOf };
