import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { setting } from "./db/schema.js";
import { parseTrustedProxies } from "./http/client-address.js";

/** Tiers the admin may choose for new agents: trusted is too generous for an unknown PC, and blocked would register and then refuse. */
export const NEW_AGENT_TIERS = ["low", "normal", "suspicious"] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validates a public URL and returns its origin. HTTPS is required, except
 * for a loopback host in local development, which browsers treat as a secure
 * context.
 */
export function parsePublicUrl(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  if (url.pathname !== "/") {
    return undefined;
  }
  if (url.protocol === "https:") {
    return url.origin;
  }
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
    return url.origin;
  }
  return undefined;
}

/**
 * When a new value takes effect: at once, after a server restart, or with the
 * next email.
 */
export type SettingApply = "now" | "restart" | "next_email";

interface Rule<T> {
  /** Row key in the setting table. */
  key: string;
  default: T;
  /** Environment variable that overrides the stored value and locks the field. */
  env?: string;
  apply: SettingApply;
  /** The value from the admin panel or the database, or undefined when invalid. */
  parse: (value: unknown) => T | undefined;
  /** The value of the environment variable; defaults to parse of the text. */
  fromEnv?: (text: string) => T | undefined;
  /** Stored encrypted and never returned to the browser. */
  secret?: true;
}

const integer =
  (min: number, max: number) =>
  (value: unknown): number | undefined =>
    Number.isInteger(value) && (value as number) >= min && (value as number) <= max
      ? (value as number)
      : undefined;

const integerText = (min: number, max: number) => (text: string) =>
  /^\d{1,9}$/.test(text) ? integer(min, max)(Number(text)) : undefined;

const text =
  (max: number, pattern?: RegExp) =>
  (value: unknown): string | undefined => {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    if (
      trimmed.length > max ||
      (trimmed !== "" && pattern !== undefined && !pattern.test(trimmed))
    ) {
      return undefined;
    }
    return trimmed;
  };

/** A list from the panel (an array of strings) or the environment (comma-separated). */
const list =
  (check: (entries: string[]) => string[] | undefined) =>
  (value: unknown): string[] | undefined => {
    const entries =
      typeof value === "string"
        ? value.split(/[\s,]+/)
        : Array.isArray(value) && value.every((item) => typeof item === "string")
          ? value
          : undefined;
    if (entries === undefined || entries.length > 50) {
      return undefined;
    }
    return check(entries.map((entry) => entry.trim()).filter((entry) => entry !== ""));
  };

const originList = list((entries) =>
  entries.every((entry) => parsePublicUrl(entry) === entry) ? entries : undefined,
);

const proxyList = list((entries) => {
  const parsed = parseTrustedProxies(entries.join(","));
  return parsed.ok ? parsed.entries : undefined;
});

const HOST = /^[A-Za-z0-9.-]+$/;
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+$/;

/**
 * Every setting the admin manages in the admin panel, with its default, its
 * validation, and the environment variable that may override it. The
 * defaults are safe development values; production values live only in the
 * database or the environment.
 */
