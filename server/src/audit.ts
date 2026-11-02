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
  "admin.password_reset",
  "admin.password_reset_failed",
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
  // Since admin sign-in uses Better Auth as is (2026-11-02), the setup and
  // reset token actions, sign_in.rate_limited, and credential_change.* above
  // are no longer written; old rows keep them.
  "totp.disabled",
  "backup_codes.generated",
  "password.changed",
  "password_reset.requested",
  "email_change.requested",
  "email.changed",
  // MVP stage 1, step 2a. Since open enrollment (2026-11-03) the enrollment
  // key actions and agent.registered are no longer written; old rows keep
  // them. A promotion from low to normal is agent.trust_tier_changed with
  // the actor "system".
  "enrollment_key.created",
  "enrollment_key.revoked",
  "agent.registered",
  "agent.trust_tier_changed",
  "agent.label_changed",
  "agent.area_assigned",
  "agent.area_cleared",
  "agent.revoked",
  "blocked_range.added",
  "blocked_range.removed",
  "provider.created",
  "provider.updated",
  "provider.deleted",
  "settings.updated",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  /**
   * Admin username, "cli" for the former operator commands, "agent" for an agent's own
   * request (no longer written), "system" for the promotion job, or "-" when nobody is
   * signed in.
   */
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
