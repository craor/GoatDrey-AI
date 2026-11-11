// Управление ПК. Windows — через PowerShell (user32 + SendKeys), без нативных модулей.
// Linux — через xdotool, если он есть; иначе режим симуляции (действие только пишется в журнал).
const { execFile } = require('child_process');
const os = require('os');

const IS_WIN = process.platform === 'win32';
const RISKY_KEYS = /(alt\+f4|ctrl\+w|ctrl\+q|delete|del|shift\+delete|ctrl\+shift\+esc|win\+l|win\+r|ctrl\+alt)/i;
const PASSWORDISH = /(парол|password|passwd|pin|cvv|\bкод\b|token|секрет|secret)/i;

// Описание инструментов для модели (OpenAI tools / Groq function calling).
const TOOLS = [
  fn('mouse_move', 'Переместить курсор в точку экрана (пиксели).', { x: 'integer', y: 'integer' }, ['x', 'y']),
  fn('mouse_click', 'Клик мышью. Если x/y заданы — сначала переместить.', { x: 'integer', y: 'integer', button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: 'boolean' }, []),
  fn('type_text', 'Напечатать текст в активное окно.', { text: 'string' }, ['text']),
  fn('key_press', 'Нажать клавишу или сочетание, например "enter", "ctrl+c", "alt+tab".', { keys: 'string' }, ['keys']),
  fn('scroll', 'Прокрутить колесо мыши. Положительное — вверх.', { amount: 'integer' }, ['amount']),
  fn('screenshot', 'Сделать снимок экрана и показать пользователю. Возвращает размер экрана.', {}, []),
  fn('open_url', 'Открыть ссылку в браузере по умолчанию.', { url: 'string' }, ['url']),
  fn('open_app', 'Запустить программу по имени (notepad, calc, explorer, chrome...).', { name: 'string' }, ['name']),
  fn('close_app', 'Закрыть программу по имени процесса. Опасное действие.', { name: 'string' }, ['name'])
];
function fn(name, description, props, required) {
  const properties = {};
  for (const [k, v] of Object.entries(props)) properties[k] = typeof v === 'string' ? { type: v } : v;
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

/** Классификация риска: 'safe' | 'risky'. Опасное — всегда с подтверждением. */
function classify(action, args = {}) {
  switch (action) {
    case 'close_app': return { level: 'risky', reason: 'Закроет программу — несохранённое может пропасть.' };
    case 'open_app': return { level: 'risky', reason: 'Запустит программу на компьютере.' };
    case 'key_press': return RISKY_KEYS.test(args.keys || '') ? { level: 'risky', reason: `Сочетание «${args.keys}» может закрыть окно или удалить данные.` } : { level: 'safe' };
    case 'type_text': {
      const t = args.text || '';
      if (PASSWORDISH.test(t) || t.length > 400) return { level: 'risky', reason: 'Похоже на пароль/секрет или очень длинный ввод.' };
      return { level: 'safe' };
    }
    case 'open_url': return /^https?:\/\//i.test(args.url || '') ? { level: 'safe' } : { level: 'risky', reason: 'Ссылка не http(s).' };
    default: return { level: 'safe' };
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).toString().trim()));
      resolve(stdout.toString());
    });
  });
}

