// Живой тест локальной модели через Ollama: node scripts/smoke-ollama.js [модель]
// Нужна запущенная Ollama (http://localhost:11434) и скачанная модель (по умолчанию qwen2.5:0.5b).
const assert = require('assert');
const ai = require('../src/main/ai');
const local = require('../src/main/local');
const ja = require('../src/main/jsonactions');
const pc = require('../src/main/pc');
const model = process.argv[2] || 'qwen2.5:0.5b';
const target = { provider: 'ollama', base: 'http://localhost:11434/v1', key: '' };
const names = new Set(pc.TOOLS.map(t => t.function.name));
(async () => {
  const st = await local.ollamaStatus();
  if (!st.running) { console.log('Ollama не запущена — тест пропущен'); return; }
  console.log(`Ollama v${st.version}, модели: ${st.models.map(m => `${m.name} [${m.caps.join(',')}]`).join('; ')}`);
  assert.ok(st.models.some(m => m.name === model), 'нет модели ' + model);
  const list = await ai.listModels(target); console.log('/v1/models:', list.join(', '));
  let n = 0;
  const r = await ai.chatStream({ target, model, messages: [{ role: 'user', content: 'Столица Франции? Ответь одним словом.' }], temperature: 0, onDelta: () => n++ });
  console.log(`Чат: ${n} кусочков, «${r.content.trim()}»`); assert.ok(r.content.trim());
  // Нативные tools
  const rt = await ai.chatStream({ target, model, temperature: 0, tools: pc.TOOLS, messages: [{ role: 'system', content: 'Ты управляешь ПК через функции. Чтобы открыть программу — вызови open_app.' }, { role: 'user', content: 'Открой блокнот (notepad).' }] });
  console.log('Нативные tools:', rt.toolCalls.map(t => t.function.name + ' ' + t.function.arguments).join('; ') || '(нет вызовов) ' + rt.content.slice(0, 120));
  // JSON-протокол (для моделей без tools)
  let ok = false;
  for (let i = 0; i < 3 && !ok; i++) {
    const rj = await ai.chatStream({ target, model, temperature: 0, messages: ja.withProtocol([{ role: 'system', content: 'Ты помощник, управляешь компьютером.' }, { role: 'user', content: 'Открой блокнот.' }], pc.TOOLS) });
    const tc = ja.parseActions(rj.content, names);
    console.log(`JSON-протокол, попытка ${i + 1}:`, tc.map(t => t.function.name + ' ' + t.function.arguments).join('; ') || rj.content.slice(0, 160));
    ok = tc.length > 0;
  }
  assert.ok(ok, 'модель не выдала действие JSON-блоком');
  console.log('OK');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
