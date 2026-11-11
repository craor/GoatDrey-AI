// Проверка Groq без Electron: node scripts/smoke-groq.js
// Ключ — только из переменной окружения GROQ_API_KEY. В вывод ключ не печатается.
const path = require('path'), fs = require('fs');
const groq = require('../src/main/groq');
const key = process.env.GROQ_API_KEY; // только из переменной окружения разработчика, в репозитории ключей нет
if (!key) { console.error('Пропуск: задайте GROQ_API_KEY'); process.exit(0); }
(async () => {
  const masked = key.slice(0, 4) + '…' + key.slice(-4);
  const models = await groq.listModels(key);
  console.log(`Ключ ${masked}: доступно моделей ${models.length}`);
  let streamed = 0;
  const r = await groq.chatStream({ key, model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'Ответь одним словом: столица Франции?' }], onDelta: d => { if (d.content) streamed++; } });
  console.log(`Стрим: ${streamed} кусочков, модель ${r.model}, ответ: «${r.content.trim()}»`);
  if (!r.content.trim()) throw new Error('пустой ответ');
  console.log('OK');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
