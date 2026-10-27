import { handle } from 'hono/vercel';
import { app } from '../lib/app';

export const config = {
  runtime: 'nodejs',
  maxDuration: 300,
};

export default handle(app);
