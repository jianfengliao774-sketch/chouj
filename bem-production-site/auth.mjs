import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
// OWASP scrypt profile: N=2^15, r=8, p=3 (32 MiB per verification).
const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const WINDOW = 15 * 60 * 1000;
const cookieToken = cookie => /(?:^|;\s*)bem2075_admin=([a-f0-9]{64})(?:;|$)/.exec(cookie || '')?.[1];
const failure = (status, message) => Object.assign(new Error(message), { authStatus: status });

export async function createAdminCredential(username, password) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,64}$/.test(username)
    || typeof password !== 'string' || password.length < 8 || password.length > 256) throw new Error('Invalid admin account');
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return { schemaVersion: 1, username, algorithm: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('hex'), hash: hash.toString('hex') };
}

export function createAdminAuth({ credential, now = Date.now }) {
  if (!credential || credential.schemaVersion !== 1 || credential.algorithm !== 'scrypt'
    || typeof credential.username !== 'string' || !/^[a-zA-Z0-9_.-]{3,64}$/.test(credential.username)
    || credential.N !== SCRYPT.N || credential.r !== SCRYPT.r || credential.p !== SCRYPT.p
    || typeof credential.salt !== 'string' || !/^[a-f0-9]{32}$/.test(credential.salt)
    || typeof credential.hash !== 'string' || !/^[a-f0-9]{128}$/.test(credential.hash)) throw new Error('Invalid admin credential file');
  const { username } = credential, salt = Buffer.from(credential.salt, 'hex'), expected = Buffer.from(credential.hash, 'hex');
  const attempts = new Map(), sessions = new Map();
  let active = 0, global = { until: 0, count: 0 };
  function prune() {
    for (const [id, item] of attempts) if (item.until <= now()) attempts.delete(id);
    for (const [id, item] of sessions) if (item.expiresAt <= now()) sessions.delete(id);
  }
  return {
    async login({ username: account, password, ip }) {
      prune();
      if (global.until <= now()) global = { until: now() + WINDOW, count: 0 };
      const id = ip || 'unknown', attempt = attempts.get(id) || { until: now() + WINDOW, count: 0 };
      if (attempt.count >= 5 || global.count >= 100 || active >= 2 || (!attempts.has(id) && attempts.size >= 2000)) {
        throw failure(429, '登录尝试过多，请 15 分钟后重试。');
      }
      attempts.set(id, attempt); attempt.count++; global.count++; active++;
      try {
        if (typeof account !== 'string' || account.length > 64 || typeof password !== 'string' || password.length > 256) throw failure(401, '账号或密码不正确。');
        const hash = await scrypt(password, salt, 64, SCRYPT);
        if (!timingSafeEqual(hash, expected) || account !== username) throw failure(401, '账号或密码不正确。');
        if (sessions.size >= 100) throw failure(429, '登录会话较多，请稍后再试。');
        const token = randomBytes(32).toString('hex'), expiresAt = now() + WINDOW;
        sessions.set(token, { username, expiresAt }); attempts.delete(id);
        return { token, username, expiresAt };
      } finally { active--; }
    },
    async session(cookie) {
      prune(); const value = sessions.get(cookieToken(cookie));
      return value ? { ...value } : null;
    },
    logout(cookie) { sessions.delete(cookieToken(cookie)); }
  };
}
