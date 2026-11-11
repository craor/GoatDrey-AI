// Универсальный клиент ИИ: любой OpenAI-совместимый API (Groq, OpenAI, xAI, Gemini, OpenRouter, DeepSeek,
// Mistral, MiniMax, Together, Ollama, LM Studio, свой адрес) + адаптер Anthropic.
// Работает в main-процессе: без CORS, ключ не уходит в DOM.
const { preset, baseOf } = require('./providers');
const anthropic = require('./anthropic');
const net = require('./net');
const { redact } = require('./redact');

function headers(target, json = true) {
  const h = {};
  if (target.key) h.Authorization = `Bearer ${target.key}`;
  if (json) h['Content-Type'] = 'application/json';
  if (/openrouter\.ai/.test(target.base || '')) { h['HTTP-Referer'] = 'https://goatdrey.ai'; h['X-Title'] = 'GoatDrey AI'; }
  return h;
}

async function readError(res) {
  let msg = `HTTP ${res.status}`;
  try {
    const t = await res.text();
    try { const j = JSON.parse(t); msg = j.error?.message || j.error || j.message || j.base_resp?.status_msg || msg; if (typeof msg !== 'string') msg = JSON.stringify(msg); msg = redact(String(msg)); }
    catch { if (t) msg += ': ' + redact(t).slice(0, 200); }
  } catch {}
  const e = new Error(msg); e.status = res.status; return e;
}

/** target = { provider, base, key } — собирается из профиля. */
function targetOf(profile) { return { provider: profile.provider, base: baseOf(profile), key: profile.apiKey || '' }; }

function assertTarget(target) {
  net.assertKeyDestination({ provider: target.provider, baseUrl: target.base, apiKey: target.key || '' });
}


async function listModels(target) {
  assertTarget(target);
  if (preset(target.provider).adapter === 'anthropic') return anthropic.listModels(target);
  const res = await fetch(`${target.base}/models`, { headers: headers(target, false), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw await readError(res);
  const j = await res.json();
  return (j.data || j.models || []).map(m => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean).sort();
}

/**
 * Стриминговый чат. onDelta({content, reasoning, status}) на каждый кусок.
 * Возвращает {content, reasoning, toolCalls, finishReason, model, sources}.
 */
async function chatStream(opts) {
  const { target, model, messages, tools, temperature = 0.6, signal, onDelta } = opts;
  assertTarget(target);
  if (preset(target.provider).adapter === 'anthropic') return anthropic.chatStream(opts);
  const body = buildBody({ model, messages, tools, temperature, provider: target.provider });
  const res = await fetch(`${target.base}/chat/completions`, { method: 'POST', headers: headers(target), body: JSON.stringify(body), signal });
  if (!res.ok) throw await readError(res);

  const decoder = new TextDecoder();
  let buf = '', content = '', reasoning = '', finishReason = null, usedModel = model;
  const toolCalls = [];
  const sources = new Map();
  const handle = line => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let j; try { j = JSON.parse(data); } catch { return; }
    if (j.error) throw Object.assign(new Error(j.error.message || String(j.error) || 'stream error'), { status: j.error.code });
    usedModel = j.model || usedModel;
    const ch = j.choices?.[0]; if (!ch) return;
    const d = ch.delta || ch.message || {};
    if (d.executed_tools) for (const t of d.executed_tools) collectSources(t, sources, onDelta);
    if (d.content) { content += d.content; onDelta?.({ content: d.content }); }
    const r = d.reasoning || d.reasoning_content;
    if (r) { reasoning += r; onDelta?.({ reasoning: r }); }
    if (d.tool_calls) for (const tc of d.tool_calls) {
      const i = tc.index ?? toolCalls.length;
      toolCalls[i] = toolCalls[i] || { id: tc.id || 'call_' + Math.random().toString(36).slice(2, 10), type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) toolCalls[i].id = tc.id;
      if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
      if (tc.function?.arguments) toolCalls[i].function.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
    }
    if (ch.finish_reason) finishReason = ch.finish_reason;
  };
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1); handle(line); }
  }
  if (buf.trim()) handle(buf.trim());
  // Некоторые локальные модели (qwen3, deepseek-r1) пишут размышления в <think>…</think> прямо в content.
  const think = content.match(/^\s*<think>([\s\S]*?)<\/think>\s*/);
  if (think) { reasoning += think[1]; content = content.slice(think[0].length); }
  return { content: cleanCites(content), reasoning, toolCalls: toolCalls.filter(Boolean), finishReason, model: usedModel, sources: [...sources.values()].slice(0, 8) };
}

/**
 * Тело запроса. Правила (из опыта с Groq «Tool choice is none, but model called a tool»):
 *  - если есть tools — всегда tool_choice: 'auto';
 *  - если tools нет — в истории не должно быть tool_calls / role:'tool' (превращаем их в обычный текст).
 */
function buildBody({ model, messages, tools, temperature = 0.6, stream = true, provider }) {
  const hasTools = !!(tools && tools.length);
  const fnNames = new Set(hasTools ? tools.filter(t => t.type === 'function').map(t => t.function.name) : []);
  const body = { model, messages: sanitizeMessages(messages, hasTools ? fnNames : null), stream };
  if (temperature != null && !/^(o\d|gpt-5)/.test(model || '')) body.temperature = temperature;
  if (hasTools) { body.tools = tools; body.tool_choice = 'auto'; }
  if (provider === 'mistral' || provider === 'gemini') body.messages = body.messages.map(m => m.role === 'system' ? m : m); // совместимы как есть
  return body;
}

