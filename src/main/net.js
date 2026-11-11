// Проверка адресов: куда можно ходить с ключом, что можно открыть снаружи, какой base URL допустим.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopback(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return LOCAL_HOSTS.has(h);
}

function isPrivateHostname(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (LOCAL_HOSTS.has(h)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(h)) return true;
  if (/^0\.0\.0\.0$/.test(h)) return true;
  if (h === '::' || h.startsWith('fe80:') || /^f[cd][0-9a-f]{0,2}:/i.test(h)) return true;
  return false;
}

function parseUrl(raw) {
  try { return new URL(String(raw || '').trim()); } catch { return null; }
}

/**
 * Разрешённый адрес API: https на публичный хост, либо http(s) на localhost
 * (Ollama, LM Studio, свой локальный сервер). Без логина в URL, без странных схем.
 */
function validateBaseUrl(raw, { allowLocalHttp = true } = {}) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, reason: 'Не указан адрес сервера.' };
  const u = parseUrl(s);
  if (!u) return { ok: false, reason: 'Это не похож на адрес (нужен полный URL, например https://api.example.com/v1).' };
  if (u.username || u.password) return { ok: false, reason: 'В адресе не должно быть логина и пароля.' };
  if (u.hash) return { ok: false, reason: 'В адресе не должно быть #якоря.' };
  const local = isPrivateHostname(u.hostname);
  if (local) {
    if (!allowLocalHttp) return { ok: false, reason: 'Локальный адрес здесь не принимается.' };
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'Локальный сервер — только http или https.' };
    return { ok: true, url: u.toString().replace(/\/+$/, ''), local: true, https: u.protocol === 'https:' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'Удалённый сервер — только https.' };
  if (!u.hostname || u.hostname === '.' || /[\s<>]/.test(u.hostname)) return { ok: false, reason: 'Некорректное имя сервера.' };
  return { ok: true, url: u.toString().replace(/\/+$/, ''), local: false, https: true };
}

/** Хост, на который можно отправить ключ этого провайдера. Для custom — любой прошедший validateBaseUrl. */
function assertKeyDestination(profile) {
  // Ленивый require, чтобы не было цикла с providers.js.
  const { PRESETS } = require('./providers');
  const pre = PRESETS[profile.provider] || PRESETS.custom;
  const base = String(profile.baseUrl || pre.base || '').replace(/\/+$/, '');
  const localProvider = !!pre.local || profile.provider === 'custom' || profile.provider === 'ollama' || profile.provider === 'lmstudio';
  const v = validateBaseUrl(base, { allowLocalHttp: localProvider });
  if (!v.ok) {
    const e = new Error(v.reason);
    e.code = 'BAD_BASE';
    throw e;
  }
  const actual = new URL(v.url);
  if (pre.base && !pre.local && profile.provider !== 'custom') {
    const expected = new URL(pre.base);
    if (actual.hostname.toLowerCase() !== expected.hostname.toLowerCase()) {
      const e = new Error(`Ключ «${pre.name}» можно отправлять только на ${expected.hostname}, а не на ${actual.hostname}.`);
      e.code = 'KEY_HOST';
      throw e;
    }
    if (actual.protocol !== 'https:') {
      const e = new Error('Ключ отправляется только по https.');
      e.code = 'KEY_HTTPS';
      throw e;
    }
  }
  if (!v.local && actual.protocol !== 'https:') {
    const e = new Error('Ключ отправляется только по https (кроме localhost).');
    e.code = 'KEY_HTTPS';
    throw e;
  }
  return v;
}

/**
 * Ссылка, которую можно открыть в браузере пользователя (shell.openExternal).
 * Только https, без логина, без исполняемых файлов.
 */
function validateExternalUrl(raw) {
  const u = parseUrl(raw);
  if (!u) return { ok: false, reason: 'Это не ссылка.' };
  if (u.username || u.password) return { ok: false, reason: 'В ссылке не должно быть логина и пароля.' };
  if (u.protocol !== 'https:') return { ok: false, reason: 'Открываю только ссылки https.' };
  const pathAndQuery = u.pathname.replace(/\/+$/, '') + ' ' + u.search;
  if (/\.(exe|msi|bat|cmd|ps1|vbs|jar|scr|com|pif|sh|command|pkg|dmg|apk|appx|msix|iso|reg|dll|so|dylib)(\s|$|\?)/i.test(pathAndQuery)) {
    return { ok: false, reason: 'Скачивать программы и скрипты из интернета не буду.' };
  }
  return { ok: true, url: u.toString() };
}

/** Адреса обновлений: только релизы craor/GoatDrey-AI по https. */
const GH_CDN = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'media.githubusercontent.com',
  'codeload.github.com'
]);
function validateGithubReleaseUrl(raw) {
  const u = parseUrl(raw);
  if (!u) return { ok: false, reason: 'Некорректный адрес обновления.' };
  if (u.protocol !== 'https:') return { ok: false, reason: 'Обновления только по https.' };
  if (u.username || u.password) return { ok: false, reason: 'В адресе обновления не должно быть логина.' };
  const host = u.hostname.toLowerCase();
  if (!GH_CDN.has(host)) return { ok: false, reason: `Обновления принимаю только с GitHub, а не с ${host}.` };
  if (host === 'github.com' || host === 'api.github.com' || host === 'codeload.github.com') {
    const path = u.pathname.replace(/^\/repos/, '');
    if (!/^\/craor\/GoatDrey-AI(\/|$)/i.test(path)) {
      return { ok: false, reason: 'Обновления принимаю только из репозитория craor/GoatDrey-AI.' };
    }
  }
  return { ok: true, url: u.toString() };
}

module.exports = {
  LOCAL_HOSTS, isLoopback, isPrivateHostname, parseUrl,
  validateBaseUrl, assertKeyDestination, validateExternalUrl, validateGithubReleaseUrl
};
