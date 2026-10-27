import { serve } from '@hono/node-server';
import { app } from '../lib/app';

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Sufi Gateway API listening on http://localhost:${info.port}`);
  console.log('Public paths: /v1/... (Vercel rewrite) and /api/v1/... (direct)');
});
