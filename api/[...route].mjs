// Vercel entry (plain ESM, no TypeScript step).
// The whole app is bundled into ./_bundle.mjs by `npm run build:fn` (postinstall),
// so Node never has to resolve extensionless local modules at runtime.
import handler from './_bundle.mjs';

export default handler;
