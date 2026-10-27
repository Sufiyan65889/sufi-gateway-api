import { db } from './db';
import type { ApiKeyRecord, ApiKeyWithProvider, Usage } from './types';

export type UsageTotals = {
  requests: number;
  success: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgLatencyMs: number | null;
  lastLatencyMs: number | null;
  lastUsedAt: string | null;
};

export type KeyUsageRow = UsageTotals & {
  id: string;
  label: string;
  maskedKey: string;
  active: boolean;
  rpm: number | null;
  rpd: number | null;
  tpd: number | null;
  providerId: string;
  providerName: string;
  providerProtocol: string;
  credentialCount: number;
};

function n(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Number(value) || 0;
  return 0;
}

function iso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export async function keyUsageList(): Promise<KeyUsageRow[]> {
  const sql = await db();
  const rows = await sql<any[]>`
    select
      k.id, k.label, k.key_prefix, k.key_last4, k.active, k.rpm, k.rpd, k.tpd,
      k.created_at, k.last_used_at, k.revoked_at,
      p.id as provider_id, p.name as provider_name, p.protocol as provider_protocol,
      (select count(*)::int from provider_credentials c where c.api_key_id = k.id) as credential_count,
      coalesce(sum(u.requests), 0)::bigint as requests,
      coalesce(sum(u.success), 0)::bigint as success,
      coalesce(sum(u.failed), 0)::bigint as failed,
      coalesce(sum(u.input_tokens), 0)::bigint as input_tokens,
      coalesce(sum(u.output_tokens), 0)::bigint as output_tokens,
      case when coalesce(sum(u.latency_count), 0) > 0
        then round(sum(u.latency_sum_ms)::numeric / sum(u.latency_count))::int
        else null end as avg_latency_ms,
      (select r.latency_ms from request_logs r
        where r.api_key_id = k.id and r.latency_ms is not null
        order by r.created_at desc limit 1) as last_latency_ms
    from api_keys k
    join providers p on p.id = k.provider_id
    left join usage_daily u on u.api_key_id = k.id
    group by k.id, p.id
    order by k.created_at desc
  `;
  return rows.map((r) => {
    const inputTokens = n(r.inputTokens);
    const outputTokens = n(r.outputTokens);
    return {
      id: r.id,
      label: r.label,
      maskedKey: `${r.keyPrefix}${'•'.repeat(14)}${r.keyLast4}`,
      active: r.active,
      rpm: r.rpm == null ? null : n(r.rpm),
      rpd: r.rpd == null ? null : n(r.rpd),
      tpd: r.tpd == null ? null : n(r.tpd),
      providerId: r.providerId,
      providerName: r.providerName,
      providerProtocol: r.providerProtocol,
      credentialCount: n(r.credentialCount),
      requests: n(r.requests),
      success: n(r.success),
      failed: n(r.failed),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      avgLatencyMs: r.avgLatencyMs == null ? null : n(r.avgLatencyMs),
      lastLatencyMs: r.lastLatencyMs == null ? null : n(r.lastLatencyMs),
      lastUsedAt: iso(r.lastUsedAt),
    };
  });
}

export async function getKeyUsage(apiKeyId: string, days = 30): Promise<{
  totals: UsageTotals;
  daily: any[];
  recent: any[];
}> {
  const sql = await db();
  const limitDays = Math.max(1, Math.min(90, Math.floor(days) || 30));
  const [totals] = await sql<any[]>`
    select
      coalesce(sum(requests), 0)::bigint as requests,
      coalesce(sum(success), 0)::bigint as success,
      coalesce(sum(failed), 0)::bigint as failed,
      coalesce(sum(input_tokens), 0)::bigint as input_tokens,
      coalesce(sum(output_tokens), 0)::bigint as output_tokens,
      case when coalesce(sum(latency_count), 0) > 0
        then round(sum(latency_sum_ms)::numeric / sum(latency_count))::int
        else null end as avg_latency_ms
    from usage_daily where api_key_id = ${apiKeyId}
  `;
  const [last] = await sql<any[]>`
    select latency_ms, created_at from request_logs
    where api_key_id = ${apiKeyId} and latency_ms is not null
    order by created_at desc limit 1
  `;
  const [key] = await sql<any[]>`select last_used_at from api_keys where id = ${apiKeyId}`;
  const daily = await sql<any[]>`
    select day::text as day, requests::int, success::int, failed::int,
      input_tokens::bigint, output_tokens::bigint, latency_sum_ms::bigint, latency_count::int
    from usage_daily
    where api_key_id = ${apiKeyId} and day >= current_date - (${limitDays}::int - 1)
    order by day asc
  `;
  const recent = await sql<any[]>`
    select id::text, endpoint, model, status, http_status, latency_ms, input_tokens, output_tokens, error, created_at
    from request_logs where api_key_id = ${apiKeyId}
    order by created_at desc limit 50
  `;
  const inputTokens = n(totals?.inputTokens);
  const outputTokens = n(totals?.outputTokens);
  return {
    totals: {
      requests: n(totals?.requests),
      success: n(totals?.success),
      failed: n(totals?.failed),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      avgLatencyMs: totals?.avgLatencyMs == null ? null : n(totals.avgLatencyMs),
      lastLatencyMs: last?.latencyMs == null ? null : n(last.latencyMs),
      lastUsedAt: iso(key?.lastUsedAt),
    },
    daily: daily.map((d) => ({
      day: d.day,
      requests: n(d.requests),
      success: n(d.success),
      failed: n(d.failed),
      inputTokens: n(d.inputTokens),
      outputTokens: n(d.outputTokens),
      latencyMs: n(d.latencyCount) > 0 ? Math.round(n(d.latencySumMs) / n(d.latencyCount)) : null,
    })),
    recent: recent.map((r) => ({
      id: r.id,
      endpoint: r.endpoint,
      model: r.model,
      status: r.status,
      httpStatus: r.httpStatus == null ? null : n(r.httpStatus),
      latencyMs: r.latencyMs == null ? null : n(r.latencyMs),
      inputTokens: r.inputTokens == null ? null : n(r.inputTokens),
      outputTokens: r.outputTokens == null ? null : n(r.outputTokens),
      error: r.error,
      at: iso(r.createdAt),
    })),
  };
}

