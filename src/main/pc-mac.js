// Управление Mac без установки чего-либо:
//  • мышь — JXA (osascript -l JavaScript) + CoreGraphics через ObjC-мост;
//  • клавиатура и приложения — AppleScript (System Events), `open -a`;
//  • снимок экрана делает main через desktopCapturer.
// Нужны разрешения: «Универсальный доступ» (мышь/клавиатура) и «Запись экрана» (скриншоты),
// при первом действии macOS ещё спросит «GoatDrey AI хочет управлять System Events» — нажмите «Разрешить».
const { execFile } = require('child_process');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(humanize((stderr || err.message).toString().trim()));
      resolve(stdout.toString());
    });
  });
}

/** Понятные сообщения вместо кодов ошибок AppleScript. */
function humanize(msg) {
  let text = msg;
  if (/-1719|1002|assistive|not allowed to send keystrokes|не разрешено/i.test(msg)) text = 'macOS не дала доступ к клавиатуре и мыши. Откройте Системные настройки → Конфиденциальность и безопасность → Универсальный доступ и включите GoatDrey AI (если он там уже включён — выключите и включите снова).';
  else if (/-1743|Not authorized to send Apple events/i.test(msg)) text = 'macOS не разрешила управлять другими программами. Системные настройки → Конфиденциальность и безопасность → Автоматизация → GoatDrey AI → включите System Events.';
  else if (/Unable to find application|can.t find application|LSOpenURLsWithRole|-10814|-600/i.test(msg)) text = 'Не нашёл такое приложение на этом Mac.';
  const e = new Error(text); e.raw = msg; return e;
}

const osa = script => run('osascript', ['-e', script]);
const jxa = (script, args = []) => run('osascript', ['-l', 'JavaScript', '-e', script, ...args.map(String)]);
const asStr = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Мышь: CGEventCreateMouseEvent / CGEventPost. Типы событий и кнопки — числами, чтобы не зависеть от BridgeSupport.
const MOUSE_JXA = `
ObjC.import('Cocoa');
function pt(x, y) { try { return $.CGPointMake(x, y); } catch (e) { return { x: x, y: y }; } }
function post(type, p, btn, clicks) {
  var e = $.CGEventCreateMouseEvent(null, type, p, btn);
  if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks); // kCGMouseEventClickState
  $.CGEventPost(0, e); // kCGHIDEventTap
  delay(0.02);
}
function run(argv) {
  var op = argv[0], x = parseFloat(argv[1]), y = parseFloat(argv[2]), button = argv[3] || 'left', dbl = argv[4] === '1';
  var cur = $.CGEventGetLocation($.CGEventCreate(null));
  var p = isNaN(x) || isNaN(y) ? cur : pt(x, y);
  if (op === 'move') { post(5, p, 0); return 'ok'; }
  if (op === 'click') {
    var codes = { left: [1, 2, 0], right: [3, 4, 1], middle: [25, 26, 2] }[button] || [1, 2, 0];
    if (!(isNaN(x) || isNaN(y))) { post(5, p, 0); delay(0.05); }
    post(codes[0], p, codes[2], 1); post(codes[1], p, codes[2], 1);
    if (dbl) { delay(0.06); post(codes[0], p, codes[2], 2); post(codes[1], p, codes[2], 2); }
    return 'ok';
  }
  if (op === 'scroll') {
    var lines = parseInt(argv[1], 10) || 0;
    try { var s = $.CGEventCreateScrollWheelEvent2(null, 1, 1, lines * 3, 0, 0); $.CGEventPost(0, s); return 'ok'; }
    catch (e) { return 'fallback'; }
  }
  return 'unknown';
}`;

