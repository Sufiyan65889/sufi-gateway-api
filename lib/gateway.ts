import type { ApiKeyWithProvider, CanonicalRequest, CredentialRecord, IncomingFormat, ProviderRecord, Usage } from './types';
import { db } from './db';
import { decryptSecret, maskApiKey } from './crypto';
import { HttpError } from './errors';
import {
  consumeUpstreamStream,
  formatByIncoming,
  makeStreamFormatter,
  parseUpstreamJson,
} from './adapters';
import {
  classifyProviderError,
  fetchUpstreamModels,
  readUpstreamJson,
  startUpstream,
} from './upstream';
import { getSettings, dayKeyFor } from './settings';
import { recordRejected, recordUsage } from './usage';

type GatewayJson = { kind: 'json'; body: any };
type GatewayStream = { kind: 'stream'; response: Response };
export type GatewayResult = GatewayJson | GatewayStream;

function providerOf(key: ApiKeyWithProvider): ProviderRecord {
  return {
    id: key.providerId,
    name: key.providerName,
    protocol: key.providerProtocol,
    baseUrl: key.providerBaseUrl,
  };
}

function asNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function retrySecondsForMinute(): number {
  const now = new Date();
  return Math.max(1, 60 - now.getUTCSeconds());
}

async function reserveLimits(key: ApiKeyWithProvider): Promise<{ dayKey: string }> {
  const settings = await getSettings();
  const dayKey = dayKeyFor(settings.timezone);
  const sql = await db();
  const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const rpm = asNumber(key.rpm);
  const rpd = asNumber(key.rpd);
  const tpd = asNumber(key.tpd);

  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${key.id}))`;
    if (rpm != null && rpm > 0) {
      const [row] = await tx<any[]>`
        insert into usage_minute (api_key_id, minute, requests) values (${key.id}, ${minute}, 1)
        on conflict (api_key_id, minute) do update set requests = usage_minute.requests + 1
        returning requests
      `;
      if (Number(row.requests) > rpm) {
        throw new HttpError(429, `RPM limit reached (${rpm}/minute).`, 'rate_limit_error', 'rpm_limit', {
          'retry-after': String(retrySecondsForMinute()),
        });
      }
    }
    if (rpd != null && rpd > 0) {
      const [row] = await tx<any[]>`
        insert into usage_daily (api_key_id, day, requests) values (${key.id}, ${dayKey}, 1)
        on conflict (api_key_id, day) do update set requests = usage_daily.requests + 1
        returning requests
      `;
      if (Number(row.requests) > rpd) {
        throw new HttpError(429, `Requests-per-day limit reached (${rpd}/day).`, 'rate_limit_error', 'rpd_limit', {
          'retry-after': '60',
        });
      }
    }
    if (tpd != null && tpd > 0) {
      const [row] = await tx<any[]>`
        select coalesce(input_tokens, 0) + coalesce(output_tokens, 0) as tokens
        from usage_daily where api_key_id = ${key.id} and day = ${dayKey}
      `;
      if (Number(row?.tokens ?? 0) >= tpd) {
        throw new HttpError(429, `Tokens-per-day limit reached (${tpd}/day).`, 'rate_limit_error', 'tpd_limit', {
          'retry-after': '60',
        });
      }
    }
    return { dayKey };
  });
}

async function activeCredentials(keyId: string): Promise<CredentialRecord[]> {
  const sql = await db();
  return sql<CredentialRecord[]>`
    select * from provider_credentials
    where api_key_id = ${keyId} and active = true
    order by created_at asc
  `;
}

function orderedCredentials(records: CredentialRecord[], routing: 'ordered' | 'random'): CredentialRecord[] {
  const now = Date.now();
  const ready: CredentialRecord[] = [];
  const cooling: CredentialRecord[] = [];
  for (const record of records) {
    const until = record.cooldownUntil ? new Date(record.cooldownUntil).getTime() : 0;
    if (until > now) cooling.push(record);
    else ready.push(record);
  }
  if (routing === 'random') {
    for (let i = ready.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ready[i], ready[j]] = [ready[j], ready[i]];
    }
  }
  return [...ready, ...cooling];
}

async function markCredentialFailed(id: string, status: string, retryAfterSeconds?: number): Promise<void> {
  const sql = await db();
  const seconds = Math.max(5, Math.min(300, retryAfterSeconds ?? 60));
  await sql`
    update provider_credentials set
      cooldown_until = now() + (${seconds} || ' seconds')::interval,
      last_status = ${status},
      last_checked_at = now()
    where id = ${id}
  `;
}

async function markCredentialOk(id: string): Promise<void> {
  const sql = await db();
  await sql`
    update provider_credentials set
      cooldown_until = null,
      last_status = 'ok',
      last_checked_at = now()
    where id = ${id}
  `;
}

function keyHttpStatus(status: number): number {
  return status > 0 ? status : 502;
}

export async function syncModelsForKey(keyId: string): Promise<any[]> {
  const sql = await db();
  const [key] = await sql<ApiKeyWithProvider[]>`
    select k.*, p.name as provider_name, p.protocol as provider_protocol, p.base_url as provider_base_url
    from api_keys k join providers p on p.id = k.provider_id
    where k.id = ${keyId} limit 1
  `;
  if (!key) throw new HttpError(404, 'API key not found');
  const provider = providerOf(key);
  const credentials = await activeCredentials(key.id);
  if (!credentials.length) {
    throw new HttpError(400, 'Add at least one provider key to this API key first.', 'invalid_request_error', 'no_provider_keys');
  }
  let lastError = 'Could not fetch models from the provider';
  for (const credential of credentials.slice(0, 5)) {
    const secret = decryptSecret(credential.secretCiphertext, credential.secretIv, credential.secretTag);
    try {
      const models = await fetchUpstreamModels(provider, secret);
      await markCredentialOk(credential.id);
      await upsertModels(provider.id, models);
      return modelsForProvider(provider.id);
    } catch (error: any) {
      lastError = error instanceof HttpError ? error.message : String(error?.message ?? error);
      await markCredentialFailed(credential.id, 'model_sync_failed').catch(() => {});
    }
  }
  throw new HttpError(502, lastError, 'provider_error', 'models_failed');
}

export async function upsertModels(providerId: string, models: Array<{
  id: string;
  displayName?: string;
  ownedBy?: string;
  contextWindow?: number;
  maxOutput?: number;
}>): Promise<void> {
  const sql = await db();
  for (const model of models) {
    await sql`
      insert into provider_models
        (id, provider_id, model_id, display_name, owned_by, context_window, max_output)
      values
        (gen_random_uuid(), ${providerId}, ${model.id}, ${model.displayName ?? null}, ${model.ownedBy ?? null},
         ${model.contextWindow ?? null}, ${model.maxOutput ?? null})
      on conflict (provider_id, model_id) do update set
        display_name = coalesce(excluded.display_name, provider_models.display_name),
        owned_by = coalesce(excluded.owned_by, provider_models.owned_by),
        context_window = coalesce(excluded.context_window, provider_models.context_window),
        max_output = coalesce(excluded.max_output, provider_models.max_output),
        updated_at = now()
    `;
  }
}

export async function modelsForProvider(providerId: string): Promise<any[]> {
  const sql = await db();
  const rows = await sql<any[]>`
    select id, model_id, display_name, owned_by, context_window, max_output, enabled, created_at
    from provider_models where provider_id = ${providerId} order by model_id asc
  `;
  return rows.map((r) => ({
    id: r.modelId,
    modelId: r.modelId,
    displayName: r.displayName,
    ownedBy: r.ownedBy,
    contextWindow: r.contextWindow == null ? null : Number(r.contextWindow),
    maxOutput: r.maxOutput == null ? null : Number(r.maxOutput),
    enabled: r.enabled,
    createdAt: r.createdAt,
  }));
}

export async function modelsForKey(key: ApiKeyWithProvider): Promise<{
  models: any[];
  all: any[];
}> {
  const sql = await db();
  let rows = await sql<any[]>`
    select * from provider_models where provider_id = ${key.providerId} order by model_id asc
  `;
  if (!rows.length) {
    await syncModelsForKey(key.id);
    rows = await sql<any[]>`
      select * from provider_models where provider_id = ${key.providerId} order by model_id asc
    `;
  }
  const allowed = new Set(key.allowedModels ?? []);
  const all = rows.map((r) => ({
    id: r.modelId,
    modelId: r.modelId,
    displayName: r.displayName,
    ownedBy: r.ownedBy,
    contextWindow: r.contextWindow == null ? null : Number(r.contextWindow),
    maxOutput: r.maxOutput == null ? null : Number(r.maxOutput),
    enabled: r.enabled,
    allowed: allowed.size === 0 ? r.enabled : allowed.has(r.modelId),
    createdAt: r.createdAt,
  }));
  const models = all.filter((m) => m.enabled && (allowed.size === 0 || allowed.has(m.id)));
  return { models, all };
}

export async function assertModelAllowed(key: ApiKeyWithProvider, model: string): Promise<void> {
  const allowed = key.allowedModels ?? [];
  if (allowed.length > 0) {
    if (!allowed.includes(model)) {
      throw new HttpError(400, `Model "${model}" is not allowed for this API key.`, 'invalid_request_error', 'model_not_allowed');
    }
    return;
  }
  const { models } = await modelsForKey(key);
  if (!models.some((m) => m.id === model)) {
    throw new HttpError(
      400,
      `Model "${model}" is not enabled. Add it from the admin Models panel first.`,
      'invalid_request_error',
      'model_not_allowed',
    );
  }
}

function streamResponse(params: {
  upstream: Response;
  format: IncomingFormat;
  model: string;
  key: ApiKeyWithProvider;
  provider: ProviderRecord;
  credentialId: string;
  endpoint: string;
  startedAt: number;
  dayKey: string;
}): Response {
  const formatter = makeStreamFormatter(params.format, params.model);
  const encoder = new TextEncoder();
  let usage: Usage = {};
  let closed = false;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (text: string) => {
        if (closed || !text) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };
      emit(formatter.start());
      try {
        if (!params.upstream.body) throw new Error('Provider returned an empty stream');
        const result = await consumeUpstreamStream(
          params.provider.protocol,
          params.upstream.body,
          (delta) => emit(formatter.delta(delta)),
          (u) => { usage = { ...usage, ...u }; },
        );
        usage = {
          inputTokens: result.usage.inputTokens ?? usage.inputTokens,
          outputTokens: result.usage.outputTokens ?? usage.outputTokens,
        };
        emit(formatter.finish(usage, result.finishReason));
        await recordUsage({
          apiKey: params.key,
          providerId: params.provider.id,
          credentialId: params.credentialId,
          endpoint: params.endpoint,
          model: params.model,
          ok: true,
          httpStatus: 200,
          latencyMs: Date.now() - params.startedAt,
          usage,
          dayKey: params.dayKey,
        }).catch((error) => console.error('usage log failed', error));
      } catch (error: any) {
        const message = String(error?.message ?? error).slice(0, 300);
        emit(formatter.error(message));
        await recordUsage({
          apiKey: params.key,
          providerId: params.provider.id,
          credentialId: params.credentialId,
          endpoint: params.endpoint,
          model: params.model,
          ok: false,
          httpStatus: 502,
          latencyMs: Date.now() - params.startedAt,
          usage,
          error: message,
          dayKey: params.dayKey,
        }).catch((logError) => console.error('usage log failed', logError));
      } finally {
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

export async function runGateway(params: {
  key: ApiKeyWithProvider;
  format: IncomingFormat;
  endpoint: string;
  request: CanonicalRequest;
}): Promise<GatewayResult> {
  const { key, format, endpoint, request } = params;
  const provider = providerOf(key);
  const wantsStream = request.stream === true;
  if (wantsStream && !key.streaming) {
    throw new HttpError(400, 'Streaming is disabled for this API key.', 'invalid_request_error', 'streaming_disabled');
  }
  const stream = wantsStream;
  await assertModelAllowed(key, request.model);

  let dayKey: string;
  try {
    ({ dayKey } = await reserveLimits(key));
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) {
      await recordRejected(key.id, endpoint, request.model, error.message).catch(() => {});
    }
    throw error;
  }

  const startedAt = Date.now();
  const credentials = orderedCredentials(await activeCredentials(key.id), key.routing);
  if (!credentials.length) {
    const message = 'No provider keys configured for this API key.';
    await recordUsage({
      apiKey: key,
      providerId: provider.id,
      credentialId: null,
      endpoint,
      model: request.model,
      ok: false,
      httpStatus: 502,
      latencyMs: Date.now() - startedAt,
      usage: {},
      error: message,
      dayKey,
    }).catch(() => {});
    throw new HttpError(502, message, 'provider_error', 'no_provider_keys');
  }

  let lastError = 'All provider keys failed';
  let lastStatus = 502;
  let lastCredentialId: string | null = null;

  for (const credential of credentials.slice(0, 5)) {
    lastCredentialId = credential.id;
    let secret: string;
    try {
      secret = decryptSecret(credential.secretCiphertext, credential.secretIv, credential.secretTag);
    } catch {
      lastError = 'A saved provider key could not be decrypted. Remove and re-add it.';
      lastStatus = 500;
      continue;
    }

    const attempt = await startUpstream(provider, secret, request, stream);
    if (!attempt.ok) {
      lastError = attempt.error;
      lastStatus = attempt.status || 502;
      await markCredentialFailed(credential.id, classifyProviderError(attempt.status), attempt.retryAfterSeconds).catch(() => {});
      if (!attempt.shouldFailover) break;
      continue;
    }

    await markCredentialOk(credential.id).catch(() => {});

    if (stream) {
      return {
        kind: 'stream',
        response: streamResponse({
          upstream: attempt.response,
          format,
          model: request.model,
          key,
          provider,
          credentialId: credential.id,
          endpoint,
          startedAt,
          dayKey,
        }),
      };
    }

    try {
      const json = await readUpstreamJson(attempt.response);
      const parsed = parseUpstreamJson(provider.protocol, json);
      const body = formatByIncoming(format, parsed, request.model);
      await recordUsage({
        apiKey: key,
        providerId: provider.id,
        credentialId: credential.id,
        endpoint,
        model: request.model,
        ok: true,
        httpStatus: 200,
        latencyMs: Date.now() - startedAt,
        usage: parsed.usage,
        dayKey,
      }).catch(() => {});
      return { kind: 'json', body };
    } catch (error: any) {
      lastError = String(error?.message ?? error).slice(0, 300);
      lastStatus = 502;
      await markCredentialFailed(credential.id, 'parse_error').catch(() => {});
    }
  }

  await recordUsage({
    apiKey: key,
    providerId: provider.id,
    credentialId: lastCredentialId,
    endpoint,
    model: request.model,
    ok: false,
    httpStatus: keyHttpStatus(lastStatus),
    latencyMs: Date.now() - startedAt,
    usage: {},
    error: lastError,
    dayKey,
  }).catch(() => {});
  throw new HttpError(502, lastError, 'provider_error', 'provider_failed');
}

export function publicKeyInfo(key: ApiKeyWithProvider) {
  return {
    id: key.id,
    label: key.label,
    maskedKey: maskApiKey(key.keyPrefix, key.keyLast4),
    provider: key.providerName,
    protocol: key.providerProtocol,
    limits: { rpm: key.rpm, rpd: key.rpd, tpd: key.tpd == null ? null : Number(key.tpd) },
    routing: key.routing,
    streaming: key.streaming,
    models: key.allowedModels,
    active: key.active,
  };
}