export const SETTING_RULES = {
  /** Heartbeat interval sent to agents (decision D4). */
  heartbeatIntervalSeconds: {
    key: "heartbeat_interval_seconds",
    default: 60,
    apply: "now",
    parse: integer(30, 600),
  } satisfies Rule<number>,
  /** Raw heartbeats and events are deleted after this many days. */
  retentionDays: {
    key: "retention_days",
    default: 30,
    apply: "now",
    parse: integer(8, 3650),
  } satisfies Rule<number>,
  /** Whether new agents may register (decision of 2026-11-03); existing agents are not affected. */
  registrationOpen: {
    key: "registration_open",
    default: true,
    apply: "now",
    parse: (value: unknown) => (typeof value === "boolean" ? value : undefined),
  } satisfies Rule<boolean>,
  /** The trust tier of a new agent; low agents are promoted after their trial. */
  newAgentTier: {
    key: "new_agent_tier",
    default: "low" as string,
    apply: "now",
    parse: (value: unknown) =>
      typeof value === "string" && (NEW_AGENT_TIERS as readonly string[]).includes(value)
        ? value
        : undefined,
  } satisfies Rule<string>,
  /** Distinct days a low agent must report on before it becomes normal. */
  promotionDays: {
    key: "promotion_days",
    default: 7,
    apply: "now",
    parse: integer(1, 90),
  } satisfies Rule<number>,
  /** New registrations per site (an IPv4 address or an IPv6 /64) in 10 minutes. */
  registerPerSitePer10Min: {
    key: "register_per_site_per_10min",
    default: 10,
    apply: "now",
    parse: integer(1, 1000),
  } satisfies Rule<number>,
  /** New registrations per hour across all sites. */
  registerGlobalPerHour: {
    key: "register_global_per_hour",
    default: 200,
    apply: "now",
    parse: integer(1, 100_000),
  } satisfies Rule<number>,
  /** Events stored per agent per hour; events past it are deferred. */
  eventsPerAgentHour: {
    key: "events_per_agent_hour",
    default: 2000,
    apply: "now",
    parse: integer(100, 100_000),
  } satisfies Rule<number>,
  /** The same budget for low agents. */
  eventsPerLowAgentHour: {
    key: "events_per_low_agent_hour",
    default: 200,
    apply: "now",
    parse: integer(10, 100_000),
  } satisfies Rule<number>,
  /** Agents that registered but never sent a heartbeat are deleted after this many days. */
  agentCleanupDays: {
    key: "agent_cleanup_days",
    default: 30,
    apply: "now",
    parse: integer(7, 3650),
  } satisfies Rule<number>,
  /** Origin of the web app; empty lets Better Auth infer it from each request. */
  publicUrl: {
    key: "public_url",
    default: "",
    env: "BETTER_AUTH_URL",
    apply: "restart",
    parse: (value: unknown) =>
      value === "" ? "" : typeof value === "string" ? parsePublicUrl(value.trim()) : undefined,
  } satisfies Rule<string>,
  /** Origins trusted besides the public URL. Better Auth reads the environment variable itself. */
  trustedOrigins: {
    key: "trusted_origins",
    default: [] as string[],
    env: "BETTER_AUTH_TRUSTED_ORIGINS",
    apply: "now",
    parse: originList,
    fromEnv: (value: string) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
  } satisfies Rule<string[]>,
  /** Reverse proxies whose X-Forwarded-For is believed. Empty: the TCP peer is the client. */
  trustedProxies: {
    key: "trusted_proxies",
    default: [] as string[],
    env: "MASHKIF_TRUSTED_PROXIES",
    apply: "restart",
    parse: proxyList,
  } satisfies Rule<string[]>,
  /** Length of an admin session; applies to sessions created after a restart. */
  sessionHours: {
    key: "session_hours",
    default: 12,
    env: "MASHKIF_SESSION_HOURS",
    apply: "restart",
    parse: integer(1, 168),
    fromEnv: integerText(1, 168),
  } satisfies Rule<number>,
  smtpHost: {
    key: "smtp_host",
    default: "",
    env: "MASHKIF_SMTP_HOST",
    apply: "next_email",
    parse: text(253, HOST),
  } satisfies Rule<string>,
  /** 465 uses TLS from the start; any other port must upgrade with STARTTLS. */
  smtpPort: {
    key: "smtp_port",
    default: 465,
    env: "MASHKIF_SMTP_PORT",
    apply: "next_email",
    parse: integer(1, 65535),
    fromEnv: integerText(1, 65535),
  } satisfies Rule<number>,
  smtpUser: {
    key: "smtp_user",
    default: "",
    env: "MASHKIF_SMTP_USER",
    apply: "next_email",
    parse: text(254),
  } satisfies Rule<string>,
  smtpPassword: {
    key: "smtp_password",
    default: "",
    env: "MASHKIF_SMTP_PASSWORD",
    apply: "next_email",
    parse: (value: unknown) =>
      typeof value === "string" && value.length <= 256 ? value : undefined,
    secret: true,
  } satisfies Rule<string>,
  /** Sender address of every email. */
  smtpFrom: {
    key: "smtp_from",
    default: "",
    env: "MASHKIF_SMTP_FROM",
    apply: "next_email",
    parse: text(254, ADDRESS),
  } satisfies Rule<string>,
} as const;

