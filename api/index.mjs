// Single Vercel function. vercel.json sends every path here while preserving the
// original URL, and the whole Hono app lives in ./_bundle.mjs (built on install).
import { app } from './_bundle.mjs';

const KEY_DETAIL = /^\/api\/admin\/keys\/([0-9a-fA-F-]{36})$/;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });

// Key details must stay usable while a key has no provider keys yet: the admin
// handler syncs the model list and fails with 400 in that state, which used to
// blank the whole screen. Degrade to an empty-but-valid payload instead.
async function keyDetailFallback(request, url, id) {
  const listResponse = await app.fetch(
    new Request(new URL('/api/admin/keys', url).toString(), { method: 'GET', headers: request.headers }),
  );
  if (!listResponse.ok) return null;
  const list = await listResponse.json().catch(() => null);
  const key = list?.keys?.find((entry) => entry.id === id);
  if (!key) return null;
  return json({
    key,
    credentials: [],
    models: [],
    modelsError: 'Add a provider key to load the model list.',
    usage: { totals: {}, daily: [], recent: [] },
  });
}

const handler = async (request) => {
  const url = new URL(request.url);
  // Public API is served at /v1/*; the Hono routes live under /api/v1/*.
  if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
    url.pathname = `/api${url.pathname}`;
    return app.fetch(new Request(url.toString(), request));
  }

  const response = await app.fetch(request);

  const match = url.pathname.match(KEY_DETAIL);
  if (request.method === 'GET' && match && response.status === 400) {
    const body = await response.clone().json().catch(() => null);
    if (body?.error?.code === 'no_provider_keys') {
      const fallback = await keyDetailFallback(request, url, match[1]);
      if (fallback) return fallback;
    }
  }
  return response;
};

export const fetch = handler;

export default { fetch: handler };
