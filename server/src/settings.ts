import { inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { setting } from "./db/schema.js";

/**
 * Settings the admin manages in the admin panel. The defaults are safe
 * development values; production values live only in the database.
 */
export const SETTING_RULES = {
  /** Heartbeat interval sent to agents (decision D4). */
  heartbeatIntervalSeconds: { key: "heartbeat_interval_seconds", default: 60, min: 30, max: 600 },
  /** Raw heartbeats and events are deleted after this many days. */
  retentionDays: { key: "retention_days", default: 30, min: 8, max: 3650 },
} as const;

export type SettingName = keyof typeof SETTING_RULES;
export type Settings = Record<SettingName, number>;

const NAMES = Object.keys(SETTING_RULES) as SettingName[];

// biome-ignore lint/suspicious/noExplicitAny: any Drizzle PostgreSQL database or transaction.
type Database = PgDatabase<PgQueryResultHKT, any, any>;

function valid(name: SettingName, value: unknown): value is number {
  const rule = SETTING_RULES[name];
  return Number.isInteger(value) && (value as number) >= rule.min && (value as number) <= rule.max;
}

/** The current settings; a missing or out-of-range value falls back to its default. */
export async function readSettings(db: Database): Promise<Settings> {
  const rows = await db
    .select({ key: setting.key, value: setting.value })
    .from(setting)
    .where(
      inArray(
        setting.key,
        NAMES.map((name) => SETTING_RULES[name].key),
      ),
    );
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const settings = {} as Settings;
  for (const name of NAMES) {
    const value = stored.get(SETTING_RULES[name].key);
    settings[name] = valid(name, value) ? value : SETTING_RULES[name].default;
  }
  return settings;
}

/** Checks a partial update. Returns the first invalid setting, or the update. */
export function parseSettingsUpdate(
  body: Record<string, unknown>,
): { ok: true; update: Partial<Settings> } | { ok: false; field: string } {
  const update: Partial<Settings> = {};
  for (const name of NAMES) {
    if (body[name] === undefined) {
      continue;
    }
    if (!valid(name, body[name])) {
      return { ok: false, field: name };
    }
    update[name] = body[name];
  }
  return { ok: true, update };
}

/** Stores the given settings, inside the caller's transaction. */
export async function writeSettings(
  db: Database,
  update: Partial<Settings>,
  actor: string,
  now = new Date(),
): Promise<void> {
  for (const name of NAMES) {
    const value = update[name];
    if (value === undefined) {
      continue;
    }
    await db
      .insert(setting)
      .values({ key: SETTING_RULES[name].key, value, updatedAt: now, updatedBy: actor })
      .onConflictDoUpdate({
        target: setting.key,
        set: { value: sql`excluded.value`, updatedAt: now, updatedBy: actor },
      });
  }
}
