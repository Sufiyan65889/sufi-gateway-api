import { createMiddleware } from 'hono/factory';
import { db } from './db';
import { bearerToken, sha256Hex, verifyAdminToken } from './crypto';
import { HttpError } from './errors';
import type { AdminClaims } from './crypto';
import type { ApiKeyWithProvider } from './types';

export type Variables = {
  admin: AdminClaims;
  apiKey: ApiKeyWithProvider;
};

function authError(): HttpError {
  return new HttpError(401, 'Missing or invalid admin session. Please log in again.', 'authentication_error', 'invalid_session');
}

export const adminAuth = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const token = bearerToken(c.req.header('authorization'));
  if (!token) throw authError();
  const claims = await verifyAdminToken(token);
  if (!claims) throw authError();
  const sql = await db();
  const [admin] = await sql<{ id: string; email: string }[]>`
    select id, email from admins where id = ${claims.sub} limit 1
  `;
  if (!admin) throw authError();
  c.set('admin', { sub: admin.id, email: admin.email, role: 'admin' });
  await next();
});

export const apiKeyAuth = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const raw = bearerToken(c.req.header('authorization'));
  if (!raw || !raw.startsWith('sufi-ai-')) {
    throw new HttpError(401, 'Missing API key. Send Authorization: Bearer sufi-ai-...', 'authentication_error', 'invalid_api_key');
  }
  const sql = await db();
  const [row] = await sql<ApiKeyWithProvider[]>`
    select k.*, p.name as provider_name, p.protocol as provider_protocol, p.base_url as provider_base_url
    from api_keys k
    join providers p on p.id = k.provider_id
    where k.key_hash = ${sha256Hex(raw)}
    limit 1
  `;
  if (!row || !row.active) {
    throw new HttpError(401, 'This API key is invalid or has been revoked.', 'authentication_error', 'invalid_api_key');
  }
  c.set('apiKey', row);
  await next();
});
