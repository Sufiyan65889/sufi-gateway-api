// Bundled entry for Vercel. Build: npm run build:fn
import { handle } from 'hono/vercel';
import { app } from '../lib/app.js';

export { app };
export default handle(app);
