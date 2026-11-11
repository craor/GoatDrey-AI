// Юнит- и мок-тесты v1.1 без сети: node scripts/smoke-providers.js
// Поднимает локальный фейковый OpenAI-совместимый сервер, фейковый Anthropic, Ollama /api/pull и MiniMax видео.
const http = require('http'), assert = require('assert');
const ai = require('../src/main/ai');
const { detectProvider, PRESETS, ORDER } = require('../src/main/providers');
const ja = require('../src/main/jsonactions');
const anth = require('../src/main/anthropic');
const local = require('../src/main/local');
const { generateImages, generateVideoMinimax } = require('../src/main/media');
const pc = require('../src/main/pc');

const sse = (res, chunks) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n'); res.end('data: [DONE]\n\n'); };
const seen = [];
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const j = body && body[0] === '{' ? JSON.parse(body) : {};
  seen.push({ url: req.url, auth: req.headers.authorization, xkey: req.headers['x-api-key'], body: j });
  const u = req.url;
  if (u === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'm-chat' }, { id: 'm-vision' }] }));
  if (u === '/v1/chat/completions') {
    if (j.model === 'no-tools' && j.tools) { res.writeHead(400); return res.end(JSON.stringify({ error: { message: 'registry.ollama.ai/library/no-tools does not support tools' } })); }
    if (j.tools) return sse(res, [{ model: j.model, choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'open_app', arguments: '{"na' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'me":"notepad"}' } }] }, finish_reason: 'tool_calls' }] }]);
    if (j.model === 'no-tools') return sse(res, [{ choices: [{ delta: { content: 'Открываю.\n```action\n{"action": "open_app", "args": {"name": "notepad"}}\n```' } }] }]);
    return sse(res, [{ model: j.model, choices: [{ delta: { reasoning_content: 'хм' } }] }, { choices: [{ delta: { content: 'При' } }] }, { choices: [{ delta: { content: 'вет' }, finish_reason: 'stop' }] }]);
  }
  if (u === '/v1/images/generations') return res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('\x89PNGfake', 'latin1').toString('base64') }] }));
  if (u === '/v1/image_generation') return res.end(JSON.stringify({ data: { image_base64: [Buffer.from('\xff\xd8jpg', 'latin1').toString('base64')] }, base_resp: { status_code: 0 } }));
  if (u === '/v1/video_generation') return res.end(JSON.stringify({ task_id: 't1', base_resp: { status_code: 0 } }));
  if (u.startsWith('/v1/query/video_generation')) { server.polls = (server.polls || 0) + 1; return res.end(JSON.stringify(server.polls < 2 ? { status: 'Processing' } : { status: 'Success', file_id: 'f1' })); }
  if (u.startsWith('/v1/files/retrieve')) return res.end(JSON.stringify({ file: { download_url: `http://127.0.0.1:${server.address().port}/file.mp4` } }));
  if (u === '/file.mp4') return res.end(Buffer.from('mp4data'));
  if (u === '/anthropic/messages') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
    ev('message_start', { message: { model: j.model } });
    ev('content_block_start', { index: 0, content_block: { type: 'text' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Ок. ' } });
    ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'type_text' } });
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"text":' } });
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"молоко"}' } });
    ev('message_delta', { delta: { stop_reason: 'tool_use' } });
    return res.end();
  }
  if (u === '/api/version') return res.end('{"version":"0.0-mock"}');
  if (u === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b', size: 4.7e9, details: { family: 'qwen2' }, capabilities: ['completion', 'tools'] }] }));
  if (u === '/api/pull') { res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n'); res.write(JSON.stringify({ status: 'pulling abc', total: 100, completed: 50 }) + '\n'); res.write(JSON.stringify({ status: 'pulling abc', total: 100, completed: 100 }) + '\n'); return res.end(JSON.stringify({ status: 'success' }) + '\n'); }
  res.writeHead(404); res.end('{}');
});