export async function getDailyOverview(days = 14): Promise<any[]> {
  const sql = await db();
  const limitDays = Math.max(1, Math.min(90, Math.floor(days) || 14));
  const rows = await sql<any[]>`
    select day::text as day,
      coalesce(sum(requests), 0)::bigint as requests,
      coalesce(sum(input_tokens), 0)::bigint as input_tokens,
      coalesce(sum(output_tokens), 0)::bigint as output_tokens,
      case when coalesce(sum(latency_count), 0) > 0
        then round(sum(latency_sum_ms)::numeric / sum(latency_count))::int else null end as latency_ms
    from usage_daily
    where day >= current_date - (${limitDays}::int - 1)
    group by day order by day asc
  `;
  return rows.map((r) => ({
    day: r.day,
    requests: n(r.requests),
    inputTokens: n(r.inputTokens),
    outputTokens: n(r.outputTokens),
    latencyMs: r.latencyMs == null ? null : n(r.latencyMs),
  }));
}

export async function recordUsage(input: {
  apiKey: ApiKeyWithProvider | ApiKeyRecord;
  providerId: string;
  credentialId: string | null;
  endpoint: string;
  model: string;
  ok: boolean;
  httpStatus: number;
  latencyMs: number;
  usage: Usage;
  error?: string | null;
  dayKey?: string;
}): Promise<void> {
  const sql = await db();
  const day = input.dayKey ?? new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const inputTokens = input.usage.inputTokens ?? 0;
  const outputTokens = input.usage.outputTokens ?? 0;
  try {
    await sql`
      insert into usage_daily (api_key_id, day) values (${input.apiKey.id}, ${day})
      on conflict (api_key_id, day) do nothing
    `;
    await sql`
      update usage_daily set
        success = success + ${input.ok ? 1 : 0},
        failed = failed + ${input.ok ? 0 : 1},
        input_tokens = input_tokens + ${inputTokens},
        output_tokens = output_tokens + ${outputTokens},
        latency_sum_ms = latency_sum_ms + ${Math.max(0, Math.round(input.latencyMs))},
        latency_count = latency_count + 1
      where api_key_id = ${input.apiKey.id} and day = ${day}
    `;
    await sql`update api_keys set last_used_at = now() where id = ${input.apiKey.id}`;
  } finally {
    await sql`
      insert into request_logs
        (api_key_id, provider_id, credential_id, endpoint, model, status, http_status, latency_ms, input_tokens, output_tokens, error)
      values
        (${input.apiKey.id}, ${input.providerId}, ${input.credentialId}, ${input.endpoint}, ${input.model},
         ${input.ok ? 'ok' : 'error'}, ${input.httpStatus}, ${Math.max(0, Math.round(input.latencyMs))},
         ${input.usage.inputTokens ?? null}, ${input.usage.outputTokens ?? null},
         ${input.error ? input.error.slice(0, 500) : null})
    `;
  }
}

export async function recordRejected(apiKeyId: string, endpoint: string, model: string, error: string): Promise<void> {
  const sql = await db();
  await sql`
    insert into request_logs (api_key_id, endpoint, model, status, http_status, error)
    values (${apiKeyId}, ${endpoint}, ${model}, 'rate_limited', 429, ${error.slice(0, 500)})
  `;
}

export async function getTotals(): Promise<UsageTotals> {
  const sql = await db();
  const [row] = await sql<any[]>`
    select
      coalesce(sum(requests), 0)::bigint as requests,
      coalesce(sum(success), 0)::bigint as success,
      coalesce(sum(failed), 0)::bigint as failed,
      coalesce(sum(input_tokens), 0)::bigint as input_tokens,
      coalesce(sum(output_tokens), 0)::bigint as output_tokens,
      case when coalesce(sum(latency_count), 0) > 0
        then round(sum(latency_sum_ms)::numeric / sum(latency_count))::int else null end as avg_latency_ms
    from usage_daily
  `;
  const inputTokens = n(row?.inputTokens);
  const outputTokens = n(row?.outputTokens);
  return {
    requests: n(row?.requests),
    success: n(row?.success),
    failed: n(row?.failed),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    avgLatencyMs: row?.avgLatencyMs == null ? null : n(row.avgLatencyMs),
    lastLatencyMs: null,
    lastUsedAt: null,
  };
}
