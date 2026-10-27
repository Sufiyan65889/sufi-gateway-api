import postgres from 'postgres';
import { getConfig } from './config';
import { HttpError } from './errors';
import { uuid } from './crypto';
import type { ProviderRecord } from './types';

const schemaStatements = [
  `create table if not exists admins (
    id uuid primary key,
    email text not null unique,
    password_hash text not null,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists providers (
    id uuid primary key,
    name text not null unique,
    protocol text not null check (protocol in ('openai_chat','openai_responses','anthropic')),
    base_url text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists api_keys (
    id uuid primary key,
    label text not null,
    key_hash text not null unique,
    key_prefix text not null,
    key_last4 text not null,
    provider_id uuid not null references providers(id) on delete restrict,
    active boolean not null default true,
    routing text not null default 'ordered' check (routing in ('ordered','random')),
    streaming boolean not null default true,
    rpm integer,
    rpd integer,
    tpd bigint,
    allowed_models text[] not null default '{}',
    created_at timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at timestamptz
  )`,
  `create table if not exists provider_credentials (
    id uuid primary key,
    api_key_id uuid not null references api_keys(id) on delete cascade,
    label text not null default 'Provider key',
    secret_ciphertext text not null,
    secret_iv text not null,
    secret_tag text not null,
    secret_hash text not null,
    secret_last4 text not null,
    active boolean not null default true,
    cooldown_until timestamptz,
    last_status text,
    last_checked_at timestamptz,
    created_at timestamptz not null default now(),
    unique (api_key_id, secret_hash)
  )`,
  `create table if not exists provider_models (
    id uuid primary key,
    provider_id uuid not null references providers(id) on delete cascade,
    model_id text not null,
    display_name text,
    owned_by text,
    context_window bigint,
    max_output bigint,
    enabled boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (provider_id, model_id)
  )`,
  `create table if not exists usage_daily (
    api_key_id uuid not null references api_keys(id) on delete cascade,
    day date not null,
    requests bigint not null default 0,
    success bigint not null default 0,
    failed bigint not null default 0,
    input_tokens bigint not null default 0,
    output_tokens bigint not null default 0,
    latency_sum_ms bigint not null default 0,
    latency_count bigint not null default 0,
    primary key (api_key_id, day)
  )`,
  `create table if not exists usage_minute (
    api_key_id uuid not null references api_keys(id) on delete cascade,
    minute timestamptz not null,
    requests bigint not null default 0,
    primary key (api_key_id, minute)
  )`,
  `create table if not exists request_logs (
    id bigserial primary key,
    api_key_id uuid not null references api_keys(id) on delete cascade,
    provider_id uuid references providers(id) on delete set null,
    credential_id uuid references provider_credentials(id) on delete set null,
    endpoint text not null,
    model text,
    status text not null,
    http_status integer,
    latency_ms integer,
    input_tokens bigint,
    output_tokens bigint,
    error text,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists settings (
    id integer primary key check (id = 1),
    default_rpm integer,
    default_rpd integer,
    default_tpd bigint,
    default_streaming boolean not null default true,
    timezone text not null default 'Asia/Kolkata',
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists login_attempts (
    id bigserial primary key,
    ip text,
    email text,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists idx_api_keys_hash on api_keys (key_hash)`,
  `create index if not exists idx_credentials_key on provider_credentials (api_key_id)`,
  `create index if not exists idx_provider_models_provider on provider_models (provider_id)`,
  `create index if not exists idx_usage_daily_key_day on usage_daily (api_key_id, day desc)`,
  `create index if not exists idx_usage_minute_key_minute on usage_minute (api_key_id, minute desc)`,
  `create index if not exists idx_request_logs_key_time on request_logs (api_key_id, created_at desc)`,
  `create index if not exists idx_request_logs_time on request_logs (created_at desc)`,
  `create index if not exists idx_login_attempts_time on login_attempts (created_at desc)`,
  `insert into settings (id) values (1) on conflict (id) do nothing`,
];

let sqlClient: postgres.Sql | null = null;
let schemaPromise: Promise<void> | null = null;

function client(): postgres.Sql {
  if (sqlClient) return sqlClient;
  const config = getConfig();
  if (!config.databaseUrl) {
    throw new HttpError(503, 'DATABASE_URL is not configured. Add a Neon/Vercel Postgres database.', 'configuration_error');
  }
  sqlClient = postgres(config.databaseUrl, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
    ssl: config.databaseSsl ? 'require' : false,
    transform: postgres.camel,
    onnotice: () => {},
  });
  return sqlClient;
}

async function initSchema(): Promise<void> {
  const db = client();
  for (const statement of schemaStatements) {
    await db.unsafe(statement);
  }
}

export async function db(): Promise<postgres.Sql> {
  const sql = client();
  if (!schemaPromise) {
    schemaPromise = initSchema().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
  return sql;
}

export async function seedProviders(): Promise<ProviderRecord[]> {
  const sql = await db();
  const defaults = [
    { name: 'OpenAI', protocol: 'openai_chat', baseUrl: 'https://api.openai.com/v1' },
    { name: 'OpenAI Responses', protocol: 'openai_responses', baseUrl: 'https://api.openai.com/v1' },
    { name: 'OpenRouter', protocol: 'openai_chat', baseUrl: 'https://openrouter.ai/api/v1' },
    { name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  ];
  for (const p of defaults) {
    await sql`
      insert into providers (id, name, protocol, base_url)
      values (${uuid()}, ${p.name}, ${p.protocol}, ${p.baseUrl})
      on conflict (name) do nothing
    `;
  }
  return sql<ProviderRecord[]>`select * from providers order by created_at asc`;
}

export async function healthCheck(): Promise<boolean> {
  const sql = await db();
  const rows = await sql`select 1 as ok`;
  return rows.length > 0;
}

export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = null;
    schemaPromise = null;
  }
}

export type Sql = postgres.Sql;
