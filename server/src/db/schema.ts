// Drizzle schema. After changing it, run
// `pnpm --filter @mashkif/server run db:generate` to create a forward-only
// migration in server/drizzle/.
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
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
