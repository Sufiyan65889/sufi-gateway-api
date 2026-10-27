import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { APP_VERSION, getConfig } from './config';
import { db, healthCheck, seedProviders } from './db';
import { HttpError, anthropicError, openAiError } from './errors';
import {
  bearerToken,
  hashPassword,
  maskApiKey,
  maskProviderSecret,
  parseSecretLines,
  safeEqual,
  setupTokenMatches,
  signAdminToken,
  uuid,
  validateProviderSecret,
  verifyPassword,
  generateApiKey,
} from './crypto';
import { adminAuth, apiKeyAuth, type Variables } from './auth';
import { dayKeyFor, getSettings, saveSettings } from './settings';
import { getDailyOverview, getKeyUsage, getTotals, keyUsageList } from './usage';
import {
  assertModelAllowed,
  modelsForKey,
  modelsForProvider,
  publicKeyInfo,
  runGateway,
  syncModelsForKey,
  upsertModels,
} from './gateway';
import { parseAnthropic, parseOpenAIChat, parseOpenAIResponses } from './adapters';
import {
  classifyCredentialStatus,
  fetchUpstreamModels,
  normalizeBaseUrl,
} from './upstream';
import type { ApiKeyWithProvider, CredentialRecord, IncomingFormat, Protocol } from './types';

type Env = {
  Variables: Variables & { errorFormat?: IncomingFormat };
};

const app = new Hono<Env>();

app.use('*', logger());
app.use('*', secureHeaders());
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'anthropic-version', 'x-setup-token'],
    exposeHeaders: ['retry-after'],
    maxAge: 86400,
  }),
);
app.use(
  '/api/*',
  bodyLimit({
    maxSize: 4.5 * 1024 * 1024,
    onError: (c) =>
      c.json(
        { error: { message: 'Request body too large. Vercel allows about 4.5 MB.', type: 'invalid_request_error' } },
        413,
      ),
  }),
);

const emailSchema = z.string().trim().toLowerCase().email().max(200);
const passwordSchema = z.string().min(8).max(200);
const limitSchema = z.union([z.number().int().min(0).max(1_000_000_000_000), z.null()]);

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
    throw new HttpError(400, `${path}${issue?.message ?? 'Invalid request body'}`, 'invalid_request_error', 'validation_error');
  }
  return result.data;
}

async function readJson(c: any): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.', 'invalid_request_error', 'invalid_json');
  }
}

function normalizeProviderUrl(raw: string): string {
  try {
    return normalizeBaseUrl(raw);
  } catch (error: any) {
    throw new HttpError(400, String(error?.message ?? error), 'invalid_request_error', 'invalid_base_url');
  }
}

function parseIncoming<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error: any) {
    throw new HttpError(400, String(error?.message ?? error), 'invalid_request_error', 'invalid_request');
  }
}

async function loadKeyById(id: string): Promise<ApiKeyWithProvider> {
  const sql = await db();
  const [key] = await sql<ApiKeyWithProvider[]>`
    select k.*, p.name as provider_name, p.protocol as provider_protocol, p.base_url as provider_base_url
    from api_keys k join providers p on p.id = k.provider_id
    where k.id = ${id} limit 1
  `;
  if (!key) throw new HttpError(404, 'API key not found.');
  return key;
}

async function keyDetail(keyId: string) {
  const sql = await db();
  const key = await loadKeyById(keyId);
  const credentials = await sql<any[]>`
    select id, label, secret_last4, active, cooldown_until, last_status, last_checked_at, created_at
    from provider_credentials where api_key_id = ${keyId}
    order by created_at asc
  `;
  const models = await modelsForKey(key);
  const usage = await getKeyUsage(keyId, 30);
  return {
    key: {
      ...publicKeyInfo(key),
      providerId: key.providerId,
      providerProtocol: key.providerProtocol,
      keyPrefix: key.keyPrefix,
      keyLast4: key.keyLast4,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      revokedAt: key.revokedAt,
      limits: {
        rpm: key.rpm,
        rpd: key.rpd,
        tpd: key.tpd == null ? null : Number(key.tpd),
      },
      allowedModels: key.allowedModels,
    },
    credentials: credentials.map((c) => ({
      id: c.id,
      label: c.label,
      maskedSecret: `••••${c.secretLast4}`,
      last4: c.secretLast4,
      active: c.active,
      cooldownUntil: c.cooldownUntil,
      lastStatus: c.lastStatus,
      lastCheckedAt: c.lastCheckedAt,
      createdAt: c.createdAt,
    })),
    models: models.all,
    usage,
  };
}