/** Убирает из истории вызовы инструментов, которые не объявлены в текущем запросе. */
function sanitizeMessages(messages, fnNames) {
  const out = [];
  const keptIds = new Set();
  for (const m of messages || []) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const keep = fnNames ? m.tool_calls.filter(tc => fnNames.has(tc.function?.name)) : [];
      keep.forEach(tc => keptIds.add(tc.id));
      const dropped = m.tool_calls.filter(tc => !keep.includes(tc));
      let content = m.content || '';
      if (dropped.length) content += (content ? '\n' : '') + dropped.map(tc => `[Выполнено действие ${tc.function?.name} ${tc.function?.arguments || ''}]`).join('\n');
      const msg = { role: 'assistant', content };
      if (keep.length) msg.tool_calls = keep;
      if (msg.content || msg.tool_calls) out.push(msg);
    } else if (m.role === 'tool') {
      if (keptIds.has(m.tool_call_id)) out.push(m);
      else out.push({ role: 'user', content: `[Результат действия]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}` });
    } else out.push(m);
  }
  return out;
}

const TOOL_MISMATCH = /tool choice is none|called a tool|tool call validation failed|not in request\.tools|attempted to call tool|failed to call a function/i;
const TOOLS_UNSUPPORTED = /does not support (tools|tool|function)|tool use is not supported|tools? (are|is) not supported|function calling is not (enabled|supported)|"tools" is not|unknown (field|parameter).{0,20}tools|no endpoints found that support tool/i;

/** chatStream с одной повторной попыткой, если модель вызвала неизвестный инструмент. */
async function chatWithToolGuard(opts) {
  try { return await chatStream(opts); }
  catch (err) {
    if (!TOOL_MISMATCH.test(err.message || '') || opts.signal?.aborted) throw err;
    const fns = (opts.tools || []).filter(t => t.type === 'function').map(t => t.function.name);
    const hint = fns.length
      ? `ВАЖНО: можно вызывать ТОЛЬКО эти функции: ${fns.join(', ')}. Других инструментов (поиск, браузер, python) нет.`
      : (opts.tools || []).length ? 'ВАЖНО: из инструментов доступен только встроенный веб-поиск. Других функций нет.'
      : 'ВАЖНО: инструментов в этом разговоре нет. Не вызывай никакие функции, отвечай обычным текстом.';
    try { return await chatStream({ ...opts, messages: [...opts.messages, { role: 'system', content: hint }] }); }
    catch (err2) { if (TOOL_MISMATCH.test(err2.message || '')) err2.toolMismatch = true; throw err2; }
  }
}

// Встроенный веб-поиск Groq (browser_search у gpt-oss): источники из executed_tools.
function collectSources(t, map, onDelta) {
  if (t.type === 'function' && !t.output) { try { const a = JSON.parse(t.arguments || '{}'); if (a.query) onDelta?.({ status: `Ищу: ${a.query}` }); } catch {} return; }
  for (const r of t.search_results?.results || []) if (r.url && !/exa\.ai\/search/.test(r.url)) map.set(r.url, { title: (r.title || r.url).replace(/ - viewing lines.*$/, ''), url: r.url, snippet: '' });
  const out = t.output || '';
  for (const m of out.matchAll(/【\d+†([^†】]+)†([^】\s]+)】/g)) {
    const url = /^https?:/.test(m[2]) ? m[2] : 'https://' + m[2];
    if (![...map.values()].some(v => v.url.includes(m[2]))) map.set(url, { title: m[1].replace(/\\\|/g, '|').replace(/\s+/g, ' ').trim(), url, snippet: '' });
  }
}
const cleanCites = s => (s || '').replace(/【[^】]*】/g, '');

async function chatOnce({ target, model, messages, temperature = 0.3, max_tokens = 400 }) {
  assertTarget(target);
  if (preset(target.provider).adapter === 'anthropic') return anthropic.chatOnce({ target, model, messages, temperature, max_tokens });
  const body = { model, messages, max_tokens };
  if (!/^(o\d|gpt-5)/.test(model || '')) body.temperature = temperature;
  const res = await fetch(`${target.base}/chat/completions`, { method: 'POST', headers: headers(target), body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw await readError(res);
  const j = await res.json();
  return (j.choices?.[0]?.message?.content || '').replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '');
}

// Голосовой ввод: Whisper (Groq whisper-large-v3-turbo или OpenAI whisper-1). audio — Buffer.
async function transcribe({ target, model, audio, mime = 'audio/webm', language = 'ru' }) {
  assertTarget(target);
  const fd = new FormData();
  fd.append('file', new Blob([audio], { type: mime }), 'voice.webm');
  fd.append('model', model);
  if (language) fd.append('language', language);
  fd.append('response_format', 'json');
  const res = await fetch(`${target.base}/audio/transcriptions`, { method: 'POST', headers: headers(target, false), body: fd });
  if (!res.ok) throw await readError(res);
  const j = await res.json();
  return j.text || '';
}

module.exports = { headers, readError, targetOf, cleanCites, listModels, chatStream, chatWithToolGuard, buildBody, sanitizeMessages, TOOL_MISMATCH, TOOLS_UNSUPPORTED, chatOnce, transcribe };