function ps(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

const WIN_PRELUDE = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class GD {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
}
"@
`;
const MOUSE = { left: [0x02, 0x04], right: [0x08, 0x10], middle: [0x20, 0x40] };

// SendKeys: экранирование спецсимволов + разбор сочетаний.
function sendKeysEscape(text) { return text.replace(/[+^%~(){}[\]]/g, c => `{${c}}`).replace(/\n/g, '{ENTER}'); }
const NAMED = { enter: 'ENTER', return: 'ENTER', esc: 'ESC', escape: 'ESC', tab: 'TAB', backspace: 'BACKSPACE', delete: 'DELETE', del: 'DELETE', up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', home: 'HOME', end: 'END', pageup: 'PGUP', pagedown: 'PGDN', space: ' ', insert: 'INSERT' };
function toSendKeys(combo) {
  const parts = combo.toLowerCase().split('+').map(s => s.trim()).filter(Boolean);
  let mods = '', key = parts.pop() || '';
  for (const p of parts) mods += p === 'ctrl' || p === 'control' ? '^' : p === 'alt' ? '%' : p === 'shift' ? '+' : '';
  if (/^f\d{1,2}$/.test(key)) key = `{${key.toUpperCase()}}`;
  else if (NAMED[key]) key = NAMED[key] === ' ' ? ' ' : `{${NAMED[key]}}`;
  else key = sendKeysEscape(key);
  return mods + key;
}
const psStr = s => "'" + String(s).replace(/'/g, "''") + "'";
const safeName = s => String(s || '').replace(/[^\w.\- ]/g, '').slice(0, 64);

async function hasXdotool() { try { await run('which', ['xdotool']); return !!process.env.DISPLAY; } catch { return false; } }

/** Выполнить действие. screenshotFn — из main (desktopCapturer). */
async function execute(action, args = {}, { screenshotFn } = {}) {
  if (action === 'screenshot') return screenshotFn();
  if (action === 'open_url') {
    const { shell } = require('electron');
    await shell.openExternal(args.url); return { ok: true, text: `Открыл ${args.url}` };
  }
  if (IS_WIN) return executeWindows(action, args);
  if (await hasXdotool()) return executeXdotool(action, args);
  return { ok: true, simulated: true, text: `Симуляция (${os.platform()}): ${action} ${JSON.stringify(args)}. На Windows выполнится по-настоящему.` };
}

async function executeWindows(action, a) {
  switch (action) {
    case 'mouse_move': await ps(`${WIN_PRELUDE}[GD]::SetCursorPos(${a.x | 0}, ${a.y | 0})`); return { ok: true, text: `Курсор → ${a.x}, ${a.y}` };
    case 'mouse_click': {
      const [d, u] = MOUSE[a.button || 'left'] || MOUSE.left;
      const move = Number.isFinite(a.x) && Number.isFinite(a.y) ? `[GD]::SetCursorPos(${a.x | 0}, ${a.y | 0}); Start-Sleep -Milliseconds 40;` : '';
      const click = `[GD]::mouse_event(${d},0,0,0,[UIntPtr]::Zero); [GD]::mouse_event(${u},0,0,0,[UIntPtr]::Zero);`;
      await ps(`${WIN_PRELUDE}${move}${click}${a.double ? 'Start-Sleep -Milliseconds 60;' + click : ''}`);
      return { ok: true, text: `Клик (${a.button || 'left'}${a.double ? ', двойной' : ''})` };
    }
    case 'scroll': await ps(`${WIN_PRELUDE}[GD]::mouse_event(0x0800,0,0,${(a.amount | 0) * 120},[UIntPtr]::Zero)`); return { ok: true, text: `Прокрутка ${a.amount}` };
    case 'type_text': await ps(`${WIN_PRELUDE}[System.Windows.Forms.SendKeys]::SendWait(${psStr(sendKeysEscape(a.text || ''))})`); return { ok: true, text: `Напечатал ${(a.text || '').length} симв.` };
    case 'key_press': await ps(`${WIN_PRELUDE}[System.Windows.Forms.SendKeys]::SendWait(${psStr(toSendKeys(a.keys || ''))})`); return { ok: true, text: `Нажал ${a.keys}` };
    case 'open_app': await ps(`Start-Process ${psStr(safeName(a.name))}; Start-Sleep -Milliseconds 1200`); return { ok: true, text: `Запустил ${a.name}` };
    case 'close_app': { const n = safeName(a.name).replace(/\.exe$/i, ''); await ps(`Get-Process -Name ${psStr(n)} -ErrorAction Stop | ForEach-Object { $_.CloseMainWindow() | Out-Null }`); return { ok: true, text: `Попросил ${n} закрыться` }; }
    default: throw new Error('Неизвестное действие: ' + action);
  }
}

async function executeXdotool(action, a) {
  const x = (...args) => run('xdotool', args.map(String));
  switch (action) {
    case 'mouse_move': await x('mousemove', a.x | 0, a.y | 0); return { ok: true, text: `Курсор → ${a.x}, ${a.y}` };
    case 'mouse_click': {
      if (Number.isFinite(a.x)) await x('mousemove', a.x | 0, a.y | 0);
      const b = { left: 1, middle: 2, right: 3 }[a.button || 'left'] || 1;
      await x('click', '--repeat', a.double ? 2 : 1, b); return { ok: true, text: 'Клик' };
    }
    case 'scroll': await x('click', '--repeat', Math.abs(a.amount | 0) || 1, (a.amount | 0) > 0 ? 4 : 5); return { ok: true, text: `Прокрутка ${a.amount}` };
    case 'type_text': await x('type', '--delay', 8, a.text || ''); return { ok: true, text: `Напечатал ${(a.text || '').length} симв.` };
    case 'key_press': await x('key', (a.keys || '').replace(/\benter\b/i, 'Return').replace(/\besc\b/i, 'Escape')); return { ok: true, text: `Нажал ${a.keys}` };
    case 'open_app': case 'close_app':
      return { ok: true, simulated: true, text: `Симуляция на Linux: ${action} ${a.name}` };
    default: throw new Error('Неизвестное действие: ' + action);
  }
}

module.exports = { TOOLS, classify, execute, toSendKeys, sendKeysEscape, IS_WIN };
