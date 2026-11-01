// Drizzle schema. After changing it, run
// `pnpm --filter @mashkif/server run db:generate` to create a forward-only
// migration in server/drizzle/.
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  cidr,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ---------------------------------------------------------------------------
// Better Auth. Property names are Better Auth field names. Mashkif has exactly
// one admin; the singleton column enforces it in the database.
// ---------------------------------------------------------------------------

export const user = pgTable(
  "auth_user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    username: text("username").unique(),
    displayUsername: text("display_username"),
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    /** Always true and unique: a second user row cannot exist. Better Auth does not know it. */
    singleton: boolean("singleton").notNull().default(true).unique("auth_user_one_admin"),
  },
  (t) => [check("auth_user_singleton_true", sql`${t.singleton}`)],
);

/** Assurance of a session: how the admin proved who they are. */
export const SESSION_ASSURANCES = ["password", "totp", "passkey"] as const;
export type SessionAssurance = (typeof SESSION_ASSURANCES)[number];

export const session = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    // Mashkif's session policy (src/auth/session-policy.ts). Better Auth does
    // not know these columns; the defaults describe a fresh password session.
    /** password: may only enroll TOTP. totp or passkey: full admin session. */
    assurance: text("assurance").$type<SessionAssurance>().notNull().default("password"),
    /** When the admin signed in; the absolute limit counts from here and survives rotation. */
    authenticatedAt: ts("authenticated_at").notNull().defaultNow(),
    /** Last admin request; the idle limit counts from here. */
    lastActiveAt: ts("last_active_at").notNull().defaultNow(),
  },
  (t) => [
    index("auth_session_user_idx").on(t.userId),
    check("auth_session_assurance_known", sql`${t.assurance} in ('password', 'totp', 'passkey')`),
  ],
);

export const account = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("auth_account_user_idx").on(t.userId)],
);

/** Pending challenges: the TOTP step of a sign-in and passkey ceremonies. */
export const verification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("auth_verification_identifier_idx").on(t.identifier)],
);

export const twoFactor = pgTable(
  "auth_two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    // Better Auth generates backup codes on enrollment. Mashkif never shows
    // them and blocks the backup-code routes; recovery is reset-admin.
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: ts("locked_until"),
  },
  (t) => [
    index("auth_two_factor_secret_idx").on(t.secret),
    index("auth_two_factor_user_idx").on(t.userId),
  ],
);

