import { db } from './db';
import type { SettingsRecord } from './types';

export async function getSettings(): Promise<SettingsRecord> {
  const sql = await db();
  const [row] = await sql<SettingsRecord[]>`
    select id, default_rpm, default_rpd, default_tpd, default_streaming, timezone
    from settings where id = 1
  `;
  if (row) return row;
  const [created] = await sql<SettingsRecord[]>`
    insert into settings (id) values (1)
    on conflict (id) do update set id = 1
    returning id, default_rpm, default_rpd, default_tpd, default_streaming, timezone
  `;
  return created;
}

export async function saveSettings(input: {
  defaultRpm?: number | null;
  defaultRpd?: number | null;
  defaultTpd?: number | null;
  defaultStreaming?: boolean;
  timezone?: string;
}): Promise<SettingsRecord> {
  const sql = await db();
  const [row] = await sql<SettingsRecord[]>`
    update settings set
      default_rpm = ${input.defaultRpm === undefined ? sql`default_rpm` : input.defaultRpm},
      default_rpd = ${input.defaultRpd === undefined ? sql`default_rpd` : input.defaultRpd},
      default_tpd = ${input.defaultTpd === undefined ? sql`default_tpd` : input.defaultTpd},
      default_streaming = ${input.defaultStreaming === undefined ? sql`default_streaming` : input.defaultStreaming},
      timezone = ${input.timezone === undefined ? sql`timezone` : input.timezone},
      updated_at = now()
    where id = 1
    returning id, default_rpm, default_rpd, default_tpd, default_streaming, timezone
  `;
  return row;
}

export function dayKeyFor(timezone: string, date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }
}
