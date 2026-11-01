import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { auditLog } from "./db/schema.js";

/**
 * Audited actions. Stable identifiers: the admin panel and later steps read
 * them. Add new actions here; never rename existing ones.
 */
export const AUDIT_ACTIONS = [
  "admin.setup_token_created",
  "admin.created",
  "admin.reset",
  "sign_in.succeeded",
  "sign_in.failed",
  "sign_in.rate_limited",
  "sign_out",
  "totp.secret_created",
  "totp.enrolled",
  "passkey.added",
  "passkey.removed",
  "credential_change.started",
  "credential_change.failed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  /** Admin username, "cli" for operator commands, or "-" when nobody is signed in. */
  actor: string;
  action: AuditAction;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

// Any Drizzle PostgreSQL database or transaction.
// biome-ignore lint/suspicious/noExplicitAny: the schema type parameter is irrelevant here.
type Database = PgDatabase<PgQueryResultHKT, any, any>;

/** Writes one audit entry, inside the caller's transaction when given one. */
export async function writeAudit(db: Database, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actor: entry.actor,
    action: entry.action,
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent?.slice(0, 512) ?? null,
    details: entry.details ?? null,
  });
}