export const passkey = pgTable(
  "auth_passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull().unique(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: ts("created_at"),
    aaguid: text("aaguid"),
  },
  (t) => [index("auth_passkey_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------
// First-run setup and audit
// ---------------------------------------------------------------------------

/** Single-use setup tokens printed by `cli.js setup-token`. Only the SHA-256 hash is stored. */
export const adminSetupToken = pgTable("admin_setup_token", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

/**
 * Single-use tokens printed by `cli.js reset-admin` for setting a new
 * password at /admin/reset. Only the SHA-256 hash is stored.
 */
export const adminResetToken = pgTable("admin_reset_token", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

/**
 * Security and admin events. Rows are only ever inserted. `actor` is the admin
 * username, "cli" for operator commands, or "-" when nobody is signed in.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: ts("at").notNull().defaultNow(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => [index("audit_log_at_idx").on(t.at)],
);

// ---------------------------------------------------------------------------
// Agents: enrollment, heartbeats, and events (MVP stage 1, step 2a)
// ---------------------------------------------------------------------------

/** Trust tiers the admin assigns to an agent. A blocked agent is refused. */
export const TRUST_TIERS = ["trusted", "normal", "suspicious", "blocked"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

/** Access infrastructure the user chooses in the tray. Never inferred from the provider. */
export const INFRASTRUCTURES = [
  "unknown",
  "bezeq",
  "hot",
  "ibc",
  "partner_fiber",
  "cellcom_fiber",
  "other",
] as const;
export type Infrastructure = (typeof INFRASTRUCTURES)[number];

export const EVENT_KINDS = [
  "connectivity_lost",
  "connectivity_restored",
  "shutdown",
  "sleep",
  "resume",
  "service_stop",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Why an event's time could not be placed. */
export const TIME_UNCERTAIN_REASONS = [
  "no_sync",
  "sync_unknown",
  "other_boot",
  "in_future",
  "too_old",
] as const;
export type TimeUncertainReason = (typeof TIME_UNCERTAIN_REASONS)[number];

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/**
 * Single-use enrollment keys created in the admin panel. Only the SHA-256 hash
 * is stored; the key is shown once. The agent that used a key points to it.
 */
export const enrollmentKey = pgTable("enrollment_key", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  label: text("label").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: text("created_by").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  revokedAt: ts("revoked_at"),
});

/**
 * One row per registered agent. The token is stored only as a SHA-256 hash.
 * The address, site, ASN, area, and interval columns describe the latest
 * heartbeat; an agent belongs to the site of its latest heartbeat.
 */
export const agent = pgTable(
  "agent",
  {
    id: uuid("id").primaryKey(),
    installId: uuid("install_id").notNull().unique(),
    tokenHash: text("token_hash").notNull().unique(),
    /** Unique: a key creates at most one agent. */
    enrollmentKeyId: bigint("enrollment_key_id", { mode: "number" })
      .notNull()
      .unique()
      .references(() => enrollmentKey.id),
    label: text("label"),
    trustTier: text("trust_tier").$type<TrustTier>().notNull().default("normal"),
    agentVersion: text("agent_version").notNull(),
    osVersion: text("os_version"),
    registeredAt: ts("registered_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
    lastSeenAt: ts("last_seen_at"),
    /** Full public address of the latest heartbeat. Admin only; never public. */
    address: inet("address"),
    /** IPv4 address, or the IPv6 /64, of the latest heartbeat. */
    siteKey: text("site_key"),
    /** 32-bit unsigned, so bigint. */
    asn: bigint("asn", { mode: "number" }),
    asOrganization: text("as_organization"),
    /** The cell the agent reported; null when unknown or outside the service area. */
    reportedCell: text("reported_cell"),
    /** The cell the admin assigned; wins over the reported one until cleared. */
    assignedCell: text("assigned_cell"),
    infrastructure: text("infrastructure").$type<Infrastructure>().notNull().default("unknown"),
    /** The interval the agent said it uses in its latest heartbeat. */
    intervalReportedSeconds: integer("interval_reported_seconds"),
    /** The interval the server sent in its latest heartbeat response. */
    intervalSentSeconds: integer("interval_sent_seconds"),
    /** The interval silence is judged by: the sent one once reported, else the larger. */
    silenceIntervalSeconds: integer("silence_interval_seconds"),
    lastBootId: uuid("last_boot_id"),
    lastSequence: bigint("last_sequence", { mode: "number" }),
    /** Latest event with a certain time later than the latest heartbeat at the time. */
    lastEventKind: text("last_event_kind").$type<EventKind>(),
    lastEventAt: ts("last_event_at"),
  },
  (t) => [
    index("agent_site_key_idx").on(t.siteKey),
    check("agent_trust_tier_known", sql`${t.trustTier} in (${quoted(TRUST_TIERS)})`),
    check("agent_infrastructure_known", sql`${t.infrastructure} in (${quoted(INFRASTRUCTURES)})`),
  ],
);

/** Raw heartbeats, deleted after the retention period. */
export const heartbeat = pgTable(
  "heartbeat",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    /** Server time when the heartbeat was first received. */
    receivedAt: ts("received_at").notNull(),
    bootId: uuid("boot_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    address: inet("address").notNull(),
    siteKey: text("site_key").notNull(),
    asn: bigint("asn", { mode: "number" }),
    asOrganization: text("as_organization"),
    areaCell: text("area_cell"),
    infrastructure: text("infrastructure").$type<Infrastructure>().notNull(),
    intervalReportedSeconds: integer("interval_reported_seconds").notNull(),
    intervalSentSeconds: integer("interval_sent_seconds").notNull(),
    roundTripMs: integer("round_trip_ms"),
    dnsMs: integer("dns_ms"),
    agentVersion: text("agent_version"),
  },
  (t) => [
    unique("heartbeat_agent_boot_sequence").on(t.agentId, t.bootId, t.sequence),
    index("heartbeat_received_at_idx").on(t.receivedAt),
    index("heartbeat_agent_received_at_idx").on(t.agentId, t.receivedAt),
  ],
);

/**
 * Sync anchors kept per agent: about one day of heartbeats at the default
 * 60-second interval. No anchor is created while an agent is offline, so the
 * anchor it holds survives any time offline; after reconnecting it has this
 * many heartbeats to upload its queue. An event whose anchor was evicted is
 * time uncertain.
 */
export const MAX_SYNC_ANCHORS_PER_AGENT = 1440;

/**
 * One row per heartbeat response: the sync ID returned to the agent and the
 * server time it was anchored at. Events compute their time from it. Every
 * heartbeat request gets a new anchor, also a retry of the same sequence,
 * and the agent's anchors beyond the newest MAX_SYNC_ANCHORS_PER_AGENT are
 * deleted in the same transaction. No retention job touches anchors.
 */
export const syncAnchor = pgTable(
  "sync_anchor",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    syncId: text("sync_id").notNull().unique(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    /** For the same-boot check of events. */
    bootId: uuid("boot_id").notNull(),
    serverTime: ts("server_time").notNull(),
  },
  (t) => [index("sync_anchor_agent_idx").on(t.agentId, t.id)],
);

/** Boot counter rows kept per agent, the agent's current boot always among them. */
export const MAX_BOOTS_PER_AGENT = 10;

/**
 * Events an agent dropped from its queue, as the cumulative count per boot
 * it reports; the largest count seen is kept, so a retry counts once. At
 * most MAX_BOOTS_PER_AGENT rows per agent: a new row evicts the oldest by
 * creation, never the agent's current boot. Rows go when the agent is
 * revoked or deleted, never by age.
 */
export const agentBoot = pgTable(
  "agent_boot",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    bootId: uuid("boot_id").notNull(),
    createdAt: ts("created_at").notNull(),
    droppedEvents: bigint("dropped_events", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.bootId] })],
);

/** Raw agent events, deleted after the retention period. */
export const agentEvent = pgTable(
  "agent_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    /** The agent's durable event ID; a repeat is a duplicate. */
    eventId: uuid("event_id").notNull(),
    kind: text("kind").$type<EventKind>().notNull(),
    bootId: uuid("boot_id").notNull(),
    syncId: text("sync_id"),
    elapsedMs: bigint("elapsed_ms", { mode: "number" }),
    /** Server time of the sync plus the elapsed time; null when there is no usable sync. */
    occurredAt: ts("occurred_at"),
    timeUncertain: boolean("time_uncertain").notNull(),
    uncertainReason: text("uncertain_reason").$type<TimeUncertainReason>(),
    receivedAt: ts("received_at").notNull(),
  },
  (t) => [
    unique("agent_event_agent_event_id").on(t.agentId, t.eventId),
    index("agent_event_received_at_idx").on(t.receivedAt),
    index("agent_event_agent_occurred_at_idx").on(t.agentId, t.occurredAt),
  ],
);

/** Addresses and ranges whose requests are refused. */
export const blockedRange = pgTable("blocked_range", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  range: cidr("range").notNull().unique(),
  note: text("note").notNull().default(""),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: text("created_by").notNull(),
});

/** Providers group ASNs. Managed in the admin panel; the repository ships none. */
export const provider = pgTable("provider", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** An ASN belongs to at most one provider. */
export const providerAsn = pgTable(
  "provider_asn",
  {
    /** 32-bit unsigned, so bigint. */
    asn: bigint("asn", { mode: "number" }).primaryKey(),
    providerId: bigint("provider_id", { mode: "number" })
      .notNull()
      .references(() => provider.id, { onDelete: "cascade" }),
  },
  (t) => [index("provider_asn_provider_idx").on(t.providerId)],
);

/**
 * Settings the admin manages. A missing row means the development default in
 * src/settings.ts; production values are never committed.
 */
export const setting = pgTable("setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
});
