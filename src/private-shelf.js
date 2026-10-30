'use strict';
// Part 7h: the password side of the private shelf (main process only).
//
// This is privacy from someone glancing at the screen, NOT encryption: hidden books stay readable
// on disk. All it keeps is a salted scrypt hash, whether the shelf is unlocked right now, and the
// delay after repeated wrong passwords. Where the hash is stored and which books are hidden is
// decided by library.js; this file never touches the disk itself.

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_LENGTH = 6;
const MAX_LENGTH = 200;
// After the 5th wrong attempt: 30 s, then 2 min, then 10 min for every attempt after that.
const FREE_TRIES = 5;
const DELAYS = [30000, 120000, 600000];

const isHex = (s, bytes) => typeof s === 'string' && s.length === bytes * 2 && /^[0-9a-f]+$/i.test(s);

// Shape check for what is read back from settings.json. A hand-edited file must not be able to ask
// scrypt for gigabytes, so the cost parameters are bounded.
function validSecret(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  const p = s.params;
  if (!p || typeof p !== 'object') return false;
  const pow2 = Number.isInteger(p.N) && p.N >= 1024 && p.N <= 65536 && (p.N & (p.N - 1)) === 0;
  return pow2 && Number.isInteger(p.r) && p.r >= 1 && p.r <= 16 && Number.isInteger(p.p) && p.p >= 1 && p.p <= 4 &&
    Number.isInteger(p.keylen) && p.keylen >= 16 && p.keylen <= 128 &&
    isHex(s.salt, 16) && isHex(s.hash, p.keylen);
}

const derive = (password, saltHex, p) =>
  scrypt(Buffer.from(password, 'utf8'), Buffer.from(saltHex, 'hex'), p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: 256 * p.N * p.r });

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await derive(password, salt, PARAMS)).toString('hex');
  return { salt, hash, params: { ...PARAMS } };
}

function checkNew(password) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) throw new Error(`The password needs at least ${MIN_LENGTH} characters.`);
  if (password.length > MAX_LENGTH) throw new Error('That password is too long.');
}

// getSecret() -> the stored { salt, hash, params } or null; saveSecret(next|null) -> Promise.
function create({ getSecret, saveSecret }) {
  let unlocked = false;
  let fails = 0;
  let blockedUntil = 0;
  // Attempts run one at a time, so two at once cannot slip past the delay.
  let chain = Promise.resolve();

  const enabled = () => !!getSecret();

  function check(password) {
    const run = async () => {
      const now = Date.now();
      if (now < blockedUntil) return { ok: false, reason: 'wait', wait: Math.ceil((blockedUntil - now) / 1000) };
      const s = getSecret();
      let good = false;
      if (s && typeof password === 'string' && password.length <= MAX_LENGTH) {
        try {
          const got = await derive(password, s.salt, s.params);
          const want = Buffer.from(s.hash, 'hex');
          good = got.length === want.length && crypto.timingSafeEqual(got, want);
        } catch { good = false; }
      }
      if (good) { fails = 0; blockedUntil = 0; return { ok: true }; }
      fails++;
      if (fails >= FREE_TRIES) {
        const d = DELAYS[Math.min(fails - FREE_TRIES, DELAYS.length - 1)];
        blockedUntil = Date.now() + d;
        return { ok: false, reason: 'wrong', wait: Math.ceil(d / 1000) };
      }
      return { ok: false, reason: 'wrong' };
    };
    chain = chain.catch(() => {}).then(run);
    return chain;
  }

  return {
    check, enabled, validSecret,
    status: () => ({ enabled: enabled(), unlocked: enabled() && unlocked }),
    isUnlocked: () => enabled() && unlocked,
    lock: () => { unlocked = false; return true; },
    async unlock(password) {
      const r = await check(password);
      if (r.ok) unlocked = true;
      return r;
    },
    async set(password) {
      if (enabled()) throw new Error('A private shelf password is already set.');
      checkNew(password);
      await saveSecret(await hashPassword(password));
      unlocked = false;
      fails = 0; blockedUntil = 0;
      return true;
    },
    async change(current, next) {
      const r = await check(current);
      if (!r.ok) return r;
      checkNew(next);
      await saveSecret(await hashPassword(next));
      return { ok: true };
    },
    // Library.js moves the hidden books out first, then calls this to forget the password.
    async clear() { await saveSecret(null); unlocked = false; fails = 0; blockedUntil = 0; return true; }
  };
}

module.exports = { create, validSecret, MIN_LENGTH, MAX_LENGTH };
