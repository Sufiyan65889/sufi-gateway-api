import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { getConfig, requireSecret } from './config';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const API_KEY_PREFIX = 'sufi-ai-';

export function uuid(): string {
  return randomUUID();
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacHex(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function generateApiKey(): { raw: string; hash: string; prefix: string; last4: string } {
  const bytes = randomBytes(32);
  let random = '';
  for (let i = 0; i < 32; i++) random += BASE62[bytes[i] % BASE62.length];
  const raw = `${API_KEY_PREFIX}${random}`;
  return {
    raw,
    hash: sha256Hex(raw),
    prefix: raw.slice(0, 12),
    last4: raw.slice(-4),
  };
}

export function maskApiKey(prefix: string, last4: string): string {
  return `${prefix}${'•'.repeat(14)}${last4}`;
}

export function maskProviderSecret(secret: string): string {
  if (secret.length <= 8) return `••••${secret.slice(-2)}`;
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}

export function validateProviderSecret(secret: string): string | null {
  if (!secret) return 'Empty';
  if (/\s/.test(secret)) return 'Contains spaces';
  if (secret.length < 6) return 'Too short (min 6)';
  if (secret.length > 512) return 'Too long (max 512)';
  if (!/^[\x21-\x7E]+$/.test(secret)) return 'Unsupported characters';
  if (secret.startsWith(API_KEY_PREFIX)) return 'This is a Sufi key, not a provider key';
  return null;
}

export function parseSecretLines(text: string): { values: string[]; skipped: number } {
  const values: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const raw of text.replace(/\uFEFF/g, '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) {
      skipped++;
      continue;
    }
    line = line.replace(/^["',;]+|["',;]+$/g, '').trim();
    if (validateProviderSecret(line)) {
      skipped++;
      continue;
    }
    if (seen.has(line)) {
      skipped++;
      continue;
    }
    seen.add(line);
    values.push(line);
  }
  return { values, skipped };
}

function encryptionKey(): Buffer {
  return createHash('sha256').update(requireSecret('ENCRYPTION_KEY')).digest();
}

export function encryptSecret(secret: string): { ciphertext: string; iv: string; tag: string; hash: string; last4: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    hash: sha256Hex(secret),
    last4: secret.slice(-4),
  };
}

export function decryptSecret(ciphertext: string, iv: string, tag: string): string {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join(maskProviderSecret(secret));
  }
  out = out.replace(/(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{8,}/g, '$1••••');
  return out;
}

function scryptHash(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(key as Buffer);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const N = 16384;
  const r = 8;
  const p = 1;
  const key = await scryptHash(password, salt, N, r, p);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, salt, expected] = parts;
    const key = await scryptHash(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
    const expectedBuffer = Buffer.from(expected, 'base64url');
    if (key.length !== expectedBuffer.length) return false;
    return timingSafeEqual(key, expectedBuffer);
  } catch {
    return false;
  }
}

export type AdminClaims = { sub: string; email: string; role: 'admin' };

export async function signAdminToken(admin: { id: string; email: string }): Promise<string> {
  const secret = new TextEncoder().encode(requireSecret('JWT_SECRET'));
  return new SignJWT({ email: admin.email, role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(admin.id)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);
}

export async function verifyAdminToken(token: string): Promise<AdminClaims | null> {
  try {
    const secret = new TextEncoder().encode(requireSecret('JWT_SECRET'));
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (payload.role !== 'admin' || typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;
    return { sub: payload.sub, email: payload.email, role: 'admin' };
  } catch {
    return null;
  }
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export function setupTokenMatches(input: string): boolean {
  const expected = getConfig().setupToken;
  return !!expected && safeEqual(input, expected);
}
