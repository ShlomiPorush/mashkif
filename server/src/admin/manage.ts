import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { lockBlocklistExclusive } from "../agent/write-guard.js";
import { type AuditAction, writeAudit } from "../audit.js";
import type { AdminSession } from "../auth/session-policy.js";
import type { Tx } from "../db/client.js";
import {
  agent,
  agentBoot,
  blockedRange,
  enrollmentKey,
  provider,
  providerAsn,
  syncAnchor,
  TRUST_TIERS,
  type TrustTier,
} from "../db/schema.js";
import { classifyAreaCell } from "../geo/area.js";
import { NO_ASN } from "../geoip.js";
import { canonicalRange } from "../http/ip.js";
import { parseSettingsUpdate, readSettings, SETTING_RULES, writeSettings } from "../settings.js";
import { type AdminDeps, type RequestMeta, requestMeta } from "./context.js";
import {
  adminChange,
  idParam,
  jsonFields,
  requireFullSession,
  SESSION_GONE,
  uniqueViolation,
  uuidParam,
} from "./guard.js";
import { hashToken } from "./setup.js";

/** Enrollment keys are valid for 24 hours unless the admin chooses otherwise (decision D2). */
export const ENROLLMENT_KEY_DEFAULT_HOURS = 24;
export const ENROLLMENT_KEY_MAX_HOURS = 7 * 24;
export const LABEL_MAX = 100;
export const PROVIDER_ASNS_MAX = 200;
const ASN_MAX = 4_294_967_295;

type Status = 200 | 201 | 400 | 404 | 409;
type Outcome = { status: Status; body: Record<string, unknown> };
type Audit = { action: AuditAction; details: Record<string, unknown> };

/** Thrown inside a provider change so its transaction rolls back. */
class AsnTaken extends Error {
  override name = "AsnTaken";
  constructor(readonly asns: number[]) {
    super("ASNs belong to another provider");
  }
}

const fail = (status: Status, error: string, field?: string): Outcome => ({
  status,
  body: field === undefined ? { error } : { error, field },
});

/**
 * Runs a change under the session's share lock and writes its audit entries
 * in the same transaction. A refusal (status 400 or more) writes nothing.
 */
