// Блокировка приложения: PIN или пароль, хэш scrypt (необратимый). По умолчанию выключено.
const crypto = require('crypto');

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };
const MIN_LEN = 4;
const MAX_LEN = 128;
const MAX_TRIES = 5;
const BASE_COOLDOWN_MS = 15_000;

function hashPin(pin, salt = crypto.randomBytes(16), params = PARAMS) {
  const p = String(pin);
  if (p.length < MIN_LEN || p.length > MAX_LEN) {
    const e = new Error(`Пароль должен быть от ${MIN_LEN} до ${MAX_LEN} символов.`);
    e.code = 'PIN_LEN';
    throw e;
  }
  const hash = crypto.scryptSync(p, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 });
  return {
    algo: 'scrypt',
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    N: params.N, r: params.r, p: params.p, keylen: params.keylen
  };
}

function verifyPin(pin, stored) {
  if (!stored || stored.algo !== 'scrypt' || !stored.salt || !stored.hash) return false;
  let salt, expected, actual;
  try {
    salt = Buffer.from(stored.salt, 'base64');
    expected = Buffer.from(stored.hash, 'base64');
    actual = crypto.scryptSync(String(pin), salt, stored.keylen || PARAMS.keylen, {
      N: stored.N || PARAMS.N, r: stored.r || PARAMS.r, p: stored.p || PARAMS.p,
      maxmem: 256 * 1024 * 1024
    });
  } catch { return false; }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/** Состояние попыток в памяти процесса (не на диске). */
function createLimiter() {
  let fails = 0, blockedUntil = 0;
  return {
    status() {
      const wait = Math.max(0, blockedUntil - Date.now());
      return { fails, blocked: wait > 0, waitMs: wait, maxTries: MAX_TRIES };
    },
    check() {
      const wait = Math.max(0, blockedUntil - Date.now());
      if (wait > 0) {
        const e = new Error(`Слишком много попыток. Подождите ${Math.ceil(wait / 1000)} с.`);
        e.code = 'COOLDOWN';
        e.waitMs = wait;
        throw e;
      }
    },
    fail() {
      fails += 1;
      if (fails >= MAX_TRIES) {
        const mul = Math.min(8, 2 ** Math.floor((fails - MAX_TRIES) / 2));
        blockedUntil = Date.now() + BASE_COOLDOWN_MS * mul;
      }
      return this.status();
    },
    reset() { fails = 0; blockedUntil = 0; }
  };
}

module.exports = { hashPin, verifyPin, createLimiter, PARAMS, MIN_LEN, MAX_LEN, MAX_TRIES };
