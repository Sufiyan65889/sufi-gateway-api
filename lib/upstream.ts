import { getConfig } from './config';
import { redactSecrets } from './crypto';
import type { CanonicalRequest, Protocol, UpstreamModel, ProviderRecord } from './types';
import { buildUpstreamPayload } from './adapters';

export type UpstreamFailure = {
  ok: false;
  status: number;
  error: string;
  shouldFailover: boolean;
  retryAfterSeconds?: number;
};

export type UpstreamSuccess = {
  ok: true;
  response: Response;
};

export type UpstreamAttempt = UpstreamFailure | UpstreamSuccess;

export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('Base URL is not a valid URL');
  }
  const config = getConfig();
  if (url.protocol !== 'https:' && !(config.allowLocalProvider && url.protocol === 'http:')) {
    throw new Error('Base URL must use https://');
  }
  if (!config.allowLocalProvider && isPrivateHost(url.hostname)) {
    throw new Error('Base URL cannot point to a private or local address');
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!/\/v\d+[a-z0-9]*$/i.test(url.pathname)) {
    url.pathname = `${url.pathname}/v1`.replace(/\/+/g, '/');
  }
  return url.toString().replace(/\/$/, '');
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1') return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const private172 = /^172\.(\d+)\./.exec(host);
  if (private172) {
    const second = Number(private172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return true;
  return false;
}

export function providerEndpoint(provider: ProviderRecord, suffix: string): string {
  const base = normalizeBaseUrl(provider.baseUrl);
  return `${base}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

export function providerHeaders(protocol: Protocol, secret: string, stream: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    accept: stream ? 'text/event-stream' : 'application/json',
    'content-type': 'application/json',
    'user-agent': 'SufiGateway/2.0',
    'x-title': 'Sufi Gateway',
  };
  if (protocol === 'anthropic') {
    headers['x-api-key'] = secret;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = `Bearer ${secret}`;
    headers['http-referer'] = getConfig().publicBaseUrl;
  }
  return headers;
}

function upstreamUrl(provider: ProviderRecord): string {
  if (provider.protocol === 'openai_chat') return providerEndpoint(provider, '/chat/completions');
  if (provider.protocol === 'openai_responses') return providerEndpoint(provider, '/responses');
  return providerEndpoint(provider, '/messages');
}

function shouldFailover(status: number): boolean {
  return status === 401 || status === 403 || status === 402 || status === 408 || status === 429 || status >= 500;
}

function providerErrorMessage(text: string, status: number, secrets: string[]): string {
  let message = text.trim();
  try {
    const json = JSON.parse(text);
    message = json?.error?.message ?? json?.message ?? json?.error ?? message;
    if (typeof message !== 'string') message = JSON.stringify(message);
  } catch {
    // keep text
  }
  message = redactSecrets(message, secrets).replace(/\s+/g, ' ').trim();
  if (message.length > 300) message = `${message.slice(0, 300)}…`;
  return message || `Provider returned HTTP ${status}`;
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 300);
  return undefined;
}

export async function startUpstream(
  provider: ProviderRecord,
  secret: string,
  request: CanonicalRequest,
  stream: boolean,
): Promise<UpstreamAttempt> {
  const payload = buildUpstreamPayload(provider.protocol, request, stream);
  const url = upstreamUrl(provider);
  const headers = providerHeaders(provider.protocol, secret, stream);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(280_000),
      redirect: 'follow',
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        status: response.status,
        error: providerErrorMessage(text, response.status, [secret]),
        shouldFailover: shouldFailover(response.status),
        retryAfterSeconds: retryAfterSeconds(response),
      };
    }
    return { ok: true, response };
  } catch (error: any) {
    const name = String(error?.name ?? '');
    const isTimeout = name === 'TimeoutError' || name === 'AbortError';
    return {
      ok: false,
      status: 0,
      error: isTimeout ? 'Provider timed out after 280 seconds' : redactSecrets(String(error?.message ?? error), [secret]).slice(0, 300),
      shouldFailover: true,
    };
  }
}

export async function readUpstreamJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Provider returned invalid JSON: ${text.slice(0, 160)}`);
  }
}

function parseModel(raw: any): UpstreamModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : typeof raw.model === 'string' ? raw.model : '';
  if (!id) return null;
  const contextWindow =
    numberValue(raw.context_window) ??
    numberValue(raw.context_length) ??
    numberValue(raw.max_context_length) ??
    numberValue(raw.max_model_len) ??
    numberValue(raw.max_input_tokens) ??
    numberValue(raw.input_token_limit) ??
    numberValue(raw.top_provider?.context_length);
  const maxOutput =
    numberValue(raw.max_output_tokens) ??
    numberValue(raw.max_completion_tokens) ??
    numberValue(raw.output_token_limit) ??
    numberValue(raw.max_tokens) ??
    numberValue(raw.top_provider?.max_completion_tokens);
  return {
    id,
    displayName: typeof raw.display_name === 'string' ? raw.display_name : typeof raw.name === 'string' ? raw.name : undefined,
    ownedBy: typeof raw.owned_by === 'string' ? raw.owned_by : typeof raw.organization === 'string' ? raw.organization : undefined,
    contextWindow,
    maxOutput,
  };
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export async function fetchUpstreamModels(provider: ProviderRecord, secret: string): Promise<UpstreamModel[]> {
  const base = normalizeBaseUrl(provider.baseUrl);
  const headers = providerHeaders(provider.protocol, secret, false);
  const collected: UpstreamModel[] = [];
  let after: string | null = null;
  for (let page = 0; page < 5; page++) {
    const url = new URL(`${base}/models`);
    if (provider.protocol === 'anthropic') {
      url.searchParams.set('limit', '1000');
      if (after) url.searchParams.set('after_id', after);
    }
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const error = new Error(providerErrorMessage(text, response.status, [secret]));
      (error as any).status = response.status;
      throw error;
    }
    const json: any = await response.json();
    const data = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    for (const raw of data) {
      const model = parseModel(raw);
      if (model && !collected.some((m) => m.id === model.id)) collected.push(model);
    }
    if (provider.protocol !== 'anthropic') break;
    if (json?.has_more === true && typeof json?.last_id === 'string') {
      after = json.last_id;
      continue;
    }
    break;
  }
  collected.sort((a, b) => a.id.localeCompare(b.id));
  return collected;
}

export function classifyCredentialStatus(status: number): string {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'rejected';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server_error';
  if (status === 0) return 'network';
  return 'client_error';
}

export function classifyProviderError(status: number): string {
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'provider_error';
  return 'invalid_request_error';
}