export type SettingName = keyof typeof SETTING_RULES;
export type Settings = {
  [K in SettingName]: (typeof SETTING_RULES)[K]["default"] extends boolean
    ? boolean
    : (typeof SETTING_RULES)[K]["default"] extends number
      ? number
      : (typeof SETTING_RULES)[K]["default"] extends string
        ? string
        : string[];
};

const NAMES = Object.keys(SETTING_RULES) as SettingName[];

/** The environment variable that may override each setting, for the admin panel. */
export const SETTING_ENV: Readonly<Partial<Record<SettingName, string>>> = Object.fromEntries(
  NAMES.flatMap((name) => {
    const rule: Rule<unknown> = SETTING_RULES[name];
    return rule.env === undefined ? [] : [[name, rule.env]];
  }),
);

// biome-ignore lint/suspicious/noExplicitAny: any Drizzle PostgreSQL database or transaction.
type Database = PgDatabase<PgQueryResultHKT, any, any>;

function rule(name: SettingName): Rule<unknown> {
  return SETTING_RULES[name];
}

/**
 * The environment value of a setting: set when not empty after trimming. A
 * secret is kept exactly as given, and set when not empty.
 */
function envText(name: SettingName, env: NodeJS.ProcessEnv): string | undefined {
  const variable = rule(name).env;
  const raw = variable === undefined ? undefined : env[variable];
  const value = rule(name).secret === true ? raw : raw?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function fromEnv(name: SettingName, value: string): unknown {
  const current = rule(name);
  return (current.fromEnv ?? current.parse)(value);
}

/** Problems with environment overrides, so the server refuses to start with an invalid one. */
export function settingEnvProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  for (const name of NAMES) {
    const value = envText(name, env);
    if (value !== undefined && fromEnv(name, value) === undefined) {
      problems.push(`${rule(name).env} is not a valid value (${name})`);
    }
  }
  return problems;
}

export interface ResolvedSettings {
  values: Settings;
  /** Settings an environment variable sets; the admin panel shows them locked. */
  locked: SettingName[];
}

/**
 * The current settings: an environment override wins, then the stored value,
 * then the default. A stored secret is decrypted with the Better Auth secret
 * when one is given; otherwise secrets read as empty.
 */
export async function resolveSettings(
  db: Database,
  options: { env?: NodeJS.ProcessEnv; secret?: string } = {},
): Promise<ResolvedSettings> {
  const env = options.env ?? process.env;
  const rows = await db
    .select({ key: setting.key, value: setting.value })
    .from(setting)
    .where(
      inArray(
        setting.key,
        NAMES.map((name) => rule(name).key),
      ),
    );
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const values = {} as Record<SettingName, unknown>;
  const locked: SettingName[] = [];
  for (const name of NAMES) {
    const current = rule(name);
    const override = envText(name, env);
    const fromEnvironment = override === undefined ? undefined : fromEnv(name, override);
    if (fromEnvironment !== undefined) {
      values[name] = fromEnvironment;
      locked.push(name);
      continue;
    }
    let value = stored.get(current.key);
    if (current.secret === true) {
      value =
        typeof value === "string" && value !== "" && options.secret !== undefined
          ? await symmetricDecrypt({ key: options.secret, data: value }).catch(() => undefined)
          : undefined;
    }
    const parsed = value === undefined ? undefined : current.parse(value);
    values[name] = parsed ?? current.default;
  }
  return { values: values as Settings, locked };
}

