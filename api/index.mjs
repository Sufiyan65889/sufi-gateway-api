// Single Vercel function. vercel.json sends every path here while preserving the
// original URL, and the whole Hono app lives in ./_bundle.mjs (built on install).
import { app } from './_bundle.mjs';

const handler = (request) => {
  const url = new URL(request.url);
  // Public API is served at /v1/*; the Hono routes live under /api/v1/*.
  if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
    url.pathname = `/api${url.pathname}`;
    return app.fetch(new Request(url.toString(), request));
  }
  return app.fetch(request);
};

export const fetch = handler;

export default { fetch: handler };
