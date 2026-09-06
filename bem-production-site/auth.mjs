import { randomBytes } from 'node:crypto';
import { getAddress, verifyMessage } from 'ethers';

export function createAdminAuth({ readOwner, now = Date.now }) {
  const challenges = new Map(), sessions = new Map();
  function prune() { for (const map of [challenges, sessions]) for (const [id, value] of map) if (value.expiresAt <= now()) map.delete(id); }
  return {
    async challenge({ address, origin }) {
      prune();
      const owner = getAddress(await readOwner()), account = getAddress(address);
      if (owner !== account) throw new Error('请使用当前持有 2075 的钱包登录管理后台。');
      if (challenges.size >= 100) throw new Error('登录请求较多，请稍后再试。');
      const id = randomBytes(16).toString('hex'), issuedAt = now(), expiresAt = issuedAt + 120000;
      const url = new URL(origin);
      const message = `${url.host} wants you to sign in with your Ethereum account:\n${account}\n\n查看 BEHEMOTH 2075 管理后台；此签名仅用于登录，不授权转账或合约交易。\n\nURI: ${url.origin}/admin.html\nVersion: 1\nChain ID: 56\nNonce: ${id}\nIssued At: ${new Date(issuedAt).toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}`;
      challenges.set(id, { address: account, origin: url.origin, message, expiresAt });
      return { id, message, expiresAt: new Date(expiresAt).toISOString() };
    },
    async login({ id, signature, origin }) {
      prune(); const challenge = challenges.get(id); challenges.delete(id);
      if (!challenge || challenge.origin !== origin || typeof signature !== 'string' || signature.length > 200) throw new Error('登录请求已失效，请重新连接并签名。');
      if (getAddress(verifyMessage(challenge.message, signature)) !== challenge.address || getAddress(await readOwner()) !== challenge.address) throw new Error('签名与当前 2075 持有人不匹配。');
      if (challenge.expiresAt <= now()) throw new Error('登录请求已过期，请重新签名。');
      if (sessions.size >= 100) throw new Error('登录会话较多，请稍后再试。');
      const token = randomBytes(32).toString('hex'), expiresAt = now() + 900000;
      sessions.set(token, { address: challenge.address, expiresAt });
      return { token, address: challenge.address, expiresAt };
    },
    async session(cookie) {
      prune();
      const token = /(?:^|;\s*)bem2075_admin=([a-f0-9]{64})(?:;|$)/.exec(cookie || '')?.[1];
      const session = token && sessions.get(token);
      if (!session) return null;
      if (getAddress(await readOwner()) !== session.address || session.expiresAt <= now()) { sessions.delete(token); return null; }
      return { address: session.address, expiresAt: session.expiresAt };
    },
    logout(cookie) { const token = /(?:^|;\s*)bem2075_admin=([a-f0-9]{64})(?:;|$)/.exec(cookie || '')?.[1]; if (token) sessions.delete(token); }
  };
}