// Коды клавиш macOS (US-раскладка, не зависят от языка ввода).
const KEYCODES = {
  enter: 36, return: 36, tab: 48, space: 49, backspace: 51, esc: 53, escape: 53, delete: 117, del: 117, forwarddelete: 117,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121, pgup: 116, pgdn: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111
};
const MODS = { cmd: 'command down', command: 'command down', meta: 'command down', win: 'command down', super: 'command down', '⌘': 'command down',
  ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down', opt: 'option down', '⌥': 'option down', shift: 'shift down', '⇧': 'shift down' };

function keyScript(combo) {
  const parts = String(combo || '').toLowerCase().split('+').map(s => s.trim()).filter(Boolean);
  const key = parts.pop() || '';
  const mods = [...new Set(parts.map(p => MODS[p]).filter(Boolean))];
  const using = mods.length ? ` using {${mods.join(', ')}}` : '';
  const action = KEYCODES[key] != null ? `key code ${KEYCODES[key]}` : `keystroke ${asStr(key.length === 1 ? key : key)}`;
  return `tell application "System Events" to ${action}${using}`;
}

async function typeText(text) {
  // Латиница и цифры — честный набор; кириллица/эмодзи — через буфер обмена (keystroke зависит от раскладки).
  if (/^[\x20-\x7E\n\t]*$/.test(text)) {
    const lines = text.split('\n');
    const cmds = lines.map((l, i) => (l ? `keystroke ${asStr(l)}\n` : '') + (i < lines.length - 1 ? 'key code 36\n' : '')).join('');
    await osa(`tell application "System Events"\n${cmds}end tell`);
    return;
  }
  const { clipboard } = require('electron');
  const prev = clipboard.readText();
  clipboard.writeText(text);
  try { await osa('tell application "System Events" to keystroke "v" using {command down}'); await sleep(350); }
  finally { clipboard.writeText(prev); }
}

// Привычные «виндовые» имена → приложения macOS.
const APP_ALIASES = {
  notepad: 'TextEdit', 'блокнот': 'TextEdit', textedit: 'TextEdit', calc: 'Calculator', calculator: 'Calculator', 'калькулятор': 'Calculator',
  explorer: 'Finder', finder: 'Finder', 'проводник': 'Finder', chrome: 'Google Chrome', 'google chrome': 'Google Chrome', edge: 'Microsoft Edge', msedge: 'Microsoft Edge',
  firefox: 'Firefox', safari: 'Safari', cmd: 'Terminal', powershell: 'Terminal', terminal: 'Terminal', 'терминал': 'Terminal',
  settings: 'System Settings', 'ms-settings:': 'System Settings', control: 'System Settings', 'настройки': 'System Settings', mspaint: 'Preview', paint: 'Preview',
  telegram: 'Telegram', discord: 'Discord', spotify: 'Spotify', code: 'Visual Studio Code', vscode: 'Visual Studio Code', word: 'Microsoft Word', excel: 'Microsoft Excel',
  taskmgr: 'Activity Monitor', 'диспетчер задач': 'Activity Monitor', music: 'Music', mail: 'Mail', notes: 'Notes', 'заметки': 'Notes'
};
const appName = n => { const raw = String(n || '').trim().replace(/\.(exe|app)$/i, '').replace(/[^\p{L}\p{N} .\-_]/gu, '').slice(0, 64); return APP_ALIASES[raw.toLowerCase()] || raw; };

async function execute(action, a = {}) {
  switch (action) {
    case 'mouse_move': await jxa(MOUSE_JXA, ['move', a.x | 0, a.y | 0]); return { ok: true, text: `Курсор → ${a.x}, ${a.y}` };
    case 'mouse_click': {
      const has = Number.isFinite(a.x) && Number.isFinite(a.y);
      await jxa(MOUSE_JXA, ['click', has ? a.x : 'nan', has ? a.y : 'nan', a.button || 'left', a.double ? 1 : 0]);
      return { ok: true, text: `Клик (${a.button || 'left'}${a.double ? ', двойной' : ''})` };
    }
    case 'scroll': {
      const n = a.amount | 0;
      const r = (await jxa(MOUSE_JXA, ['scroll', n])).trim();
      if (r !== 'ok') await osa(`tell application "System Events"\nrepeat ${Math.min(50, Math.abs(n) || 1) * 3} times\nkey code ${n > 0 ? 126 : 125}\nend repeat\nend tell`);
      return { ok: true, text: `Прокрутка ${n}` };
    }
    case 'type_text': await typeText(a.text || ''); return { ok: true, text: `Напечатал ${(a.text || '').length} симв.` };
    case 'key_press': await osa(keyScript(a.keys)); return { ok: true, text: `Нажал ${a.keys}` };
    case 'open_app': {
      const n = appName(a.name); if (!n) throw new Error('Не указано приложение');
      await run('open', ['-a', n]); await sleep(1200);
      return { ok: true, text: `Запустил ${n}` };
    }
    case 'close_app': {
      const n = appName(a.name); if (!n) throw new Error('Не указано приложение');
      await osa(`if application ${asStr(n)} is running then tell application ${asStr(n)} to quit`);
      return { ok: true, text: `Попросил ${n} закрыться` };
    }
    default: throw new Error('Неизвестное действие: ' + action);
  }
}

module.exports = { execute, keyScript, appName, humanize, MOUSE_JXA };