async function change(
  deps: AdminDeps,
  c: Context,
  admin: AdminSession,
  work: (tx: Tx) => Promise<{ outcome: Outcome; audits?: Audit[] }>,
): Promise<Response> {
  const meta: RequestMeta = requestMeta(deps, c);
  let result: Outcome | typeof SESSION_GONE;
  try {
    result = await adminChange(deps, admin, async (tx) => {
      const { outcome, audits = [] } = await work(tx);
      if (outcome.status < 400) {
        for (const audit of audits) {
          await writeAudit(tx, { actor: admin.username, ...audit, ...meta });
        }
      }
      return outcome;
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      result = fail(409, "conflict");
    } else {
      throw error;
    }
  }
  if (result === SESSION_GONE) {
    return c.json({ error: "session_ended" }, 401);
  }
  return c.json(result.body, result.status);
}

function label(value: unknown, required: boolean): string | null | undefined {
  if (value === null || value === undefined) {
    return required ? undefined : null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (text.length > LABEL_MAX || (required && text === "")) {
    return undefined;
  }
  return text === "" ? null : text;
}

function keyStatus(
  key: { expiresAt: Date; usedAt: Date | null; revokedAt: Date | null },
  now: Date,
): "active" | "used" | "expired" | "revoked" {
  if (key.usedAt !== null) {
    return "used";
  }
  if (key.revokedAt !== null) {
    return "revoked";
  }
  return key.expiresAt <= now ? "expired" : "active";
}

function asnList(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length > PROVIDER_ASNS_MAX) {
    return undefined;
  }
  const asns = new Set<number>();
  for (const item of value) {
    if (!Number.isSafeInteger(item) || item < 1 || item > ASN_MAX) {
      return undefined;
    }
    asns.add(item);
  }
  return [...asns].sort((a, b) => a - b);
}

/**
 * Admin API for step 2a: enrollment keys, agents, blocked addresses and
 * ranges, providers, and settings. Every route needs a full admin session;
 * the origin check and the body limit of /api/admin/* apply. Every change is
 * audited in its own transaction.
 */
export function mountManagementRoutes(app: Hono, deps: AdminDeps): void {
  const guarded = (
    handler: (c: Context, admin: AdminSession) => Promise<Response>,
  ): ((c: Context) => Promise<Response>) => {
    return async (c) => {
      const admin = await requireFullSession(deps, c);
      return admin instanceof Response ? admin : handler(c, admin);
    };
  };

  // Enrollment keys -----------------------------------------------------------

  app.get(
    "/enrollment-keys",
    guarded(async (c) => {
      const now = new Date();
      const rows = await deps.db
        .select({
          id: enrollmentKey.id,
          label: enrollmentKey.label,
          createdAt: enrollmentKey.createdAt,
          expiresAt: enrollmentKey.expiresAt,
          usedAt: enrollmentKey.usedAt,
          revokedAt: enrollmentKey.revokedAt,
          agentId: agent.id,
        })
        .from(enrollmentKey)
        .leftJoin(agent, eq(agent.enrollmentKeyId, enrollmentKey.id))
        .orderBy(desc(enrollmentKey.id))
        .limit(200);
      return c.json({ keys: rows.map((row) => ({ ...row, status: keyStatus(row, now) })) });
    }),
  );

  app.post(
    "/enrollment-keys",
    guarded(async (c, admin) => {
      const fields = await jsonFields(c);
      const keyLabel = label(fields.label, true);
      if (typeof keyLabel !== "string") {
        return c.json({ error: "label_invalid", field: "label" }, 400);
      }
      const hours = fields.validHours ?? ENROLLMENT_KEY_DEFAULT_HOURS;
      if (!Number.isInteger(hours) || (hours as number) < 1) {
        return c.json({ error: "valid_hours_invalid", field: "validHours" }, 400);
      }
      if ((hours as number) > ENROLLMENT_KEY_MAX_HOURS) {
        return c.json({ error: "valid_hours_invalid", field: "validHours" }, 400);
      }
      const secret = randomBytes(24).toString("base64url");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + (hours as number) * 60 * 60 * 1000);
      return change(deps, c, admin, async (tx) => {
        const [row] = await tx
          .insert(enrollmentKey)
          .values({
            label: keyLabel,
            keyHash: hashToken(secret),
            createdAt: now,
            createdBy: admin.username,
            expiresAt,
          })
          .returning({ id: enrollmentKey.id });
        const id = row?.id;
        return {
          outcome: {
            status: 201,
            body: {
              key: {
                id,
                label: keyLabel,
                createdAt: now,
                expiresAt,
                usedAt: null,
                revokedAt: null,
                agentId: null,
                status: "active",
              },
              // Shown once; only the hash is stored.
              secret,
            },
          },
          audits: [
            {
              action: "enrollment_key.created",
              details: { id, label: keyLabel, expiresAt: expiresAt.toISOString() },
            },
          ],
        };
      });
    }),
  );

  app.post(
    "/enrollment-keys/:id/revoke",
    guarded(async (c, admin) => {
      const id = idParam(c);
      if (id === undefined) {
        return c.json({ error: "not_found" }, 404);
      }
      return change(deps, c, admin, async (tx) => {
        const [row] = await tx
          .update(enrollmentKey)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(enrollmentKey.id, id),
              isNull(enrollmentKey.usedAt),
              isNull(enrollmentKey.revokedAt),
            ),
          )
          .returning({ id: enrollmentKey.id, label: enrollmentKey.label });
        if (row === undefined) {
          const [exists] = await tx
            .select({ id: enrollmentKey.id })
            .from(enrollmentKey)
            .where(eq(enrollmentKey.id, id));
          return {
            outcome:
              exists === undefined
                ? fail(404, "not_found")
                : fail(409, "enrollment_key_not_revocable"),
          };
        }
        return {
          outcome: { status: 200, body: { ok: true } },
          audits: [{ action: "enrollment_key.revoked", details: { id, label: row.label } }],
        };
      });
    }),
  );

  // Agents --------------------------------------------------------------------

  app.get(
    "/agents",
    guarded(async (c) => {
      const rows = await deps.db
        .select({
          id: agent.id,
          label: agent.label,
          trustTier: agent.trustTier,
          agentVersion: agent.agentVersion,
          osVersion: agent.osVersion,
          registeredAt: agent.registeredAt,
          revokedAt: agent.revokedAt,
          lastSeenAt: agent.lastSeenAt,
          address: agent.address,
          siteKey: agent.siteKey,
          asn: agent.asn,
          asOrganization: agent.asOrganization,
          providerName: provider.name,
          reportedCell: agent.reportedCell,
          assignedCell: agent.assignedCell,
          infrastructure: agent.infrastructure,
          silenceIntervalSeconds: agent.silenceIntervalSeconds,
          lastEventKind: agent.lastEventKind,
          lastEventAt: agent.lastEventAt,
          droppedEvents:
            sql<number>`coalesce((select sum(d.dropped_events) from ${agentBoot} d where d.agent_id = ${agent.id}), 0)`.mapWith(
              Number,
            ),
        })
        .from(agent)
        .leftJoin(providerAsn, eq(providerAsn.asn, agent.asn))
        .leftJoin(provider, eq(provider.id, providerAsn.providerId))
        .orderBy(sql`${agent.lastSeenAt} desc nulls last`, desc(agent.registeredAt));
      return c.json({ agents: rows });
    }),
  );

  app.post(
    "/agents/:id",
    guarded(async (c, admin) => {
      const id = uuidParam(c);
      const fields = await jsonFields(c);
      const update: {
        label?: string | null;
        trustTier?: TrustTier;
        assignedCell?: string | null;
      } = {};
      if ("label" in fields) {
        const value = label(fields.label, false);
        if (value === undefined) {
          return c.json({ error: "label_invalid", field: "label" }, 400);
        }
        update.label = value;
      }
      if ("trustTier" in fields) {
        if (!(TRUST_TIERS as readonly unknown[]).includes(fields.trustTier)) {
          return c.json({ error: "trust_tier_invalid", field: "trustTier" }, 400);
        }
        update.trustTier = fields.trustTier as TrustTier;
      }
      if ("assignedCell" in fields) {
        const cell = fields.assignedCell;
        if (cell === null || cell === "") {
          update.assignedCell = null;
        } else {
          const area = typeof cell === "string" ? classifyAreaCell(cell.trim()) : "invalid";
          if (area === "invalid") {
            return c.json({ error: "area_cell_invalid", field: "assignedCell" }, 400);
          }
          if (area === "outside") {
            return c.json({ error: "area_outside_service_area", field: "assignedCell" }, 400);
          }
          update.assignedCell = (cell as string).trim();
        }
      }
      if (id === undefined) {
        return c.json({ error: "not_found" }, 404);
      }
      return change(deps, c, admin, async (tx) => {
        const [before] = await tx
          .select({
            label: agent.label,
            trustTier: agent.trustTier,
            assignedCell: agent.assignedCell,
          })
          .from(agent)
          .where(eq(agent.id, id))
          .for("update");
        if (before === undefined) {
          return { outcome: fail(404, "not_found") };
        }
        const audits: Audit[] = [];
        if (update.trustTier !== undefined && update.trustTier !== before.trustTier) {
          audits.push({
            action: "agent.trust_tier_changed",
            details: { agentId: id, from: before.trustTier, to: update.trustTier },
          });
        }
        if (update.label !== undefined && update.label !== before.label) {
          audits.push({
            action: "agent.label_changed",
            details: { agentId: id, from: before.label, to: update.label },
          });
        }
        if (update.assignedCell !== undefined && update.assignedCell !== before.assignedCell) {
          audits.push(
            update.assignedCell === null
              ? {
                  action: "agent.area_cleared",
                  details: { agentId: id, from: before.assignedCell },
                }
              : {
                  action: "agent.area_assigned",
                  details: { agentId: id, from: before.assignedCell, to: update.assignedCell },
                },
          );
        }
        if (audits.length > 0) {
          await tx.update(agent).set(update).where(eq(agent.id, id));
        }
        return { outcome: { status: 200, body: { ok: true } }, audits };
      });
    }),
  );

  app.post(
    "/agents/:id/revoke",
    guarded(async (c, admin) => {
      const id = uuidParam(c);
      if (id === undefined) {
        return c.json({ error: "not_found" }, 404);
      }
      return change(deps, c, admin, async (tx) => {
        const [row] = await tx
          .update(agent)
          .set({ revokedAt: new Date() })
          .where(and(eq(agent.id, id), isNull(agent.revokedAt)))
          .returning({ id: agent.id, label: agent.label });
        if (row === undefined) {
          const [exists] = await tx.select({ id: agent.id }).from(agent).where(eq(agent.id, id));
          return {
            outcome: exists === undefined ? fail(404, "not_found") : fail(409, "agent_revoked"),
          };
        }
        // Its sync anchors and boot counters are of no further use.
        await tx.delete(syncAnchor).where(eq(syncAnchor.agentId, id));
        await tx.delete(agentBoot).where(eq(agentBoot.agentId, id));
        return {
          outcome: { status: 200, body: { ok: true } },
          audits: [{ action: "agent.revoked", details: { agentId: id, label: row.label } }],
        };
      });
    }),
  );

  // Blocked addresses and ranges ---------------------------------------------

  app.get(
    "/blocked-ranges",
    guarded(async (c) => {
      const rows = await deps.db
        .select({
          id: blockedRange.id,
          range: blockedRange.range,
          note: blockedRange.note,
          createdAt: blockedRange.createdAt,
          createdBy: blockedRange.createdBy,
        })
        .from(blockedRange)
        .orderBy(desc(blockedRange.id));
      return c.json({ ranges: rows });
    }),
  );

  app.post(
    "/blocked-ranges",
    guarded(async (c, admin) => {
      const fields = await jsonFields(c);
      // The same normalization as client addresses: host bits cleared
      // (192.0.2.7/24 is 192.0.2.0/24), and an IPv4-mapped range is IPv4.
      const range =
        typeof fields.range === "string" && fields.range.length <= 64
          ? canonicalRange(fields.range)
          : undefined;
      if (range === undefined) {
        return c.json({ error: "range_invalid", field: "range" }, 400);
      }
      const note = label(fields.note, false);
      if (note === undefined) {
        return c.json({ error: "note_invalid", field: "note" }, 400);
      }
      return change(deps, c, admin, async (tx) => {
        // Waits for agent writes that checked the list, and makes later ones see this range.
        await lockBlocklistExclusive(tx);
        const inserted = await tx
          .insert(blockedRange)
          .values({ range, note: note ?? "", createdBy: admin.username })
          .onConflictDoNothing({ target: blockedRange.range })
          .returning({ id: blockedRange.id });
        if (inserted.length === 0) {
          return { outcome: fail(409, "range_exists") };
        }
        return {
          outcome: { status: 201, body: { id: inserted[0]?.id, range } },
          audits: [{ action: "blocked_range.added", details: { range, note: note ?? "" } }],
        };
      });
    }),
  );

  app.post(
    "/blocked-ranges/:id/delete",
    guarded(async (c, admin) => {
      const id = idParam(c);
      if (id === undefined) {
        return c.json({ error: "not_found" }, 404);
      }
      return change(deps, c, admin, async (tx) => {
        const [row] = await tx
          .delete(blockedRange)
          .where(eq(blockedRange.id, id))
          .returning({ range: blockedRange.range });
        if (row === undefined) {
          return { outcome: fail(404, "not_found") };
        }
        return {
          outcome: { status: 200, body: { ok: true } },
          audits: [{ action: "blocked_range.removed", details: { range: row.range } }],
        };
      });
    }),
  );

  // Providers -----------------------------------------------------------------

  app.get(
    "/providers",
    guarded(async (c) => {
      const providers = await deps.db
        .select({ id: provider.id, name: provider.name })
        .from(provider)
        .orderBy(asc(provider.name));
      const asns = await deps.db
        .select({ asn: providerAsn.asn, providerId: providerAsn.providerId })
        .from(providerAsn)
        .orderBy(asc(providerAsn.asn));
      return c.json({
        providers: providers.map((item) => ({
          ...item,
          asns: asns.filter((row) => row.providerId === item.id).map((row) => row.asn),
        })),
      });
    }),
  );

  const providerInput = async (
    c: Context,
  ): Promise<{ name: string; asns: number[] } | Response> => {
    const fields = await jsonFields(c);
    const name = label(fields.name, true);
    if (typeof name !== "string") {
      return c.json({ error: "name_invalid", field: "name" }, 400);
    }
    const asns = asnList(fields.asns ?? []);
    if (asns === undefined) {
      return c.json({ error: "asns_invalid", field: "asns" }, 400);
    }
    return { name, asns };
  };

  /** Replaces the ASNs of a provider; an ASN of another provider is a conflict. */
  const setAsns = async (tx: Tx, providerId: number, asns: number[]): Promise<number[]> => {
    if (asns.length > 0) {
      const taken = await tx
        .select({ asn: providerAsn.asn })
        .from(providerAsn)
        .where(and(inArray(providerAsn.asn, asns), ne(providerAsn.providerId, providerId)));
      if (taken.length > 0) {
        return taken.map((row) => row.asn);
      }
    }
    await tx.delete(providerAsn).where(eq(providerAsn.providerId, providerId));
    if (asns.length > 0) {
      await tx.insert(providerAsn).values(asns.map((asn) => ({ asn, providerId })));
    }
    return [];
  };

  app.post(
    "/providers",
    guarded(async (c, admin) => {
      const input = await providerInput(c);
      if (input instanceof Response) {
        return input;
      }
      return change(deps, c, admin, async (tx) => {
        const inserted = await tx
          .insert(provider)
          .values({ name: input.name })
          .onConflictDoNothing({ target: provider.name })
          .returning({ id: provider.id });
        const id = inserted[0]?.id;
        if (id === undefined) {
          return { outcome: fail(409, "provider_exists", "name") };
        }
        const taken = await setAsns(tx, id, input.asns);
        if (taken.length > 0) {
          throw new AsnTaken(taken);
        }
        return {
          outcome: { status: 201, body: { id, ...input } },
          audits: [{ action: "provider.created", details: { id, ...input } }],
        };
      }).catch((error: unknown) => {
        if (error instanceof AsnTaken) {
          return c.json({ error: "asn_taken", field: "asns", asns: error.asns }, 409);
        }
        throw error;
      });
    }),
  );

  app.post(
    "/providers/:id",
    guarded(async (c, admin) => {
      const id = idParam(c);
      if (id === undefined) {
        return c.json({ error: "not_found" }, 404);
      }
      const input = await providerInput(c);
      if (input instanceof Response) {
        return input;
      }
      return change(deps, c, admin, async (tx) => {
        const [before] = await tx
          .select({ name: provider.name })
          .from(provider)
          .where(eq(provider.id, id))
          .for("update");
        if (before === undefined) {
          return { outcome: fail(404, "not_found") };
        }
        const [clash] = await tx
          .select({ id: provider.id })
          .from(provider)
          .where(and(eq(provider.name, input.name), ne(provider.id, id)));
        if (clash !== undefined) {
          return { outcome: fail(409, "provider_exists", "name") };
        }
        const taken = await setAsns(tx, id, input.asns);
        if (taken.length > 0) {
          throw new AsnTaken(taken);
        }
        await tx
          .update(provider)
          .set({ name: input.name, updatedAt: new Date() })
          .where(eq(provider.id, id));
        return {
          outcome: { status: 200, body: { id, ...input } },
          audits: [{ action: "provider.updated", details: { id, from: before.name, ...input } }],
        };
      }).catch((error: unknown) => {
        if (error instanceof AsnTaken) {
          return c.json({ error: "asn_taken", field: "asns", asns: error.asns }, 409);
        }
        throw error;
      });
    }),
  );

  app.post(
    "/providers/:id/delete",
    guarded(async (c, admin) => {
      const id = idParam(c);
      if (id === undefined) {
        return c.json({ error: "not_found" }, 404);
      }
      return change(deps, c, admin, async (tx) => {
        const [row] = await tx
          .delete(provider)
          .where(eq(provider.id, id))
          .returning({ name: provider.name });
        if (row === undefined) {
          return { outcome: fail(404, "not_found") };
        }
        return {
          outcome: { status: 200, body: { ok: true } },
          audits: [{ action: "provider.deleted", details: { id, name: row.name } }],
        };
      });
    }),
  );

  // Settings ------------------------------------------------------------------

  app.get(
    "/settings",
    guarded(async (c) => {
      const settings = await readSettings(deps.db);
      return c.json({
        ...settings,
        rules: SETTING_RULES,
        geoip: (deps.asn ?? NO_ASN).status(),
      });
    }),
  );

  app.post(
    "/settings",
    guarded(async (c, admin) => {
      const parsed = parseSettingsUpdate(await jsonFields(c));
      if (!parsed.ok) {
        return c.json({ error: "setting_invalid", field: parsed.field }, 400);
      }
      return change(deps, c, admin, async (tx) => {
        // One update at a time, also before a setting's row exists, so the
        // value read here is the one this update replaces and every change
        // is audited.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mashkif:settings'))`);
        const before = await readSettings(tx);
        await deps.testHooks?.afterSettingsRead?.();
        const changes: Record<string, { from: number; to: number }> = {};
        for (const [name, value] of Object.entries(parsed.update)) {
          const from = before[name as keyof typeof before];
          if (value !== from) {
            changes[name] = { from, to: value };
          }
        }
        await writeSettings(tx, parsed.update, admin.username);
        const after = { ...before, ...parsed.update };
        return {
          outcome: { status: 200, body: after },
          audits:
            Object.keys(changes).length === 0
              ? []
              : [{ action: "settings.updated", details: { changes } }],
        };
      });
    }),
  );
}
