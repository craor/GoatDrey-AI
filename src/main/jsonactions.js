// Запасной протокол для моделей без function calling (многие локальные): модель пишет действие JSON-блоком,
// мы разбираем текст и превращаем его в обычные tool_calls — дальше всё как с «настоящими» инструментами.
function protocolPrompt(tools) {
  const list = tools.filter(t => t.type === 'function').map(t => {
    const p = t.function.parameters?.properties || {};
    const args = Object.entries(p).map(([k, v]) => `${k}: ${v.enum ? v.enum.join('|') : v.type}`).join(', ');
    return `- ${t.function.name}(${args}) — ${t.function.description}`;
  }).join('\n');
  return `У тебя нет встроенных функций, поэтому действия на компьютере ты выполняешь так: пишешь ОДИН блок

\`\`\`action
{"action": "имя_действия", "args": { ... }}
\`\`\`

и заканчиваешь сообщение. Я выполню действие и пришлю его результат. Потом делай следующий шаг тем же способом. Когда задача выполнена — ответь обычным текстом без блока action.
Доступные действия:
${list}
Пример: чтобы открыть Блокнот — \`\`\`action
{"action": "open_app", "args": {"name": "notepad"}}
\`\`\``;
}

/** Достаёт действия из текста. Понимает ```action / ```json блоки, <action>…</action> и «голый» JSON с полем action. */
function parseActions(text, names) {
  const found = [];
  const tryPush = raw => {
    let o; try { o = JSON.parse(raw.trim()); } catch { try { o = JSON.parse(raw.trim().replace(/'/g, '"').replace(/,\s*}/g, '}')); } catch { return; } }
    for (const it of [].concat(o)) {
      const name = it.action || it.name || it.tool || it.function?.name;
      let args = it.args || it.arguments || it.parameters || it.function?.arguments || {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      if (name && (!names || names.has(name))) found.push({ id: 'json_' + Math.random().toString(36).slice(2, 10), type: 'function', function: { name, arguments: JSON.stringify(args) } });
    }
  };
  const s = String(text || '');
  for (const m of s.matchAll(/```(?:action|json|tool)?\s*([\[{][\s\S]*?[\]}])\s*```/g)) tryPush(m[1]);
  if (!found.length) for (const m of s.matchAll(/<(?:action|tool_call)>\s*([\s\S]*?)\s*<\/(?:action|tool_call)>/g)) tryPush(m[1]);
  if (!found.length) for (const m of s.matchAll(/\{[^{}]*"(?:action|name)"\s*:\s*"[^"]+"[^{}]*(?:\{[^{}]*\}[^{}]*)?\}/g)) tryPush(m[0]);
  return found.slice(0, 1); // по одному шагу — так надёжнее для маленьких моделей
}

/** Убрать блоки действий из видимого текста. */
const stripActions = s => String(s || '').replace(/```(?:action|json|tool)?\s*[\[{][\s\S]*?[\]}]\s*```/g, '').replace(/<(?:action|tool_call)>[\s\S]*?<\/(?:action|tool_call)>/g, '').trim();

// Пример диалога: маленьким моделям так гораздо проще понять формат.
function fewShot() {
  return [
    { role: 'user', content: 'Открой калькулятор.' },
    { role: 'assistant', content: 'Запускаю калькулятор.\n```action\n{"action": "open_app", "args": {"name": "calc"}}\n```' },
    { role: 'user', content: '[Результат действия]: Запустил calc' },
    { role: 'assistant', content: 'Готово, калькулятор открыт.' }
  ];
}

/** Вставить протокол и пример после системных сообщений. */
function withProtocol(messages, tools) {
  const msgs = [...messages];
  let i = msgs.findIndex(m => m.role !== 'system'); if (i < 0) i = msgs.length;
  msgs.splice(i, 0, { role: 'system', content: protocolPrompt(tools) }, ...fewShot());
  return msgs;
}

module.exports = { protocolPrompt, parseActions, stripActions, fewShot, withProtocol };
