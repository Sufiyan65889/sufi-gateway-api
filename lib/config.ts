export type AppConfig = {
  databaseUrl: string;
  databaseSsl: boolean;
  jwtSecret: string;
  encryptionKey: string;
  setupToken: string;
  publicBaseUrl: string;
  allowLocalProvider: boolean;
};

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function getConfig(): AppConfig {
  return {
    databaseUrl: process.env.DATABASE_URL ?? '',
    databaseSsl: process.env.DATABASE_SSL !== 'disable',
    jwtSecret: process.env.JWT_SECRET ?? '',
    encryptionKey: process.env.ENCRYPTION_KEY ?? '',
    setupToken: process.env.SETUP_TOKEN ?? '',
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? 'https://sufi-gateway-api.vercel.app').replace(/\/+$/, ''),
    allowLocalProvider: boolEnv('ALLOW_LOCAL_PROVIDER', false),
  };
}

export function requireSecret(name: 'JWT_SECRET' | 'ENCRYPTION_KEY'): string {
  const value = getConfig()[name === 'JWT_SECRET' ? 'jwtSecret' : 'encryptionKey'];
  if (!value || value.startsWith('change-me')) {
    throw new Error(`${name} is not configured. Add it in Vercel Environment Variables.`);
  }
  return value;
}

export const APP_VERSION = '2.0.0';