(async () => {
  // 1. Определение провайдера по ключу
  const cases = { gsk_abc: 'groq', 'sk-or-v1-x': 'openrouter', 'xai-123': 'xai', AIzaSyX: 'gemini', 'sk-ant-api03': 'anthropic', 'sk-proj-1': 'openai', 'sk-api-x': 'minimax', hello: null };
  for (const [k, v] of Object.entries(cases)) assert.equal(detectProvider(k), v, k);
  assert.ok(ORDER.every(id => PRESETS[id]), 'все пресеты из ORDER существуют');
  assert.equal(PRESETS.gemini.base, 'https://generativelanguage.googleapis.com/v1beta/openai');
  console.log('detectProvider + пресеты: OK');

  // 2. JSON-протокол
  const names = new Set(pc.TOOLS.map(t => t.function.name));
  assert.equal(ja.parseActions('```action\n{"action":"open_app","args":{"name":"calc"}}\n```', names)[0].function.name, 'open_app');
  assert.equal(JSON.parse(ja.parseActions('сделаю {"action": "type_text", "args": {"text": "hi"}} вот', names)[0].function.arguments).text, 'hi');
  assert.equal(ja.parseActions('<tool_call>{"name":"key_press","arguments":{"keys":"enter"}}</tool_call>', names)[0].function.name, 'key_press');
  assert.equal(ja.parseActions('```json\n{"action":"rm_rf","args":{}}\n```', names).length, 0, 'неизвестные действия игнорируются');
  assert.equal(ja.stripActions('Готово.\n```action\n{"action":"x"}\n```'), 'Готово.');
  assert.ok(ja.protocolPrompt(pc.TOOLS).includes('open_app('));
  console.log('JSON-действия: OK');

  // 3. Конвертация в Anthropic
  const conv = anth.convert([{ role: 'system', content: 'S' }, { role: 'user', content: [{ type: 'text', text: 'что тут' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'screenshot', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'ok' }]);
  assert.equal(conv.system, 'S'); assert.equal(conv.messages[0].content[1].type, 'image'); assert.equal(conv.messages[1].content[0].type, 'tool_use'); assert.equal(conv.messages[2].content[0].type, 'tool_result');
  console.log('Anthropic convert: OK');

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const T = (provider, key = 'k') => ({ provider: (provider === 'ollama' || provider === 'lmstudio' || provider === 'custom') ? provider : 'custom', base, key });

  // 4. Список моделей, стрим, reasoning_content, tools
  assert.deepEqual(await ai.listModels(T('openai')), ['m-chat', 'm-vision']);
  let deltas = 0; const r1 = await ai.chatStream({ target: T('deepseek'), model: 'm-chat', messages: [{ role: 'user', content: 'hi' }], onDelta: () => deltas++ });
  assert.equal(r1.content, 'Привет'); assert.equal(r1.reasoning, 'хм'); assert.equal(deltas, 3);
  assert.equal(seen.at(-1).auth, 'Bearer k');
  const r2 = await ai.chatStream({ target: T('openai'), model: 'm-chat', messages: [{ role: 'user', content: 'x' }], tools: pc.TOOLS });
  assert.equal(r2.toolCalls[0].function.arguments, '{"name":"notepad"}');
  assert.equal(seen.at(-1).body.tool_choice, 'auto');
  // Без ключа (Ollama) — нет Authorization
  await ai.chatStream({ target: T('ollama', ''), model: 'm-chat', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(seen.at(-1).auth, undefined);
  console.log('OpenAI-совместимый клиент: OK');

  // 5. Модель без tools: ошибка распознаётся, JSON-фолбэк даёт действие
  let err; try { await ai.chatStream({ target: T('ollama', ''), model: 'no-tools', messages: [{ role: 'user', content: 'x' }], tools: pc.TOOLS }); } catch (e) { err = e; }
  assert.ok(err && ai.TOOLS_UNSUPPORTED.test(err.message), 'ошибка «does not support tools» распознана');
  const r3 = await ai.chatStream({ target: T('ollama', ''), model: 'no-tools', messages: [{ role: 'system', content: ja.protocolPrompt(pc.TOOLS) }, { role: 'user', content: 'открой блокнот' }] });
  const tc = ja.parseActions(r3.content, names); assert.equal(tc[0].function.name, 'open_app');
  console.log('Фолбэк на JSON-действия: OK');

  // 6. Anthropic стрим с tool_use
  const ra = await anth.chatStream({ target: { provider: 'custom', base: base.replace('/v1', '/anthropic'), key: 'sk-ant-x' }, model: 'claude-x', messages: [{ role: 'user', content: 'напиши' }], tools: pc.TOOLS });
  assert.equal(ra.content, 'Ок. '); assert.equal(ra.toolCalls[0].function.name, 'type_text'); assert.equal(JSON.parse(ra.toolCalls[0].function.arguments).text, 'молоко');
  assert.equal(seen.at(-1).xkey, 'sk-ant-x'); assert.ok(seen.at(-1).body.tools[0].input_schema);
  console.log('Anthropic стрим + tool_use: OK');

  // 7. Картинки и видео
  const imgs = await generateImages({ target: T('openai'), kind: 'openai', model: 'gpt-image-1', prompt: 'козёл', n: 1 });
  assert.equal(imgs[0][0], 0x89);
  const mm = await generateImages({ target: T('minimax'), kind: 'minimax', model: 'image-01', prompt: 'козёл' });
  assert.equal(mm[0][0], 0xff);
  const prog = []; const vid = await generateVideoMinimax({ target: T('minimax'), prompt: 'туман', pollMs: 10, onProgress: t => prog.push(t) });
  assert.equal(vid.toString(), 'mp4data'); assert.ok(prog.length >= 2);
  console.log('Картинки (OpenAI, MiniMax) и видео MiniMax: OK');

  // 8. Ollama: статус и скачивание с прогрессом
  const root = base.replace('/v1', '');
  const st = await local.ollamaStatus(root + '/v1');
  assert.ok(st.running); assert.equal(st.models[0].name, 'qwen2.5:7b'); assert.ok(st.models[0].caps.includes('tools'));
  const pp = []; await local.ollamaPull('qwen2.5:7b', { base: root + '/v1', onProgress: p => pp.push(p.pct) });
  assert.ok(pp.includes(50) && pp.includes(100));
  const down = await local.ollamaStatus('http://127.0.0.1:1/v1'); assert.equal(down.running, false);
  const rec = local.recommend({ ramGB: 16, gpus: [{ name: 'NVIDIA GeForce RTX 4060', vramGB: 8 }] }); assert.equal(rec.best, 'qwen2.5:7b');
  assert.equal(local.recommend({ ramGB: 32, gpus: [{ name: 'RTX 4090', vramGB: 24 }] }).best, 'gpt-oss:20b');
  console.log('Ollama статус, /api/pull с прогрессом, подбор под железо: OK');

  server.close();
  console.log('OK');
})().catch(e => { console.error('FAIL:', e.stack || e.message); server.close(); process.exit(1); });