// ───────────────────────── health / app config ─────────────────────────

app.get('/', (c) => {
  const config = getConfig();
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sufi Gateway API</title><style>
body{margin:0;background:#000;color:#f5f5f5;font-family:system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{max-width:620px;padding:40px 28px;text-align:center}
h1{font-size:30px;margin:0 0 6px;letter-spacing:-1px}
p{color:#9a9a9a;font-size:14px;line-height:1.6;margin:6px 0}
code{background:#1a1a1a;border:1px solid #242424;border-radius:8px;padding:2px 6px;font-size:12.5px;color:#fff}
.badge{display:inline-block;background:#4ade80;color:#000;font-weight:800;font-size:11px;letter-spacing:1px;padding:4px 10px;border-radius:99px;margin-bottom:18px}
ul{text-align:left;display:inline-block;color:#9a9a9a;font-size:13.5px;line-height:1.9;margin:18px 0 0;padding-left:18px}
</style></head><body><div class="card">
<div class="badge">RUNNING</div>
<h1>Sufi Gateway API</h1>
<p>Version ${APP_VERSION} · OpenAI Chat · OpenAI Responses · Anthropic</p>
<ul>
<li>Public base: <code>${config.publicBaseUrl}/v1</code></li>
<li>Health: <code>/api/health</code></li>
<li>Models: <code>GET /v1/models</code></li>
<li>Chat: <code>POST /v1/chat/completions</code></li>
<li>Responses: <code>POST /v1/responses</code></li>
<li>Anthropic: <code>POST /v1/messages</code></li>
</ul>
</div></body></html>`);
});

app.get('/api/health', async (c) => {
  try {
    const ok = await healthCheck();
    return c.json({ ok, service: 'sufi-gateway-api', version: APP_VERSION, time: new Date().toISOString() });
  } catch (error: any) {
    return c.json({ ok: false, error: String(error?.message ?? error), version: APP_VERSION }, 503);
  }
});

app.get('/api/app-config', (c) => {
  const config = getConfig();
  return c.json({
    serverBaseUrl: config.publicBaseUrl,
    publicApiBaseUrl: `${config.publicBaseUrl}/v1`,
    formats: ['openai_chat', 'openai_responses', 'anthropic'],
    streamingDefault: true,
    version: APP_VERSION,
  });
});

// ───────────────────────── setup / auth ─────────────────────────

app.get('/api/setup/status', async (c) => {
  try {
    const sql = await db();
    const [row] = await sql<{ count: number }[]>`select count(*)::int as count from admins`;
    const config = getConfig();
    return c.json({
      needsSetup: Number(row?.count ?? 0) === 0,
      setupTokenConfigured: !!config.setupToken && !config.setupToken.startsWith('change-me'),
    });
  } catch (error: any) {
    return c.json({ needsSetup: false, setupTokenConfigured: false, error: String(error?.message ?? error) }, 503);
  }
});

app.post('/api/setup', async (c) => {
  const body = parseBody(
    z.object({
      setupToken: z.string().min(1).max(300),
      email: emailSchema,
      password: passwordSchema,
    }),
    await readJson(c),
  );
  if (!setupTokenMatches(body.setupToken)) {
    throw new HttpError(401, 'Wrong setup token. Check SETUP_TOKEN in Vercel.', 'authentication_error', 'invalid_setup_token');
  }
  const sql = await db();
  const [countRow] = await sql<{ count: number }[]>`select count(*)::int as count from admins`;
  if (Number(countRow?.count ?? 0) > 0) {
    throw new HttpError(409, 'Admin already exists. Please log in.', 'conflict_error', 'admin_exists');
  }
  const id = uuid();
  const passwordHash = await hashPassword(body.password);
  try {
    await sql`insert into admins (id, email, password_hash) values (${id}, ${body.email}, ${passwordHash})`;
  } catch {
    throw new HttpError(409, 'Admin already exists. Please log in.', 'conflict_error', 'admin_exists');
  }
  const providers = await seedProviders();
  const token = await signAdminToken({ id, email: body.email });
  return c.json({ token, admin: { id, email: body.email }, providers }, 201);
});

app.post('/api/auth/login', async (c) => {
  const body = parseBody(
    z.object({ email: emailSchema, password: z.string().min(1).max(200) }),
    await readJson(c),
  );
  const sql = await db();
  const ip = (c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown').split(',')[0].trim();
  await sql`insert into login_attempts (ip, email) values (${ip}, ${body.email})`;
  const [attempts] = await sql<{ count: number }[]>`
    select count(*)::int as count from login_attempts
    where ip = ${ip} and created_at > now() - interval '15 minutes'
  `;
  if (Number(attempts?.count ?? 0) > 20) {
    throw new HttpError(429, 'Too many login attempts. Try again in 15 minutes.', 'rate_limit_error', 'login_rate_limited');
  }
  const [admin] = await sql<{ id: string; email: string; passwordHash: string }[]>`
    select id, email, password_hash from admins where email = ${body.email} limit 1
  `;
  if (!admin || !(await verifyPassword(body.password, admin.passwordHash))) {
    throw new HttpError(401, 'Wrong email or password.', 'authentication_error', 'invalid_credentials');
  }
  await sql`delete from login_attempts where ip = ${ip}`;
  const token = await signAdminToken({ id: admin.id, email: admin.email });
  return c.json({ token, admin: { id: admin.id, email: admin.email } });
});

app.get('/api/auth/me', adminAuth, async (c) => {
  const admin = c.get('admin');
  return c.json({ admin: { id: admin.sub, email: admin.email } });
});

app.post('/api/auth/logout', adminAuth, (c) => c.body(null, 204));

// ───────────────────────── admin: settings ─────────────────────────

app.get('/api/admin/settings', adminAuth, async (c) => {
  const settings = await getSettings();
  return c.json({ settings });
});

app.put('/api/admin/settings', adminAuth, async (c) => {
  const body = parseBody(
    z.object({
      defaultRpm: limitSchema.optional(),
      defaultRpd: limitSchema.optional(),
      defaultTpd: limitSchema.optional(),
      defaultStreaming: z.boolean().optional(),
      timezone: z.string().min(1).max(60).optional(),
    }),
    await readJson(c),
  );
  const settings = await saveSettings(body);
  return c.json({ settings });
});

// ───────────────────────── admin: providers ─────────────────────────

app.get('/api/admin/providers', adminAuth, async (c) => {
  const sql = await db();
  const rows = await sql<any[]>`
    select p.*,
      (select count(*)::int from api_keys k where k.provider_id = p.id) as key_count,
      (select count(*)::int from provider_models m where m.provider_id = p.id) as model_count
    from providers p order by p.created_at asc
  `;
  return c.json({
    providers: rows.map((p) => ({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      keyCount: Number(p.keyCount ?? 0),
      modelCount: Number(p.modelCount ?? 0),
      createdAt: p.createdAt,
    })),
  });
});

app.post('/api/admin/providers', adminAuth, async (c) => {
  const body = parseBody(
    z.object({
      name: z.string().trim().min(2).max(80),
      protocol: z.enum(['openai_chat', 'openai_responses', 'anthropic']) as z.ZodType<Protocol>,
      baseUrl: z.string().trim().min(4).max(500),
    }),
    await readJson(c),
  );
  const baseUrl = normalizeProviderUrl(body.baseUrl);
  const sql = await db();
  const id = uuid();
  try {
    const [row] = await sql<any[]>`
      insert into providers (id, name, protocol, base_url)
      values (${id}, ${body.name}, ${body.protocol}, ${baseUrl})
      returning *
    `;
    return c.json({ provider: { id: row.id, name: row.name, protocol: row.protocol, baseUrl: row.baseUrl } }, 201);
  } catch {
    throw new HttpError(409, 'A provider with this name already exists.', 'conflict_error', 'provider_exists');
  }
});

app.patch('/api/admin/providers/:id', adminAuth, async (c) => {
  const id = c.req.param('id');
  const body = parseBody(
    z.object({
      name: z.string().trim().min(2).max(80).optional(),
      protocol: z.enum(['openai_chat', 'openai_responses', 'anthropic']).optional(),
      baseUrl: z.string().trim().min(4).max(500).optional(),
    }),
    await readJson(c),
  );
  const sql = await db();
  const [current] = await sql<any[]>`select * from providers where id = ${id}`;
  if (!current) throw new HttpError(404, 'Provider not found.');
  const baseUrl = body.baseUrl ? normalizeProviderUrl(body.baseUrl) : current.baseUrl;
  try {
    const [row] = await sql<any[]>`
      update providers set
        name = ${body.name ?? current.name},
        protocol = ${body.protocol ?? current.protocol},
        base_url = ${baseUrl},
        updated_at = now()
      where id = ${id} returning *
    `;
    return c.json({ provider: { id: row.id, name: row.name, protocol: row.protocol, baseUrl: row.baseUrl } });
  } catch {
    throw new HttpError(409, 'A provider with this name already exists.', 'conflict_error', 'provider_exists');
  }
});

app.delete('/api/admin/providers/:id', adminAuth, async (c) => {
  const id = c.req.param('id');
  const sql = await db();
  const [row] = await sql<{ count: number }[]>`select count(*)::int as count from api_keys where provider_id = ${id}`;
  if (Number(row?.count ?? 0) > 0) {
    throw new HttpError(409, 'This provider is used by API keys. Delete those keys first.', 'conflict_error', 'provider_in_use');
  }
  await sql`delete from providers where id = ${id}`;
  return c.body(null, 204);
});

app.get('/api/admin/providers/:id/models', adminAuth, async (c) => {
  const id = c.req.param('id');
  const sql = await db();
  const [provider] = await sql`select id from providers where id = ${id}`;
  if (!provider) throw new HttpError(404, 'Provider not found.');
  return c.json({ models: await modelsForProvider(id) });
});

app.post('/api/admin/providers/:id/models', adminAuth, async (c) => {
  const id = c.req.param('id');
  const body = parseBody(
    z.object({
      modelId: z.string().trim().min(1).max(200),
      displayName: z.string().trim().max(200).optional(),
      contextWindow: z.number().int().positive().optional(),
      maxOutput: z.number().int().positive().optional(),
    }),
    await readJson(c),
  );
  const sql = await db();
  const [provider] = await sql`select id from providers where id = ${id}`;
  if (!provider) throw new HttpError(404, 'Provider not found.');
  await upsertModels(id, [{ id: body.modelId, displayName: body.displayName, contextWindow: body.contextWindow, maxOutput: body.maxOutput }]);
  return c.json({ models: await modelsForProvider(id) }, 201);
});

app.patch('/api/admin/providers/:id/models/:modelId', adminAuth, async (c) => {
  const id = c.req.param('id');
  const modelId = decodeURIComponent(c.req.param('modelId'));
  const body = parseBody(z.object({ enabled: z.boolean() }), await readJson(c));
  const sql = await db();
  const [row] = await sql<any[]>`
    update provider_models set enabled = ${body.enabled}, updated_at = now()
    where provider_id = ${id} and model_id = ${modelId}
    returning *
  `;
  if (!row) throw new HttpError(404, 'Model not found.');
  return c.json({ ok: true, enabled: row.enabled });
});

app.delete('/api/admin/providers/:id/models/:modelId', adminAuth, async (c) => {
  const id = c.req.param('id');
  const modelId = decodeURIComponent(c.req.param('modelId'));
  const sql = await db();
  await sql`delete from provider_models where provider_id = ${id} and model_id = ${modelId}`;
  return c.body(null, 204);
});

// ───────────────────────── admin: API keys ─────────────────────────

app.get('/api/admin/keys', adminAuth, async (c) => {
  const keys = await keyUsageList();
  return c.json({ keys });
});

app.post('/api/admin/keys', adminAuth, async (c) => {
  const body = parseBody(
    z.object({
      label: z.string().trim().min(1).max(60),
      providerId: z.string().uuid(),
      rpm: limitSchema.optional(),
      rpd: limitSchema.optional(),
      tpd: limitSchema.optional(),
      routing: z.enum(['ordered', 'random']).optional(),
      streaming: z.boolean().optional(),
      allowedModels: z.array(z.string().min(1).max(200)).max(1000).optional(),
    }),
    await readJson(c),
  );
  const sql = await db();
  const [provider] = await sql<any[]>`select * from providers where id = ${body.providerId}`;
  if (!provider) throw new HttpError(404, 'Provider not found.');
  const settings = await getSettings();
  const generated = generateApiKey();
  const id = uuid();
  const rpm = body.rpm === undefined ? settings.defaultRpm : body.rpm;
  const rpd = body.rpd === undefined ? settings.defaultRpd : body.rpd;
  const tpd = body.tpd === undefined ? settings.defaultTpd : body.tpd;
  await sql`
    insert into api_keys
      (id, label, key_hash, key_prefix, key_last4, provider_id, routing, streaming, rpm, rpd, tpd, allowed_models)
    values
      (${id}, ${body.label}, ${generated.hash}, ${generated.prefix}, ${generated.last4}, ${body.providerId},
       ${body.routing ?? 'ordered'}, ${body.streaming ?? settings.defaultStreaming}, ${rpm}, ${rpd}, ${tpd},
       ${body.allowedModels ?? []})
  `;
  const key = await loadKeyById(id);
  return c.json(
    {
      key: generated.raw,
      apiKey: {
        ...publicKeyInfo(key),
        providerId: key.providerId,
        providerName: provider.name,
        providerProtocol: provider.protocol,
        createdAt: key.createdAt,
      },
    },
    201,
  );
});

app.get('/api/admin/keys/:id', adminAuth, async (c) => {
  return c.json(await keyDetail(c.req.param('id')));
});

app.patch('/api/admin/keys/:id', adminAuth, async (c) => {
  const id = c.req.param('id');
  const body = parseBody(
    z.object({
      label: z.string().trim().min(1).max(60).optional(),
      providerId: z.string().uuid().optional(),
      rpm: limitSchema.optional(),
      rpd: limitSchema.optional(),
      tpd: limitSchema.optional(),
      routing: z.enum(['ordered', 'random']).optional(),
      streaming: z.boolean().optional(),
      allowedModels: z.array(z.string().min(1).max(200)).max(1000).optional(),
    }),
    await readJson(c),
  );
  const current = await loadKeyById(id);
  const sql = await db();
  let providerId = current.providerId;
  if (body.providerId && body.providerId !== current.providerId) {
    const [provider] = await sql`select id from providers where id = ${body.providerId}`;
    if (!provider) throw new HttpError(404, 'Provider not found.');
    providerId = body.providerId;
  }
  await sql`
    update api_keys set
      label = ${body.label ?? current.label},
      provider_id = ${providerId},
      rpm = ${body.rpm === undefined ? current.rpm : body.rpm},
      rpd = ${body.rpd === undefined ? current.rpd : body.rpd},
      tpd = ${body.tpd === undefined ? current.tpd : body.tpd},
      routing = ${body.routing ?? current.routing},
      streaming = ${body.streaming ?? current.streaming},
      allowed_models = ${body.allowedModels ?? current.allowedModels}
    where id = ${id}
  `;
  return c.json(await keyDetail(id));
});

app.delete('/api/admin/keys/:id', adminAuth, async (c) => {
  const sql = await db();
  await sql`delete from api_keys where id = ${c.req.param('id')}`;
  return c.body(null, 204);
});

app.post('/api/admin/keys/:id/revoke', adminAuth, async (c) => {
  const sql = await db();
  const [row] = await sql<any[]>`
    update api_keys set active = false, revoked_at = now() where id = ${c.req.param('id')} returning id
  `;
  if (!row) throw new HttpError(404, 'API key not found.');
  return c.json({ ok: true });
});

app.post('/api/admin/keys/:id/activate', adminAuth, async (c) => {
  const sql = await db();
  const [row] = await sql<any[]>`
    update api_keys set active = true, revoked_at = null where id = ${c.req.param('id')} returning id
  `;
  if (!row) throw new HttpError(404, 'API key not found.');
  return c.json({ ok: true });
});

// ───────────────────────── admin: provider credentials ─────────────────────────

app.get('/api/admin/keys/:id/credentials', adminAuth, async (c) => {
  const sql = await db();
  const key = await loadKeyById(c.req.param('id'));
  const rows = await sql<any[]>`
    select id, label, secret_last4, active, cooldown_until, last_status, last_checked_at, created_at
    from provider_credentials where api_key_id = ${key.id} order by created_at asc
  `;
  return c.json({
    credentials: rows.map((r) => ({
      id: r.id,
      label: r.label,
      maskedSecret: `••••${r.secretLast4}`,
      last4: r.secretLast4,
      active: r.active,
      cooldownUntil: r.cooldownUntil,
      lastStatus: r.lastStatus,
      lastCheckedAt: r.lastCheckedAt,
      createdAt: r.createdAt,
    })),
  });
});

app.post('/api/admin/keys/:id/credentials', adminAuth, async (c) => {
  const key = await loadKeyById(c.req.param('id'));
  const body = parseBody(
    z.object({
      text: z.string().max(200_000).optional(),
      keys: z.array(z.string()).max(500).optional(),
      label: z.string().trim().max(60).optional(),
    }),
    await readJson(c),
  );
  const parsed = body.keys?.length ? { values: body.keys, skipped: 0 } : parseSecretLines(body.text ?? '');
  const valid = parsed.values.filter((value) => !validateProviderSecret(value));
  if (!valid.length) throw new HttpError(400, 'No valid provider keys found.', 'invalid_request_error', 'no_valid_keys');
  const sql = await db();
  const added: string[] = [];
  const skipped: string[] = [];
  for (const secret of valid) {
    const encrypted = await import('./crypto').then((m) => m.encryptSecret(secret));
    try {
      const [row] = await sql<any[]>`
        insert into provider_credentials
          (id, api_key_id, label, secret_ciphertext, secret_iv, secret_tag, secret_hash, secret_last4)
        values
          (${uuid()}, ${key.id}, ${body.label ?? 'Provider key'}, ${encrypted.ciphertext}, ${encrypted.iv},
           ${encrypted.tag}, ${encrypted.hash}, ${encrypted.last4})
        on conflict (api_key_id, secret_hash) do nothing
        returning id
      `;
      if (row) added.push(maskProviderSecret(secret));
      else skipped.push(maskProviderSecret(secret));
    } catch {
      skipped.push(maskProviderSecret(secret));
    }
  }
  return c.json(
    {
      added,
      skipped,
      addedCount: added.length,
      skippedCount: skipped.length + parsed.skipped,
      duplicateCount: skipped.length,
      invalidCount: parsed.skipped,
    },
    201,
  );
});

app.patch('/api/admin/keys/:id/credentials/:credentialId', adminAuth, async (c) => {
  const body = parseBody(z.object({ active: z.boolean() }), await readJson(c));
  const sql = await db();
  const [row] = await sql<any[]>`
    update provider_credentials set active = ${body.active}
    where id = ${c.req.param('credentialId')} and api_key_id = ${c.req.param('id')}
    returning id
  `;
  if (!row) throw new HttpError(404, 'Provider key not found.');
  return c.json({ ok: true });
});

app.delete('/api/admin/keys/:id/credentials/:credentialId', adminAuth, async (c) => {
  const sql = await db();
  await sql`
    delete from provider_credentials
    where id = ${c.req.param('credentialId')} and api_key_id = ${c.req.param('id')}
  `;
  return c.body(null, 204);
});

app.post('/api/admin/keys/:id/credentials/test', adminAuth, async (c) => {
  const key = await loadKeyById(c.req.param('id'));
  const sql = await db();
  const credentials = await sql<CredentialRecord[]>`
    select * from provider_credentials where api_key_id = ${key.id} and active = true
    order by created_at asc limit 20
  `;
  if (!credentials.length) throw new HttpError(400, 'No provider keys to test.');
  const provider = {
    id: key.providerId,
    name: key.providerName,
    protocol: key.providerProtocol,
    baseUrl: key.providerBaseUrl,
  };
  const { decryptSecret } = await import('./crypto');
  const results: any[] = [];
  for (const credential of credentials) {
    const started = Date.now();
    let status = 'network';
    let error: string | null = null;
    try {
      const secret = decryptSecret(credential.secretCiphertext, credential.secretIv, credential.secretTag);
      await fetchUpstreamModels(provider, secret);
      status = 'ok';
    } catch (e: any) {
      error = String(e?.message ?? e).slice(0, 300);
      const code = Number((e as any)?.status ?? 0) || (/401|403/.test(error ?? '') ? 401 : /429/.test(error ?? '') ? 429 : /404/.test(error ?? '') ? 404 : 0);
      status = classifyCredentialStatus(code);
    }
    await sql`
      update provider_credentials set
        last_status = ${status},
        last_checked_at = now(),
        cooldown_until = ${status === 'ok' ? null : new Date(Date.now() + 60_000)}
      where id = ${credential.id}
    `;
    results.push({
      id: credential.id,
      label: credential.label,
      maskedSecret: `••••${credential.secretLast4}`,
      status,
      error,
      latencyMs: Date.now() - started,
    });
  }
  return c.json({ results });
});

// ───────────────────────── admin: models for a key / usage ─────────────────────────

app.get('/api/admin/keys/:id/models', adminAuth, async (c) => {
  const key = await loadKeyById(c.req.param('id'));
  const result = await modelsForKey(key);
  return c.json({ models: result.all });
});

app.post('/api/admin/keys/:id/models/sync', adminAuth, async (c) => {
  const key = await loadKeyById(c.req.param('id'));
  await syncModelsForKey(key.id);
  const result = await modelsForKey(key);
  return c.json({ models: result.all });
});

app.patch('/api/admin/keys/:id/models', adminAuth, async (c) => {
  const key = await loadKeyById(c.req.param('id'));
  const body = parseBody(
    z.object({ allowedModels: z.array(z.string().min(1).max(200)).max(1000) }),
    await readJson(c),
  );
  const sql = await db();
  await sql`update api_keys set allowed_models = ${body.allowedModels} where id = ${key.id}`;
  return c.json({ ok: true, allowedModels: body.allowedModels });
});

app.get('/api/admin/keys/:id/usage', adminAuth, async (c) => {
  const key = await loadKeyById(c.req.param('id'));
  const days = Number(c.req.query('days') ?? 30);
  return c.json(await getKeyUsage(key.id, Number.isFinite(days) ? days : 30));
});

app.post('/api/admin/playground/chat', adminAuth, async (c) => {
  c.set('errorFormat', 'openai_chat');
  const raw = (await readJson(c)) as any;
  const body = parseBody(
    z.object({
      keyId: z.string().uuid(),
      model: z.string().min(1).max(200),
      messages: z.array(z.any()).min(1).max(200),
      max_tokens: z.number().int().positive().max(32000).optional(),
      stream: z.boolean().optional(),
    }),
    raw,
  );
  const key = await loadKeyById(body.keyId);
  const request = parseIncoming(() =>
    parseOpenAIChat({
      model: body.model,
      messages: body.messages,
      max_tokens: body.max_tokens,
      stream: body.stream === true,
    }),
  );
  request.stream = body.stream === true;
  const result = await runGateway({
    key,
    format: 'openai_chat',
    endpoint: 'playground',
    request,
  });
  if (result.kind === 'stream') return result.response;
  return c.json(result.body);
});

app.get('/api/admin/usage/summary', adminAuth, async (c) => {
  const daysParam = Number(c.req.query('days') ?? 14);
  const days = Number.isFinite(daysParam) ? daysParam : 14;
  const [totals, keys, daily] = await Promise.all([getTotals(), keyUsageList(), getDailyOverview(days)]);
  return c.json({ totals, keys, daily });
});

app.get('/api/admin/usage/logs', adminAuth, async (c) => {
  const sql = await db();
  const limit = Math.max(1, Math.min(200, Number(c.req.query('limit') ?? 50)));
  const keyId = c.req.query('keyId');
  const rows = keyId
    ? await sql<any[]>`
        select id::text, api_key_id, endpoint, model, status, http_status, latency_ms, input_tokens, output_tokens, error, created_at
        from request_logs where api_key_id = ${keyId} order by created_at desc limit ${limit}
      `
    : await sql<any[]>`
        select id::text, api_key_id, endpoint, model, status, http_status, latency_ms, input_tokens, output_tokens, error, created_at
        from request_logs order by created_at desc limit ${limit}
      `;
  return c.json({
    logs: rows.map((r) => ({
      id: r.id,
      apiKeyId: r.apiKeyId,
      endpoint: r.endpoint,
      model: r.model,
      status: r.status,
      httpStatus: r.httpStatus,
      latencyMs: r.latencyMs,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      error: r.error,
      at: r.createdAt,
    })),
  });
});

// ───────────────────────── public OpenAI / Anthropic API ─────────────────────────

app.get('/api/v1/me', apiKeyAuth, async (c) => {
  const key = c.get('apiKey');
  const usage = await getKeyUsage(key.id, 1);
  return c.json({ key: publicKeyInfo(key), usage: usage.totals });
});

app.get('/api/v1/models', apiKeyAuth, async (c) => {
  const key = c.get('apiKey');
  const { models } = await modelsForKey(key);
  return c.json({
    object: 'list',
    data: models.map((model) => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: model.ownedBy ?? 'sufi-gateway',
      display_name: model.displayName,
      context_window: model.contextWindow,
      max_output_tokens: model.maxOutput,
    })),
  });
});

app.post('/api/v1/chat/completions', apiKeyAuth, async (c) => {
  c.set('errorFormat', 'openai_chat');
  const key = c.get('apiKey');
  const raw = await readJson(c);
  const request = parseIncoming(() => parseOpenAIChat(raw as any));
  const result = await runGateway({ key, format: 'openai_chat', endpoint: 'chat.completions', request });
  if (result.kind === 'stream') return result.response;
  return c.json(result.body);
});

app.post('/api/v1/responses', apiKeyAuth, async (c) => {
  c.set('errorFormat', 'openai_responses');
  const key = c.get('apiKey');
  const raw = await readJson(c);
  const request = parseIncoming(() => parseOpenAIResponses(raw as any));
  const result = await runGateway({ key, format: 'openai_responses', endpoint: 'responses', request });
  if (result.kind === 'stream') return result.response;
  return c.json(result.body);
});

app.post('/api/v1/messages', apiKeyAuth, async (c) => {
  c.set('errorFormat', 'anthropic');
  const key = c.get('apiKey');
  const raw = await readJson(c);
  const request = parseIncoming(() => parseAnthropic(raw as any));
  const result = await runGateway({ key, format: 'anthropic', endpoint: 'messages', request });
  if (result.kind === 'stream') return result.response;
  return c.json(result.body);
});

// ───────────────────────── errors ─────────────────────────

app.notFound((c) =>
  c.json({ error: { message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}`, type: 'invalid_request_error', code: 'not_found' } }, 404),
);

app.onError((error, c) => {
  if (error instanceof HttpError) {
    const format = c.get('errorFormat') ?? 'openai';
    const body = format === 'anthropic' ? anthropicError(error) : openAiError(error);
    return c.json(body, error.status as any, error.headers as any);
  }
  console.error('Unhandled error:', error);
  const format = c.get('errorFormat') ?? 'openai';
  const fallback = new HttpError(500, 'Unexpected server error.', 'server_error', 'internal_error');
  const body = format === 'anthropic' ? anthropicError(fallback) : openAiError(fallback);
  return c.json(body, 500);
});

export { app };
