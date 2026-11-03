import { randomBytes } from "node:crypto";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agent, heartbeat, MAX_SYNC_ANCHORS_PER_AGENT, syncAnchor } from "../db/schema.js";
import type { AsnInfo } from "../geoip.js";
import type { HeartbeatInput } from "./parse.js";
import { guardAgentWrite, type WriteRefusal } from "./write-guard.js";

export interface HeartbeatContext {
  agentId: string;
  /** Full public address the heartbeat came from. */
  address: string;
  siteKey: string;
  asn: AsnInfo | undefined;
  /** The reported cell after validation: null when unknown or outside the service area. */
  areaCell: string | null;
  /** The interval this response sends. */
  intervalSentSeconds: number;
  now: Date;
}

export type HeartbeatOutcome =
  | { ok: true; syncId: string; serverTime: Date; nextIntervalSeconds: number }
  | { ok: false; error: WriteRefusal };

/**
 * The interval silence is judged by. Until the agent reports the interval
 * the server last sent, the larger of the two counts, so neither a lost
 * response nor a change in either direction makes the agent look silent.
 */
export function silenceInterval(reportedSeconds: number, sentSeconds: number): number {
  return reportedSeconds === sentSeconds ? sentSeconds : Math.max(reportedSeconds, sentSeconds);
}

/**
 * Records a heartbeat in one transaction that first checks, under the agent
 * row lock, that the agent may still write. Every request gets a new sync
 * anchored at its own receive time and moves the agent to its site and
 * values, also a retry of the same heartbeat whose answer was lost: the
 * agent measures elapsed time from the answer it receives, so an old anchor
 * would place its events too early. A retry (same boot ID and sequence) is
 * stored once as a heartbeat sample. The agent keeps its newest
 * MAX_SYNC_ANCHORS_PER_AGENT anchors.
 */
export async function recordHeartbeat(
  db: Db,
  input: HeartbeatInput,
  context: HeartbeatContext,
): Promise<HeartbeatOutcome> {
  const { agentId, now } = context;
  return db.transaction(async (tx): Promise<HeartbeatOutcome> => {
    const refusal = await guardAgentWrite(tx, agentId, context.address);
    if (refusal !== undefined) {
      return { ok: false, error: refusal };
    }

    await tx
      .insert(heartbeat)
      .values({
        agentId,
        receivedAt: now,
        bootId: input.bootId,
        sequence: input.sequence,
        address: context.address,
        siteKey: context.siteKey,
        asn: context.asn?.asn ?? null,
        asOrganization: context.asn?.organization ?? null,
        areaCell: context.areaCell,
        infrastructure: input.infrastructure,
        intervalReportedSeconds: input.intervalSeconds,
        intervalSentSeconds: context.intervalSentSeconds,
        roundTripMs: input.roundTripMs,
        dnsMs: input.dnsMs,
        agentVersion: input.agentVersion ?? null,
      })
      .onConflictDoNothing({ target: [heartbeat.agentId, heartbeat.bootId, heartbeat.sequence] });

    const syncId = randomBytes(16).toString("base64url");
    await tx.insert(syncAnchor).values({ syncId, agentId, bootId: input.bootId, serverTime: now });
    // Only the newest anchors are kept; the agent row lock serializes this per agent.
    await tx.delete(syncAnchor).where(
      and(
        eq(syncAnchor.agentId, agentId),
        sql`${syncAnchor.id} < (select a.id from ${syncAnchor} a where a.agent_id = ${agentId}
          order by a.id desc offset ${MAX_SYNC_ANCHORS_PER_AGENT - 1} limit 1)`,
      ),
    );

    // A heartbeat received earlier but committed later never moves the agent back.
    // The first heartbeat of each UTC day (server time) counts one active day
    // for the trial of a low agent; a retry or a second heartbeat that day does not.
    const day = now.toISOString().slice(0, 10);
    await tx
      .update(agent)
      .set({
        activeDays: sql`${agent.activeDays} + case when ${agent.lastActiveDay} is distinct from ${day}::date then 1 else 0 end`,
        lastActiveDay: day,
        lastSeenAt: now,
        address: context.address,
        siteKey: context.siteKey,
        asn: context.asn?.asn ?? null,
        asOrganization: context.asn?.organization ?? null,
        reportedCell: context.areaCell,
        infrastructure: input.infrastructure,
        intervalReportedSeconds: input.intervalSeconds,
        intervalSentSeconds: context.intervalSentSeconds,
        silenceIntervalSeconds: silenceInterval(input.intervalSeconds, context.intervalSentSeconds),
        lastBootId: input.bootId,
        lastSequence: input.sequence,
        ...(input.agentVersion === undefined ? {} : { agentVersion: input.agentVersion }),
      })
      .where(and(eq(agent.id, agentId), or(isNull(agent.lastSeenAt), lte(agent.lastSeenAt, now))));

    return { ok: true, syncId, serverTime: now, nextIntervalSeconds: context.intervalSentSeconds };
  });
}
