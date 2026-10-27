import { closeDb, db, seedProviders } from '../lib/db';

try {
  await db();
  const providers = await seedProviders();
  console.log(`Database ready. ${providers.length} provider presets available.`);
} catch (error) {
  console.error('Database init failed:', error);
  process.exitCode = 1;
} finally {
  await closeDb();
}
