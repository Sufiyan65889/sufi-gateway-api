// Vercel entry (Node runtime, Web fetch signature).
// The whole Hono app is bundled into ./_bundle.mjs by `npm run build:fn`
// during install, so no TypeScript step and no ESM extension issues.
import { app } from './_bundle.mjs';

export const fetch = (request) => app.fetch(request);

export default { fetch };
