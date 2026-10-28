// Shared Vercel handler. Re-exported by every depth of the catch-all entries
// because Vercel's function router matches a single dynamic segment per file.
import { app } from './_bundle.mjs';

export const fetch = (request) => app.fetch(request);

export default { fetch };