/** The current settings without secrets; see resolveSettings. */
export async function readSettings(db: Database, env?: NodeJS.ProcessEnv): Promise<Settings> {
  return (await resolveSettings(db, env === undefined ? {} : { env })).values;
}

/** How long the in-process settings cache serves a value before it reads the database again. */
export const SETTINGS_CACHE_TTL_MS = 5_000;

let cacheGeneration = 0;
const cached = new WeakMap<object, { at: number; generation: number; values: Settings }>();

/**
 * The current settings (with the process environment), from an in-process
 * cache: at most SETTINGS_CACHE_TTL_MS old, and read again after every save
 * from the admin panel in this process (invalidateSettingsCache). For paths
 * that unauthenticated requests reach, so a limited request does no query.
 */
export async function cachedSettings(db: Database, now = Date.now()): Promise<Settings> {
  const hit = cached.get(db);
  if (
    hit !== undefined &&
    hit.generation === cacheGeneration &&
    now - hit.at < SETTINGS_CACHE_TTL_MS
  ) {
    return hit.values;
  }
  const generation = cacheGeneration;
  const values = await readSettings(db);
  cached.set(db, { at: now, generation, values });
  return values;
}

/** Makes cachedSettings read the database again; called after a settings save commits. */
export function invalidateSettingsCache(): void {
  cacheGeneration += 1;
}

/**
 * Checks a partial update from the admin panel. Returns the first invalid or
 * locked setting, or the update. Unknown fields are ignored.
 */
export function parseSettingsUpdate(
  body: Record<string, unknown>,
  locked: readonly SettingName[],
): { ok: true; update: Partial<Settings> } | { ok: false; field: string; locked: boolean } {
  const update: Record<string, unknown> = {};
  for (const name of NAMES) {
    if (body[name] === undefined) {
      continue;
    }
    if (locked.includes(name)) {
      return { ok: false, field: name, locked: true };
    }
    const value = rule(name).parse(body[name]);
    if (value === undefined) {
      return { ok: false, field: name, locked: false };
    }
    update[name] = value;
  }
  return { ok: true, update: update as Partial<Settings> };
}

/** Stores the given settings inside the caller's transaction; secrets encrypted with the Better Auth secret. */
export async function writeSettings(
  db: Database,
  update: Partial<Settings>,
  actor: string,
  secret: string,
  now = new Date(),
): Promise<void> {
  for (const name of NAMES) {
    let value: unknown = update[name];
    if (value === undefined) {
      continue;
    }
    if (rule(name).secret === true && value !== "") {
      value = await symmetricEncrypt({ key: secret, data: value as string });
    }
    await db
      .insert(setting)
      .values({ key: rule(name).key, value, updatedAt: now, updatedBy: actor })
      .onConflictDoUpdate({
        target: setting.key,
        set: { value: sql`excluded.value`, updatedAt: now, updatedBy: actor },
      });
  }
}

/** Whether a setting is stored encrypted and never returned to the browser. */
export function isSecretSetting(name: SettingName): boolean {
  return rule(name).secret === true;
}

/** When each setting takes effect, for the admin panel. */
export const SETTING_APPLY: Readonly<Record<SettingName, SettingApply>> = Object.fromEntries(
  NAMES.map((name) => [name, rule(name).apply]),
) as Record<SettingName, SettingApply>;

/**
 * The extra trusted origins from the admin panel, for Better Auth's
 * trustedOrigins callback. Empty while BETTER_AUTH_TRUSTED_ORIGINS is set:
 * Better Auth adds that variable itself.
 */
export async function panelTrustedOrigins(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const { values, locked } = await resolveSettings(db, { env });
  return locked.includes("trustedOrigins") ? [] : values.trustedOrigins;
}
