// Проверка режима «Компьютер» без Electron: node scripts/smoke-desktop.js
// 1) форма тела запроса (tools только ПК, tool_choice:auto, без browser_search);
// 2) живой запрос в Groq «Открой блокнот и напиши список покупок» — ошибки «Tool choice is none» быть не должно;
// 3) запрос без инструментов, но с историей tool_calls — история чистится.
const path = require('path'), fs = require('fs'), assert = require('assert');
const groq = require('../src/main/groq');
const pc = require('../src/main/pc');
const key = process.env.GROQ_API_KEY; // только из переменной окружения разработчика, в репозитории ключей нет
const SYS = 'Ты — GoatDrey. Режим «Компьютер»: управляешь ПК (Windows) ТОЛЬКО через функции: open_app, type_text, key_press, mouse_click, mouse_move, scroll, screenshot, open_url, close_app. Других инструментов нет. Чтобы запустить Блокнот — open_app name="notepad", потом сразу type_text.';
const names = new Set(pc.TOOLS.map(t => t.function.name));

(async () => {
  // 1. Форма тела
  const body = groq.buildBody({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'x' }], tools: pc.TOOLS });
  assert.equal(body.tool_choice, 'auto');
  assert.ok(body.tools.every(t => t.type === 'function'), 'в режиме Компьютер не должно быть browser_search');
  const noTools = groq.buildBody({ model: 'm', messages: [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'open_app', arguments: '{"name":"notepad"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'Запустил notepad' }] });
  assert.ok(!('tools' in noTools) && !('tool_choice' in noTools));
  assert.ok(noTools.messages.every(m => m.role !== 'tool' && !m.tool_calls), 'без tools история не должна содержать tool_calls');
  console.log('Форма запроса: OK');
  if (!key) { console.log('Нет ключа — живой тест пропущен'); return; }

  // 2. Живой цикл (действия не выполняются, результат подставляется)
  const messages = [{ role: 'system', content: SYS }, { role: 'user', content: 'Открой блокнот и напиши список покупок' }];
  const called = [];
  for (let step = 0; step < 5; step++) {
    const r = await groq.chatWithToolGuard({ key, model: 'openai/gpt-oss-120b', messages, tools: pc.TOOLS, temperature: 0.4 });
    if (!r.toolCalls.length) { console.log('Финальный ответ:', r.content.trim().slice(0, 200)); break; }
    messages.push({ role: 'assistant', content: r.content || '', tool_calls: r.toolCalls });
    for (const tc of r.toolCalls) {
      assert.ok(names.has(tc.function.name), 'неизвестный инструмент ' + tc.function.name);
      called.push(tc.function.name + ' ' + tc.function.arguments);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: tc.function.name === 'open_app' ? 'Запустил notepad, окно активно' : 'Готово' });
    }
  }
  console.log('Вызовы:', called);
  assert.ok(called.some(c => c.startsWith('open_app')), 'ожидался open_app');
  assert.ok(called.some(c => c.startsWith('type_text')), 'ожидался type_text');

  // 3. Обычный чат с той же историей, но без tools — раньше тут была ошибка «Tool choice is none»
  const r3 = await groq.chatWithToolGuard({ key, model: 'openai/gpt-oss-120b', messages: [...messages, { role: 'user', content: 'Коротко: что ты сделал?' }] });
  console.log('Чат без tools после действий:', r3.content.trim().slice(0, 150));
  console.log('OK');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
