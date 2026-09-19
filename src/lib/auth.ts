// 鉴权核心:密码哈希(PBKDF2-SHA256)+ 会话令牌(HMAC-SHA256 签名)
// 全部使用 Workers 运行时内置的 Web Crypto,不依赖 Node 原生模块。

const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 100_000;

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bufToB64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBuf(str: string): Uint8Array {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 生成随机盐(hex) */
export function generateSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return toHex(bytes.buffer);
}

/** PBKDF2-SHA256 派生密码哈希(hex) */
export async function hashPassword(password: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(saltHex),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    key,
    256,
  );
  return toHex(bits);
}

/** 恒定时间比较,避免时序攻击 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(
  password: string,
  saltHex: string,
  expectedHash: string,
): Promise<boolean> {
  const hash = await hashPassword(password, saltHex);
  return safeEqual(hash, expectedHash);
}

// ------------------------- 会话令牌 -------------------------

export interface TokenPayload {
  uid: string;
  username: string;
  role: SessionUser['role'];
  orgId: string | null;
  exp: number; // 秒级时间戳
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** 签发令牌:base64url(payload).base64url(signature) */
export async function signToken(
  payload: Omit<TokenPayload, 'exp'>,
  secret: string,
  ttlSeconds = 60 * 60 * 24 * 7,
): Promise<string> {
  const full: TokenPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = bufToB64url(enc.encode(JSON.stringify(full)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return `${body}.${bufToB64url(sig)}`;
}

/** 校验令牌,失败或过期返回 null */
export async function verifyToken(token: string, secret: string): Promise<TokenPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlToBuf(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBuf(body))) as TokenPayload;
    if (!payload || typeof payload.exp !== 'number') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ------------------------- Cookie -------------------------

export const SESSION_COOKIE = 'mm_session';

export function sessionCookie(token: string, maxAge = 60 * 60 * 24 * 7): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}
