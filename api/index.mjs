// Single Vercel function. vercel.json sends every path here while preserving the
// original URL, and the whole Hono app lives in ./_bundle.mjs (built on install).
import { app } from './_bundle.mjs';

export const fetch = (request) => app.fetch(request);

export default { fetch };
