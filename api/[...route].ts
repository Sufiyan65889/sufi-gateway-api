// Vercel entry. The real app is bundled into ./_bundle.mjs by `npm run build:fn`
// so ESM resolution never depends on Vercel's per-file transpile step.
import handler, { app } from './_bundle.mjs';

export { app };
export default handler;
